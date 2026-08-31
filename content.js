/**
 * Content script: detects PDF URLs on the current page.
 * 
 * Detection strategies:
 * 1. Current page IS a PDF (Content-Type or .pdf extension)
 * 2. Links to PDFs on the page (e.g., arxiv abstract page -> PDF link)
 * 3. Known academic sites with predictable PDF URL patterns
 */

(function () {
    'use strict';

    // Avoid double-injection
    if (window.__pdfDetectorInjected) return;
    window.__pdfDetectorInjected = true;

    function detectSourceTitle() {
        const candidates = [
            document.querySelector('meta[name="citation_title"]')?.content,
            document.querySelector('meta[property="og:title"]')?.content,
            document.querySelector('h1.title')?.textContent?.replace(/^Title:\s*/i, ''),
            document.title,
        ];
        const title = candidates.find(value => typeof value === 'string' && value.trim());
        return title ? title.replace(/\s+/g, ' ').trim() : null;
    }

    /**
     * Detect if the current page is a PDF or has PDF links.
     * Returns { isPdf, pdfUrl, pageUrl, source }
     */
    function detectPdf() {
        const currentUrl = window.location.href;
        const pageUrl = currentUrl;
        const sourceTitle = detectSourceTitle();

        // Strategy 1: Current URL ends with .pdf
        if (/\.pdf(\?.*)?$/i.test(currentUrl)) {
            return { isPdf: true, pdfUrl: currentUrl, pageUrl, source: 'direct_pdf_url', sourceTitle };
        }

        // Strategy 2: Embedded PDF viewer (Chrome shows PDFs in <embed>)
        const embed = document.querySelector('embed[type="application/pdf"]');
        if (embed) {
            return { isPdf: true, pdfUrl: embed.src || currentUrl, pageUrl, source: 'embedded_pdf', sourceTitle };
        }

        // Strategy 3: arXiv abstract page -> construct PDF link
        // https://arxiv.org/abs/2511.12529 -> https://arxiv.org/pdf/2511.12529
        const arxivAbsMatch = currentUrl.match(/^https?:\/\/arxiv\.org\/abs\/([\d.]+)(v\d+)?/);
        if (arxivAbsMatch) {
            const arxivId = arxivAbsMatch[1] + (arxivAbsMatch[2] || '');
            const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
            return { isPdf: true, pdfUrl, pageUrl, source: 'arxiv_abstract', sourceTitle };
        }

        // Strategy 4: arXiv PDF page
        const arxivPdfMatch = currentUrl.match(/^https?:\/\/arxiv\.org\/pdf\/([\d.]+)/);
        if (arxivPdfMatch) {
            return { isPdf: true, pdfUrl: currentUrl, pageUrl, source: 'arxiv_pdf', sourceTitle };
        }

        // Strategy 5: Any link on the page that points to a PDF
        const pdfLinks = [];
        document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href;
            if (/\.pdf(\?.*)?$/i.test(href)) {
                pdfLinks.push({
                    url: href,
                    text: (a.textContent || '').trim().substring(0, 80),
                });
            }
        });

        // Special case: arXiv HTML page with PDF link
        const arxivPdfLink = document.querySelector('a[href*="/pdf/"]');
        if (arxivPdfLink && /arxiv\.org/.test(currentUrl)) {
            return {
                isPdf: true,
                pdfUrl: arxivPdfLink.href,
                pageUrl,
                source: 'arxiv_link',
                sourceTitle,
            };
        }

        if (pdfLinks.length > 0) {
            // Return the first PDF link found
            return {
                isPdf: true,
                pdfUrl: pdfLinks[0].url,
                pageUrl,
                source: 'page_link',
                sourceTitle,
                allPdfLinks: pdfLinks,
            };
        }

        return { isPdf: false, pdfUrl: null, pageUrl, source: null, sourceTitle };
    }

    // Run detection and send result to background
    const result = detectPdf();

    chrome.runtime.sendMessage({
        type: 'DETECT_PDF',
        data: result,
    }).catch(() => {
        // Extension context may be invalid, ignore
    });

    // Also listen for the popup asking for detection
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'REQUEST_PDF_DETECTION') {
            const result = detectPdf();
            sendResponse(result);
            return false;
        }
    });
})();
