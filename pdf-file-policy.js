export const MAX_PDF_UPLOAD_BYTES = 32 * 1024 * 1024;

export function decodedBase64ByteLength(value) {
  if (typeof value !== 'string') return 0;
  const payload = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const compact = payload.replace(/\s+/g, '');
  if (!compact) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

export function pdfSizeError(size, limit = MAX_PDF_UPLOAD_BYTES) {
  const limitMiB = Math.floor(limit / (1024 * 1024));
  const actualMiB = Number.isFinite(size) ? (size / (1024 * 1024)).toFixed(1) : 'unknown';
  const error = new Error(
    `This PDF is ${actualMiB} MiB. ScholarRelay local uploads are limited to ${limitMiB} MiB ` +
    'to keep Chrome memory use safe. Use the PDF URL directly or choose a smaller file.'
  );
  error.code = 'PDF_TOO_LARGE';
  return error;
}

export function assertPdfUploadSize(size, limit = MAX_PDF_UPLOAD_BYTES) {
  if (!Number.isFinite(size) || size < 0 || size > limit) throw pdfSizeError(size, limit);
  return size;
}

export async function readResponseWithinLimit(response, limit = MAX_PDF_UPLOAD_BYTES) {
  const contentLengthHeader = response?.headers?.get?.('content-length');
  if (contentLengthHeader !== null && contentLengthHeader !== undefined && contentLengthHeader !== '') {
    try {
      assertPdfUploadSize(Number(contentLengthHeader), limit);
    } catch (error) {
      try { await response?.body?.cancel?.('PDF exceeds the safe local upload limit'); } catch {}
      throw error;
    }
  }
  if (!response?.body?.getReader) {
    const error = new Error('The PDF response cannot be streamed safely in this browser. Use URL import instead.');
    error.code = 'PDF_STREAM_UNAVAILABLE';
    throw error;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel('PDF exceeds the safe local upload limit'); } catch {}
        throw pdfSizeError(total, limit);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function hasPdfSignature(payload) {
  let bytes;
  if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload);
  else if (ArrayBuffer.isView(payload)) bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  else return false;

  const scanLength = Math.min(bytes.length, 1024);
  for (let i = 0; i <= scanLength - 5; i += 1) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 &&
        bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

export function hasBase64PdfSignature(value) {
  if (typeof value !== 'string') return false;
  const payload = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const compact = payload.replace(/\s+/g, '');
  if (!compact) return false;
  const prefixLength = Math.min(compact.length, 2048);
  const alignedLength = prefixLength - (prefixLength % 4);
  try {
    const binary = atob(compact.slice(0, alignedLength || prefixLength));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return hasPdfSignature(bytes);
  } catch {
    return false;
  }
}
