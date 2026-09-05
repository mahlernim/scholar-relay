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

import { t, errorSummary } from './i18n.js';
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
    createPipelineStateCoordinator,
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

async function getState() {
    const result = await chrome.storage.local.get('pipelineState');
    return result.pipelineState || { ...INITIAL_STATE };
}

const pipelineState = createPipelineStateCoordinator({
    readState: getState,
    writeState: state => chrome.storage.local.set({ pipelineState: state }),
});

async function setState(updates) {
    return (await pipelineState.update(updates)).state;
}

async function resetState(options = {}) {
    const result = await pipelineState.reset({ ...INITIAL_STATE }, options);
    return result.applied ? result.state : null;
}

async function transitionRun(runId, updates, options = {}) {
    const result = await pipelineState.transition(runId, updates, options);
    if (result.effectError) throw result.effectError;
    return result.applied ? result.state : null;
}

async function requireActiveRun(runId, expectedSteps = null) {
    const state = await getState();
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

    const response = await fetch(pdfUrl, {
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

const DEFAULT_SETTINGS = {
    // Audio
    generateAudio: true,
    audioFormat: 'deep_dive',   // 'deep_dive'|'brief'|'critique'|'debate'
    audioLength: 'long',        // 'short'|'default'|'long'
    language: 'en',
    audioPrompt: '',
    // Video
    generateVideo: false,
    videoFormat: 'explainer',   // 'explainer'|'brief'
    videoStyle: 'auto',        // 'auto'|'custom'|'classic'|'whiteboard'|'kawaii'|'anime'|'watercolor'|'retro_print'|'heritage'|'paper_craft'
    videoPrompt: '',
    videoStylePrompt: '',
    // Report
    generateReport: false,
    reportFormat: 'study_guide', // 'briefing_doc'|'study_guide'|'blog_post'|'custom'
    reportPrompt: '',
    // Quiz
    generateQuiz: false,
    quizQuantity: 'standard',    // 'fewer'|'standard'|'more'
    quizDifficulty: 'medium',      // 'easy'|'medium'|'hard'
    quizPrompt: '',
    // Flashcards
    generateFlashcards: false,
    flashcardsQuantity: 'standard',
    flashcardsDifficulty: 'medium',
    flashcardsPrompt: '',
    // Infographic
    generateInfographic: true,
    infographicOrientation: 'landscape', // 'landscape'|'portrait'|'square'
    infographicDetail: 'standard',       // 'concise'|'standard'|'detailed'
    infographicStylePreset: 'auto',
    infographicNativeStyle: 'auto',
    infographicPrompt: '',
    // Slide deck
    generateSlideDeck: false,
    slideDeckFormat: 'detailed_deck',   // 'detailed_deck'|'presenter_slides'
    slideDeckLength: 'default',         // 'default'|'short'
    slideDeckPrompt: '',
    // Mind map
    generateMindMap: false,
    // Data table
    generateDataTable: false,
    dataTablePrompt: '',
    // UX
    notificationEnabled: true,
    chimeEnabled: true,
    autoOpenNotebook: false,
    useSourceTitleForNotebook: true,
    collectionId: '',
};

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
    const settings = await getSettings();
    const state = await getState();
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
        afterWrite: async () => {
            try { await chrome.alarms.clear(ALARM_NAME); }
            catch (error) { console.warn('[Alarm] Could not clear completion alarm:', error); }
        },
    });
    if (!completedState) return;
    setBadge('\u2713', '#0fad6e').catch(error => console.warn('[Badge] Completion badge failed:', error));

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

async function failPipeline(runId, errorMsg, notebookId = null, canDeleteBlankNotebook = false) {
    await requireActiveRun(runId);
    let cleanupMessage = '';
    if (notebookId && canDeleteBlankNotebook) {
        try {
            await deleteNotebook(notebookId);
            cleanupMessage = ' Blank notebook was deleted automatically.';
        } catch (cleanupErr) {
            cleanupMessage = ' Failed to delete blank notebook automatically.';
            console.warn('[Pipeline] Failed to delete blank notebook:', cleanupErr?.message);
        }
    }

    const finalError = `${errorMsg}${cleanupMessage}`.trim();
    const failedState = await transitionRun(runId, {
        status: 'error',
        step: 'error',
        stepDetail: finalError,
        error: finalError,
    }, {
        afterWrite: async () => {
            try { await chrome.alarms.clear(ALARM_NAME); }
            catch (error) { console.warn('[Alarm] Could not clear failure alarm:', error); }
        },
    });
    if (!failedState) return;
    setBadge('!', '#e03e3e').catch(error => console.warn('[Badge] Error badge failed:', error));

    const settings = await getSettings();

    if (settings.notificationEnabled !== false) {
        chrome.notifications.create(`pipeline-error:${runId}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: t('ScholarRelay Error'),
            message: errorSummary(finalError),
            priority: 2,
        });
    }

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
async function tickSourcePoll(state) {
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
        const settings = await getSettings();
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

        const sourceIds = [state.sourceId];
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
async function tickArtifactPoll(state) {
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

async function handlePollAlarm(alarm) {
    if (alarm.name !== ALARM_NAME) return;
    let step = 'unknown';
    try {
        await bootReconciliationPromise;
        const ran = await runExclusivePollTick(async () => {
            const state = await getState();
            step = state?.step || 'idle';

            if (!state || state.status !== 'running') {
                const cleanup = await pipelineState.effectWhen(
                    current => current?.status !== 'running',
                    () => chrome.alarms.clear(ALARM_NAME)
                );
                if (cleanup.effectError) throw cleanup.effectError;
                return;
            }

            console.log(`[Alarm] tick -- step=${state.step}`);

            if (state.step === 'wait_source') {
                await tickSourcePoll(state);
            } else if (state.step === 'wait_artifacts') {
                await tickArtifactPoll(state);
            } else if (state.step === 'generate_artifacts') {
                console.log('[Alarm] Artifact start phase still in progress');
            } else {
                console.log(`[Alarm] tick during non-polling step '${state.step}', ignoring`);
            }
        });

        if (!ran) {
            console.warn('[Alarm] Previous poll tick is still running; skipping overlap');
        }
    } catch (error) {
        if (error?.code === 'PIPELINE_STALE_RUN') {
            console.log(`[Alarm] Ignoring stale tick at ${step}`);
        } else {
            console.error(`[Alarm] Tick failed at ${step}:`, error);
        }
    }
}

chrome.alarms.onAlarm.addListener(handlePollAlarm);

async function reconcilePipelineRuntime() {
    const [state, alarm] = await Promise.all([
        getState(),
        chrome.alarms.get(ALARM_NAME),
    ]);
    const action = runtimeRecoveryAction(state, !!alarm);

    if (action === 'create_alarm') {
        try {
            await chrome.alarms.create(ALARM_NAME, {
                periodInMinutes: PIPELINE_POLL_PERIOD_MINUTES,
            });
            console.log(`[Recovery] Restored ${ALARM_NAME} for ${state.step}`);
        } catch (error) {
            await setState(interruptedPipelineUpdate(state));
            setBadge('!', '#e03e3e').catch(badgeError => console.warn('[Badge] Recovery badge failed:', badgeError));
            console.warn('[Recovery] Could not restore polling alarm:', error);
        }
    } else if (action === 'wait_pdf_access') {
        await setState({ step: 'wait_pdf_access', stepDetail: 'PDF download was paused. Open the popup to resume or select a PDF.' });
        await chrome.alarms.clear(ALARM_NAME);
    } else if (action === 'clear_alarm') {
        await chrome.alarms.clear(ALARM_NAME);
    } else if (action === 'interrupt') {
        await setState(interruptedPipelineUpdate(state));
        chrome.alarms.clear(ALARM_NAME).catch(error => console.warn('[Alarm] Recovery cleanup failed:', error));
        setBadge('!', '#e03e3e').catch(error => console.warn('[Badge] Recovery badge failed:', error));
        console.warn(`[Recovery] Stopped interrupted non-idempotent phase: ${state?.step}`);
    }
}

const fallbackPdf = createPdfFallback({
    getState,
    transition: transitionRun,
    download: downloadRemotePdfForUpload,
    upload: (notebookId, file) => addFileSource(notebookId, file.filename, file.fileData, file.mimeType),
    poll: () => chrome.alarms.create(ALARM_NAME, { periodInMinutes: PIPELINE_POLL_PERIOD_MINUTES }),
    fail: failPipeline,
});

async function resumePdfFallback(message) {
    await bootReconciliationPromise;
    await requireActiveRun(message.runId, ['wait_pdf_access']);
    let file = null;
    if (message.fileDataBase64) {
        assertPdfUploadSize(decodedBase64ByteLength(message.fileDataBase64));
        if (!hasBase64PdfSignature(message.fileDataBase64)) throw new Error('The selected file is not a PDF.');
        file = { filename: message.fileName || 'paper.pdf', fileData: message.fileDataBase64, mimeType: 'application/pdf' };
    }
    // Keep the message channel alive until the claimed fallback completes.
    await fallbackPdf(message.runId, { resume: true, file });
    return { ok: true, state: await getState() };
}

const bootReconciliationPromise = reconcilePipelineRuntime()
    .catch(error => console.warn('[Recovery] Initial reconciliation failed:', error));

// =========================================================================
// Pipeline orchestration (steps 1-3: synchronous network calls)
// =========================================================================

async function runPipeline(runId, pdfUrl, pageUrl, uploadFile = null, sourceType = 'pdf', sourceTitle = null) {
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
        const settings = await getSettings();
        const requestedNotebookTitle = settings.useSourceTitleForNotebook !== false ? detectedTitle : '';
        await requireActiveRun(runId, ['create_notebook']);
        const notebook = await createNotebook(requestedNotebookTitle);
        if (!notebook.id) throw new Error('Failed to create notebook -- no ID returned');
        notebookId = notebook.id;
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
            assertPdfUploadSize(decodedBase64ByteLength(uploadFile.fileData));
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
                if (isConfirmedImportRejection(urlErr) && canFallback(await getState())) {
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
                await chrome.alarms.clear(ALARM_NAME);
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
        const msg = err?.message || 'Unknown error';
        console.error('[Pipeline] Setup error:', err);
        await failPipeline(runId, msg, notebookId, !!notebookId && !sourceMutationStarted);
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

async function startPipelineRequest(message, uploadFile = null) {
    await bootReconciliationPromise;
    assertArtifactSelection(await getSettings());

    if (uploadFile) {
        const decodedSize = decodedBase64ByteLength(uploadFile.fileData);
        assertPdfUploadSize(decodedSize);
        if (!hasBase64PdfSignature(uploadFile.fileData)) {
            throw new Error('The selected file does not contain a PDF signature.');
        }
    }

    const runId = crypto.randomUUID();
    const sourceType = uploadFile ? 'pdf' : (message.sourceType || 'pdf');
    const initialState = {
        ...INITIAL_STATE,
        status: 'running',
        runId,
        step: 'auth',
        stepDetail: 'Connecting to Gemini Notebook...',
        pdfUrl: uploadFile ? uploadFile.filename : message.pdfUrl,
        sourceType,
        pageUrl: message.pageUrl || null,
        sourceTitle: normalizeSourceTitle(message.sourceTitle) || null,
        importMethod: uploadFile ? 'file' : 'url',
        originalPdfUrl: uploadFile ? null : message.pdfUrl,
        pdfEvidence: message.pdfEvidence || null,
        startedAt: new Date().toISOString(),
        stepStartedAt: new Date().toISOString(),
    };

    const claimed = await pipelineState.claim(runId, initialState, {
    });
    if (!claimed.applied) {
        const alreadyRunning = claimed.state?.status === 'running';
        return {
            ok: false,
            code: alreadyRunning ? 'PIPELINE_ALREADY_RUNNING' : 'PIPELINE_NOT_IDLE',
            message: alreadyRunning
                ? 'Another pipeline is already active. Open the popup to review or stop it first.'
                : 'Reset the completed or failed pipeline before starting a new one.',
            state: claimed.state,
        };
    }

    try { await chrome.alarms.clear(ALARM_NAME); }
    catch (error) { console.warn('[Alarm] Could not clear an old polling alarm:', error); }
    setBadge('...', '#6b7a8d').catch(error => console.warn('[Badge] Start badge failed:', error));

    runPipeline(
        runId,
        uploadFile ? uploadFile.filename : message.pdfUrl,
        message.pageUrl || null,
        uploadFile,
        sourceType,
        message.sourceTitle || null
    ).catch(error => console.error('[Pipeline] Unhandled setup failure:', error));

    return { ok: true, runId, message: 'Pipeline started' };
}

async function stopPipelineRequest(requestedRunId) {
    await bootReconciliationPromise;
    const state = await getState();
    if (!requestedRunId || !canStopPipeline(state, requestedRunId)) {
        return {
            ok: false,
            code: 'PIPELINE_NOT_STOPPABLE',
            message: 'This pipeline has already advanced or is no longer the active run.',
            state,
        };
    }

    const replacement = {
        ...INITIAL_STATE,
        status: 'idle',
        stepDetail: 'Monitoring stopped. No further work will be started.',
    };
    const stopped = await pipelineState.invalidate(requestedRunId, replacement, {
        expectedSteps: ['wait_source', 'wait_artifacts', 'wait_pdf_access', 'download_pdf'],
        afterWrite: async () => {
            await chrome.alarms.clear(ALARM_NAME);
        },
    });
    if (stopped.applied) {
        clearBadge().catch(error => console.warn('[Badge] Clear badge failed:', error));
    }
    return stopped.applied
        ? { ok: true, message: replacement.stepDetail }
        : {
            ok: false,
            code: 'PIPELINE_NOT_STOPPABLE',
            message: 'This pipeline changed before it could be stopped.',
            state: stopped.state,
        };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

    if (message.type === 'GET_STATE') {
        bootReconciliationPromise.then(() => getState()).then(sendResponse);
        return true;
    }

    if (message.type === 'LIST_COLLECTIONS') {
        bootReconciliationPromise.then(() => listCollections())
            .then(collections => sendResponse({ ok: true, collections }))
            .catch(error => sendResponse({
                ok: false,
                collections: [],
                message: error?.message || 'Could not load Gemini Notebook collections',
            }));
        return true;
    }

    if (message.type === 'RESET_STATE') {
        bootReconciliationPromise
            .then(() => resetState({
                afterWrite: async () => {
                    await chrome.alarms.clear(ALARM_NAME);
                },
            }))
            .then(state => {
                if (state) clearBadge().catch(error => console.warn('[Badge] Clear badge failed:', error));
                sendResponse(state
                    ? { ok: true }
                    : { ok: false, code: 'PIPELINE_ALREADY_RUNNING', message: 'Stop the active pipeline before resetting.' });
            })
            .catch(error => sendResponse({ ok: false, message: error?.message || 'Could not reset pipeline state' }));
        return true;
    }

    if (message.type === 'ABORT_PIPELINE') {
        stopPipelineRequest(message.runId).then(sendResponse)
            .catch(error => sendResponse({ ok: false, message: error?.message || 'Could not stop monitoring' }));
        return true;
    }

    if (message.type === 'DETECT_PDF') {
        const detectedPdf = bindDetectionToTab(message.data, sender.tab);
        if (!detectedPdf) {
            sendResponse({ ok: false, message: 'Detection was not associated with a browser tab.' });
            return false;
        }
        chrome.storage.local.set({ detectedPdf }).then(() => sendResponse({ ok: true }));
        return true;
    }
});

// =========================================================================
// Notification handlers
// =========================================================================

// Clicking the notification body opens the notebook
chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (notificationId.startsWith('pipeline-complete:')) {
        const notebookUrl = await takeNotificationTarget(notificationId);
        if (notebookUrl) {
            chrome.tabs.create({ url: notebookUrl });
        }
        chrome.notifications.clear(notificationId);
    }
});

// Handling the "Open Notebook" / "Dismiss" action buttons
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    if (notificationId.startsWith('pipeline-complete:')) {
        const notebookUrl = await takeNotificationTarget(notificationId);
        if (buttonIndex === 0) {
            if (notebookUrl) {
                chrome.tabs.create({ url: notebookUrl });
            }
        }
        // buttonIndex 1 = "Dismiss" -- just clear
        chrome.notifications.clear(notificationId);
    }
});

chrome.notifications.onClosed.addListener(notificationId => {
    if (notificationId.startsWith('pipeline-complete:')) {
        takeNotificationTarget(notificationId).catch(error => console.warn('[Notification] Could not clear target:', error));
    }
});

console.log('[ScholarRelay] Service worker loaded');
