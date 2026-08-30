import { choosePdfTitle } from './pdf-metadata.js';

/**
 * Popup script: reads pipeline state from background service worker
 * and renders the UI. Triggers pipeline start on button click.
 * All persistent state lives in chrome.storage.local.
 */

const contentEl = document.getElementById('content');

// Pipeline steps -- 'keys' maps one or more background state step names to this display row
const STEPS = [
    { keys: ['auth', 'create_notebook'], label: 'Setup', emoji: '🔑' },
    { keys: ['add_source'], label: 'Add Source', emoji: '📄' },
    { keys: ['wait_source'], label: 'Processing Source', emoji: '⏳' },
    {
        keys: ['generate_artifacts',
            'wait_artifacts'], label: 'Generate Artifacts', emoji: '🎧'
    },
    { keys: ['done'], label: 'Complete', emoji: '✅' },
];


// =========================================================================
// Settings schema
// =========================================================================

const DEFAULTS = {
    generateAudio: true,
    audioFormat: 'deep_dive', audioLength: 'long', language: 'en', audioPrompt: '',
    generateVideo: false, videoFormat: 'explainer', videoStyle: 'auto', videoPrompt: '', videoStylePrompt: '',
    generateReport: false, reportFormat: 'study_guide', reportPrompt: '',
    generateQuiz: false, quizQuantity: 'standard', quizDifficulty: 'medium', quizPrompt: '',
    generateFlashcards: false, flashcardsQuantity: 'standard', flashcardsDifficulty: 'medium', flashcardsPrompt: '',
    generateInfographic: true,
    infographicOrientation: 'landscape', infographicDetail: 'standard', infographicStylePreset: 'auto', infographicNativeStyle: 'auto', infographicPrompt: '',
    generateSlideDeck: false, slideDeckFormat: 'detailed_deck', slideDeckLength: 'default', slideDeckPrompt: '',
    generateMindMap: false,
    generateDataTable: false, dataTablePrompt: '',
    notificationEnabled: true,
    chimeEnabled: true, autoOpenNotebook: false, useSourceTitleForNotebook: true,
    collectionId: '',
};

const SELECT_MAP = {
    's-audioFormat': 'audioFormat',
    's-language': 'language',
    's-videoStyle': 'videoStyle',
    's-infographicStylePreset': 'infographicStylePreset',
    's-infographicNativeStyle': 'infographicNativeStyle',
    's-collectionId': 'collectionId',
};
const RADIO_NAMES = [
    'audioLength', 'videoFormat', 'reportFormat',
    'quizQuantity', 'quizDifficulty',
    'flashcardsQuantity', 'flashcardsDifficulty',
    'infographicOrientation', 'infographicDetail',
    'slideDeckFormat', 'slideDeckLength',
];
// All artifact-type toggles (used for at-least-1 validation)
const ARTIFACT_TOGGLE_IDS = [
    's-generateAudio', 's-generateVideo', 's-generateReport',
    's-generateQuiz', 's-generateFlashcards', 's-generateInfographic',
    's-generateSlideDeck', 's-generateMindMap', 's-generateDataTable',
];
const TOGGLE_MAP = {
    's-generateAudio': 'generateAudio',
    's-generateVideo': 'generateVideo',
    's-generateReport': 'generateReport',
    's-generateQuiz': 'generateQuiz',
    's-generateFlashcards': 'generateFlashcards',
    's-generateInfographic': 'generateInfographic',
    's-generateSlideDeck': 'generateSlideDeck',
    's-generateMindMap': 'generateMindMap',
    's-generateDataTable': 'generateDataTable',
    's-notificationEnabled': 'notificationEnabled',
    's-chimeEnabled': 'chimeEnabled',
    's-autoOpenNotebook': 'autoOpenNotebook',
    's-useSourceTitleForNotebook': 'useSourceTitleForNotebook',
};
const TEXTAREA_MAP = {
    's-audioPrompt': 'audioPrompt',
    's-videoPrompt': 'videoPrompt',
    's-videoStylePrompt': 'videoStylePrompt',
    's-reportPrompt': 'reportPrompt',
    's-quizPrompt': 'quizPrompt',
    's-flashcardsPrompt': 'flashcardsPrompt',
    's-infographicPrompt': 'infographicPrompt',
    's-slideDeckPrompt': 'slideDeckPrompt',
    's-dataTablePrompt': 'dataTablePrompt',
};
// No ARTIFACT_SUB_OPTS needed: section collapse handles visibility.
// Toggles live in the header and are always visible.

// =========================================================================
// Settings load / save
// =========================================================================

async function loadSettings() {
    const result = await chrome.storage.local.get('userSettings');
    const s = { ...DEFAULTS, ...(result.userSettings || {}) };

    for (const [id, key] of Object.entries(SELECT_MAP)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const value = s[key] ?? DEFAULTS[key];
        if (id === 's-collectionId' && value && !Array.from(el.options).some(opt => opt.value === value)) {
            el.add(new Option('Previously selected collection', value));
        }
        el.value = value;
    }
    for (const name of RADIO_NAMES) {
        const val = s[name] ?? DEFAULTS[name];
        document.querySelectorAll(`input[name="${name}"]`).forEach(inp => {
            inp.checked = (inp.value === val);
        });
    }
    for (const [id, key] of Object.entries(TOGGLE_MAP)) {
        const el = document.getElementById(id);
        if (el) el.checked = !!s[key];
    }
    for (const [id, key] of Object.entries(TEXTAREA_MAP)) {
        const el = document.getElementById(id);
        if (el) el.value = s[key] ?? '';
    }

    updateReportPromptHint();
}

async function refreshCollections() {
    const select = document.getElementById('s-collectionId');
    const status = document.getElementById('collection-load-status');
    if (!select) return;

    const selectedId = select.value;
    select.disabled = true;
    if (status) status.textContent = 'Loading collections...';

    try {
        const response = await chrome.runtime.sendMessage({ type: 'LIST_COLLECTIONS' });
        if (!response?.ok) throw new Error(response?.message || 'Could not load collections');

        select.replaceChildren(new Option('Do not add to a collection', ''));
        for (const collection of response.collections || []) {
            const emoji = collection.emoji ? `${collection.emoji} ` : '';
            const count = Array.isArray(collection.notebookIds) ? collection.notebookIds.length : 0;
            select.add(new Option(`${emoji}${collection.name} (${count})`, collection.id));
        }

        if (selectedId && !Array.from(select.options).some(opt => opt.value === selectedId)) {
            select.add(new Option('Previously selected collection (unavailable)', selectedId));
        }
        select.value = selectedId;
        if (status) {
            const count = response.collections?.length || 0;
            status.textContent = count
                ? `${count} collection${count === 1 ? '' : 's'} available.`
                : 'No collections found. Create one in NotebookLM first.';
        }
    } catch (error) {
        select.replaceChildren(new Option('Do not add to a collection', ''));
        if (selectedId) {
            select.add(new Option('Previously selected collection (could not refresh)', selectedId));
            select.value = selectedId;
        }
        if (status) status.textContent = error?.message || 'Could not load collections.';
    } finally {
        select.disabled = false;
    }
}

async function saveSettings() {
    const s = {};
    for (const [id, key] of Object.entries(SELECT_MAP)) {
        const el = document.getElementById(id);
        if (el) s[key] = el.value;
    }
    for (const name of RADIO_NAMES) {
        const checked = document.querySelector(`input[name="${name}"]:checked`);
        if (checked) s[name] = checked.value;
    }
    for (const [id, key] of Object.entries(TOGGLE_MAP)) {
        const el = document.getElementById(id);
        if (el) s[key] = el.checked;
    }
    for (const [id, key] of Object.entries(TEXTAREA_MAP)) {
        const el = document.getElementById(id);
        if (el) s[key] = el.value.trim();
    }

    const current = ((await chrome.storage.local.get('userSettings')).userSettings) || {};
    await chrome.storage.local.set({ userSettings: { ...current, ...s } });
}

// Returns true if at least one artifact toggle is checked
function hasAtLeastOneArtifact() {
    return ARTIFACT_TOGGLE_IDS.some(id => {
        const el = document.getElementById(id);
        return el && el.checked;
    });
}

function showArtifactWarning(show) {
    const w = document.getElementById('artifact-warning');
    if (w) w.style.display = show ? 'block' : 'none';
}

// Sub-option visibility is handled by section collapse (.expanded class).
// No per-artifact sub-opts hiding needed.

function updateReportPromptHint() {
    const formatEl = document.querySelector('input[name="reportFormat"]:checked');
    const hint = document.getElementById('report-prompt-required');
    if (hint) hint.style.display = (formatEl && formatEl.value === 'custom') ? 'inline' : 'none';
}

// =========================================================================
// Section collapse/expand -- handled by addEventListener, not inline onclick
// =========================================================================

function initSectionHeaders() {
    document.querySelectorAll('.s-section-header').forEach(header => {
        header.addEventListener('click', (e) => {
            // Clicking the toggle label/input must NOT trigger expand/collapse
            if (e.target.closest('.s-header-toggle')) return;
            const section = header.closest('.s-section');
            if (!section) return;
            // Mind Map has no content -- don't toggle it
            if (!section.querySelector('.s-section-content')) return;
            const expanding = !section.classList.contains('expanded');
            section.classList.toggle('expanded', expanding);
            const arrow = header.querySelector('.s-section-arrow');
            if (arrow && arrow.style.visibility !== 'hidden') {
                arrow.textContent = expanding ? '▾' : '▸';
            }
        });
    });
}

// =========================================================================
// Gear panel toggle
// =========================================================================

let settingsOpen = false;
let listenersWired = false;

document.getElementById('btn-gear').addEventListener('click', async () => {
    settingsOpen = !settingsOpen;
    document.getElementById('settings-panel').classList.toggle('open', settingsOpen);
    document.getElementById('btn-gear').classList.toggle('active', settingsOpen);

    if (settingsOpen) {
        if (!listenersWired) {
            initSectionHeaders();
            wireSettingsListeners();
            listenersWired = true;
        }
        await loadSettings();
        await refreshCollections();
    }
});

function wireSettingsListeners() {
    // Selects
    for (const id of Object.keys(SELECT_MAP)) {
        document.getElementById(id)?.addEventListener('change', saveSettings);
    }
    document.getElementById('btn-refresh-collections')?.addEventListener('click', refreshCollections);
    // Radios
    for (const name of RADIO_NAMES) {
        document.querySelectorAll(`input[name="${name}"]`).forEach(inp => {
            inp.addEventListener('change', () => {
                saveSettings();
                if (name === 'reportFormat') updateReportPromptHint();
            });
        });
    }
    // Artifact toggles -- validate at-least-1 on change
    for (const id of ARTIFACT_TOGGLE_IDS) {
        document.getElementById(id)?.addEventListener('change', async function () {
            if (!hasAtLeastOneArtifact()) {
                this.checked = true;
                showArtifactWarning(true);
                setTimeout(() => showArtifactWarning(false), 3000);
            } else {
                showArtifactWarning(false);
            }
            await saveSettings();
        });
    }
    // Non-artifact toggles (chime, auto-open) -- no validation needed
    ['s-notificationEnabled', 's-chimeEnabled', 's-autoOpenNotebook', 's-useSourceTitleForNotebook'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', saveSettings);
    });
    // Textareas (debounced)
    for (const id of Object.keys(TEXTAREA_MAP)) {
        let timer;
        document.getElementById(id)?.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(saveSettings, 600);
        });
    }

    // Save & Close button
    document.getElementById('btn-save-close')?.addEventListener('click', async () => {
        await saveSettings();
        settingsOpen = false;
        document.getElementById('settings-panel').classList.remove('open');
        document.getElementById('btn-gear').classList.remove('active');
    });
}

// =========================================================================
// Init
// =========================================================================

async function init() {
    const state = await getState();
    if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
        renderProgress(state);
        if (state.status === 'running') startPolling();
        return;
    }
    await detectAndRender();
}

// =========================================================================
// PDF Detection
// =========================================================================

function cleanDetectedTitle(value) {
    if (typeof value !== 'string') return null;
    const title = value.replace(/\s+/g, ' ').trim()
        .replace(/^\[[\d.]+(?:v\d+)?\]\s*/, '')
        .replace(/\s*[|\-]\s*arXiv(?:\.org)?\s*$/i, '')
        .trim();
    return title && !/^untitled$/i.test(title) ? title.substring(0, 300) : null;
}

async function detectSourceTitleFromTab(tab) {
    if (!tab?.id) return cleanDetectedTitle(tab?.title);
    try {
        const injected = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const candidates = [
                    document.querySelector('meta[name="citation_title"]')?.content,
                    document.querySelector('meta[property="og:title"]')?.content,
                    document.querySelector('h1.title')?.textContent?.replace(/^Title:\s*/i, ''),
                    document.title,
                ];
                return candidates.find(value => typeof value === 'string' && value.trim()) || null;
            },
        });
        return cleanDetectedTitle(injected?.[0]?.result) || cleanDetectedTitle(tab.title);
    } catch (_) {
        return cleanDetectedTitle(tab.title);
    }
}

async function detectAndRender() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) {
            const url = tab.url;
            const sourceTitle = await detectSourceTitleFromTab(tab);
            if (/\.pdf(\?.*)?$/i.test(url)) {
                const source = /^https?:\/\//i.test(url) ? 'direct_url' : 'local_file';
                renderDetection({ isPdf: true, pdfUrl: url, pageUrl: url, source, sourceTitle });
                return;
            }
            const arxivAbsMatch = url.match(/^https?:\/\/arxiv\.org\/abs\/([\d.]+)(v\d+)?/);
            if (arxivAbsMatch) {
                const pdfUrl = `https://arxiv.org/pdf/${arxivAbsMatch[1]}${arxivAbsMatch[2] || ''}`;
                renderDetection({ isPdf: true, pdfUrl, pageUrl: url, source: 'arxiv_abstract', sourceTitle });
                return;
            }
            if (/arxiv\.org\/pdf\//.test(url)) {
                renderDetection({ isPdf: true, pdfUrl: url, pageUrl: url, source: 'arxiv_pdf', sourceTitle });
                return;
            }
            const arxivHtmlMatch = url.match(/^https?:\/\/arxiv\.org\/html\/([\d.]+)(v\d+)?/);
            if (arxivHtmlMatch) {
                const pdfUrl = `https://arxiv.org/pdf/${arxivHtmlMatch[1]}${arxivHtmlMatch[2] || ''}`;
                renderDetection({ isPdf: true, pdfUrl, pageUrl: url, source: 'arxiv_html', sourceTitle });
                return;
            }
        }
    } catch (_) { /* ignore */ }

    try {
        const stored = await chrome.storage.local.get('detectedPdf');
        if (stored.detectedPdf?.isPdf) { renderDetection(stored.detectedPdf); return; }
    } catch (_) { /* ignore */ }

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && tab?.url && !tab.url.startsWith('chrome://')) {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
            await new Promise(r => setTimeout(r, 200));
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_PDF_DETECTION' });
            if (response?.isPdf) { renderDetection(response); return; }
        }
    } catch (_) { /* ignore */ }

    renderNoPdf();
}

// =========================================================================
// Rendering
// =========================================================================

function renderDetection(data) {
    const truncated = data.pdfUrl.length > 80 ? data.pdfUrl.substring(0, 77) + '...' : data.pdfUrl;
    const sourceLabel = {
        direct_pdf_url: 'Direct PDF', embedded_pdf: 'Embedded PDF viewer',
        arxiv_abstract: 'arXiv abstract page', arxiv_pdf: 'arXiv PDF',
        arxiv_link: 'arXiv PDF link', page_link: 'PDF link on page',
        direct_url: 'Direct PDF URL', local_file: 'Local file',
    }[data.source] || data.source;

    const isUploadRequired = typeof data.pdfUrl === 'string' && !/^https?:\/\//i.test(data.pdfUrl);

    if (isUploadRequired) {
        contentEl.innerHTML = `
    <div class="pdf-info">
      <div class="label">Detected Local PDF</div>
      <div class="pdf-url">${escapeHtml(truncated)}</div>
      <div class="pdf-source">via ${escapeHtml(sourceLabel)}</div>
    </div>
    <button class="btn-generate" id="btn-upload-start">Use Current PDF and Generate</button>
    <button class="btn-secondary" id="btn-upload-other">Choose Different PDF</button>`;
        document.getElementById('btn-upload-start').addEventListener('click', () => startPipelineFromCurrentTabPdf(data.pageUrl || data.pdfUrl));
        document.getElementById('btn-upload-other').addEventListener('click', () => promptForPdfUpload(data.pageUrl || data.pdfUrl));
        return;
    }

    contentEl.innerHTML = `
    <div class="pdf-info">
      <div class="label">Detected PDF</div>
      <div class="pdf-url">${escapeHtml(truncated)}</div>
      <div class="pdf-source">via ${escapeHtml(sourceLabel)}</div>
    </div>
    <button class="btn-generate" id="btn-start">🎧 Generate Artifacts</button>`;
    document.getElementById('btn-start').addEventListener('click', () =>
        startPipelineFromCurrentTabPdf(data.pageUrl || data.pdfUrl, data.pdfUrl, data.sourceTitle)
    );
}

function renderNoPdf() {
    contentEl.innerHTML = `
    <div class="no-pdf">
      <div class="icon">📄</div>
      No PDF detected on this page.<br>
      <span style="font-size:11px; color:var(--text-dim)">You can still try importing this page URL directly.</span>
    </div>
    <button class="btn-generate" id="btn-start-url">Use Current Webpage URL</button>
    <button class="btn-secondary" id="btn-upload-manual">Upload Local PDF</button>`;
    document.getElementById('btn-start-url').addEventListener('click', startPipelineFromCurrentPageUrl);
    document.getElementById('btn-upload-manual').addEventListener('click', () => promptForPdfUpload(null));
}

function renderProgress(state) {
    const currentStepIndex = STEPS.findIndex(s => s.keys.includes(state.step));

    const stepsHtml = STEPS.map((step, idx) => {
        let cls = 'pending', content = idx + 1;
        if (state.status === 'error' && idx === currentStepIndex) { cls = 'error'; content = '!'; }
        else if (idx < currentStepIndex || state.step === 'done') { cls = 'done'; content = '✓'; }
        else if (idx === currentStepIndex) { cls = 'active'; content = '●'; }
        const detail = idx === currentStepIndex ? state.stepDetail : '';
        return `
      <div class="pipeline-step">
        <div class="step-indicator ${cls}">${content}</div>
        <div class="step-content">
          <div class="step-name">${step.emoji} ${step.label}</div>
          ${detail ? `<div class="step-detail">${escapeHtml(detail)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    const titleHtml = state.notebookTitle ? `
    <div class="notebook-title-bar">
      <span class="nb-icon">📓</span>
      <div>
        <div class="nb-label">Notebook title</div>
        <div class="nb-title" title="${escapeHtml(state.notebookTitle)}">${escapeHtml(state.notebookTitle)}</div>
      </div>
    </div>` : '';

    const collection = state.collectionAssignment;
    const collectionHtml = collection?.status === 'completed' ? `
    <div class="collection-status success">🗂 Added to ${escapeHtml(collection.name || 'collection')}</div>`
        : collection?.status === 'failed' ? `
    <div class="collection-status warning">⚠️ Collection assignment failed: ${escapeHtml(collection.error || 'Unknown error')}</div>`
            : '';

    let bottomHtml = '';
    if (state.notebookUrl) {
        bottomHtml += `<a class="notebook-link" href="${state.notebookUrl}" target="_blank">📓 Open Notebook in NotebookLM</a>`;
    }
    if (state.status === 'completed') {
        const tasks = state.tasks || [];
        const totalCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === 'completed').length;
        const failedCount = tasks.filter(t => t.status === 'failed').length;
        const summaryMsg = failedCount > 0
            ? `${completedCount}/${totalCount} artifacts ready (${failedCount} failed).`
            : `${completedCount} artifact${completedCount !== 1 ? 's' : ''} ready!`;
        bottomHtml += `
      <div class="completed-box">
        <div class="icon">🎉</div>
        <div class="msg">${summaryMsg}</div>
      </div>`;
    }
    if (state.status === 'running') {
        bottomHtml += `<button class="btn-secondary" id="btn-abort">Stop Monitoring</button>`;
    }
    if (state.status === 'error' || state.status === 'completed') {
        bottomHtml += `<button class="btn-secondary" id="btn-reset">Start Over</button>`;
    }

    contentEl.innerHTML = `
    <div class="pdf-info" style="margin-bottom:10px;">
      <div class="label">Processing Source</div>
      <div class="pdf-url">${escapeHtml((state.pdfUrl || '').substring(0, 80))}</div>
    </div>
    ${titleHtml}
    ${collectionHtml}
    <div class="pipeline">${stepsHtml}</div>
    ${bottomHtml}`;

    document.getElementById('btn-reset')?.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'RESET_STATE' });
        await detectAndRender();
    });
    document.getElementById('btn-abort')?.addEventListener('click', abortPipeline);
}

// =========================================================================
// Pipeline control
// =========================================================================

async function startPipeline(pdfUrl, pageUrl, sourceType = 'pdf', sourceTitle = null) {
    const btn = document.getElementById('btn-start') || document.getElementById('btn-start-url');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting...'; }
    await chrome.runtime.sendMessage({ type: 'START_PIPELINE', pdfUrl, pageUrl, sourceType, sourceTitle });
    await new Promise(r => setTimeout(r, 300));
    const state = await getState();
    renderProgress(state);
    startPolling();
}

async function startPipelineFromCurrentPageUrl() {
    const btn = document.getElementById('btn-start-url');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentUrl = tab?.url || '';
        if (!/^https?:\/\//i.test(currentUrl)) {
            throw new Error('Current tab is not an http(s) webpage URL.');
        }
        const sourceTitle = await detectSourceTitleFromTab(tab);
        await startPipeline(currentUrl, currentUrl, 'webpage', sourceTitle);
    } catch (err) {
        console.warn('[Popup] Could not start webpage URL pipeline:', err?.message || err);
        if (btn) { btn.disabled = false; btn.textContent = 'Use Current Webpage URL'; }
        alert(err?.message || 'Could not use current webpage URL as a source.');
    }
}

async function abortPipeline() {
    await chrome.runtime.sendMessage({ type: 'ABORT_PIPELINE' });
    stopPolling();
    await detectAndRender();
}

async function startPipelineFile(file, pageUrl, sourceTitle = null) {
    const btn = document.getElementById('btn-upload-start') || document.getElementById('btn-upload-manual');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }
    const fileDataBase64 = await readFileAsBase64(file);
    const selectedTitle = choosePdfTitle({
        payload: fileDataBase64,
        pageTitle: sourceTitle,
        filename: file.name,
    });
    console.log(`[Popup] Notebook title source: ${selectedTitle.source}`);
    await chrome.runtime.sendMessage({
        type: 'START_PIPELINE_FILE',
        fileName: file.name || 'local-upload.pdf',
        mimeType: file.type || 'application/pdf',
        fileDataBase64, pageUrl,
        sourceTitle: selectedTitle.title,
    });
    await new Promise(r => setTimeout(r, 300));
    const state = await getState();
    renderProgress(state);
    startPolling();
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const commaIdx = result.indexOf(',');
            resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('Failed to read PDF blob'));
        reader.readAsDataURL(blob);
    });
}

function filenameFromUrl(url) {
    try {
        const u = new URL(url);
        const raw = u.pathname.split('/').pop() || '';
        const decoded = decodeURIComponent(raw);
        if (decoded && /\.pdf$/i.test(decoded)) return decoded;
    } catch (_) { /* ignore */ }
    return 'local-upload.pdf';
}

function extractPdfUrlFromTabUrl(tabUrl) {
    if (!tabUrl || typeof tabUrl !== 'string') return null;
    if (/^(file|https?):\/\//i.test(tabUrl) && /\.pdf(\?|#|$)/i.test(tabUrl)) {
        return tabUrl;
    }

    try {
        const u = new URL(tabUrl);
        if (u.protocol === 'chrome-extension:') {
            const candidates = [
                u.searchParams.get('src'),
                u.searchParams.get('file'),
                u.searchParams.get('url'),
            ].filter(Boolean);
            for (const raw of candidates) {
                const decoded = decodeURIComponent(raw);
                if (/^(file|https?):\/\//i.test(decoded) && /\.pdf(\?|#|$)/i.test(decoded)) {
                    return decoded;
                }
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

function isAllowedFileSchemeAccess() {
    return new Promise(resolve => {
        if (!chrome?.extension?.isAllowedFileSchemeAccess) {
            resolve(true);
            return;
        }
        chrome.extension.isAllowedFileSchemeAccess(allowed => resolve(!!allowed));
    });
}

function showFileAccessHint() {
    alert(
        'To use "Use Current PDF" for local files, enable file access:\n\n' +
        '1) Open chrome://extensions\n' +
        '2) Find this extension\n' +
        '3) Enable "Allow access to file URLs"\n' +
        '4) Reload the extension and try again'
    );
}

async function tryDirectTabPdfRead(tab, preferredPdfUrl = null) {
    const sourceUrl = /^https?:\/\//i.test(preferredPdfUrl || '')
        ? preferredPdfUrl
        : extractPdfUrlFromTabUrl(tab?.url || '');
    if (!sourceUrl) {
        return { ok: false, error: 'No readable PDF URL found in the active tab' };
    }

    if (sourceUrl.startsWith('file://')) {
        const allowed = await isAllowedFileSchemeAccess();
        if (!allowed) {
            return { ok: false, error: 'FILE_ACCESS_DISABLED' };
        }
    }

    try {
        const response = await fetch(sourceUrl, { credentials: 'include' });
        if (!response.ok) {
            return { ok: false, error: `HTTP ${response.status}` };
        }
        const blob = await response.blob();
        const mimeType = blob.type || 'application/pdf';
        const looksLikePdf = /pdf/i.test(mimeType) || /\.pdf(\?|#|$)/i.test(sourceUrl);
        if (!looksLikePdf) {
            return { ok: false, error: 'Current tab content is not a PDF' };
        }
        const fileDataBase64 = await blobToBase64(blob);
        return {
            ok: true,
            fileDataBase64,
            fileName: filenameFromUrl(sourceUrl),
            mimeType,
            sourceUrl,
        };
    } catch (e) {
        return { ok: false, error: e?.message || 'Could not fetch PDF from active tab URL' };
    }
}

async function startPipelineFromCurrentTabPdf(pageUrl, pdfUrl = null, detectedSourceTitle = null) {
    const btn = document.getElementById('btn-upload-start') || document.getElementById('btn-start');
    if (btn) { btn.disabled = true; btn.textContent = 'Reading current PDF...'; }

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('No active tab');
        const pageTitle = detectedSourceTitle || await detectSourceTitleFromTab(tab);

        let payload = await tryDirectTabPdfRead(tab, pdfUrl);

        // Fallback path for pages where URL doesn't expose the actual PDF.
        if (!payload?.ok || !payload.fileDataBase64) {
            const injected = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: async (preferredPdfUrl) => {
                    const pickCandidateUrl = () => {
                        const embed = document.querySelector('embed[type="application/pdf"]');
                        if (embed?.src) return embed.src;
                        const iframePdf = document.querySelector('iframe[src*=".pdf"]');
                        if (iframePdf?.src) return iframePdf.src;
                        return window.location.href;
                    };

                    const toBase64 = (blob) => new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const result = String(reader.result || '');
                            const commaIdx = result.indexOf(',');
                            resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result);
                        };
                        reader.onerror = () => reject(reader.error || new Error('Failed to read PDF blob'));
                        reader.readAsDataURL(blob);
                    });

                    const filenameFromUrl = (url) => {
                        try {
                            const u = new URL(url, window.location.href);
                            const raw = u.pathname.split('/').pop() || '';
                            const decoded = decodeURIComponent(raw);
                            if (decoded && /\.pdf$/i.test(decoded)) return decoded;
                        } catch (_) { /* ignore */ }
                        return 'local-upload.pdf';
                    };

                    const sourceUrl = /^https?:\/\//i.test(preferredPdfUrl || '')
                        ? preferredPdfUrl
                        : pickCandidateUrl();
                    try {
                        const response = await fetch(sourceUrl, { credentials: 'include' });
                        if (!response.ok) {
                            return { ok: false, error: `HTTP ${response.status}` };
                        }
                        const blob = await response.blob();
                        const mimeType = blob.type || 'application/pdf';
                        const looksLikePdf = /pdf/i.test(mimeType) || /\.pdf(\?|#|$)/i.test(sourceUrl);
                        if (!looksLikePdf) {
                            return { ok: false, error: 'Current tab content is not a PDF' };
                        }
                        const fileDataBase64 = await toBase64(blob);
                        return {
                            ok: true,
                            fileDataBase64,
                            fileName: filenameFromUrl(sourceUrl),
                            mimeType,
                            sourceUrl,
                        };
                    } catch (e) {
                        return { ok: false, error: e?.message || 'Could not read current PDF from tab' };
                    }
                },
                args: [pdfUrl],
            });
            payload = injected?.[0]?.result;
        }

        if (!payload?.ok || !payload.fileDataBase64) {
            if (payload?.error === 'FILE_ACCESS_DISABLED') {
                showFileAccessHint();
            }
            throw new Error(payload?.error || 'Could not read current PDF from tab');
        }

        const selectedTitle = choosePdfTitle({
            payload: payload.fileDataBase64,
            pageTitle,
            filename: payload.fileName,
        });
        console.log(`[Popup] Notebook title source: ${selectedTitle.source}`);

        if (btn) { btn.textContent = 'Uploading...'; }
        await chrome.runtime.sendMessage({
            type: 'START_PIPELINE_FILE',
            fileName: payload.fileName || 'local-upload.pdf',
            mimeType: payload.mimeType || 'application/pdf',
            fileDataBase64: payload.fileDataBase64,
            pageUrl: pageUrl || payload.sourceUrl || null,
            sourceTitle: selectedTitle.title,
        });
        await new Promise(r => setTimeout(r, 300));
        const state = await getState();
        renderProgress(state);
        startPolling();
    } catch (err) {
        console.warn('[Popup] Direct local PDF read failed, falling back to file picker:', err?.message || err);
        if (btn) {
            btn.disabled = false;
            btn.textContent = btn.id === 'btn-start' ? '🎧 Generate Artifacts' : 'Use Current PDF and Generate';
        }
        promptForPdfUpload(pageUrl);
    }
}

function promptForPdfUpload(pageUrl) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,application/pdf';
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        await startPipelineFile(file, pageUrl);
    });
    input.click();
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const commaIdx = result.indexOf(',');
            resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

// =========================================================================
// State polling
// =========================================================================

let pollInterval = null;
let pollInFlight = false;
let pollingEnabled = false;

function startPolling() {
    if (pollingEnabled) return;
    pollingEnabled = true;
    const tick = async () => {
        if (!pollingEnabled || pollInFlight) return;
        pollInFlight = true;
        try {
            const state = await getState();
            renderProgress(state);
            if (state.status !== 'running') {
                stopPolling();
                return;
            }
            if (pollingEnabled) {
                pollInterval = setTimeout(tick, 2000);
            }
        } catch (_) {
            if (pollingEnabled) {
                pollInterval = setTimeout(tick, 2000);
            }
        } finally {
            pollInFlight = false;
        }
    };
    pollInterval = setTimeout(tick, 0);
}

function stopPolling() {
    pollingEnabled = false;
    if (pollInterval) {
        clearTimeout(pollInterval);
    }
    pollInterval = null;
    pollInFlight = false;
}

async function getState() {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, response => {
            resolve(response || { status: 'idle' });
        });
    });
}

// =========================================================================
// Utils
// =========================================================================

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

window.addEventListener('unload', stopPolling);

init();
