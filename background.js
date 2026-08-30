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
    createExclusiveRunner,
    interruptedPipelineUpdate,
    pollingElapsedMs,
    runtimeRecoveryAction,
} from './runtime-policy.js';
import { httpOriginPattern, sameHttpOrigin } from './site-permissions.js';

const ALARM_NAME = PIPELINE_ALARM_NAME;
const ARTIFACT_START_DELAY_MS = 1000;

// =========================================================================
// State management
// =========================================================================

const INITIAL_STATE = {
    status: 'idle',          // idle | running | completed | error
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

let stateMutationQueue = Promise.resolve();

async function setState(updates) {
    const applyUpdate = async () => {
        const current = await getState();
        const resolved = typeof updates === 'function' ? updates(current) : updates;
        const newState = { ...current, ...resolved };
        await chrome.storage.local.set({ pipelineState: newState });
        return newState;
    };
    stateMutationQueue = stateMutationQueue.then(applyUpdate, applyUpdate);
    return stateMutationQueue;
}

async function resetState() {
    const applyReset = async () => {
        const reset = { ...INITIAL_STATE };
        await chrome.storage.local.set({ pipelineState: reset });
        return reset;
    };
    stateMutationQueue = stateMutationQueue.then(applyReset, applyReset);
    return stateMutationQueue;
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

    const fileData = await response.arrayBuffer();
    const bytes = new Uint8Array(fileData);
    const hasPdfMagic = bytes.length >= 4 &&
        bytes[0] === 0x25 && // %
        bytes[1] === 0x50 && // P
        bytes[2] === 0x44 && // D
        bytes[3] === 0x46;   // F

    if (!likelyPdfMime && !likelyPdfUrl && !hasPdfMagic) {
        throw new Error('Downloaded content does not appear to be a PDF');
    }

    return {
        filename,
        mimeType: /application\/pdf/i.test(contentType) ? 'application/pdf' : 'application/pdf',
        fileData,
    };
}

// =========================================================================
// Extension icon badge
// =========================================================================

function setBadge(text, color) {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge() {
    chrome.action.setBadgeText({ text: '' });
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

async function completePipeline() {
    chrome.alarms.clear(ALARM_NAME);

    const settings = await getSettings();
    const state = await getState();
    const tasks = state.tasks || [];
    const totalCount = tasks.length;
    const completedCount = tasks.filter(t => t.status === 'completed').length;
    const failedCount = tasks.filter(t => t.status === 'failed').length;
    const allSucceeded = totalCount > 0 && failedCount === 0 && completedCount === totalCount;

    if (completedCount === 0) {
        await failPipeline('All artifact generations failed. No artifacts were generated.', null, true);
        return;
    }

    setBadge('\u2713', '#0fad6e');  // green check

    const stepDetail = allSucceeded
        ? 'All artifacts generated successfully!'
        : `Partial success: ${completedCount}/${totalCount} artifacts generated (${failedCount} failed).`;

    await setState({
        status: 'completed',
        step: 'done',
        stepDetail,
        completedAt: new Date().toISOString(),
    });

    if (settings.chimeEnabled) {
        playCompletionChime();
    }

    const nbTitle = state.notebookTitle ? `"${state.notebookTitle}" ` : '';
    const artifactLabel = allSucceeded
        ? (completedCount === 1 ? '1 artifact' : `${completedCount} artifacts`)
        : `${completedCount}/${totalCount} artifacts`;
    const notificationMessage = allSucceeded
        ? `Notebook ${nbTitle}is ready with ${artifactLabel}. Click to open.`
        : `Notebook ${nbTitle}is partially ready with ${artifactLabel} (${failedCount} failed). Click to open.`;

    if (settings.notificationEnabled !== false) {
        chrome.notifications.create('pipeline-complete', {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: `\uD83C\uDFD9 Gemini Notebook Ready!`,
            message: notificationMessage,
            priority: 2,
            requireInteraction: true,
            buttons: [
                { title: '\uD83D\uDCD3 Open Notebook' },
                { title: 'Dismiss' },
            ],
        });
    }

    if (settings.autoOpenNotebook && state.notebookUrl) {
        chrome.tabs.create({ url: state.notebookUrl });
    }

    console.log('[Pipeline] Completed successfully');
}

async function failPipeline(errorMsg, notebookId = null, sourceWasReady = false) {
    chrome.alarms.clear(ALARM_NAME);
    setBadge('!', '#e03e3e');  // red exclamation
    const settings = await getSettings();

    let cleanupMessage = '';
    if (notebookId && !sourceWasReady) {
        try {
            await deleteNotebook(notebookId);
            cleanupMessage = ' Blank notebook was deleted automatically.';
        } catch (cleanupErr) {
            cleanupMessage = ' Failed to delete blank notebook automatically.';
            console.warn('[Pipeline] Failed to delete blank notebook:', cleanupErr?.message);
        }
    }

    const finalError = `${errorMsg}${cleanupMessage}`.trim();
    await setState({
        status: 'error',
        step: 'error',
        stepDetail: finalError,
        error: finalError,
    });

    if (settings.notificationEnabled !== false) {
        chrome.notifications.create('pipeline-error', {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'ScholarRelay Error',
            message: finalError.substring(0, 140) || 'Unknown error',
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
    const SOURCE_TIMEOUT_MS = 600000; // 10 minutes
    const elapsed = pollingElapsedMs(state.stepStartedAt);
    const sourceLabel = getSourceLabel(state.sourceType);
    const ingestionLabel = getIngestionLabel(state.sourceType);

    if (elapsed > SOURCE_TIMEOUT_MS) {
        await failPipeline(
            `${sourceLabel} ingestion timed out after 10 minutes.`,
            state.notebookId,
            false   // source never became ready, delete the blank notebook
        );
        return;
    }

    let sources;
    try {
        sources = await listSources(state.notebookId);
    } catch (err) {
        // Transient network error -- log and retry next tick
        console.warn('[Tick] Could not list sources, will retry:', err.message);
        await setState({ stepDetail: `Waiting for ${ingestionLabel} (${Math.round(elapsed / 1000)}s, retrying...)` });
        return;
    }

    const source = sources.find(s => String(s.id) === String(state.sourceId));
    const elapsedSec = Math.round(elapsed / 1000);

    if (!source) {
        await setState({ stepDetail: `Waiting for ${sourceLabel} to appear (${elapsedSec}s elapsed)...` });
        return;
    }

    if (source.status === SourceStatus.ERROR) {
        await failPipeline(`${sourceLabel} processing failed.`, state.notebookId, false);
        return;
    }

    if (source.status !== SourceStatus.READY) {
        await setState({ stepDetail: `${ingestionLabel} in progress (${elapsedSec}s elapsed)...` });
        return;
    }

    // Source is READY -- fetch notebook title, then trigger artifact generation
    console.log('[Tick] Source ready, triggering artifact generation');
    await setState({ step: 'generate_artifacts', stepDetail: 'Source ready! Starting generation...' });

    // Fetch the auto-generated notebook title and store it in state for display
    try {
        const title = await getNotebookTitle(state.notebookId);
        if (title) {
            await setState({ notebookTitle: title });
            console.log(`[Tick] Notebook title: ${title}`);
        }
    } catch (titleErr) {
        console.warn('[Tick] Could not fetch notebook title:', titleErr.message);
    }

    try {
        const settings = await getSettings();

        if (settings.collectionId) {
            await setState({ stepDetail: 'Source ready! Adding notebook to collection...' });
            try {
                const collection = await addNotebookToCollection(settings.collectionId, state.notebookId);
                await setState({
                    collectionAssignment: {
                        collectionId: collection.id,
                        name: collection.name,
                        status: 'completed',
                    },
                });
            } catch (collectionErr) {
                console.warn('[Pipeline] Could not add notebook to collection:', collectionErr.message);
                await setState({
                    collectionAssignment: {
                        collectionId: settings.collectionId,
                        name: null,
                        status: 'failed',
                        error: collectionErr.message,
                    },
                });
            }
        }

        const sourceIds = [state.sourceId];
        const tasks = [];

        // Helper to run a generation function safely so one failure doesn't stop the pipeline
        const runTask = async (type, fn) => {
            try {
                const res = await fn();
                if (res?.status === 'completed') {
                    tasks.push({ type, taskId: res.taskId || null, status: 'completed' });
                    return;
                }
                if (res?.status === 'failed') {
                    tasks.push({ type, taskId: res.taskId || null, status: 'failed', error: res.error || 'Artifact generation failed' });
                    return;
                }
                if (!res?.taskId) throw new Error('API returned no task ID');
                // Pending/unknown initial states are polled like in-progress tasks.
                tasks.push({ type, taskId: res.taskId, status: 'in_progress' });
            } catch (e) {
                console.warn(`[Pipeline] Failed to start ${type}:`, e.message);
                tasks.push({ type, taskId: null, status: 'failed', error: e.message });
            }
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
            }
        }

        const typeLabels = tasks.map(t => t.type).join(', ');
        await setState({
            tasks,
            step: 'wait_artifacts',
            stepDetail: `Generating: ${typeLabels}...`,
            stepStartedAt: new Date().toISOString(),
        });
    } catch (err) {
        await failPipeline(
            `Failed to start artifact generation: ${err.message}`,
            state.notebookId,
            true   // source was ready, keep the notebook
        );
    }
}

/**
 * One tick of the artifact-polling phase.
 * Polls all artifact tasks. Calls completePipeline() when all have settled.
 */
async function tickArtifactPoll(state) {
    const ARTIFACT_TIMEOUT_MS = 1200000; // 20 minutes
    const elapsed = pollingElapsedMs(state.stepStartedAt);

    if (elapsed > ARTIFACT_TIMEOUT_MS) {
        await failPipeline('Artifact generation timed out after 20 minutes.', null, true);
        return;
    }

    const tasks = state.tasks || [];
    const updatedTasks = [...tasks];
    let statusByTaskId = new Map();

    try {
        statusByTaskId = await listArtifactStatuses(state.notebookId);
    } catch (err) {
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
    await setState({ tasks: updatedTasks, stepDetail: `${summary} (~${elapsedMin} min elapsed)` });

    const allDone = updatedTasks.every(t => t.status !== 'in_progress');
    if (allDone && updatedTasks.length > 0) {
        const completedCount = updatedTasks.filter(t => t.status === 'completed').length;
        if (completedCount === 0) {
            await failPipeline('All artifact generations failed. No artifacts were generated.', null, true);
            return;
        }
        await completePipeline();
    }
}

// =========================================================================
// Alarm listener -- the heart of long-running polling
// =========================================================================

const runExclusivePollTick = createExclusiveRunner();

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    const ran = await runExclusivePollTick(async () => {
        const state = await getState();

        if (!state || state.status !== 'running') {
            await chrome.alarms.clear(ALARM_NAME);
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
});

async function reconcilePipelineRuntime() {
    const [state, alarm] = await Promise.all([
        getState(),
        chrome.alarms.get(ALARM_NAME),
    ]);
    const action = runtimeRecoveryAction(state, !!alarm);

    if (action === 'create_alarm') {
        await chrome.alarms.create(ALARM_NAME, {
            periodInMinutes: PIPELINE_POLL_PERIOD_MINUTES,
        });
        console.log(`[Recovery] Restored ${ALARM_NAME} for ${state.step}`);
    } else if (action === 'clear_alarm') {
        await chrome.alarms.clear(ALARM_NAME);
    } else if (action === 'interrupt') {
        await chrome.alarms.clear(ALARM_NAME);
        await setState(interruptedPipelineUpdate(state));
        setBadge('!', '#e03e3e');
        console.warn(`[Recovery] Stopped interrupted non-idempotent phase: ${state?.step}`);
    }
}

chrome.runtime.onStartup.addListener(() => {
    reconcilePipelineRuntime().catch(error => console.warn('[Recovery] Startup reconciliation failed:', error));
});

chrome.runtime.onInstalled.addListener(() => {
    reconcilePipelineRuntime().catch(error => console.warn('[Recovery] Install reconciliation failed:', error));
});

// =========================================================================
// Pipeline orchestration (steps 1-3: synchronous network calls)
// =========================================================================

async function runPipeline(pdfUrl, pageUrl, uploadFile = null, sourceType = 'pdf', sourceTitle = null) {
    const effectiveSourceType = uploadFile ? 'pdf' : (sourceType || 'pdf');
    const sourceLabel = getSourceLabel(effectiveSourceType);
    const ingestionLabel = getIngestionLabel(effectiveSourceType);
    const detectedTitle = normalizeSourceTitle(sourceTitle);
    console.log(`[Pipeline] Starting for ${sourceLabel}: ${pdfUrl}`);

    let notebookId = null;

    try {
        setBadge('...', '#6b7a8d');  // grey ellipsis while running

        // Step 1: Authenticate
        await setState({
            status: 'running',
            step: 'auth',
            stepDetail: 'Connecting to Gemini Notebook...',
            pdfUrl,
            sourceType: effectiveSourceType,
            pageUrl,
            sourceTitle: detectedTitle || null,
            notebookId: null,
            notebookUrl: null,
            notebookTitle: null,
            sourceId: null,
            collectionAssignment: null,
            tasks: [],
            error: null,
            startedAt: new Date().toISOString(),
            completedAt: null,
            stepStartedAt: new Date().toISOString(),
        });

        await fetchTokens();
        await setState({ step: 'create_notebook', stepDetail: 'Creating notebook...' });

        // Step 2: Create notebook
        const settings = await getSettings();
        const requestedNotebookTitle = settings.useSourceTitleForNotebook !== false ? detectedTitle : '';
        const notebook = await createNotebook(requestedNotebookTitle);
        if (!notebook.id) throw new Error('Failed to create notebook -- no ID returned');
        notebookId = notebook.id;

        const notebookUrl = getNotebookUrl(notebook.id);
        const sourceStepDetail = uploadFile
            ? `Uploading local PDF: ${uploadFile.filename}`
            : `Adding ${sourceLabel}: ${pdfUrl.substring(0, 60)}...`;

        await setState({
            notebookId: notebook.id,
            notebookUrl,
            step: 'add_source',
            stepDetail: sourceStepDetail,
        });

        // Step 3: Add source
        let source = null;
        if (uploadFile) {
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
            const canFallbackToPdfUpload = !isWebpageSourceType(effectiveSourceType) && isLikelyPdfUrl(pdfUrl);
            try {
                source = await addUrlSource(notebook.id, pdfUrl);
            } catch (urlErr) {
                if (!canFallbackToPdfUpload) {
                    throw urlErr;
                }
                console.warn('[Pipeline] URL source add failed, trying download+upload fallback:', urlErr?.message || urlErr);
                await setState({
                    stepDetail: 'URL source was blocked. Downloading PDF from the current URL and uploading directly...'
                });

                try {
                    const fallbackFile = await downloadRemotePdfForUpload(pdfUrl, pageUrl);
                    source = await addFileSource(
                        notebook.id,
                        fallbackFile.filename,
                        fallbackFile.fileData,
                        fallbackFile.mimeType
                    );
                    await setState({
                        stepDetail: `URL blocked. Fallback upload succeeded (${fallbackFile.filename}).`
                    });
                } catch (fallbackErr) {
                    throw new Error(buildFallbackUploadErrorMessage(urlErr, fallbackErr, pdfUrl));
                }
            }
        }

        if (!source.id) throw new Error('Failed to add source -- no ID returned');

        // Step 4: Hand off to alarm-based polling.
        // The service worker is free to be suspended between alarm ticks.
        // All state needed for polling is now in chrome.storage.local.
        await setState({
            sourceId: source.id,
            step: 'wait_source',
            stepDetail: `Waiting for ${ingestionLabel} (checking every ~30s)...`,
            stepStartedAt: new Date().toISOString(),
        });

        await chrome.alarms.clear(ALARM_NAME);
        await chrome.alarms.create(ALARM_NAME, {
            periodInMinutes: PIPELINE_POLL_PERIOD_MINUTES,
        });
        console.log('[Pipeline] Alarm-based polling started (30 s interval)');

    } catch (err) {
        const msg = err?.message || 'Unknown error';
        console.error('[Pipeline] Setup error:', err);
        await failPipeline(msg, notebookId, false);
    }
}

// =========================================================================
// Message handlers (from popup and content script)
// =========================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_PIPELINE') {
        chrome.alarms.clear(ALARM_NAME);
        runPipeline(
            message.pdfUrl,
            message.pageUrl,
            null,
            message.sourceType || 'pdf',
            message.sourceTitle || null
        );
        sendResponse({ ok: true, message: 'Pipeline started' });
        return false;
    }

    if (message.type === 'START_PIPELINE_FILE') {
        if (!message.fileDataBase64 || !message.fileName) {
            sendResponse({ ok: false, message: 'Missing file payload or filename' });
            return false;
        }
        chrome.alarms.clear(ALARM_NAME);
        runPipeline(
            message.fileName || 'local-upload.pdf',
            message.pageUrl || null,
            {
                filename: message.fileName || 'local-upload.pdf',
                mimeType: message.mimeType || 'application/pdf',
                fileData: message.fileDataBase64,
            },
            'pdf',
            message.sourceTitle || null
        );
        sendResponse({ ok: true, message: 'Pipeline started' });
        return false;
    }

    if (message.type === 'GET_STATE') {
        getState().then(state => sendResponse(state));
        return true;
    }

    if (message.type === 'LIST_COLLECTIONS') {
        listCollections()
            .then(collections => sendResponse({ ok: true, collections }))
            .catch(error => sendResponse({
                ok: false,
                collections: [],
                message: error?.message || 'Could not load Gemini Notebook collections',
            }));
        return true;
    }

    if (message.type === 'RESET_STATE') {
        chrome.alarms.clear(ALARM_NAME);
        clearBadge();
        resetState().then(() => sendResponse({ ok: true }));
        return true;
    }

    if (message.type === 'ABORT_PIPELINE') {
        chrome.alarms.clear(ALARM_NAME);
        clearBadge();
        setState({
            ...INITIAL_STATE,
            status: 'idle',
            stepDetail: 'Monitoring stopped. You can start another generation.',
            error: null,
        }).then(() => sendResponse({ ok: true }));
        return true;
    }

    if (message.type === 'DETECT_PDF') {
        chrome.storage.local.set({ detectedPdf: message.data });
        sendResponse({ ok: true });
        return false;
    }
});

// =========================================================================
// Notification handlers
// =========================================================================

// Clicking the notification body opens the notebook
chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (notificationId === 'pipeline-complete') {
        const state = await getState();
        if (state.notebookUrl) {
            chrome.tabs.create({ url: state.notebookUrl });
        }
        chrome.notifications.clear(notificationId);
    }
});

// Handling the "Open Notebook" / "Dismiss" action buttons
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    if (notificationId === 'pipeline-complete') {
        if (buttonIndex === 0) {
            const state = await getState();
            if (state.notebookUrl) {
                chrome.tabs.create({ url: state.notebookUrl });
            }
        }
        // buttonIndex 1 = "Dismiss" -- just clear
        chrome.notifications.clear(notificationId);
    }
});

console.log('[ScholarRelay] Service worker loaded');
reconcilePipelineRuntime().catch(error => console.warn('[Recovery] Initial reconciliation failed:', error));
