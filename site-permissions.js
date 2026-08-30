export function httpOriginPattern(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/*`;
  } catch (_) {
    return null;
  }
}

export function sameHttpOrigin(firstUrl, secondUrl) {
  try {
    const first = new URL(firstUrl);
    const second = new URL(secondUrl);
    if (!['http:', 'https:'].includes(first.protocol)) return false;
    return first.origin === second.origin;
  } catch (_) {
    return false;
  }
}

export function needsOptionalPdfAccess(pageUrl, pdfUrl) {
  const pattern = httpOriginPattern(pdfUrl);
  return !!pattern && !sameHttpOrigin(pageUrl, pdfUrl);
}
