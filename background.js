import { inspectPaperPage } from './content.js';
import { withRequestDeadline } from './request-deadline.js';
/**
 * Background service worker for ScholarRelay.
 *
 * MV3 SERVICE WORKER LIFETIME
 * Chrome terminates idle service workers after ~30 seconds. Any code that
 * sleeps between network calls (e.g. a while-loop with setTimeout) risks
 * being killed mid-execution during a 10-15 minute job.
 *
 * Solution: use chrome.alarms (30-second production-safe period) for the two long polling
 * phases. The alarm wakes the worker, runs one poll tick, then exits.
 * All inter-tick state is persisted in chrome.storage.local.
 *
 * Pipeline:
 * 1. Authenticate (CSRF + session tokens)         -- sync network call
 * 2. Create notebook                              -- sync network call
 * 3. Add source (URL or file upload)              -- sync network call
 * 4. [ALARM] Poll every 30s -- wait for source ingestion (up to 10 min)
 * 5.         On source ready: trigger selected artifacts with pacing
 * 6. [ALARM] Poll every 30s -- wait for all artifact tasks (up to 20 min)
 * 7. Notify + chime on completion
 */

import { DEFAULT_SETTINGS } from './settings.js';
import { createJobQueue, canStartNextJob, isUnfinishedJob, MAX_QUEUED_JOBS, MAX_QUEUED_PDF_BYTES } from './job-queue.js';
import { createQueuedPdfStore } from './queued-pdfs.js';
import { t, errorSummary, generationLimitSummary, pdfWaitSummary } from './i18n.js';
import {
    fetchTokens,
    getNotebookUrl,
    createNotebook,
    deleteNotebook,
    listCollections,
    addNotebookToCollection,
    addUrlSource,
    addFileSource,
    listSources,
    getNotebookTitle,
    generateAudio,
    generateVideo,
    generateReport,
    generateQuiz,
    generateFlashcards,
    generateInfographic,
    generateSlideDeck,
    generateMindMap,
    generateDataTable,
    listArtifactStatuses,
    AudioLength,
    AudioFormat,
    VideoFormat,
    VideoStyle,
    QuizQuantity,
    QuizDifficulty,
    ReportFormat,
    SlideDeckFormat,
    SlideDeckLength,
    InfographicOrientation,
    InfographicDetail,
    InfographicStyle,
    SourceStatus,
} from './notebooklm-api.js';
import {
    PIPELINE_ALARM_NAME,
    PIPELINE_POLL_PERIOD_MINUTES,
    canStopPipeline,
    createExclusiveRunner,
    interruptedPipelineUpdate,
    isActivePipelineRun,
    pollingElapsedMs,
    runtimeRecoveryAction,
} from './runtime-policy.js';
import { createPdfFallback, canFallback, isConfirmedImportRejection } from './source-import.js';
import { bindDetectionToTab } from './detection-policy.js';
import {
    MAX_PDF_UPLOAD_BYTES,
    assertPdfUploadSize,
    decodedBase64ByteLength,
    hasBase64PdfSignature,
    hasPdfSignature,
    readResponseWithinLimit,
} from './pdf-file-policy.js';
import { httpOriginPattern, sameHttpOrigin } from './site-permissions.js';

const ALARM_NAME = PIPELINE_ALARM_NAME;
const ARTIFACT_START_DELAY_MS = 1000;

// =========================================================================
// State management
// =========================================================================

const INITIAL_STATE = {
    status: 'idle',          // idle | running | completed | error
    runId: null,
    step: null,              // current step name
    stepDetail: '',          // human-readable detail for current step
    pdfUrl: null,
    sourceType: 'pdf',       // pdf | webpage
    pageUrl: null,
    sourceTitle: null,
    notebookId: null,
    notebookUrl: null,
    notebookTitle: null,
    sourceId: null,
    importMethod: null,
    originalPdfUrl: null,
    pdfEvidence: null,
    fallbackAttempted: false,
    fallbackUploadStarted: false,
    failedUrlSourceId: null,
    replacementSourceId: null,
    collectionAssignment: null, // { collectionId, name, status, error? }
    tasks: [],               // [{ type, taskId, status }] for each artifact being generated
    error: null,
    startedAt: null,
    completedAt: null,
    stepStartedAt: null,     // ISO timestamp when the current polling phase began
};

async function getQueue() {
    const result = await chrome.storage.local.get('jobQueue');
    if (result.jobQueue) return result.jobQueue;
    const legacy = (await chrome.storage.local.get('pipelineState')).pipelineState;
    return { version: 1, paused: false, jobs: legacy?.runId ? [legacy] : [] };
}

async function getState(runId = null) {
    const queue = await getQueue();
    return (runId ? queue.jobs.find(job => job.runId === runId) : queue.jobs.at(-1)) || { ...INITIAL_STATE };
}

const pdfStore = createQueuedPdfStore();
const pipelineState = createJobQueue({
    read: getQueue,
    write: jobQueue => chrome.storage.local.set({ jobQueue }),
});

// Keep cancellation pending until accepted requests return. No mutation is replayed.
const pendingJobOperations = new Map();
async function withJobOperation(runId, operation) {
    pendingJobOperations.set(runId, (pendingJobOperations.get(runId) || 0) + 1);
    try { return await operation(); }
    finally {
        const remaining = pendingJobOperations.get(runId) - 1;
        if (remaining) pendingJobOperations.set(runId, remaining);
        else { pendingJobOperations.delete(runId); await finishCancellation(runId); }
    }
}
async function finishCancellation(runId) {
    if (pendingJobOperations.has(runId)) return;
    const result = await pipelineState.transact(queue => {
        const job = queue.jobs.find(item => item.runId === runId);
        if (job?.status !== 'stopping') return null;
        Object.assign(job, { status: 'stopped', step: 'stopped', completedAt: new Date().toISOString(), cleanupAvailable: !!job.notebookId });
        if (!job.notebookId && job.cancelledStep === 'create_notebook') {
            job.cleanupStatus = 'unknown';
            job.cleanupError = 'Notebook creation needs checking. No delete request was sent without a confirmed identity.';
        }
        return { state: job };
    });
    if (!result.applied) return;
    await releaseJobPdf(runId);
    if (result.state.cancelIntent === 'delete' && result.state.notebookId) {
        await deleteCancelledNotebook(runId).catch(error => console.warn('[Cancellation]', error.message));
    }
    kickQueue();
}
async function deleteCancelledNotebook(runId) {
    const claimed = await pipelineState.transact(queue => {
        const job = queue.jobs.find(item => item.runId === runId);
        if (!job || !['error', 'stopped'].includes(job.status) || !job.notebookId || job.notebookDeletedAt) return null;
        if (['deleting', 'unknown'].includes(job.cleanupStatus)) return null;
        if (queue.jobs.some(item => item.runId !== runId && item.notebookId === job.notebookId && !item.notebookDeletedAt)) {
            throw new Error('Another job references this notebook.');
        }
        job.cleanupStatus = 'deleting';
        return { notebookId: job.notebookId };
    });
    if (!claimed.applied) return { ok: false, message: 'Deletion needs checking. Open the notebook before taking another action.' };
    try {
        await deleteNotebook(claimed.notebookId);
        await pipelineState.transact(queue => {
            const job = queue.jobs.find(item => item.runId === runId && item.notebookId === claimed.notebookId);
            if (!job) return null;
            Object.assign(job, { notebookDeletedAt: new Date().toISOString(), cleanupStatus: 'deleted', notebookUrl: null });
            return {};
        });
        return { ok: true };
    } catch (error) {
        await pipelineState.transact(queue => {
            const job = queue.jobs.find(item => item.runId === runId);
            if (!job) return null;
            job.cleanupStatus = 'unknown';
            job.cleanupError = error.message;
            return {};
        });
        throw error;
    }
}

async function transitionRun(runId, updates, options = {}) {
    const result = await pipelineState.transition(runId, updates, options);
    if (result.effectError) throw result.effectError;
    if (result.applied && (result.state.status !== 'running' ||
        ['wait_artifacts', 'wait_pdf_access'].includes(result.state.step))) {
        kickQueue();
    }
    return result.applied ? result.state : null;
}

async function requireActiveRun(runId, expectedSteps = null) {
    const state = await getState(runId);
    if (!isActivePipelineRun(state, runId)) {
        const error = new Error('Pipeline run is no longer active');
        error.code = 'PIPELINE_STALE_RUN';
        throw error;
    }
    if (expectedSteps && !expectedSteps.includes(state.step)) {
        const error = new Error(`Pipeline step changed from ${expectedSteps.join(' or ')} to ${state.step || 'none'}`);
        error.code = 'PIPELINE_STALE_RUN';
        throw error;
    }
    return state;
}

function isWebpageSourceType(sourceType) {
    return sourceType === 'webpage';
}

function normalizeSourceTitle(value) {
    if (typeof value !== 'string') return '';
    const title = value.replace(/\s+/g, ' ').trim()
        .replace(/^\[[\d.]+(?:v\d+)?\]\s*/, '')
        .replace(/\s*[|\-]\s*arXiv(?:\.org)?\s*$/i, '')
        .trim();
    return title && !/^untitled$/i.test(title) ? title.substring(0, 300) : '';
}

function getSourceLabel(sourceType) {
    return isWebpageSourceType(sourceType) ? 'webpage source' : 'PDF source';
}

function getIngestionLabel(sourceType) {
    return isWebpageSourceType(sourceType) ? 'webpage ingestion' : 'PDF ingestion';
}

function isLikelyPdfUrl(url) {
    return typeof url === 'string' && /\.pdf(\?|#|$)/i.test(url);
}

function extractHttpStatusFromMessage(message) {
    if (typeof message !== 'string') return null;
    const match = message.match(/\bHTTP\s+(\d{3})\b/i);
    if (!match) return null;
    const code = Number(match[1]);
    return Number.isFinite(code) ? code : null;
}

function hostFromUrl(url) {
    try {
        return new URL(url).host || null;
    } catch (_) {
        return null;
    }
}

function buildFallbackUploadErrorMessage(urlErr, fallbackErr, pdfUrl) {
    const urlMsg = urlErr?.message || 'URL source blocked';
    const fallbackMsg = fallbackErr?.message || 'fallback upload failed';
    const fallbackStatus = extractHttpStatusFromMessage(fallbackMsg);

    if (fallbackStatus === 401 || fallbackStatus === 403) {
        const host = hostFromUrl(pdfUrl);
        const hostText = host ? ` (${host})` : '';
        return `Source site blocked automated PDF download${hostText} (HTTP ${fallbackStatus}). Download the PDF manually and retry with "Upload Local PDF" or "Choose Different PDF". URL source error: ${urlMsg}.`;
    }

    if (/does not appear to be a PDF/i.test(fallbackMsg)) {
        return `The detected URL did not return a real PDF file. Open the direct PDF URL or retry with "Upload Local PDF". URL source error: ${urlMsg}. Fallback detail: ${fallbackMsg}.`;
    }

    return `${urlMsg}; fallback upload failed: ${fallbackMsg}`;
}

function decodeFilenameValue(raw) {
    if (!raw) return null;
    let value = String(raw).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }
    try {
        return decodeURIComponent(value);
    } catch (_) {
        return value;
    }
}

function filenameFromContentDisposition(contentDisposition) {
    if (!contentDisposition) return null;

    // RFC 5987: filename*=UTF-8''encoded-name.pdf
    const filenameStarMatch = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
    if (filenameStarMatch) {
        let value = filenameStarMatch[1].trim();
        const utf8Prefix = value.match(/^([^']*)'[^']*'(.*)$/);
        if (utf8Prefix) {
            value = utf8Prefix[2];
        }
        const decoded = decodeFilenameValue(value);
        if (decoded) return decoded;
    }

    const filenameMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
    if (filenameMatch) {
        const decoded = decodeFilenameValue(filenameMatch[1]);
        if (decoded) return decoded;
    }

    return null;
}

function filenameFromUrl(url) {
    try {
        const parsed = new URL(url);
        const raw = parsed.pathname.split('/').pop() || '';
        const decoded = decodeFilenameValue(raw);
        if (decoded) return decoded;
    } catch (_) {
        // ignore
    }
    return null;
}

function ensurePdfFilename(name) {
    const sanitized = String(name || '').trim();
    if (!sanitized) return 'uploaded.pdf';
    return /\.pdf$/i.test(sanitized) ? sanitized : `${sanitized}.pdf`;
}

async function downloadRemotePdfForUpload(pdfUrl, pageUrl = null) {
    const originPattern = httpOriginPattern(pdfUrl);
    const coveredByActiveTab = sameHttpOrigin(pdfUrl, pageUrl);
    const hasGrantedOrigin = originPattern
        ? await chrome.permissions.contains({ origins: [originPattern] })
        : false;
    if (originPattern && !coveredByActiveTab && !hasGrantedOrigin) {
        throw new Error(
            `SITE_ACCESS_REQUIRED: Direct download access was not granted for ${new URL(pdfUrl).host}. ` +
            'Grant access from the extension popup or upload the PDF manually.'
        );
    }

    return withRequestDeadline(async signal => {
        const response = await fetch(pdfUrl, {
            signal,
            method: 'GET',
            credentials: 'include',
            redirect: 'follow',
            cache: 'force-cache',
            headers: {
                Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
            },
            referrer: pageUrl || undefined,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} while downloading source PDF`);
        }

        const contentType = response.headers.get('content-type') || '';
        const contentDisposition = response.headers.get('content-disposition') || '';
        const filename = ensurePdfFilename(
            filenameFromContentDisposition(contentDisposition) ||
            filenameFromUrl(response.url || pdfUrl) ||
            filenameFromUrl(pdfUrl) ||
            'uploaded.pdf'
        );

        // Accept common PDF delivery types: application/pdf or generic binary payloads.
        const likelyPdfMime = /application\/pdf/i.test(contentType) || /application\/octet-stream/i.test(contentType);
        const likelyPdfUrl = /\.pdf(\?|#|$)/i.test(response.url || pdfUrl);

        const bytes = await readResponseWithinLimit(response);
        const fileData = bytes.buffer;
        const hasPdfMagic = hasPdfSignature(bytes);

        if (!hasPdfMagic) {
            const deliveryHint = likelyPdfMime || likelyPdfUrl ? ' despite its PDF URL or content type' : '';
            throw new Error(`Downloaded content does not contain a PDF signature${deliveryHint}`);
        }

        return {
            filename,
            mimeType: 'application/pdf',
            fileData,
        };
    }, 25000);
}

// =========================================================================
// Extension icon badge
// =========================================================================

function setBadge(text, color) {
    return Promise.all([
        chrome.action.setBadgeText({ text }),
        chrome.action.setBadgeBackgroundColor({ color }),
    ]);
}

function clearBadge() {
    return chrome.action.setBadgeText({ text: '' });
}

// =========================================================================
// Settings
// =========================================================================



async function getJobSettings(runId) {
    return (await getState(runId)).settings || await getSettings();
}

async function getSettings() {
    const result = await chrome.storage.local.get('userSettings');
    return { ...DEFAULT_SETTINGS, ...(result.userSettings || {}) };
}

// Map string keys to enum values
function resolveAudioLength(s) {
    return { short: AudioLength.SHORT, default: AudioLength.DEFAULT, long: AudioLength.LONG }[s] ?? AudioLength.LONG;
}
function resolveAudioFormat(s) {
    return { deep_dive: AudioFormat.DEEP_DIVE, brief: AudioFormat.BRIEF, critique: AudioFormat.CRITIQUE, debate: AudioFormat.DEBATE }[s] ?? null;
}
function resolveVideoFormat(s) {
    return { explainer: VideoFormat.EXPLAINER, brief: VideoFormat.BRIEF }[s] ?? VideoFormat.EXPLAINER;
}
function resolveVideoStyle(s) {
    const map = { auto: VideoStyle.AUTO_SELECT, custom: VideoStyle.CUSTOM, classic: VideoStyle.CLASSIC, whiteboard: VideoStyle.WHITEBOARD, kawaii: VideoStyle.KAWAII, anime: VideoStyle.ANIME, watercolor: VideoStyle.WATERCOLOR, retro_print: VideoStyle.RETRO_PRINT, heritage: VideoStyle.HERITAGE, paper_craft: VideoStyle.PAPER_CRAFT };
    return map[s] ?? VideoStyle.AUTO_SELECT;
}
function resolveQuizQuantity(s) {
    return { fewer: QuizQuantity.FEWER, standard: QuizQuantity.STANDARD, more: QuizQuantity.MORE }[s] ?? QuizQuantity.STANDARD;
}
function resolveQuizDifficulty(s) {
    return { easy: QuizDifficulty.EASY, medium: QuizDifficulty.MEDIUM, hard: QuizDifficulty.HARD }[s] ?? QuizDifficulty.MEDIUM;
}
function resolveReportFormat(s) {
    return { briefing_doc: ReportFormat.BRIEFING_DOC, study_guide: ReportFormat.STUDY_GUIDE, blog_post: ReportFormat.BLOG_POST, custom: ReportFormat.CUSTOM }[s] ?? ReportFormat.STUDY_GUIDE;
}
function resolveSlideDeckFormat(s) {
    return { detailed_deck: SlideDeckFormat.DETAILED_DECK, presenter_slides: SlideDeckFormat.PRESENTER_SLIDES }[s] ?? SlideDeckFormat.DETAILED_DECK;
}
function resolveSlideDeckLength(s) {
    return { default: SlideDeckLength.DEFAULT, short: SlideDeckLength.SHORT }[s] ?? SlideDeckLength.DEFAULT;
}
function resolveInfographicOrientation(s) {
    return { landscape: InfographicOrientation.LANDSCAPE, portrait: InfographicOrientation.PORTRAIT, square: InfographicOrientation.SQUARE }[s] ?? InfographicOrientation.LANDSCAPE;
}
function resolveInfographicDetail(s) {
    return { concise: InfographicDetail.CONCISE, standard: InfographicDetail.STANDARD, detailed: InfographicDetail.DETAILED }[s] ?? InfographicDetail.STANDARD;
}
function resolveInfographicStyle(s) {
    const map = {
        auto: InfographicStyle.AUTO_SELECT,
        sketch_note: InfographicStyle.SKETCH_NOTE,
        professional: InfographicStyle.PROFESSIONAL,
        bento_grid: InfographicStyle.BENTO_GRID,
        editorial: InfographicStyle.EDITORIAL,
        instructional: InfographicStyle.INSTRUCTIONAL,
        bricks: InfographicStyle.BRICKS,
        clay: InfographicStyle.CLAY,
        anime: InfographicStyle.ANIME,
        kawaii: InfographicStyle.KAWAII,
        scientific: InfographicStyle.SCIENTIFIC,
    };
    return map[s] ?? InfographicStyle.AUTO_SELECT;
}

const INFOGRAPHIC_STYLE_PRESET_PROMPTS = {
    auto: '',
    editorial: 'Use an editorial infographic style with polished typography, balanced whitespace, and a magazine-like layout.',
    minimal: 'Use a minimal infographic style with restrained colors, simple icons, and clean visual hierarchy.',
    data_dense: 'Use a data-dense analytical infographic style with compact charts, annotated callouts, and evidence-forward layout.',
    playful: 'Use a playful infographic style with bold color accents, approachable illustrations, and friendly labeling.',
    technical: 'Use a technical infographic style with diagram-like structure, precise annotations, and blueprint-inspired composition.',
    timeline: 'Use a timeline-centric infographic style with clear chronology, milestone callouts, and directional flow.',
    comparison: 'Use a comparison infographic style with side-by-side sections, explicit contrasts, and grouped evidence.',
    poster: 'Use a poster-style infographic with a strong headline, a dominant hero visual, and a few high-impact takeaways.',
};

function buildInfographicInstructions(settings) {
    const parts = [];
    const preset = INFOGRAPHIC_STYLE_PRESET_PROMPTS[settings.infographicStylePreset] || '';
    const prompt = typeof settings.infographicPrompt === 'string' ? settings.infographicPrompt.trim() : '';

    if (preset) {
        parts.push(preset);
    }
    if (prompt) {
        parts.push(prompt);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================================================================
// Completion chime (offscreen document)
// =========================================================================
async function playCompletionChime() {
    const url = chrome.runtime.getURL('offscreen.html');
    try {
        const existing = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [url],
        });
        if (existing.length === 0) {
            await chrome.offscreen.createDocument({
                url,
                reasons: ['AUDIO_PLAYBACK'],
                justification: 'Play the ScholarRelay completion chime',
            });
        }
        await chrome.runtime.sendMessage({ type: 'PLAY_CHIME' });
        setTimeout(async () => {
            try { await chrome.offscreen.closeDocument(); } catch (_) { /* already closed */ }
        }, 2000);
    } catch (e) {
        console.warn('[Pipeline] Could not play completion chime:', e.message);
    }
}

// =========================================================================
// Pipeline completion / error helpers
// =========================================================================

let notificationTargetQueue = Promise.resolve();

function updateNotificationTargets(operation) {
    const apply = async () => {
        const stored = await chrome.storage.local.get('notificationTargets');
        const targets = stored.notificationTargets || {};
        const result = await operation(targets);
        await chrome.storage.local.set({ notificationTargets: targets });
        return result;
    };
    notificationTargetQueue = notificationTargetQueue.then(apply, apply);
    return notificationTargetQueue;
}

async function rememberNotificationTarget(notificationId, notebookUrl) {
    if (!notebookUrl) return;
    await updateNotificationTargets(targets => {
        targets[notificationId] = { notebookUrl, createdAt: Date.now() };
        const obsoleteIds = Object.entries(targets)
            .sort((a, b) => b[1].createdAt - a[1].createdAt)
            .slice(10)
            .map(([id]) => id);
        for (const id of obsoleteIds) delete targets[id];
    });
}

async function takeNotificationTarget(notificationId) {
    return updateNotificationTargets(targets => {
        const notebookUrl = targets[notificationId]?.notebookUrl || null;
        delete targets[notificationId];
        return notebookUrl;
    });
}

async function completePipeline(runId) {
    await requireActiveRun(runId, ['wait_artifacts']);
    const settings = await getJobSettings(runId);
    const state = await getState(runId);
    if (!isActivePipelineRun(state, runId) || state.step !== 'wait_artifacts') return;
    const tasks = state.tasks || [];
    const totalCount = tasks.length;
    const completedCount = tasks.filter(t => t.status === 'completed').length;
    const failedCount = tasks.filter(t => t.status === 'failed').length;
    const allSucceeded = totalCount > 0 && failedCount === 0 && completedCount === totalCount;

    if (totalCount > 0 && completedCount === 0) {
        await failPipeline(runId, 'All artifact generations failed. No artifacts were generated.');
        return;
    }

    const stepDetail = totalCount === 0
        ? 'Source imported successfully. No artifacts were requested.'
        : allSucceeded
        ? 'All artifacts generated successfully!'
        : `Partial success: ${completedCount}/${totalCount} artifacts generated (${failedCount} failed).`;

    const completedState = await transitionRun(runId, {
        status: 'completed',
        step: 'done',
        stepDetail,
        completedAt: new Date().toISOString(),
    }, {
        expectedSteps: ['wait_artifacts'],
    });
    if (!completedState) return;

    if (settings.chimeEnabled) {
        playCompletionChime();
    }

    const nbTitle = state.notebookTitle ? `"${state.notebookTitle}" ` : '';
    const notificationMessage = totalCount === 0
        ? t('Notebook $1 is ready. Source imported without artifacts. Click to open.', [nbTitle.trim()])
        : allSucceeded
        ? completedCount === 1
            ? t('Notebook $1 is ready with one artifact. Click to open.', [nbTitle.trim()])
            : t('Notebook $1 is ready with $2 artifacts. Click to open.', [nbTitle.trim(), completedCount])
        : t('Notebook $1 is partially ready. $2/$3 artifacts ready, $4 failed. Click to open.', [nbTitle.trim(), completedCount, totalCount, failedCount]);

    if (settings.notificationEnabled !== false) {
        const notificationId = `pipeline-complete:${runId}`;
        await rememberNotificationTarget(notificationId, state.notebookUrl)
            .catch(error => console.warn('[Notification] Could not save notebook target:', error));
        chrome.notifications.create(notificationId, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: t('Gemini Notebook Ready!'),
            message: notificationMessage,
            priority: 2,
            requireInteraction: true,
            buttons: [
                { title: t('Open Notebook') },
                { title: t('Dismiss') },
            ],
        });
    }

    if (settings.autoOpenNotebook && state.notebookUrl) {
        chrome.tabs.create({ url: state.notebookUrl });
    }

    console.log('[Pipeline] Completed successfully');
}

function failureDiagnostic(error, step) {
    const message = typeof error === 'string' ? error : error?.message || 'Unknown error';
    const code = error?.code || message.match(/^([A-Z_]+):/)?.[1] || null;
    return { code, message: message.slice(0, 2000), failedStep: step, failedAt: new Date().toISOString() };
}

function jobDetailsUrl(runId) {
    return chrome.runtime.getURL('popup.html') + '?runId=' + encodeURIComponent(runId);
}

async function notifyJobAttention(state, error) {
    if ((await getJobSettings(state.runId)).notificationEnabled === false) return;
    const id = `pipeline-error:${state.runId}`;
    try {
        await rememberNotificationTarget(id, jobDetailsUrl(state.runId));
        const title = (state.sourceTitle || state.notebookTitle || t('Source')).slice(0, 120);
        await chrome.notifications.create(id, {
            type: 'basic', iconUrl: 'icons/icon128.png', title: state.step === 'wait_pdf_access' ? t('Action needed') : t('ScholarRelay Error'),
            message: `${title} · ${state.step === 'wait_pdf_access' ? pdfWaitSummary(state) : (generationLimitSummary(state.tasks) || errorSummary(error))}`, priority: 2,
        });
    } catch (error) { console.warn('[Notification] Could not show job attention:', error); }
}

// Only session discovery before notebook creation can return safely to the queue.
async function holdForSession(runId, error) {
    if (error?.phase !== 'auth_discovery' || ![
        'AUTH_REQUIRED', 'SESSION_RATE_LIMITED', 'SESSION_UNAVAILABLE', 'SESSION_UNRECOGNIZED',
    ].includes(error.code)) return false;
    const diagnostic = failureDiagnostic(error, 'auth');
    const result = await pipelineState.transact(queue => {
        const job = queue.jobs.find(item => item.runId === runId);
        if (job?.status !== 'running' || job.step !== 'auth' || job.notebookId) return null;
        const notify = !queue.serviceBlock;
        queue.serviceBlock ||= { ...diagnostic, id: crypto.randomUUID(), runId };
        Object.assign(job, { status: 'queued', step: 'queued', startedAt: null,
            stepStartedAt: null, connectionError: diagnostic });
        return { state: job, notify };
    });
    if (!result.applied) return false;
    if (result.notify) await notifyJobAttention(result.state, diagnostic);
    return true;
}

async function resumeServiceBlock(blockId) {
    await ensureBootReconciled();
    const result = await pipelineState.transact(queue => {
        if (!queue.serviceBlock || queue.serviceBlock.id !== blockId) return null;
        queue.serviceBlock = null;
        for (const job of queue.jobs) {
            if (job.status === 'queued') delete job.connectionError;
        }
        return {};
    });
    if (!result.applied) return { ok: false, message: 'The connection hold has changed. Refresh the queue.' };
    // Do not change an independent user pause or replay any remote mutation.
    await syncQueueRuntime();
    kickQueue();
    return { ok: true };
}

async function failPipeline(runId, errorInput, notebookId = null) {
    const state = await requireActiveRun(runId);
    const diagnostic = failureDiagnostic(errorInput, state.step);
    const finalError = diagnostic.message;
    if (state.sources && ['wait_source', 'download_pdf'].includes(state.step)) {
        await transitionRun(runId, { step: 'wait_source_choice', error: finalError, stepDetail: finalError,
            sources: state.sources.map((item, index) => index === state.sourceIndex ? { ...item, status: 'failed', error: finalError } : item) });
        kickQueue();
        return;
    }
    const failedState = await transitionRun(runId, {
        status: 'error', step: 'error', failedStep: diagnostic.failedStep, failure: diagnostic,
        stepDetail: finalError, error: finalError, completedAt: new Date().toISOString(),
        cleanupAvailable: !!(notebookId || state.notebookId),
    });
    if (!failedState) return;
    await notifyJobAttention(failedState, { ...diagnostic, message: finalError });
    console.error('[Pipeline] Error:', finalError);
}

// =========================================================================
// Alarm-based polling ticks
// =========================================================================

/**
 * One tick of the source-ingestion polling phase.
 * Checks if the source is ready. If so, triggers artifact generation
 * and transitions state to 'wait_artifacts'.
 */
async function tickSourcePoll(state) { return withJobOperation(state.runId, () => tickSourcePollOperation(state)); }
async function tickSourcePollOperation(state) {
    const runId = state.runId;
    await requireActiveRun(runId, ['wait_source']);
    const SOURCE_TIMEOUT_MS = 600000; // 10 minutes
    const elapsed = pollingElapsedMs(state.stepStartedAt);
    const sourceLabel = getSourceLabel(state.sourceType);
    const ingestionLabel = getIngestionLabel(state.sourceType);

    if (elapsed > SOURCE_TIMEOUT_MS) {
        await failPipeline(
            runId,
            `${sourceLabel} ingestion timed out after 10 minutes.`,
            state.notebookId
        );
        return;
    }

    let sources;
    try {
        sources = await listSources(state.notebookId);
        await requireActiveRun(runId, ['wait_source']);
    } catch (err) {
        if (err?.code === 'PIPELINE_STALE_RUN') return;
        // Transient network error -- log and retry next tick
        console.warn('[Tick] Could not list sources, will retry:', err.message);
        await transitionRun(runId, {
            stepDetail: `Waiting for ${ingestionLabel} (${Math.round(elapsed / 1000)}s, retrying...)`,
        }, { expectedSteps: ['wait_source'] });
        return;
    }

    const source = sources.find(s => String(s.id) === String(state.sourceId));
    const elapsedSec = Math.round(elapsed / 1000);

    if (!source) {
        await transitionRun(runId, {
            stepDetail: `Waiting for ${sourceLabel} to appear (${elapsedSec}s elapsed)...`,
        }, { expectedSteps: ['wait_source'] });
        return;
    }

    if (source.status === SourceStatus.ERROR) {
        if (canFallback(state)) {
            await fallbackPdf(runId);
            return;
        }
        await failPipeline(runId, `${sourceLabel} processing failed.`, state.notebookId);
        return;
    }

    if (source.status !== SourceStatus.READY) {
        await transitionRun(runId, {
            stepDetail: `${ingestionLabel} in progress (${elapsedSec}s elapsed)...`,
        }, { expectedSteps: ['wait_source'] });
        return;
    }

    if (state.sources) {
        const ready = await transitionRun(runId, current => ({ sources: current.sources.map((item, index) =>
            index === current.sourceIndex ? { ...item, status: 'ready', sourceId: current.sourceId } : item) }), { expectedSteps: ['wait_source'] });
        if (!ready) return;
        if (await advanceCombinedSource(runId)) return;
        state = await requireActiveRun(runId, ['wait_source']);
    }

    // Source is READY -- fetch notebook title, then trigger artifact generation
    console.log('[Tick] Source ready, triggering artifact generation');
    const claimed = await transitionRun(runId, {
        step: 'generate_artifacts',
        stepDetail: 'Source ready! Starting generation...',
    }, { expectedSteps: ['wait_source'] });
    if (!claimed) return;

    // Fetch the auto-generated notebook title and store it in state for display
    try {
        const title = await getNotebookTitle(state.notebookId);
        await requireActiveRun(runId, ['generate_artifacts']);
        if (title) {
            await transitionRun(runId, { notebookTitle: title }, { expectedSteps: ['generate_artifacts'] });
            console.log(`[Tick] Notebook title: ${title}`);
        }
    } catch (titleErr) {
        console.warn('[Tick] Could not fetch notebook title:', titleErr.message);
    }

    try {
        const settings = await getJobSettings(runId);
        await requireActiveRun(runId, ['generate_artifacts']);
        assertArtifactSelection(settings);

        if (settings.collectionId) {
            await transitionRun(runId, {
                stepDetail: 'Source ready! Adding notebook to collection...',
            }, { expectedSteps: ['generate_artifacts'] });
            try {
                await requireActiveRun(runId, ['generate_artifacts']);
                const collection = await addNotebookToCollection(settings.collectionId, state.notebookId);
                await requireActiveRun(runId, ['generate_artifacts']);
                await transitionRun(runId, {
                    collectionAssignment: {
                        collectionId: collection.id,
                        name: collection.name,
                        status: 'completed',
                    },
                }, { expectedSteps: ['generate_artifacts'] });
            } catch (collectionErr) {
                if (collectionErr?.code === 'PIPELINE_STALE_RUN') throw collectionErr;
                console.warn('[Pipeline] Could not add notebook to collection:', collectionErr.message);
                await transitionRun(runId, {
                    collectionAssignment: {
                        collectionId: settings.collectionId,
                        name: null,
                        status: 'failed',
                        error: collectionErr.message,
                    },
                }, { expectedSteps: ['generate_artifacts'] });
            }
        }

        const sourceIds = state.sources ? state.sources.filter(item => item.status === 'ready').map(item => item.sourceId) : [state.sourceId];
        const tasks = [];

        // Helper to run a generation function safely so one failure doesn't stop the pipeline
        const runTask = async (type, fn) => {
            await requireActiveRun(runId, ['generate_artifacts']);
            try {
                const res = await fn();
                await requireActiveRun(runId, ['generate_artifacts']);
                if (res?.status === 'completed') {
                    tasks.push({ type, taskId: res.taskId || null, status: 'completed' });
                } else if (res?.status === 'failed') {
                    tasks.push({ type, taskId: res.taskId || null, status: 'failed', error: res.error || 'Artifact generation failed' });
                } else {
                    if (!res?.taskId) throw new Error('API returned no task ID');
                    // Pending/unknown initial states are polled like in-progress tasks.
                    tasks.push({ type, taskId: res.taskId, status: 'in_progress' });
                }
            } catch (e) {
                if (e?.code === 'PIPELINE_STALE_RUN') throw e;
                console.warn(`[Pipeline] Failed to start ${type}:`, e.message);
                tasks.push({ type, taskId: null,
                    status: e?.code === 'TRANSIENT_MUTATION_UNCERTAIN' ? 'uncertain' : 'failed',
                    error: e.message, code: e?.code || null });
            }
            await transitionRun(runId, {
                tasks: [...tasks],
                stepDetail: `Started ${tasks.length} artifact request${tasks.length === 1 ? '' : 's'}...`,
            }, { expectedSteps: ['generate_artifacts'] });
        };

        const artifactRequests = [
            {
                enabled: settings.generateAudio !== false,
                type: 'audio',
                fn: () => generateAudio(
                    state.notebookId, sourceIds,
                    settings.language,
                    resolveAudioLength(settings.audioLength),
                    resolveAudioFormat(settings.audioFormat),
                    settings.audioPrompt || null
                ),
            },
            {
                enabled: !!settings.generateInfographic,
                type: 'infographic',
                fn: () => generateInfographic(
                    state.notebookId, sourceIds,
                    settings.language,
                    resolveInfographicOrientation(settings.infographicOrientation),
                    resolveInfographicDetail(settings.infographicDetail),
                    resolveInfographicStyle(settings.infographicNativeStyle),
                    buildInfographicInstructions(settings)
                ),
            },
            {
                enabled: !!settings.generateVideo,
                type: 'video',
                fn: () => generateVideo(
                    state.notebookId, sourceIds,
                    resolveVideoFormat(settings.videoFormat),
                    resolveVideoStyle(settings.videoStyle),
                    settings.videoPrompt || null,
                    settings.language,
                    settings.videoStylePrompt || null
                ),
            },
            {
                enabled: !!settings.generateReport,
                type: 'report',
                fn: () => generateReport(
                    state.notebookId, sourceIds,
                    resolveReportFormat(settings.reportFormat),
                    settings.reportPrompt || null,
                    settings.language
                ),
            },
            {
                enabled: !!settings.generateQuiz,
                type: 'quiz',
                fn: () => generateQuiz(
                    state.notebookId, sourceIds,
                    resolveQuizQuantity(settings.quizQuantity),
                    resolveQuizDifficulty(settings.quizDifficulty),
                    settings.quizPrompt || null
                ),
            },
            {
                enabled: !!settings.generateFlashcards,
                type: 'flashcards',
                fn: () => generateFlashcards(
                    state.notebookId, sourceIds,
                    resolveQuizQuantity(settings.flashcardsQuantity),
                    resolveQuizDifficulty(settings.flashcardsDifficulty),
                    settings.flashcardsPrompt || null
                ),
            },
            {
                enabled: !!settings.generateSlideDeck,
                type: 'slide_deck',
                fn: () => generateSlideDeck(
                    state.notebookId, sourceIds,
                    resolveSlideDeckFormat(settings.slideDeckFormat),
                    resolveSlideDeckLength(settings.slideDeckLength),
                    settings.slideDeckPrompt || null,
                    settings.language
                ),
            },
            {
                enabled: !!settings.generateMindMap,
                type: 'mind_map',
                fn: () => generateMindMap(state.notebookId, sourceIds),
            },
            {
                enabled: !!settings.generateDataTable,
                type: 'data_table',
                fn: () => generateDataTable(
                    state.notebookId, sourceIds,
                    settings.dataTablePrompt || null,
                    settings.language
                ),
            },
        ].filter(req => req.enabled);

        for (let i = 0; i < artifactRequests.length; i++) {
            const req = artifactRequests[i];
            await runTask(req.type, req.fn);
            // Pace generation starts to reduce NotebookLM rate-limit bursts.
            if (i < artifactRequests.length - 1) {
                await sleep(ARTIFACT_START_DELAY_MS);
                await requireActiveRun(runId, ['generate_artifacts']);
            }
        }

        const typeLabels = tasks.map(t => t.type).join(', ');
        await transitionRun(runId, {
            tasks,
            step: 'wait_artifacts',
            stepDetail: `Generating: ${typeLabels}...`,
            stepStartedAt: new Date().toISOString(),
        }, { expectedSteps: ['generate_artifacts'] });
    } catch (err) {
        if (err?.code === 'PIPELINE_STALE_RUN') return;
        await failPipeline(
            runId,
            `Failed to start artifact generation: ${err.message}`,
            state.notebookId
        );
    }
}

/**
 * One tick of the artifact-polling phase.
 * Polls all artifact tasks. Calls completePipeline() when all have settled.
 */
async function tickArtifactPoll(state) { return withJobOperation(state.runId, () => tickArtifactPollOperation(state)); }
async function tickArtifactPollOperation(state) {
    const runId = state.runId;
    await requireActiveRun(runId, ['wait_artifacts']);
    const tasks = state.tasks || [];
    if (tasks.length === 0) {
        await completePipeline(runId);
        return;
    }
    const ARTIFACT_TIMEOUT_MS = 1200000; // 20 minutes
    const elapsed = pollingElapsedMs(state.stepStartedAt);

    if (elapsed > ARTIFACT_TIMEOUT_MS) {
        await failPipeline(runId, 'Artifact generation timed out after 20 minutes.');
        return;
    }

    const updatedTasks = [...tasks];
    let statusByTaskId = new Map();

    try {
        statusByTaskId = await listArtifactStatuses(state.notebookId);
        await requireActiveRun(runId, ['wait_artifacts']);
    } catch (err) {
        if (err?.code === 'PIPELINE_STALE_RUN') return;
        console.warn('[Tick] Error listing artifact statuses:', err.message);
    }

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (task.status !== 'in_progress') continue;
        try {
            const s = statusByTaskId.get(String(task.taskId)) || { taskId: task.taskId, status: 'pending' };
            if (s.status === 'completed' || s.status === 'failed') {
                updatedTasks[i] = { ...task, status: s.status };
                console.log(`[Tick] ${task.type}: ${s.status}`);
            }
        } catch (err) {
            console.warn(`[Tick] Error polling ${task.type}:`, err.message);
        }
    }

    const elapsedMin = Math.round(elapsed / 60000);
    const summary = updatedTasks.map(t => `${t.type}: ${t.status}`).join(' | ');
    const updated = await transitionRun(runId, {
        tasks: updatedTasks,
        stepDetail: `${summary} (~${elapsedMin} min elapsed)`,
    }, { expectedSteps: ['wait_artifacts'] });
    if (!updated) return;

    const allDone = updatedTasks.every(t => t.status !== 'in_progress');
    if (allDone && updatedTasks.length > 0) {
        if (updatedTasks.some(t => t.status === 'uncertain')) {
            await failPipeline(runId, 'Uncertain artifact generation. Some requests may have been accepted. Check this notebook before starting again.');
            return;
        }
        const completedCount = updatedTasks.filter(t => t.status === 'completed').length;
        if (completedCount === 0) {
            await failPipeline(runId, 'All artifact generations failed. No artifacts were generated.');
            return;
        }
        await completePipeline(runId);
    }
}

// =========================================================================
// Alarm listener -- the heart of long-running polling
// =========================================================================

const runExclusivePollTick = createExclusiveRunner();

async function syncQueueRuntime() {
    const result = await pipelineState.transact(queue => ({ afterWrite: async () => {
        const active = queue.jobs.filter(isUnfinishedJob);
        if (active.some(job => job.status === 'running') || (!queue.paused && !queue.serviceBlock && active.length)) {
            await chrome.alarms.create(ALARM_NAME, { periodInMinutes: PIPELINE_POLL_PERIOD_MINUTES });
        } else {
            await chrome.alarms.clear(ALARM_NAME);
        }
        await setBadge(queue.serviceBlock ? '!' : active.length ? String(active.length) : queue.jobs.some(job => job.status === 'error') ? '!' : '', '#6b7a8d');
    } }));
    if (result.effectError) throw result.effectError;
}

let dispatching = false;
let dispatchAgain = false;
function kickQueue() {
    dispatchAgain = true;
    if (dispatching) return;
    dispatching = true;
    Promise.resolve().then(async () => {
        while (dispatchAgain) {
            dispatchAgain = false;
            await dispatchNextJob();
            await syncQueueRuntime();
        }
    }).catch(error => console.error('[Queue] Dispatch failed:', error))
        .finally(() => { dispatching = false; if (dispatchAgain) kickQueue(); });
}

async function dispatchNextJob() {
    const claimed = await pipelineState.transact(queue => {
        if (!canStartNextJob(queue)) return null;
        const job = queue.jobs.find(item => item.status === 'queued' || item.step === 'queued_pdf');
        if (!job) return null;
        const resume = job.step === 'queued_pdf';
        Object.assign(job, { status: 'running', step: resume ? 'wait_pdf_access' : 'auth',
            startedAt: job.startedAt || new Date().toISOString(), stepStartedAt: new Date().toISOString(), connectionError: null });
        return { state: job, resume };
    });
    if (!claimed.applied) return;
    const job = claimed.state;
    // A separate runtime lock also covers the brief wait_pdf_access resume claim.
    try {
        const file = job.payloadId ? await pdfStore.get(job.payloadId) : null;
        if (job.payloadId && !file) throw new Error('The saved PDF is unavailable. Select it again.');
        await requireActiveRun(job.runId);
        if (claimed.resume) await fallbackPdf(job.runId, { resume: true, file });
        else await runPipeline(job.runId, job.pdfUrl, job.pageUrl, file, job.sourceType, job.sourceTitle);
    } catch (error) {
        if (error?.code !== 'PIPELINE_STALE_RUN') await failPipeline(job.runId, error.message);
    } finally {
        const current = await getState(job.runId);
        if (!shouldRetainJobPdf(current)) {
            await releaseJobPdf(job.runId);
        }
        dispatchAgain = true;
    }
}

function shouldRetainJobPdf(job) {
    return ['queued', 'auth', 'create_notebook', 'add_source', 'download_pdf', 'upload_pdf', 'queued_pdf', 'wait_pdf_access']
        .includes(job?.step);
}

async function releaseJobPdf(runId) {
    const cleared = await pipelineState.transact(queue => {
        const job = queue.jobs.find(item => item.runId === runId);
        if (!job?.payloadId) return null;
        const payloadId = job.payloadId;
        Object.assign(job, { payloadId: null, payloadBytes: 0 });
        return { payloadId };
    });
    if (cleared.applied) await pdfStore.remove(cleared.payloadId);
}

async function handlePollAlarm(alarm) {
    if (alarm.name !== ALARM_NAME) return;
    try {
        await ensureBootReconciled();
        const ran = await runExclusivePollTick(async () => {
            const queue = await getQueue();
            // Different notebooks may be polled together. Only one can still be
            // preparing, so artifact-start mutations remain serialized.
            await Promise.allSettled(queue.jobs.filter(job => job.status === 'running').map(async state => {
                try {
                    if (state.step === 'wait_source') await tickSourcePoll(state);
                    else if (state.step === 'wait_artifacts') await tickArtifactPoll(state);
                } catch (error) {
                    if (error?.code === 'PIPELINE_STALE_RUN') console.log('[Alarm] Ignoring stale tick');
                    else console.error('[Alarm] Tick failed at ' + state.step, error);
                }
            }));
            kickQueue();
            await syncQueueRuntime();
        });
        if (!ran) console.warn('[Alarm] Previous poll tick is still running; skipping overlap');
    } catch (error) { console.error('[Alarm] Tick failed:', error); }
}

chrome.alarms.onAlarm.addListener(handlePollAlarm);

async function reconcilePipelineRuntime() {
    const settings = await getSettings();
    const attention = [];
    await pipelineState.transact(queue => {
        for (const job of queue.jobs) {
            job.settings ||= { ...settings };
            if (job.cleanupStatus === 'deleting') job.cleanupStatus = 'unknown';
            const action = runtimeRecoveryAction(job, false);
            if (action === 'wait_pdf_access') {
                if (job.step !== 'wait_pdf_access') {
                    Object.assign(job, { step: 'wait_pdf_access', attentionSince: new Date().toISOString(),
                        pdfWaitReason: 'download', stepDetail: 'PDF download was paused. Open the popup to resume or select a PDF.' });
                }
                if (!job.attentionNotified) {
                    job.attentionNotified = true;
                    attention.push(job.runId);
                }
            } else if (action === 'interrupt' && job.step !== 'queued_pdf') {
                Object.assign(job, interruptedPipelineUpdate(job));
            }
            if (!isUnfinishedJob(job)) Object.assign(job, { payloadId: null, payloadBytes: 0 });
        }
        return {};
    });
    const queue = await getQueue();
    await pdfStore.prune(queue.jobs.filter(job => isUnfinishedJob(job)).map(job => job.payloadId).filter(Boolean));
    for (const job of queue.jobs.filter(item => item.status === 'stopping')) await finishCancellation(job.runId);
    for (const job of queue.jobs.filter(item => item.status === 'stopped' && item.cancelIntent === 'delete' && item.notebookId && !item.cleanupStatus)) await deleteCancelledNotebook(job.runId).catch(() => {});
    await chrome.storage.local.remove('pipelineState');
    await syncQueueRuntime();
    for (const runId of attention) {
        const state = await getState(runId);
        if (state.status === 'running' && state.step === 'wait_pdf_access') await notifyJobAttention(state, state.stepDetail);
    }
}

const fallbackPdf = (runId, options) => withJobOperation(runId, () => fallbackPdfOperation(runId, options));
const fallbackPdfOperation = createPdfFallback({
    getState,
    transition: transitionRun,
    download: downloadRemotePdfForUpload,
    upload: (notebookId, file) => addFileSource(notebookId, file.filename, file.fileData, file.mimeType),
    poll: () => chrome.alarms.create(ALARM_NAME, { periodInMinutes: PIPELINE_POLL_PERIOD_MINUTES }),
    fail: failPipeline,
    notify: state => notifyJobAttention(state, state.stepDetail),
});

async function resumePdfFallback(message) {
    await ensureBootReconciled();
    let file = null;
    if (message.fileDataBase64) file = decodeQueuedPdf(message.fileDataBase64, message.fileName);
    const payloadId = file ? crypto.randomUUID() : null;
    let result;
    try {
        result = await pipelineState.transact(async queue => {
            const job = queue.jobs.find(item => item.runId === message.runId);
            if (job?.status !== 'running' || job.step !== 'wait_pdf_access') return null;
            if (file) {
                assertQueuePdfBudget(queue, file.fileData.byteLength);
                await pdfStore.put(payloadId, file);
            }
            Object.assign(job, { step: 'queued_pdf', ...(file ? { payloadId, payloadBytes: file.fileData.byteLength } : {}) });
            return { state: job };
        });
    } catch (error) {
        const saved = (await getQueue()).jobs.find(job => job.runId === message.runId && job.step === 'queued_pdf' && (!file || job.payloadId === payloadId));
        if (saved) result = { applied: true, state: saved };
        else {
            if (file) await pdfStore.remove(payloadId);
            throw error;
        }
    }
    if (!result.applied) return { ok: false, message: 'This job has already advanced. Refresh the queue.' };
    kickQueue();
    return { ok: true, state: result.state };
}

async function runBootReconciliation() {
    try {
        await reconcilePipelineRuntime();
        kickQueue();
        return true;
    } catch (error) {
        console.error('[Recovery] Initial reconciliation failed:', error);
        return false;
    }
}

let bootReconciliationPromise = runBootReconciliation();
let bootRetryPromise = null;

async function ensureBootReconciled() {
    if (await bootReconciliationPromise) return;
    const retry = bootRetryPromise || (bootRetryPromise = runBootReconciliation()
        .then(succeeded => {
            if (succeeded) bootReconciliationPromise = Promise.resolve(true);
            return succeeded;
        })
        .finally(() => { bootRetryPromise = null; }));
    if (!await retry) {
        throw new Error('ScholarRelay could not restore its saved queue. Try again in a moment.');
    }
}

// =========================================================================
// Pipeline orchestration (steps 1-3: synchronous network calls)
// =========================================================================

async function runPipeline(runId, ...args) { return withJobOperation(runId, () => runPipelineOperation(runId, ...args)); }
async function runPipelineOperation(runId, pdfUrl, pageUrl, uploadFile = null, sourceType = 'pdf', sourceTitle = null) {
    const effectiveSourceType = uploadFile ? 'pdf' : (sourceType || 'pdf');
    const sourceLabel = getSourceLabel(effectiveSourceType);
    const ingestionLabel = getIngestionLabel(effectiveSourceType);
    const detectedTitle = normalizeSourceTitle(sourceTitle);
    console.log(`[Pipeline] Starting for ${sourceLabel}: ${pdfUrl}`);

    let notebookId = null;
    let sourceMutationStarted = false;

    try {
        // Step 1: Authenticate
        await requireActiveRun(runId, ['auth']);
        await fetchTokens();
        await requireActiveRun(runId, ['auth']);
        const creating = await transitionRun(runId, {
            step: 'create_notebook',
            stepDetail: 'Creating notebook...',
        }, { expectedSteps: ['auth'] });
        if (!creating) return;

        // Step 2: Create notebook
        const settings = await getJobSettings(runId);
        const requestedNotebookTitle = (await getState(runId)).sources || settings.useSourceTitleForNotebook !== false ? detectedTitle : '';
        await requireActiveRun(runId, ['create_notebook']);
        const notebook = await createNotebook(requestedNotebookTitle);
        if (!notebook.id) throw new Error('Failed to create notebook -- no ID returned');
        notebookId = notebook.id;
        await pipelineState.transact(queue => {
            const job = queue.jobs.find(item => item.runId === runId);
            if (!job || !['running', 'stopping'].includes(job.status)) return null;
            Object.assign(job, { notebookId: notebook.id, notebookUrl: getNotebookUrl(notebook.id) });
            return {};
        });
        await requireActiveRun(runId, ['create_notebook']);

        const notebookUrl = getNotebookUrl(notebook.id);
        const sourceStepDetail = uploadFile
            ? `Uploading local PDF: ${uploadFile.filename}`
            : `Adding ${sourceLabel}: ${pdfUrl.substring(0, 60)}...`;

        const adding = await transitionRun(runId, {
            notebookId: notebook.id,
            notebookUrl,
            step: 'add_source',
            stepDetail: sourceStepDetail,
        }, { expectedSteps: ['create_notebook'] });
        if (!adding) return;

        // Step 3: Add source
        let source = null;
        if (uploadFile) {
            assertPdfUploadSize(typeof uploadFile.fileData === 'string' ? decodedBase64ByteLength(uploadFile.fileData) : uploadFile.fileData.byteLength);
            await requireActiveRun(runId, ['add_source']);
            sourceMutationStarted = true;
            source = await addFileSource(
                notebook.id,
                uploadFile.filename,
                uploadFile.fileData,
                uploadFile.mimeType || 'application/pdf'
            );
        } else {
            if (typeof pdfUrl === 'string' && pdfUrl.startsWith('file://')) {
                throw new Error('Local PDF detected. Use local upload mode instead of URL mode.');
            }
            try {
                await requireActiveRun(runId, ['add_source']);
                sourceMutationStarted = true;
                source = await addUrlSource(notebook.id, pdfUrl);
            } catch (urlErr) {
                if (isConfirmedImportRejection(urlErr) && canFallback(await getState(runId))) {
                    await fallbackPdf(runId);
                    return;
                }
                throw urlErr;
            }
        }

        if (!source.id) throw new Error('Failed to add source -- no ID returned');
        await requireActiveRun(runId, ['add_source']);

        // Step 4: Hand off to alarm-based polling.
        // The service worker is free to be suspended between alarm ticks.
        // All state needed for polling is now in chrome.storage.local.
        const polling = await transitionRun(runId, {
            sourceId: source.id,
            step: 'wait_source',
            stepDetail: `Waiting for ${ingestionLabel} (checking every ~30s)...`,
            stepStartedAt: new Date().toISOString(),
        }, {
            expectedSteps: ['add_source'],
            afterWrite: async () => {
                await chrome.alarms.create(ALARM_NAME, {
                    periodInMinutes: PIPELINE_POLL_PERIOD_MINUTES,
                });
            },
        });
        if (!polling) return;
        console.log('[Pipeline] Alarm-based polling started (30 s interval)');

    } catch (err) {
        if (err?.code === 'PIPELINE_STALE_RUN') {
            console.log(`[Pipeline] Ignoring stale run ${runId}`);
            return;
        }
        if (!notebookId && !sourceMutationStarted && await holdForSession(runId, err)) return;
        console.error('[Pipeline] Setup error:', err);
        await failPipeline(runId, err, notebookId);
    }
}

// =========================================================================
// Message handlers (from popup and content script)
// =========================================================================

function assertArtifactSelection(settings) {
    if (settings.generateAudio !== false || [
        'generateInfographic', 'generateVideo', 'generateReport', 'generateQuiz',
        'generateFlashcards', 'generateSlideDeck', 'generateMindMap', 'generateDataTable',
    ].some(key => !!settings[key])) return;
    const error = new Error('Select at least one artifact before starting.');
    error.code = 'NO_ARTIFACT_SELECTED';
    throw error;
}

function decodeQueuedPdf(base64, filename) {
    assertPdfUploadSize(decodedBase64ByteLength(base64));
    if (!hasBase64PdfSignature(base64)) throw new Error('The selected file does not contain a PDF signature.');
    const payload = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
    const binary = atob(payload.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { filename: filename || 'paper.pdf', fileData: bytes.buffer, mimeType: 'application/pdf' };
}

function assertQueuePdfBudget(queue, bytes) {
    const storedBytes = queue.jobs.reduce((sum, job) => sum + (job.payloadBytes || 0), 0);
    if (storedBytes + bytes > MAX_QUEUED_PDF_BYTES) throw new Error('Queued PDFs exceed the 100 MiB storage limit. Remove a queued PDF or wait for an upload.');
}

function validateCombinedSources(value) {
    if (value == null) return null;
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('Select between 1 and 20 sources.');
    const seen = new Set();
    return value.map(item => {
        const url = new URL(item.pdfUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid source URL');
        if (seen.has(url.href)) throw new Error('The same source was selected twice.');
        seen.add(url.href);
        return { pdfUrl: url.href, pageUrl: item.pageUrl || url.href, sourceType: item.sourceType === 'webpage' ? 'webpage' : 'pdf',
            sourceTitle: normalizeSourceTitle(item.sourceTitle), pdfEvidence: item.pdfEvidence || null, status: 'queued' };
    });
}
async function advanceCombinedSource(runId) {
    const state = await requireActiveRun(runId);
    const nextIndex = state.sources.findIndex(item => item.status === 'queued');
    if (nextIndex < 0) return false;
    const source = state.sources[nextIndex];
    const claimed = await transitionRun(runId, { sourceIndex: nextIndex, pdfUrl: source.pdfUrl,
        originalPdfUrl: source.pdfUrl, sourceType: source.sourceType, pdfEvidence: source.pdfEvidence,
        importMethod: 'url', fallbackAttempted: false, fallbackUploadStarted: false, failedUrlSourceId: null,
        sourceId: null, step: 'add_source', stepDetail: 'Adding selected source...',
        sources: state.sources.map((item, index) => index === nextIndex ? { ...item, status: 'importing' } : item) });
    if (!claimed) return true;
    try {
        await requireActiveRun(runId, ['add_source']);
        const result = await addUrlSource(state.notebookId, source.pdfUrl);
        if (!result?.id) throw new Error('Source result needs checking.');
        await transitionRun(runId, { sourceId: result.id, step: 'wait_source', stepStartedAt: new Date().toISOString() }, { expectedSteps: ['add_source'] });
    } catch (error) {
        if (isConfirmedImportRejection(error) && canFallback(await getState(runId))) await fallbackPdf(runId);
        else await failPipeline(runId, error, state.notebookId);
    }
    return true;
}
async function continueCombinedSources(runId, expectedIndex = null) {
    await ensureBootReconciled();
    return withJobOperation(runId, async () => {
        const state = await requireActiveRun(runId, ['wait_source_choice', 'wait_pdf_access']);
        if (!state.sources) throw new Error('This is not a combined notebook.');
        if (expectedIndex != null && expectedIndex !== state.sourceIndex) throw new Error('The selected source has changed. Refresh the job.');
        const changed = await transitionRun(runId, current => ({ step: 'wait_source',
            sources: current.sources.map((item, index) => index === current.sourceIndex ? { ...item, status: 'skipped' } : item)
        }), { expectedSteps: ['wait_source_choice', 'wait_pdf_access'] });
        if (!changed) return { ok: false };
        if (await advanceCombinedSource(runId)) return { ok: true };
        const latest = await getState(runId);
        const ready = latest.sources.filter(item => item.status === 'ready');
        if (!ready.length) { await transitionRun(runId, { status: 'error', step: 'error', error: 'No selected source is ready.', completedAt: new Date().toISOString() }); return { ok: true }; }
        await transitionRun(runId, { sourceIndex: latest.sources.length, sourceId: ready[0].sourceId, step: 'wait_source', stepStartedAt: new Date().toISOString() });
        await tickSourcePoll(await getState(runId));
        return { ok: true };
    });
}

async function startPipelineRequest(message, uploadFile = null) {
    await ensureBootReconciled();
    const settings = { ...DEFAULT_SETTINGS, ...(message.settings || await getSettings()) };
    assertArtifactSelection(settings);
    const sources = validateCombinedSources(message.sources);
    if (sources) message = { ...message, ...sources[0], sourceTitle: normalizeSourceTitle(message.notebookTitle) || normalizeSourceTitle(message.sourceTitle) };
    let file = null;
    let sourceKey;
    if (uploadFile) {
        file = decodeQueuedPdf(uploadFile.fileData, uploadFile.filename);
        const digest = await crypto.subtle.digest('SHA-256', file.fileData);
        sourceKey = 'file:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    } else {
        const url = new URL(message.pdfUrl);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Use a webpage URL or upload a local PDF.');
        url.hash = '';
        sourceKey = sources ? 'combined:' + JSON.stringify(sources.map(item => item.pdfUrl)) : url.href;
    }
    const runId = crypto.randomUUID();
    let result;
    try {
        result = await pipelineState.transact(async queue => {
            const duplicate = queue.jobs.find(job => (message.requestId && job.requestId === message.requestId) ||
                (isUnfinishedJob(job) && job.sourceKey === sourceKey));
            if (duplicate) return { state: duplicate, duplicate: true };
            if (queue.jobs.filter(isUnfinishedJob).length >= MAX_QUEUED_JOBS) throw new Error('The queue is full. Wait for a job to finish or remove a queued paper.');
            await chrome.alarms.create(ALARM_NAME, { periodInMinutes: PIPELINE_POLL_PERIOD_MINUTES });
            if (file) {
                assertQueuePdfBudget(queue, file.fileData.byteLength);
                await pdfStore.put(runId, file);
            }
            const job = {
                ...INITIAL_STATE, sources, sourceIndex: 0, status: 'queued', runId, requestId: message.requestId || runId,
                step: 'queued', queuedAt: new Date().toISOString(), settings,
                pdfUrl: file ? file.filename : message.pdfUrl,
                sourceType: file ? 'pdf' : (message.sourceType || 'pdf'),
                pageUrl: message.pageUrl || null, sourceTitle: normalizeSourceTitle(message.sourceTitle) || null,
                sourceKey, importMethod: file ? 'file' : 'url', originalPdfUrl: file ? null : message.pdfUrl,
                pdfEvidence: message.pdfEvidence || null,
                payloadId: file ? runId : null, payloadBytes: file?.fileData.byteLength || 0,
            };
            queue.jobs.push(job);
            return { state: job };
        });
    } catch (error) {
        const saved = (await getQueue()).jobs.find(job => job.runId === runId);
        if (saved) result = { state: saved };
        else {
            if (file) await pdfStore.remove(runId);
            throw error;
        }
    }
    // Persist the wakeup before acknowledging. A lost reply can be reconciled by
    // request ID or the active source key without repeating notebook creation.
    await syncQueueRuntime();
    kickQueue();
    return { ok: true, runId: result.state.runId, duplicate: !!result.duplicate, message: 'Paper saved in queue' };
}

async function stopPipelineRequest(requestedRunId, intent = null) {
    await ensureBootReconciled();
    if (intent && !['keep', 'delete'].includes(intent)) throw new Error('Invalid cancellation choice');
    const result = await pipelineState.transact(queue => {
        const job = queue.jobs.find(item => item.runId === requestedRunId);
        if (!job) return null;
        if (job.status === 'stopping' || job.status === 'stopped') return { state: job };
        if (job.status === 'queued' && !job.notebookId) {
            Object.assign(job, { status: 'stopped', step: 'stopped', completedAt: new Date().toISOString() });
            return { state: job, removeQueued: true };
        }
        if (job.status !== 'running') return null;
        if (!intent) return { needsChoice: true, state: job };
        Object.assign(job, { status: 'stopping', cancelIntent: intent, cancelledStep: job.step,
            cancelRequestedAt: new Date().toISOString() });
        return { state: job };
    });
    if (!result.applied) return { ok: false, message: 'This job has already finished. Refresh the queue.' };
    if (result.needsChoice) return { ok: false, code: 'CANCEL_CHOICE_REQUIRED' };
    if (result.state.status === 'stopped') await releaseJobPdf(requestedRunId);
    if (result.removeQueued) {
        await pipelineState.transact(queue => { queue.jobs = queue.jobs.filter(job => job.runId !== requestedRunId); return {}; });
    }
    await finishCancellation(requestedRunId);
    kickQueue();
    return { ok: true, state: await getState(requestedRunId) };
}

function cleanupSnapshot(sources, artifacts) {
    return JSON.stringify({
        sources: sources.map(source => [source.id, source.status]).sort((a, b) => a[0].localeCompare(b[0])),
        artifacts: [...artifacts.values()].map(artifact => [artifact.taskId, artifact.status]).sort((a, b) => a[0].localeCompare(b[0])),
    });
}

async function inspectNotebookCleanup(runId) {
    await ensureBootReconciled();
    const queue = await getQueue();
    const job = queue.jobs.find(item => item.runId === runId);
    if (!job || !['error', 'stopped'].includes(job.status) || !job.notebookId || job.notebookDeletedAt) {
        throw new Error('This job does not have a removable ScholarRelay notebook.');
    }
    if (queue.jobs.some(item => item.runId !== runId && item.notebookId === job.notebookId && !item.notebookDeletedAt)) {
        throw new Error('Another saved job references this notebook. Open it and review it manually.');
    }
    const [sources, artifacts] = await Promise.all([listSources(job.notebookId), listArtifactStatuses(job.notebookId)]);
    const statuses = [...artifacts.values()].map(artifact => artifact.status);
    if (statuses.some(status => ['completed', 'in_progress', 'pending', 'pending_review', 'unknown'].includes(status))) {
        throw new Error('This notebook has completed or possibly active work. Open it and review it manually.');
    }
    return {
        ok: true,
        runId,
        notebookId: job.notebookId,
        notebookTitle: job.notebookTitle || job.sourceTitle || '',
        sourceCount: sources.length,
        failedArtifactCount: statuses.filter(status => status === 'failed').length,
        snapshot: cleanupSnapshot(sources, artifacts),
    };
}

async function deleteJobNotebook(message) {
    const inspected = await inspectNotebookCleanup(message.runId);
    if (!message.snapshot || message.snapshot !== inspected.snapshot) {
        throw new Error('The notebook changed after confirmation. Review it before deleting.');
    }
    try {
        await deleteNotebook(inspected.notebookId);
    } catch (error) {
        await pipelineState.transact(queue => {
            const job = queue.jobs.find(item => item.runId === message.runId && item.notebookId === inspected.notebookId);
            if (!job) return null;
            job.cleanupStatus = error?.code === 'TRANSIENT_MUTATION_UNCERTAIN' ? 'unknown' : 'failed';
            job.cleanupError = error?.message || 'Notebook deletion could not be confirmed.';
            return {};
        });
        throw error;
    }
    await pipelineState.transact(queue => {
        const job = queue.jobs.find(item => item.runId === message.runId && item.notebookId === inspected.notebookId);
        if (!job) return null;
        Object.assign(job, { notebookDeletedAt: new Date().toISOString(), cleanupStatus: 'deleted', notebookUrl: null });
        return {};
    });
    return { ok: true };
}

async function clearFinishedJobs() {
    await ensureBootReconciled();
    await pipelineState.transact(queue => {
        queue.jobs = queue.jobs.filter(job => isUnfinishedJob(job) || ['deleting', 'unknown'].includes(job.cleanupStatus));
        return {};
    });
    await syncQueueRuntime();
    return { ok: true };
}

async function setPaperIcon(tabId, count) {
    const image = await createImageBitmap(await (await fetch(chrome.runtime.getURL('icons/icon48.png'))).blob());
    const imageData = {};
    for (const size of [16, 20, 24, 32]) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, size, size);
        if (count) {
            const scale = size / 16;
            ctx.scale(scale, scale);
            ctx.fillStyle = '#176bd6'; ctx.fillRect(0, 0, 9, 8);
            ctx.fillStyle = 'white'; ctx.font = 'bold 7px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(count > 9 ? '9+' : String(count), 4.5, 6.5);
        }
        imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    image.close();
    await chrome.action.setIcon({ tabId, imageData });
    const active = (await getQueue()).jobs.filter(isUnfinishedJob).length;
    await chrome.action.setTitle({ tabId, title: count == null ? 'ScholarRelay' : (count === 1 ? t('One paper candidate on this page') : t('$1 paper candidates on this page', [count])) + ' · ' + t('Paper queue') + ' ' + active });
}
async function scanGrantedTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/.test(tab.url || '')) return;
    const origin = new URL(tab.url).origin + '/*';
    const allowed = (await chrome.storage.local.get('paperDetectionOrigins')).paperDetectionOrigins || [];
    if (!allowed.includes(origin) || !await chrome.permissions.contains({ origins: [origin] })) return;
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: inspectPaperPage, args: [null, null, true, true] });
    const current = await chrome.tabs.get(tabId);
    if (current.url === tab.url) await setPaperIcon(tabId, results[0]?.result?.candidates?.length || 0);
}
chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (change.url) setPaperIcon(tabId, null).catch(() => {});
    if (change.status === 'complete' || change.url) scanGrantedTab(tabId).catch(() => {});
});
chrome.tabs.onActivated?.addListener(({ tabId }) => scanGrantedTab(tabId).catch(() => {}));
chrome.permissions?.onRemoved?.addListener(() => chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.map(tab => setPaperIcon(tab.id, null)))));
async function paperTitles(ids) {
    if (!await chrome.permissions.contains({ origins: ['https://arxiv.org/*'] })) return {};
    const queue = [...new Set(ids || [])].filter(id => typeof id === 'string' && /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(id)).slice(0, 10);
    const cache = (await chrome.storage.local.get('paperTitleCache')).paperTitleCache || {};
    const titles = {};
    const task = async () => {
        while (queue.length) {
            const id = queue.shift();
            if (cache[id]?.expires > Date.now()) { titles[id] = cache[id].title; continue; }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch('https://arxiv.org/abs/' + id, { signal: controller.signal, credentials: 'omit' });
                if (!response.ok) continue;
                const reader = response.body.getReader();
                const decoder = new TextDecoder(); let bytes = 0, html = '';
                try { while (bytes < 524288) { const chunk = await reader.read(); if (chunk.done) break; const part = chunk.value.subarray(0, 524288 - bytes); bytes += part.length; html += decoder.decode(part, { stream: true }); } }
                finally { await reader.cancel(); }
                const tag = html.match(/<meta\b[^>]*name=["']citation_title["'][^>]*>/i)?.[0];
                const title = tag?.match(/content=(["'])([\s\S]*?)\1/i)?.[2]?.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim().slice(0, 300);
                if (title) { titles[id] = title; cache[id] = { title, expires: Date.now() + 86400000 }; }
            } catch { /* A title failure does not block selection or import. */ }
            finally { clearTimeout(timer); }
        }
    };
    await Promise.all([task(), task()]);
    await chrome.storage.local.set({ paperTitleCache: Object.fromEntries(Object.entries(cache).filter(([,value]) => value.expires > Date.now()).slice(-100)) });
    return titles;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PAPER_TITLES') { paperTitles(message.ids).then(titles => sendResponse({ titles })).catch(() => sendResponse({ titles: {} })); return true; }
    if (message.type === 'ENABLE_PAPER_DETECTION') {
        (async () => {
            const tab = await chrome.tabs.get(message.tabId);
            const origin = new URL(tab.url).origin + '/*';
            if (origin !== message.origin || !await chrome.permissions.contains({ origins: [origin] })) throw new Error('Site access is required.');
            const origins = (await chrome.storage.local.get('paperDetectionOrigins')).paperDetectionOrigins || [];
            await chrome.storage.local.set({ paperDetectionOrigins: [...new Set([...origins, origin])] });
            await scanGrantedTab(tab.id); return { ok: true };
        })().then(sendResponse).catch(error => sendResponse({ ok: false, message: error.message })); return true;
    }
    if (message.type === 'DELETE_JOB_NOTEBOOK_EXPLICIT') {
        ensureBootReconciled().then(() => deleteCancelledNotebook(message.runId)).then(sendResponse)
            .catch(error => sendResponse({ ok: false, message: error.message }));
        return true;
    }
    if (message.type === 'CONTINUE_COMBINED_SOURCES') {
        continueCombinedSources(message.runId, message.sourceIndex).then(sendResponse).catch(error => sendResponse({ ok: false, message: error.message }));
        return true;
    }
    if (message.type === 'RESUME_SERVICE') {
        resumeServiceBlock(message.blockId).then(sendResponse)
            .catch(error => sendResponse({ ok: false, message: error.message }));
        return true;
    }

    if (message.type === 'RESUME_PDF_FALLBACK') {
        resumePdfFallback(message).then(sendResponse)
            .catch(error => sendResponse({ ok: false, code: error.code, message: error.message }));
        return true;
    }

    if (message.type === 'START_PIPELINE') {
        startPipelineRequest(message)
            .then(sendResponse)
            .catch(error => sendResponse({ ok: false, code: error?.code, message: error?.message || 'Could not start pipeline' }));
        return true;
    }

    if (message.type === 'START_PIPELINE_FILE') {
        if (!message.fileDataBase64 || !message.fileName) {
            sendResponse({ ok: false, message: 'Missing file payload or filename' });
            return false;
        }
        startPipelineRequest(message, {
                filename: message.fileName || 'local-upload.pdf',
                mimeType: message.mimeType || 'application/pdf',
                fileData: message.fileDataBase64,
            })
            .then(sendResponse)
            .catch(error => sendResponse({ ok: false, code: error?.code, message: error?.message || 'Could not start file pipeline' }));
        return true;
    }

    if (message.type === 'GET_QUEUE') {
        ensureBootReconciled().then(getQueue).then(sendResponse)
            .catch(error => sendResponse({ error: error.message }));
        return true;
    }
    if (message.type === 'PAUSE_QUEUE') {
        ensureBootReconciled().then(() => pipelineState.transact(queue => {
            queue.paused = !!message.paused;
            return {};
        })).then(async () => { await syncQueueRuntime(); kickQueue(); sendResponse({ ok: true }); })
            .catch(error => sendResponse({ ok: false, message: error.message }));
        return true;
    }
    if (message.type === 'GET_STATE') {
        ensureBootReconciled().then(() => getState(message.runId)).then(sendResponse)
            .catch(error => sendResponse({ ok: false, message: error?.message || 'Could not load pipeline state' }));
        return true;
    }

    if (message.type === 'LIST_COLLECTIONS') {
        ensureBootReconciled().then(() => listCollections())
            .then(collections => sendResponse({ ok: true, collections }))
            .catch(error => sendResponse({
                ok: false,
                collections: [],
                message: error?.message || 'Could not load Gemini Notebook collections',
            }));
        return true;
    }

    if (message.type === 'RESET_STATE') {
        clearFinishedJobs().then(sendResponse)
            .catch(error => sendResponse({ ok: false, message: error.message }));
        return true;
    }

    if (message.type === 'ABORT_PIPELINE') {
        stopPipelineRequest(message.runId, message.intent).then(sendResponse)
            .catch(error => sendResponse({ ok: false, message: error?.message || 'Could not stop monitoring' }));
        return true;
    }

    if (message.type === 'CHECK_NOTEBOOK_CLEANUP') {
        inspectNotebookCleanup(message.runId).then(sendResponse)
            .catch(error => sendResponse({ ok: false, code: error?.code, message: error?.message || 'Could not inspect this notebook.' }));
        return true;
    }

    if (message.type === 'DELETE_JOB_NOTEBOOK') {
        deleteJobNotebook(message).then(sendResponse)
            .catch(error => sendResponse({ ok: false, code: error?.code, message: error?.message || 'Could not confirm notebook deletion.' }));
        return true;
    }

    if (message.type === 'DETECT_PDF') {
        const detectedPdf = bindDetectionToTab(message.data, sender.tab);
        if (!detectedPdf) {
            sendResponse({ ok: false, message: 'Detection was not associated with a browser tab.' });
            return false;
        }
        (async () => {
            const tab = await chrome.tabs.get(sender.tab.id);
            if (tab.url !== detectedPdf.pageUrl) return { ok: false };
            if (message.automatic && !await chrome.permissions.contains({ origins: [new URL(tab.url).origin + '/*'] })) return { ok: false, observationAllowed: false };
            await chrome.storage.local.set({ detectedPdf });
            await setPaperIcon(tab.id, detectedPdf.candidates?.length || 0).catch(() => {});
            return { ok: true };
        })().then(sendResponse)
            .catch(error => sendResponse({ ok: false, message: error?.message || 'Could not save PDF detection' }));
        return true;
    }
});

// =========================================================================
// Notification handlers
// =========================================================================

function safeNotificationTarget(value) {
    try {
        const url = new URL(value);
        const popup = new URL(chrome.runtime.getURL('popup.html'));
        if (url.protocol === popup.protocol && url.host === popup.host && url.pathname === popup.pathname) return url.href;
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
            ['notebook.google.com', 'notebooklm.google.com'].includes(url.hostname) &&
            /^\/notebook\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return url.href;
    } catch (_) { /* Discard invalid or unrelated persisted targets. */ }
    return null;
}

function isJobNotification(id) {
    return /^(pipeline-complete|pipeline-error):/.test(id);
}

async function handleNotification(id, open = true) {
    if (!isJobNotification(id)) return;
    try {
        const saved = await takeNotificationTarget(id);
        const target = safeNotificationTarget(saved) ||
            (id.startsWith('pipeline-error:') ? jobDetailsUrl(id.slice('pipeline-error:'.length)) : null);
        if (open && target) await chrome.tabs.create({ url: target });
        await chrome.notifications.clear(id);
    } catch (error) { console.warn('[Notification] Could not handle job notification:', error); }
}

chrome.notifications.onClicked.addListener(id => handleNotification(id));
chrome.notifications.onButtonClicked.addListener((id, index) => handleNotification(id, index === 0));
chrome.notifications.onClosed.addListener(id => {
    if (isJobNotification(id)) {
        takeNotificationTarget(id).catch(error => console.warn('[Notification] Could not clear target:', error));
    }
});

console.log('[ScholarRelay] Service worker loaded');
