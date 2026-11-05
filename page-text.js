export function canRecoverPageText(job) {
    const failure = job?.pageTextFailure;
    let host;
    try { host = new URL(failure?.url).hostname; } catch (_) { return false; }
    return job?.status === 'error' && job.sourceType === 'webpage' && Number.isInteger(job.pageTabId) &&
        job.importMethod === 'url' && !job.pageTextClaimed && !job.notebookDeletedAt &&
        !['deleting', 'unknown'].includes(job.cleanupStatus) && !!job.notebookId &&
        failure?.rpcCode === 9 && failure.diagnostic === 1 && typeof failure.sourceId === 'string' &&
        failure.url === job.pdfUrl && failure.url === job.pageUrl && /^https?:\/\//.test(failure.url) &&
        !/\.pdf(?:[?#]|$)/i.test(failure.url) && !/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host);
}

// This function is injected as a standalone function into the selected tab.
// Read only the existing top-frame DOM, after explicit consent and permission.
export function extractPageText(expectedUrl, allowBody = false) {
    const current = new URL(document.URL);
    if (!['http:', 'https:'].includes(current.protocol) || current.href !== new URL(expectedUrl).href) throw new Error('PAGE_TEXT_CHANGED');
    const root = document.querySelector('article, main') || (allowBody ? document.body : null);
    if (!root || document.querySelector('iframe[src*="captcha"], #challenge-form, .cf-challenge')) throw new Error('PAGE_TEXT_UNREADABLE');
    const excluded = 'script,style,noscript,nav,header,footer,aside,form,input,textarea,select,button,iframe,object,embed,video,audio,link,[hidden],[aria-hidden="true"]';
    const parts = []; let count = 0, bytes = 0;
    const append = text => {
        bytes += new TextEncoder().encode(text).length;
        if (bytes > 198000) throw new Error('PAGE_TEXT_TOO_LARGE');
        parts.push(text);
    };
    function visit(node, depth = 0) {
        if (++count > 10000 || depth > 128) throw new Error('PAGE_TEXT_TOO_LARGE');
        if (node.nodeType === 3) { append(node.textContent); return; }
        if (node.nodeType !== 1 || node.matches(excluded)) return;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') return;
        const tag = node.localName;
        if (tag === 'img') {
            const alt = (node.alt || '').replace(/[[\]\s]+/g, ' ').trim();
            if (/^https?:/.test(node.currentSrc || node.src) && (alt || node.width >= 100)) append(`![${alt}](${node.currentSrc || node.src})`);
            return;
        }
        const block = !style.display.startsWith('inline');
        const href = tag === 'a' && /^https?:/.test(node.href) ? node.href : '';
        if (block) append('\n' + (/^h[1-6]$/.test(tag) ? '#'.repeat(+tag[1]) + ' ' : tag === 'li' ? '- ' : tag === 'pre' ? '```\n' : ''));
        if (href) append('[');
        for (const child of node.childNodes) visit(child, depth + 1);
        if (href) append(`](${href})`);
        if (tag === 'pre') append('\n```');
        if (tag === 'td' || tag === 'th') append(' | ');
        if (block) append('\n');
    }
    // A hidden ancestor must not make its article eligible.
    for (let parent = root; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.matches('[hidden],[aria-hidden="true"]') || style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') throw new Error('PAGE_TEXT_UNREADABLE');
    }
    visit(root);
    const text = parts.join('').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 300 || /^(access denied|verify you are human|sign in to continue|just a moment)/i.test(text) ||
        /captcha|verify you are human|checking your browser/i.test(document.title)) throw new Error('PAGE_TEXT_UNREADABLE');
    current.hash = ''; current.search = ''; current.username = ''; current.password = '';
    const capturedAt = new Date().toISOString();
    const content = `Page text from browser tab\n${current.href}\nCaptured ${capturedAt}\n\n${text}`;
    if (new TextEncoder().encode(content).length > 200000) throw new Error('PAGE_TEXT_TOO_LARGE');
    return { content, title: document.title.slice(0, 300), capturedAt };
}
