// Best-effort metadata only. Content outside these windows uses fallback naming.
const PDF_METADATA_WINDOW_BYTES = 256 * 1024;

function byteWindows(bytes) {
  const size = PDF_METADATA_WINDOW_BYTES;
  return bytes.length <= size * 2 ? [bytes] : [bytes.subarray(0, size), bytes.subarray(-size)];
}

function bytesFromPayload(payload) {
  if (payload instanceof Uint8Array) return byteWindows(payload);
  if (payload instanceof ArrayBuffer) return byteWindows(new Uint8Array(payload));
  if (typeof payload === 'string') {
    const compact = (payload.includes(',') ? payload.slice(payload.indexOf(',') + 1) : payload).replace(/\s+/g, '');
    // Quartet alignment bounds decoding, including the final padded quartet.
    const chars = Math.ceil(PDF_METADATA_WINDOW_BYTES / 3) * 4;
    const parts = compact.length <= chars * 2 ? [compact] : [compact.slice(0, chars), compact.slice(-chars)];
    return parts.map(part => {
      const binary = atob(part);
      return Uint8Array.from(binary, char => char.charCodeAt(0));
    });
  }
  return [];
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function decodePdfLiteral(value) {
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') {
      bytes.push(value.charCodeAt(i) & 0xff);
      continue;
    }

    const next = value[++i];
    if (next === undefined) break;
    const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (Object.hasOwn(escapes, next)) {
      bytes.push(escapes[next]);
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(value[i + 1] || '')) octal += value[++i];
      bytes.push(parseInt(octal, 8));
    } else if (next !== '\n' && next !== '\r') {
      bytes.push(next.charCodeAt(0) & 0xff);
    }
  }

  const raw = new Uint8Array(bytes);
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    let result = '';
    for (let i = 2; i + 1 < raw.length; i += 2) {
      result += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
    }
    return result;
  }
  return new TextDecoder('windows-1252').decode(raw);
}

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().substring(0, 300);
}

function isUsefulTitle(value) {
  const title = normalizeTitle(value);
  if (title.length < 4) return false;
  if (/^(?:https?|file|blob|chrome-extension):/i.test(title)) return false;
  if (/^(?:untitled|download|document|article|paper|full[-_ ]?text|local[-_ ]?upload)(?:\s*\d+)?(?:\.pdf)?$/i.test(title)) return false;
  if (/^[^\s]+\.pdf(?:[?#].*)?$/i.test(title)) return false;
  return true;
}

function extractPdfMetadataTitle(payload) {
  return titleFromWindows(bytesFromPayload(payload));
}

function titleFromWindows(windows) {
  // Preserve XMP precedence across both windows, without joining unrelated bytes.
  for (const bytes of windows) {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const dcTitle = utf8.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1];
    const xmpValue = dcTitle?.match(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/i)?.[1] || dcTitle;
    const xmpTitle = normalizeTitle(decodeXmlText(xmpValue));
    if (isUsefulTitle(xmpTitle)) return xmpTitle;
  }

  const decoded = windows.map(bytes => new TextDecoder('windows-1252').decode(bytes));
  for (const latin1 of decoded) {
    const literalMatch = latin1.match(/\/Title\s*\(((?:\\.|[^\\)])*)\)/s);
    const literalTitle = normalizeTitle(literalMatch ? decodePdfLiteral(literalMatch[1]) : '');
    if (isUsefulTitle(literalTitle)) return literalTitle;
  }

  for (const latin1 of decoded) {
    const hexMatch = latin1.match(/\/Title\s*<([0-9a-f\s]+)>/i);
    if (hexMatch) {
      const hex = hexMatch[1].replace(/\s+/g, '');
      const hexBytes = new Uint8Array((hex.length / 2) | 0);
      for (let i = 0; i < hexBytes.length; i++) hexBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      const hexTitle = normalizeTitle(decodePdfLiteral(Array.from(hexBytes, byte => String.fromCharCode(byte)).join('')));
      if (isUsefulTitle(hexTitle)) return hexTitle;
    }
  }

  return null;
}

async function choosePdfFileTitle({ file, pageTitle } = {}) {
  const normalizedPageTitle = normalizeTitle(pageTitle);
  if (isUsefulTitle(normalizedPageTitle)) return { title: normalizedPageTitle, source: 'page_metadata' };
  const size = PDF_METADATA_WINDOW_BYTES;
  const slices = file.size <= size * 2 ? [file] : [file.slice(0, size), file.slice(-size)];
  const windows = await Promise.all(slices.map(async slice => new Uint8Array(await slice.arrayBuffer())));
  const title = titleFromWindows(windows);
  if (title) return { title, source: 'pdf_metadata' };
  return choosePdfTitle({ filename: file.name });
}

function titleFromFilename(filename) {
  let stem = String(filename || '').replace(/\.pdf$/i, '');
  try { stem = decodeURIComponent(stem); } catch (_) { /* keep original */ }
  stem = normalizeTitle(stem.replace(/[_]+/g, ' ').replace(/\s+-\s+/g, ' '));
  const wordCount = (stem.match(/[\p{L}]{3,}/gu) || []).length;
  return wordCount >= 2 && isUsefulTitle(stem) ? stem : null;
}

function choosePdfTitle({ payload, pageTitle, filename } = {}) {
  const normalizedPageTitle = normalizeTitle(pageTitle);
  if (isUsefulTitle(normalizedPageTitle)) return { title: normalizedPageTitle, source: 'page_metadata' };

  const metadataTitle = extractPdfMetadataTitle(payload);
  if (metadataTitle) return { title: metadataTitle, source: 'pdf_metadata' };

  const filenameTitle = titleFromFilename(filename);
  if (filenameTitle) return { title: filenameTitle, source: 'filename' };

  return { title: null, source: 'notebooklm' };
}

export { choosePdfTitle, choosePdfFileTitle, extractPdfMetadataTitle, isUsefulTitle, titleFromFilename, PDF_METADATA_WINDOW_BYTES };
