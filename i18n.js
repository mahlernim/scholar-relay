// Source-English keys keep call sites readable. Catalog generation checks collisions.
export function messageKey(source) {
    let hash = 2166136261;
    for (const char of source) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return `ui_${(hash >>> 0).toString(16)}`;
}

export function t(source, substitutions = []) {
    const values = substitutions.map(String);
    const translated = globalThis.chrome?.i18n?.getMessage(messageKey(source), values);
    return translated || source.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] ?? '');
}

// Only run before dynamic/user content is inserted. Never translate document titles,
// collection names, URLs, prompts, protocol values or diagnostic strings by guessing.
export function localizeStaticDocument(doc = document) {
    doc.documentElement.lang = globalThis.chrome?.i18n?.getUILanguage() || 'en';
    const walker = doc.createTreeWalker(doc.body, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement.closest('script, style')) continue;
        const source = node.textContent.trim();
        if (source) node.textContent = node.textContent.replace(source, () => t(source));
    }
    for (const el of doc.querySelectorAll('[title], [placeholder], [aria-label]')) {
        for (const attr of ['title', 'placeholder', 'aria-label']) {
            if (el.hasAttribute(attr)) el.setAttribute(attr, t(el.getAttribute(attr)));
        }
    }
    // Toggle labels contain only a decorative track in the original markup.
    for (const input of doc.querySelectorAll('input[type="checkbox"]')) {
        if (input.hasAttribute('aria-label')) continue;
        const row = input.closest('.s-section-header, .s-toggle-row');
        const label = row?.querySelector('.s-section-title, .s-toggle-label');
        if (label) input.setAttribute('aria-label', label.textContent.trim());
    }
}

export function artifactLabel(type) {
    return t({
        audio: '🎧 Audio Overview', video: '🎬 Video Overview', report: '📄 Report',
        quiz: '❓ Quiz', flashcards: '🃏 Flashcards', infographic: '🖼 Infographic',
        slide_deck: '📊 Slide Deck', mind_map: '🧠 Mind Map', data_table: '📋 Data Table',
    }[type] || 'Artifact');
}

export function artifactStatusLabel(status) {
    return t({ completed: 'Ready', failed: 'Failed', in_progress: 'Generating',
        pending: 'Waiting', uncertain: 'Needs checking' }[status] || 'Waiting');
}

export function progressDetail(state) {
    // Presentation is derived from stable state, so old saved English states work too.
    if (state.step === 'wait_artifacts') {
        const tasks = state.tasks || [];
        const summary = t('$1 of $2 artifacts ready.', [tasks.filter(task => task.status === 'completed').length, tasks.length]);
        const details = tasks.map(task => `${artifactLabel(task.type)} · ${artifactStatusLabel(task.status)}`);
        const started = Date.parse(state.stepStartedAt);
        if (Number.isFinite(started)) details.push(t('Elapsed time: $1 min.', [Math.max(0, Math.round((Date.now() - started) / 60000))]));
        return [summary, ...details].join('\n');
    }
    return t({
        auth: 'Connecting to Gemini Notebook...',
        create_notebook: 'Creating notebook...',
        add_source: 'Adding source...',
        download_pdf: 'Downloading PDF...',
        upload_pdf: 'Uploading PDF...',
        wait_source: 'Waiting for source processing. Checking about every 30 seconds.',
        generate_artifacts: 'Requesting artifacts...',
        done: 'Workflow complete.',
    }[state.step] || 'Work in progress...');
}

export function errorSummary(detail) {
    const text = String(detail || '');
    const source = /isn't a valid PDF|not a PDF|not a valid PDF|PDF signature/i.test(text)
        ? "This file isn't a valid PDF. Choose another file."
        : /unknown|uncertain|unconfirmed|timed? ?out|timeout|no source ID|did not respond|malformed|interrupted|avoid duplicate/i.test(text)
        ? 'The result could not be confirmed. Check Gemini Notebook before starting again.'
        : /40 MiB|too large|size limit/i.test(text)
        ? 'This PDF exceeds the upload limit. Upload it directly in Gemini Notebook.'
        : /sign.?in|authentication|logged in/i.test(text)
        ? 'Sign in to Gemini Notebook, then reopen this popup.'
        : /quota|rate.?limit/i.test(text)
        ? 'Gemini Notebook has reached a limit. Wait before starting more work.'
        : /at least one artifact/i.test(text)
        ? 'Choose at least one artifact in Settings before starting.'
        : /already (active|running)|Stop the active pipeline|not idle/i.test(text)
        ? 'A workflow is already active. Check its progress before starting another.'
        : /file access|Allow access to file URLs|FILE_ACCESS_DISABLED/i.test(text)
        ? 'Enable Allow access to file URLs in Chrome extension settings, or choose Upload Local PDF.'
        : 'This workflow needs attention. Check the details before continuing.';
    return t(source);
}
