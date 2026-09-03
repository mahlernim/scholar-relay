// Self-contained so Chrome can inject this function into the active tab.
export function inspectPaperPage(doc = null, pageUrl = null, publish = false) {
    doc ||= document;
    pageUrl ||= location.href;
    const clean = value => {
        if (typeof value !== 'string') return null;
        const title = String(value || '').replace(/\s+/g, ' ').trim()
            .replace(/^Title:\s*/i, '').replace(/^\[[\d.]+(?:v\d+)?\]\s*/, '')
            .replace(/\s*\|\s*(?:arXiv(?:\.org)?|PLOS One|eLife|The BMJ|Nature|Frontiers).*$/i, '')
            .replace(/^Frontiers\s*\|\s*/i, '').trim();
        if (title.length < 4 || /^(?:https?|file|blob|chrome-extension):/i.test(title) ||
            /\.pdf(?:[?#].*)?$/i.test(title) || /^[\d.]+(?:v\d+)?$/.test(title) ||
            /^(?:untitled|download|document|article|paper|full[- ]?text|home)$/i.test(title) ||
            /^(?:log[ -]?in|sign[ -]?in|access denied|client challenge|just a moment|checking your browser|verify (?:you are|you're) human)(?:\b|$)/i.test(title)) return null;
        return title.substring(0, 300);
    };
    const absolute = value => {
        if (typeof value !== 'string' || !value.trim()) return null;
        try { const u = new URL(value, pageUrl); return /^https?:$/.test(u.protocol) ? u.href : null; }
        catch { return null; }
    };
    const meta = Array.from(doc.querySelectorAll('meta')).map(el => ({
        key: (el.getAttribute('name') || el.getAttribute('property') || '').toLowerCase(),
        value: el.getAttribute('content') || '',
    }));
    const values = key => meta.filter(item => item.key === key).map(item => item.value);
    const candidates = ['citation_title', 'bepress_citation_title', 'prism.title', 'dc.title', 'dcterms.title']
        .flatMap(values);
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        if ((script.textContent || '').length > 200000) continue;
        try {
            const queue = [JSON.parse(script.textContent)];
            let inspected = 0;
            while (queue.length && inspected++ < 1000) {
                const node = queue.shift();
                if (!node || typeof node !== 'object') continue;
                if (Array.isArray(node)) { queue.push(...node); continue; }
                const types = [].concat(node['@type'] || []);
                if (types.some(type => /^(?:ScholarlyArticle|Article|MedicalScholarlyArticle)$/.test(type))) {
                    candidates.push(node.headline, node.name);
                }
                if (node['@graph']) queue.push(node['@graph']);
                if (node.mainEntity) queue.push(node.mainEntity);
            }
        } catch { /* Malformed structured data is not a title. */ }
    }
    candidates.push(...values('og:title'));
    candidates.push(doc.querySelector('h1.title, h1.article-title, h1')?.textContent, doc.title);
    const isPdfDocument = /application\/pdf/i.test(doc.contentType || '');
    const sourceTitle = isPdfDocument ? null : candidates.map(clean).find(Boolean) || null;
    let pdfUrl = null;
    let source = null;
    const arxiv = pageUrl.match(/^https?:\/\/(?:www\.)?arxiv\.org\/(abs|html|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#].*)?$/i);
    if (arxiv) {
        pdfUrl = `https://arxiv.org/pdf/${arxiv[2]}`;
        source = arxiv[1] === 'abs' ? 'arxiv_abstract' : `arxiv_${arxiv[1]}`;
    } else if (/\.pdf(?:[?#]|$)/i.test(pageUrl) || isPdfDocument) {
        pdfUrl = pageUrl;
        source = isPdfDocument ? 'pdf_content_type' : 'direct_pdf_url';
    } else {
        pdfUrl = values('citation_pdf_url').map(absolute).find(Boolean) || null;
        if (pdfUrl) source = 'citation_pdf_url';
        if (!pdfUrl) {
            const links = Array.from(doc.querySelectorAll('a[href], link[type="application/pdf"]')).map(el => {
                const href = absolute(el.getAttribute('href'));
                const label = `${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`.trim();
                const supplementary = /(?:[-_/](?:figures?|supplement\w*|supporting)[-_.\/]|\b(?:figures? only|supplement\w*|supporting information)\b)/i.test(`${href || ''} ${label}`);
                const pdf = /\.pdf(?:[?#]|$)|\/pdf(?:[/?#]|$)/i.test(href || '') || /\bpdf\b/i.test(label) || el.getAttribute('type') === 'application/pdf';
                return { href, label, supplementary, pdf, score: /(?:download|full[ -]?text|article).*pdf|pdf.*(?:download|full[ -]?text|article)/i.test(label) ? 2 : 1 };
            }).filter(link => link.href && link.pdf && !link.supplementary).sort((a, b) => b.score - a.score);
            pdfUrl = links[0]?.href || null;
            if (pdfUrl) source = 'pdf_link';
        }
        if (!pdfUrl) {
            const embedded = doc.querySelector('embed[type="application/pdf"]');
            pdfUrl = embedded ? absolute(embedded.getAttribute('src')) : null;
            if (pdfUrl) source = 'pdf_content_type';
        }
    }
    const result = { isPdf: !!pdfUrl, pdfUrl, pageUrl, source, sourceTitle, pdfEvidence: source };
    if (publish) chrome.runtime.sendMessage({ type: 'DETECT_PDF', data: result }).catch(() => {});
    return result;
}
