/**
 * NotebookLM API client for Chrome Extension (service worker context).
 * 
 * Port of notebooklm-py RPC protocol to JavaScript.
 * Uses fetch() with credentials from browser cookies.
 */

const DEFAULT_BASE_URL = 'https://notebook.google.com';
const LEGACY_BASE_URL = 'https://notebooklm.google.com';
const PERSONAL_BASE_URLS = [DEFAULT_BASE_URL, LEGACY_BASE_URL];
let _baseUrl = DEFAULT_BASE_URL;

function appUrl(path = '/') {
  return `${_baseUrl}${path}`;
}

function getNotebookUrl(notebookId) {
  return appUrl(`/notebook/${notebookId}`);
}

// RPC Method IDs (reverse-engineered from notebooklm-py rpc/types.py)
const RPCMethod = {
  CREATE_NOTEBOOK: 'CCqFvf',
  GET_NOTEBOOK: 'rLM1Ne',
  DELETE_NOTEBOOK: 'WWINqb',
  ADD_SOURCE: 'izAoDd',
  ADD_SOURCE_FILE: 'o4cbdc',
  CREATE_ARTIFACT: 'R7cb6c',
  LIST_ARTIFACTS: 'gArtLc',
  GENERATE_MIND_MAP: 'yyryJe',
  CREATE_NOTE: 'CYK0Xb',
  UPDATE_NOTE: 'cYAfTb',
  LIST_LABELS: 'I3xc3c',
  UPDATE_LABEL: 'le8sX',
};

// Artifact type codes (from notebooklm-py rpc/types.py ArtifactTypeCode)
const ArtifactTypeCode = {
  AUDIO: 1,
  REPORT: 2,      // Briefing Doc, Study Guide, Blog Post, Custom
  VIDEO: 3,
  QUIZ: 4,        // also used for Flashcards
  MIND_MAP: 5,
  INFOGRAPHIC: 7,
  SLIDE_DECK: 8,
  DATA_TABLE: 9,
};

// Audio format options
const AudioFormat = {
  DEEP_DIVE: 1,
  BRIEF: 2,
  CRITIQUE: 3,
  DEBATE: 4,
};

// Audio length options
const AudioLength = {
  SHORT: 1,
  DEFAULT: 2,
  LONG: 3,
};

// Video format options
const VideoFormat = {
  EXPLAINER: 1,
  BRIEF: 2,
};

// Video visual style options
const VideoStyle = {
  AUTO_SELECT: 1,
  CUSTOM: 0,
  CLASSIC: 2,
  WHITEBOARD: 3,
  KAWAII: 9,
  ANIME: 7,
  WATERCOLOR: 6,
  RETRO_PRINT: 8,
  HERITAGE: 4,
  PAPER_CRAFT: 5,
};

// Quiz/flashcard quantity options
const QuizQuantity = {
  FEWER: 1,
  STANDARD: 2,
  MORE: 3,
};

// Quiz/flashcard difficulty options
const QuizDifficulty = {
  EASY: 1,
  MEDIUM: 2,
  HARD: 3,
};

// Report format strings
const ReportFormat = {
  BRIEFING_DOC: 'briefing_doc',
  STUDY_GUIDE: 'study_guide',
  BLOG_POST: 'blog_post',
  CUSTOM: 'custom',
};

// Slide deck format options
const SlideDeckFormat = {
  DETAILED_DECK: 1,
  PRESENTER_SLIDES: 2,
};

// Slide deck length options
const SlideDeckLength = {
  DEFAULT: 1,
  SHORT: 2,
};

// Infographic orientation options
const InfographicOrientation = {
  LANDSCAPE: 1,
  PORTRAIT: 2,
  SQUARE: 3,
};

// Infographic detail options
const InfographicDetail = {
  CONCISE: 1,
  STANDARD: 2,
  DETAILED: 3,
};

// Infographic visual style options. These values are distinct from VideoStyle.
const InfographicStyle = {
  AUTO_SELECT: 1,
  SKETCH_NOTE: 2,
  PROFESSIONAL: 3,
  BENTO_GRID: 4,
  EDITORIAL: 5,
  INSTRUCTIONAL: 6,
  BRICKS: 7,
  CLAY: 8,
  ANIME: 9,
  KAWAII: 10,
  SCIENTIFIC: 11,
};

// Artifact status codes
const ArtifactStatus = {
  UNKNOWN: 0,
  PENDING: 1,
  PROCESSING: 2,
  COMPLETED: 3,
  FAILED: 4,
  SUGGESTED: 5,
  PENDING_REVIEW: 6,
};

// Source status codes
const SourceStatus = {
  PROCESSING: 1,
  READY: 2,
  ERROR: 3,
  PREPARING: 5,
};

// =========================================================================
// Token management
// =========================================================================

let _csrfToken = null;
let _sessionId = null;
let _retrySleep = sleep;
let _mutationTimeoutMs = 15000;

const READ_ONLY_RPC_METHODS = new Set([
  RPCMethod.GET_NOTEBOOK,
  RPCMethod.LIST_ARTIFACTS,
  RPCMethod.LIST_LABELS,
]);

const MAX_READ_ATTEMPTS = 3;

function requestTemplateOptions() {
  return [
    2,
    null,
    null,
    [1, null, null, null, null, null, null, null, null, null, [1]],
  ];
}

function artifactClientOptions() {
  return [
    2,
    null,
    null,
    [1, null, null, null, null, null, null, null, null, null, [1]],
    [[1, 4, 8, 2, 3, 6]],
  ];
}

function collectionRequestOptions() {
  return [
    2,
    null,
    null,
    [1, null, null, null, null, null, null, null, null, null, [1, 3]],
  ];
}

/**
 * Fetch CSRF token (SNlM0e) and session ID (FdrFJe) from NotebookLM homepage.
 * Since we're in a Chrome extension, browser cookies are sent automatically.
 */
async function fetchTokens() {
  const candidates = [_baseUrl, ...PERSONAL_BASE_URLS.filter(url => url !== _baseUrl)];
  const failures = [];

  for (const baseUrl of candidates) {
    const homepageUrl = `${baseUrl}/`;
    try {
      const response = await fetch(homepageUrl, {
        credentials: 'include',
        redirect: 'follow',
      });

      if (!response.ok) {
        failures.push(`${baseUrl} returned HTTP ${response.status}`);
        continue;
      }

      const responseHost = new URL(response.url || homepageUrl).hostname;
      const allowedHosts = PERSONAL_BASE_URLS.map(url => new URL(url).hostname);
      if (!allowedHosts.includes(responseHost)) {
        failures.push(`${baseUrl} redirected to ${responseHost}`);
        continue;
      }

      const html = await response.text();
      const csrfMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
      const sessionMatch = html.match(/"FdrFJe"\s*:\s*"([^"]+)"/);
      if (!csrfMatch || !sessionMatch) {
        failures.push(`${baseUrl} did not provide an authenticated Gemini Notebook session`);
        continue;
      }

      _baseUrl = PERSONAL_BASE_URLS.find(
        url => new URL(url).hostname === responseHost
      ) || baseUrl;
      _csrfToken = csrfMatch[1];
      _sessionId = sessionMatch[1];

      console.log(`[NotebookLM API] Tokens fetched successfully from ${responseHost}`);
      return { csrfToken: _csrfToken, sessionId: _sessionId };
    } catch (error) {
      failures.push(`${baseUrl} failed: ${error?.message || 'request failed'}`);
    }
  }

  throw new Error(
    `AUTH_REQUIRED: Could not find an authenticated Gemini Notebook (formerly NotebookLM) session. Sign in at ${DEFAULT_BASE_URL} and retry. ${failures.join('. ')}`
  );
}

async function ensureTokens() {
  if (!_csrfToken || !_sessionId) {
    await fetchTokens();
  }
  return { csrfToken: _csrfToken, sessionId: _sessionId };
}

// =========================================================================
// RPC Encoding (matches notebooklm-py encoder.py)
// =========================================================================

function encodeRpcRequest(methodId, params) {
  const paramsJson = JSON.stringify(params);
  const inner = [methodId, paramsJson, null, 'generic'];
  return [[inner]];
}

function buildRequestBody(rpcRequest, csrfToken) {
  const fReq = JSON.stringify(rpcRequest);
  let body = `f.req=${encodeURIComponent(fReq)}`;
  if (csrfToken) {
    body += `&at=${encodeURIComponent(csrfToken)}`;
  }
  body += '&';
  return body;
}

function buildUrlParams(rpcMethodId, sourcePath = '/', sessionId = null) {
  const params = new URLSearchParams({
    rpcids: rpcMethodId,
    'source-path': sourcePath,
    hl: 'en',
    rt: 'c',
  });
  if (sessionId) {
    params.set('f.sid', sessionId);
  }
  return params;
}

// =========================================================================
// RPC Decoding (matches notebooklm-py decoder.py)
// =========================================================================

function stripAntiXssi(responseText) {
  if (responseText.startsWith(")]}'")) {
    const newlineIdx = responseText.indexOf('\n');
    if (newlineIdx !== -1) {
      return responseText.substring(newlineIdx + 1);
    }
  }
  return responseText;
}

function parseChunkedResponse(responseText) {
  if (!responseText || !responseText.trim()) return [];

  const chunks = [];
  const lines = responseText.trim().split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    // Try as byte count
    if (/^\d+$/.test(line)) {
      i++;
      if (i < lines.length) {
        try {
          chunks.push(JSON.parse(lines[i]));
        } catch (e) {
          console.warn(`[RPC] Skipping malformed chunk at line ${i + 1}`);
        }
      }
      i++;
    } else {
      try {
        chunks.push(JSON.parse(line));
      } catch (e) {
        console.warn(`[RPC] Skipping non-JSON line at ${i + 1}`);
      }
      i++;
    }
  }
  return chunks;
}

function extractRpcResult(chunks, rpcId) {
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;

    const items = (chunk.length > 0 && Array.isArray(chunk[0])) ? chunk : [chunk];

    for (const item of items) {
      if (!Array.isArray(item) || item.length < 3) continue;

      // Check for error
      if (item[0] === 'er' && item[1] === rpcId) {
        const errorCode = item.length > 2 ? item[2] : null;
        const error = new Error(`RPC error for ${rpcId}: code=${errorCode}`);
        error.code = 'RPC_REJECTED';
        error.rpcCode = errorCode;
        throw error;
      }

      // Check for success
      if (item[0] === 'wrb.fr' && item[1] === rpcId) {
        let resultData = item[2];

        // Check for rate limit (UserDisplayableError in item[5])
        if (resultData === null && item.length > 5 && item[5] !== null) {
          const serialized = JSON.stringify(item[5]);
          if (serialized.includes('UserDisplayableError')) {
            throw new Error('RATE_LIMITED: API rate limit or quota exceeded.');
          }
        }

        if (typeof resultData === 'string') {
          try { return JSON.parse(resultData); } catch { return resultData; }
        }
        return resultData;
      }
    }
  }
  return null;
}

function decodeResponse(rawResponse, rpcId, allowNull = false) {
  const cleaned = stripAntiXssi(rawResponse);
  const chunks = parseChunkedResponse(cleaned);
  const result = extractRpcResult(chunks, rpcId);

  if (result === null && !allowNull) {
    throw new Error(`No result found for RPC ID: ${rpcId}`);
  }
  return result;
}

function extractFirstIdFromResult(result) {
  const MAX_DEPTH = 8;
  const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;
  const visited = new Set();

  function walk(node, depth = 0) {
    if (node === null || node === undefined) return null;
    if (depth >= MAX_DEPTH) return null;

    if (visited.has(node)) return null;
    if (typeof node === 'object' && typeof node !== 'string') {
      visited.add(node);
    }

    if (typeof node === 'string') {
      const value = node.trim();
      if (!value) return null;

      const notebookMatch = value.match(/notebook\/([A-Za-z0-9_-]{10,})/i);
      if (notebookMatch) return notebookMatch[1];

      const sourceMatch = value.match(/source\/([A-Za-z0-9_-]{10,})/i);
      if (sourceMatch) return sourceMatch[1];

      if (ID_PATTERN.test(value)) return value;

      if (value.startsWith('{') || value.startsWith('[')) {
        try {
          const parsed = JSON.parse(value);
          const parsedId = walk(parsed, depth + 1);
          if (parsedId) return parsedId;
        } catch {
          return null;
        }
      }

      return null;
    }

    if (typeof node === 'number') {
      const value = String(node);
      if (ID_PATTERN.test(value)) return value;
      if (value.length >= 10) return value;
      return null;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = walk(entry, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof node === 'object') {
      const keys = ['id', 'notebookId', 'notebook_id', 'uuid', 'value', 'uid'];
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          const found = walk(node[key], depth + 1);
          if (found) return found;
        }
      }

      for (const value of Object.values(node)) {
        const found = walk(value, depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(result, 0);
}

// =========================================================================
// Core RPC call
// =========================================================================

function retryDelayMs(response, failedAttempt) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10000);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), 10000);
    }
  }
  return Math.min(1000 * (2 ** failedAttempt), 10000);
}

function mutationUncertainError(methodId, detail) {
  const error = new Error(
    `TRANSIENT_MUTATION_UNCERTAIN: ${detail} The ${methodId} request was not retried to avoid creating duplicate data.`
  );
  error.code = 'TRANSIENT_MUTATION_UNCERTAIN';
  return error;
}

async function rpcCall(methodId, params, sourcePath = '/', allowNull = false) {
  const isReadOnly = READ_ONLY_RPC_METHODS.has(methodId);
  const maxAttempts = isReadOnly ? MAX_READ_ATTEMPTS : 1;
  let transientAttempt = 0;
  let authRetried = false;

  while (transientAttempt < maxAttempts) {
    const { csrfToken, sessionId } = await ensureTokens();
    const rpcRequest = encodeRpcRequest(methodId, params);
    const body = buildRequestBody(rpcRequest, csrfToken);
    const urlParams = buildUrlParams(methodId, sourcePath, sessionId);
    const url = `${appUrl('/_/LabsTailwindUi/data/batchexecute')}?${urlParams.toString()}`;

    let response;
    let responseText;
    const abortController = !isReadOnly && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    let timeoutId = abortController
      ? setTimeout(() => abortController.abort(), _mutationTimeoutMs)
      : null;
    try {
      response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
        ...(abortController ? { signal: abortController.signal } : {}),
      });

      // Receiving headers confirms that NotebookLM accepted the request. Stop
      // the transport abort timer so a slow streamed body cannot cancel a
      // mutation that the server is still committing.
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (response.ok) {
        if (isReadOnly) {
          responseText = await response.text();
        } else {
          let bodyTimeoutId;
          try {
            responseText = await Promise.race([
              response.text(),
              new Promise((resolve, reject) => {
                bodyTimeoutId = setTimeout(() => {
                  const timeoutError = new Error('Mutation response body timed out');
                  timeoutError.name = 'MutationResponseTimeout';
                  reject(timeoutError);
                }, _mutationTimeoutMs);
              }),
            ]);
          } finally {
            if (bodyTimeoutId !== undefined) clearTimeout(bodyTimeoutId);
          }
        }
      }
    } catch (error) {
      if (!isReadOnly) {
        const detail = error?.name === 'AbortError' || error?.name === 'MutationResponseTimeout'
          ? `No complete response was received within ${Math.round(_mutationTimeoutMs / 1000)} seconds.`
          : `Network failure: ${error?.message || 'request failed'}.`;
        throw mutationUncertainError(methodId, detail);
      }
      transientAttempt++;
      if (transientAttempt >= maxAttempts) {
        throw new Error(`NETWORK_ERROR: ${methodId} failed after ${maxAttempts} attempts: ${error?.message || 'request failed'}`);
      }
      await _retrySleep(retryDelayMs(null, transientAttempt - 1));
      continue;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }

    if (response.status === 401 || response.status === 403) {
      if (authRetried) {
        throw new Error('AUTH_REQUIRED: Gemini Notebook authentication failed after refreshing the session. Sign in again and retry.');
      }
      authRetried = true;
      _csrfToken = null;
      _sessionId = null;
      await fetchTokens();
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (!isReadOnly) {
        throw mutationUncertainError(methodId, `Gemini Notebook returned HTTP ${response.status}.`);
      }
      transientAttempt++;
      if (transientAttempt >= maxAttempts) {
        throw new Error(`HTTP ${response.status}: ${methodId} failed after ${maxAttempts} attempts.`);
      }
      await _retrySleep(retryDelayMs(response, transientAttempt - 1));
      continue;
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
      error.httpStatus = response.status;
      throw error;
    }

    return decodeResponse(responseText, methodId, allowNull);
  }

  throw new Error(`RPC ${methodId} exhausted its retry budget.`);
}

// =========================================================================
// High-level API methods
// =========================================================================

/**
 * Create a new notebook with optional title.
 * Returns { id, title }
 */
async function createNotebook(title = '') {
  const params = [title, null, null, requestTemplateOptions()];
  const result = await rpcCall(RPCMethod.CREATE_NOTEBOOK, params);

  // Parse notebook from response
  // Response structure changed over time; keep extraction flexible.
  let notebookId = null;
  if (Array.isArray(result)) {
    notebookId = Array.isArray(result[0]) ? extractFirstIdFromResult(result[0]) : extractFirstIdFromResult(result);
  }

  if (!notebookId) {
    notebookId = extractFirstIdFromResult(result);
  }

  if (!notebookId) {
    console.warn('[NotebookLM API] Could not parse notebook ID from create response', result);
  }

  console.log(`[NotebookLM API] Created notebook: ${notebookId}`);
  return { id: notebookId, title };
}

/**
 * Delete a notebook.
 * Returns { ok: true }
 */
async function deleteNotebook(notebookId) {
  const params = [[notebookId], [2]];
  await rpcCall(RPCMethod.DELETE_NOTEBOOK, params, '/', true);
  console.log(`[NotebookLM API] Deleted notebook: ${notebookId}`);
  return { ok: true };
}

/**
 * List account-level NotebookLM collections.
 * Collections reuse the label RPCs with a null notebook parent and type 3.
 * Returns [{ id, name, emoji, notebookIds }].
 */
async function listCollections() {
  const params = [collectionRequestOptions(), null, 3];
  const result = await rpcCall(RPCMethod.LIST_LABELS, params, '/', true);
  if (!result) return [];
  if (!Array.isArray(result)) {
    throw new Error('COLLECTION_SCHEMA_CHANGED: Collection response was not a list.');
  }

  const rows = result.length > 1 ? result[1] : null;
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) {
    throw new Error('COLLECTION_SCHEMA_CHANGED: Collection rows were malformed.');
  }

  return rows.map((row, index) => {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[2] !== 'string') {
      throw new Error(`COLLECTION_SCHEMA_CHANGED: Collection row ${index + 1} was malformed.`);
    }
    const rawNotebookIds = row[1] ?? [];
    if (!Array.isArray(rawNotebookIds) || rawNotebookIds.some(id => typeof id !== 'string')) {
      throw new Error(`COLLECTION_SCHEMA_CHANGED: Collection membership row ${index + 1} was malformed.`);
    }
    if (row[3] !== null && row[3] !== undefined && typeof row[3] !== 'string') {
      throw new Error(`COLLECTION_SCHEMA_CHANGED: Collection emoji row ${index + 1} was malformed.`);
    }
    return {
      id: row[2],
      name: row[0],
      emoji: row[3] || null,
      notebookIds: [...rawNotebookIds],
    };
  });
}

/**
 * Add one notebook to an existing collection without retrying the mutation.
 * A read-before-write avoids duplicate membership, and a read-after-write
 * reconciles an uncertain response or a silent server-side no-op.
 */
async function addNotebookToCollection(collectionId, notebookId) {
  if (!collectionId || !notebookId) {
    throw new Error('A collection ID and notebook ID are required.');
  }

  const before = await listCollections();
  const target = before.find(collection => collection.id === collectionId);
  if (!target) {
    throw new Error('The selected collection no longer exists. Refresh the collection list and choose again.');
  }
  if (target.notebookIds.includes(notebookId)) {
    return { ...target, alreadyMember: true };
  }

  const params = [
    collectionRequestOptions(),
    null,
    collectionId,
    [[null, null, null, [[notebookId]]], []],
    3,
  ];

  try {
    await rpcCall(RPCMethod.UPDATE_LABEL, params, '/', true);
  } catch (error) {
    if (error?.code !== 'TRANSIENT_MUTATION_UNCERTAIN') throw error;
    const reconciled = (await listCollections()).find(collection => collection.id === collectionId);
    if (reconciled?.notebookIds.includes(notebookId)) {
      console.warn('[NotebookLM API] Collection mutation response was incomplete; recovered the committed membership.');
      return { ...reconciled, recovered: true };
    }
    throw error;
  }

  const confirmed = (await listCollections()).find(collection => collection.id === collectionId);
  if (!confirmed) {
    throw new Error('The selected collection disappeared while assigning the notebook.');
  }
  if (!confirmed.notebookIds.includes(notebookId)) {
    throw new Error('Gemini Notebook did not confirm that the notebook was added to the selected collection.');
  }
  console.log(`[NotebookLM API] Added notebook ${notebookId} to collection ${collectionId}`);
  return confirmed;
}

function makeAbortError() {
  const err = new Error('Pipeline monitoring aborted by user');
  err.code = 'PIPELINE_ABORTED';
  return err;
}

function normalizeBinaryPayload(fileData) {
  if (typeof fileData === 'string') {
    const binary = atob(fileData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (fileData instanceof ArrayBuffer) {
    return new Uint8Array(fileData);
  }

  if (ArrayBuffer.isView(fileData)) {
    return new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength);
  }

  if (Array.isArray(fileData)) {
    return new Uint8Array(fileData);
  }

  throw new Error('Unsupported file payload type');
}

async function registerFileSource(notebookId, filename) {
  const params = [
    [[filename]],
    notebookId,
    requestTemplateOptions(),
  ];

  const result = await rpcCall(
    RPCMethod.ADD_SOURCE_FILE,
    params,
    `/notebook/${notebookId}`,
    true
  );

  const sourceId = extractFirstIdFromResult(result);
  if (!sourceId) {
    throw new Error('Failed to register file source - no source ID returned');
  }
  return String(sourceId);
}

async function startResumableUpload(notebookId, filename, fileSize, sourceId, mimeType) {
  const response = await fetch(`${appUrl('/upload/_/')}?authuser=0`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-goog-authuser': '0',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(fileSize),
      'x-goog-upload-header-content-type': mimeType || 'application/pdf',
      'x-goog-upload-protocol': 'resumable',
    },
    body: JSON.stringify({
      PROJECT_ID: notebookId,
      SOURCE_NAME: filename,
      SOURCE_ID: sourceId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to start file upload: HTTP ${response.status} ${response.statusText}`);
  }

  const uploadUrl = response.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Failed to start file upload: upload URL missing in response');
  }

  return uploadUrl;
}

async function uploadFileBytes(uploadUrl, binaryPayload, mimeType = 'application/pdf') {
  const response = await fetch(uploadUrl, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Accept': '*/*',
      'Content-Type': mimeType || 'application/pdf',
      'x-goog-authuser': '0',
      'x-goog-upload-command': 'upload, finalize',
      'x-goog-upload-offset': '0',
    },
    body: binaryPayload,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload file bytes: HTTP ${response.status} ${response.statusText}`);
  }
}

/**
 * Add a local file source to a notebook via resumable upload.
 * Returns { id, title }
 */
async function addFileSource(notebookId, filename, fileData, mimeType = 'application/pdf') {
  if (!filename) {
    throw new Error('Filename is required for file upload');
  }

  const binaryPayload = normalizeBinaryPayload(fileData);
  if (!binaryPayload.byteLength) {
    throw new Error('File payload is empty');
  }

  const sourceId = await registerFileSource(notebookId, filename);
  const uploadUrl = await startResumableUpload(notebookId, filename, binaryPayload.byteLength, sourceId, mimeType);
  await uploadFileBytes(uploadUrl, binaryPayload, mimeType);

  console.log(`[NotebookLM API] Uploaded file source: ${sourceId} (${filename})`);
  return { id: sourceId, title: filename };
}

/**
 * Add a URL source to a notebook.
 * Returns { id, title }
 */
async function addUrlSource(notebookId, url) {
  // Capture the existing source IDs before creating anything. URL values are
  // not unique within a notebook, so an uncertainty probe must never adopt an
  // older source that happens to use the same URL.
  const baselineSourceIds = new Set(
    (await listSources(notebookId)).map(source => String(source.id))
  );
  const params = [
    [[null, null, [url], null, null, null, null, null, null, null, 1]],
    notebookId,
    requestTemplateOptions(),
  ];

  let result;
  try {
    result = await rpcCall(
      RPCMethod.ADD_SOURCE, params,
      `/notebook/${notebookId}`
    );
    const id = extractFirstIdFromResult(result);
    if (!id) throw mutationUncertainError(RPCMethod.ADD_SOURCE, 'The response did not identify a source.');
    return { id, title: null };
  } catch (caught) {
    let error = caught;
    if ([400, 422].includes(error?.httpStatus) || (error?.code === 'RPC_REJECTED' && error.rpcCode === 3)) {
      error.code = 'SOURCE_IMPORT_REJECTED';
      throw error;
    }
    if (/No result found for RPC ID|Unexpected token/.test(error?.message || '')) {
      error = mutationUncertainError(RPCMethod.ADD_SOURCE, 'The source response could not be decoded.');
    }
    if (error?.code !== 'TRANSIENT_MUTATION_UNCERTAIN') throw error;

    // The server can commit an ADD_SOURCE mutation while its streaming response
    // remains open. Reconcile through a safe read instead of resending the
    // mutation, which would risk creating a duplicate source.
    try {
      for (let probeAttempt = 0; probeAttempt < 3; probeAttempt++) {
        const sources = await listSources(notebookId);
        const committedMatches = sources.filter(source =>
          !baselineSourceIds.has(String(source.id))
          && (source.url === url || source.title === url)
        );
        if (committedMatches.length === 1) {
          console.warn('[NotebookLM API] Source mutation response was incomplete; recovered the committed source.');
          return committedMatches[0];
        }
        if (committedMatches.length > 1) {
          const ambiguous = new Error(
            'SOURCE_RECOVERY_AMBIGUOUS: More than one new matching source appeared. Check the notebook before retrying.'
          );
          ambiguous.code = 'SOURCE_RECOVERY_AMBIGUOUS';
          throw ambiguous;
        }
        if (probeAttempt < 2) await _retrySleep(2000);
      }
    } catch (probeError) {
      if (probeError?.code === 'SOURCE_RECOVERY_AMBIGUOUS') throw probeError;
      console.warn('[NotebookLM API] Could not reconcile the uncertain source mutation:', probeError.message);
    }

    throw error;
  }


}

/**
 * List all sources in a notebook and return their IDs + statuses.
 */
async function listSources(notebookId) {
  const params = [notebookId, null, requestTemplateOptions(), null, 0];
  const result = await rpcCall(
    RPCMethod.GET_NOTEBOOK, params,
    `/notebook/${notebookId}`
  );

  const sources = [];
  if (Array.isArray(result) && result.length > 0) {
    const nbInfo = result[0];
    if (Array.isArray(nbInfo) && nbInfo.length > 1 && Array.isArray(nbInfo[1])) {
      for (const src of nbInfo[1]) {
        if (!Array.isArray(src) || src.length === 0) continue;
        const rawSrcId = Array.isArray(src[0]) ? src[0][0] : src[0];
        const srcId = extractFirstIdFromResult(rawSrcId) || extractFirstIdFromResult(src) || rawSrcId;
        const title = src.length > 1 ? src[1] : null;
        const metadata = Array.isArray(src[2]) ? src[2] : null;
        const urlCandidates = metadata ? [metadata[7], metadata[5], metadata[0]] : [];
        let sourceUrl = null;
        for (const candidate of urlCandidates) {
          const value = Array.isArray(candidate) ? candidate.find(item => typeof item === 'string') : candidate;
          if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
            sourceUrl = value;
            break;
          }
        }

        // Extract status from src[3][1]
        let status = SourceStatus.READY;
        if (src.length > 3 && Array.isArray(src[3]) && src[3].length > 1) {
          status = src[3][1];
        }

        sources.push({ id: String(srcId), title, url: sourceUrl, status });
      }
    }
  }
  return sources;
}

async function createNote(notebookId, title = 'New Note', content = '') {
  const createParams = [notebookId, '', [1], null, 'New Note'];
  const createResult = await rpcCall(
    RPCMethod.CREATE_NOTE,
    createParams,
    `/notebook/${notebookId}`
  );

  let noteId = null;
  if (Array.isArray(createResult) && createResult.length > 0) {
    if (Array.isArray(createResult[0]) && createResult[0].length > 0) {
      noteId = createResult[0][0];
    } else if (typeof createResult[0] === 'string') {
      noteId = createResult[0];
    }
  }
  if (!noteId) {
    noteId = extractFirstIdFromResult(createResult);
  }
  if (!noteId) {
    throw new Error('Mind map note creation failed: no note ID returned');
  }

  const updateParams = [
    notebookId,
    String(noteId),
    [[[String(content || ''), String(title || ''), [], 0]]],
  ];
  await rpcCall(
    RPCMethod.UPDATE_NOTE,
    updateParams,
    `/notebook/${notebookId}`,
    true
  );

  return { id: String(noteId), title: String(title || '') };
}

/**
 * Wait for a source to become READY by polling.
 * Returns the ready source object.
 */
async function waitForSourceReady(notebookId, sourceId, timeoutMs = 120000, intervalMs = 5000, shouldAbort = null) {
  const start = Date.now();
  const requestedSourceId = String(sourceId);
  const normalizedRequestedId = extractFirstIdFromResult(requestedSourceId) || requestedSourceId;

  while (Date.now() - start < timeoutMs) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw makeAbortError();
    }

    const sources = await listSources(notebookId);
    const source = sources.find(s => {
      const currentId = String(s.id);
      const normalizedCurrentId = extractFirstIdFromResult(currentId) || currentId;
      return currentId === requestedSourceId || normalizedCurrentId === normalizedRequestedId;
    });

    if (!source) {
      console.log(`[NotebookLM API] Source ${requestedSourceId} not visible yet, waiting ${intervalMs}ms...`);
      if (typeof shouldAbort === 'function' && shouldAbort()) {
        throw makeAbortError();
      }
      await sleep(intervalMs);
      continue;
    }

    if (source.status === SourceStatus.READY) {
      console.log(`[NotebookLM API] Source ${sourceId} is READY`);
      return source;
    }

    if (source.status === SourceStatus.ERROR) {
      throw new Error(`Source ${sourceId} processing failed`);
    }

    console.log(`[NotebookLM API] Source ${sourceId} status=${source.status}, waiting ${intervalMs}ms...`);
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      throw makeAbortError();
    }
    await sleep(intervalMs);
  }

  throw new Error(`Source ${sourceId} timed out after ${timeoutMs}ms`);
}

/**
 * Get all source IDs from a notebook.
 */
async function getSourceIds(notebookId) {
  const sources = await listSources(notebookId);
  return sources.map(s => s.id);
}

/**
 * Generate an audio overview.
 * @param {string} notebookId
 * @param {string[]|null} sourceIds
 * @param {string} language  e.g. 'en'
 * @param {number} audioLength  AudioLength.*
 * @param {number} audioFormat  AudioFormat.*  (null = DEEP_DIVE default)
 * @param {string|null} instructions  Custom prompt/instructions text
 * Returns { taskId, status }
 */
async function generateAudio(notebookId, sourceIds = null, language = 'en', audioLength = AudioLength.LONG, audioFormat = null, instructions = null) {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const sourceIdsTriple = sourceIds.map(sid => [[sid]]);
  const sourceIdsDouble = sourceIds.map(sid => [sid]);

  const params = [
    artifactClientOptions(),
    notebookId,
    [
      null,
      null,
      ArtifactTypeCode.AUDIO,
      sourceIdsTriple,
      null,
      null,
      [
        null,
        [
          instructions || null,  // custom instructions
          audioLength,           // length code
          null,
          sourceIdsDouble,
          language,
          null,
          audioFormat || null,   // format code (null = DEEP_DIVE default)
        ],
      ],
    ],
  ];

  const result = await rpcCall(
    RPCMethod.CREATE_ARTIFACT, params,
    `/notebook/${notebookId}`,
    true
  );

  return parseGenerationResult(result);
}

/**
 * Generate a video overview.
 * @param {string} notebookId
 * @param {string[]|null} sourceIds
 * @param {number} videoFormat  VideoFormat.* (default EXPLAINER)
 * @param {number} videoStyle   VideoStyle.* (default AUTO_SELECT)
 * @param {string|null} instructions  Custom prompt
 * @param {string} language e.g. 'en'
 * Returns { taskId, status }
 */
async function generateVideo(
  notebookId,
  sourceIds = null,
  videoFormat = VideoFormat.EXPLAINER,
  videoStyle = VideoStyle.AUTO_SELECT,
  instructions = null,
  language = 'en',
  stylePrompt = null
) {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const sourceIdsTriple = sourceIds.map(sid => [[sid]]);
  const sourceIdsDouble = sourceIds.map(sid => [sid]);

  if (videoStyle === VideoStyle.CUSTOM && !String(stylePrompt || '').trim()) {
    throw new Error('Custom video style requires a visual style prompt.');
  }

  const styleCode = videoStyle === VideoStyle.CUSTOM ? null : videoStyle;
  const videoConfig = [
    sourceIdsDouble,
    language,
    instructions || null,
    null,
    videoFormat || null,
    styleCode ?? null,
  ];
  if (videoStyle === VideoStyle.CUSTOM && stylePrompt) {
    videoConfig.push(stylePrompt);
  }

  const params = [
    artifactClientOptions(),
    notebookId,
    [
      null,
      null,
      ArtifactTypeCode.VIDEO,
      sourceIdsTriple,
      null,
      null,
      null,
      null,
      [
        null,
        null,
        videoConfig,
      ],
    ],
  ];

  const result = await rpcCall(
    RPCMethod.CREATE_ARTIFACT, params,
    `/notebook/${notebookId}`,
    true
  );

  return parseGenerationResult(result);
}

/**
 * Generate a report (Briefing Doc, Study Guide, Blog Post, or Custom).
 * @param {string} notebookId
 * @param {string[]|null} sourceIds
 * @param {string} reportFormat  ReportFormat.* string
 * @param {string|null} instructions  Custom prompt (required if reportFormat = CUSTOM)
 * @param {string} language e.g. 'en'
 * Returns { taskId, status }
 */
async function generateReport(
  notebookId,
  sourceIds = null,
  reportFormat = ReportFormat.STUDY_GUIDE,
  instructions = null,
  language = 'en'
) {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const formatConfigs = {
    [ReportFormat.BRIEFING_DOC]: {
      title: 'Briefing Doc',
      description: 'Key insights and important quotes',
      prompt:
        'Create a comprehensive briefing document that includes an Executive Summary, detailed analysis of key themes, important quotes with context, and actionable insights.',
    },
    [ReportFormat.STUDY_GUIDE]: {
      title: 'Study Guide',
      description: 'Short-answer quiz, essay questions, glossary',
      prompt:
        'Create a comprehensive study guide that includes key concepts, short-answer practice questions, essay prompts for deeper exploration, and a glossary of important terms.',
    },
    [ReportFormat.BLOG_POST]: {
      title: 'Blog Post',
      description: 'Insightful takeaways in readable article format',
      prompt:
        'Write an engaging blog post that presents the key insights in an accessible, reader-friendly format. Include an attention-grabbing introduction, well-organized sections, and a compelling conclusion with takeaways.',
    },
    [ReportFormat.CUSTOM]: {
      title: 'Custom Report',
      description: 'Custom format',
      prompt: instructions || 'Create a report based on the provided sources.',
    },
  };

  const config = formatConfigs[reportFormat] || formatConfigs[ReportFormat.STUDY_GUIDE];
  const prompt = reportFormat === ReportFormat.CUSTOM
    ? config.prompt
    : (instructions ? `${config.prompt}\n\n${instructions}` : config.prompt);
  const sourceIdsTriple = sourceIds.map(sid => [[sid]]);
  const sourceIdsDouble = sourceIds.map(sid => [sid]);

  const params = [
    artifactClientOptions(),
    notebookId,
    [
      null,
      null,
      ArtifactTypeCode.REPORT,
      sourceIdsTriple,
      null,
      null,
      null,
      [
        null,
        [
          config.title,
          config.description,
          null,
          sourceIdsDouble,
          language,
          prompt,
          null,
          true,
        ],
      ],
    ],
  ];

  const result = await rpcCall(
    RPCMethod.CREATE_ARTIFACT, params,
    `/notebook/${notebookId}`,
    true
  );

  return parseGenerationResult(result);
}

/**
 * Generate a quiz.
 * @param {string} notebookId
 * @param {string[]|null} sourceIds
 * @param {number} quantity  QuizQuantity.*
 * @param {number} difficulty  QuizDifficulty.*
 * @param {string|null} instructions  Custom prompt
 * Returns { taskId, status }
 */
async function generateQuiz(notebookId, sourceIds = null, quantity = QuizQuantity.STANDARD, difficulty = QuizDifficulty.MEDIUM, instructions = null) {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const sourceIdsTriple = sourceIds.map(sid => [[sid]]);

  const params = [
    artifactClientOptions(),
    notebookId,
    [
      null,
      null,
      ArtifactTypeCode.QUIZ,
      sourceIdsTriple,
      null,
      null,
      null,
      null,
      null,
      [
        null,
        [
          2, // Variant: quiz
          null,
          instructions || null,
          null,
          null,
          null,
          null,
          [
            quantity || null,
            difficulty || null,
          ],
        ],
      ],
    ],
  ];

  const result = await rpcCall(
    RPCMethod.CREATE_ARTIFACT, params,
    `/notebook/${notebookId}`,
    true
  );

  return parseGenerationResult(result);
}

/**
 * Generate flashcards (same RPC type as quiz, isFlashcard = true).
 * Returns { taskId, status }
 */
async function generateFlashcards(notebookId, sourceIds = null, quantity = QuizQuantity.STANDARD, difficulty = QuizDifficulty.MEDIUM, instructions = null) {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const sourceIdsTriple = sourceIds.map(sid => [[sid]]);

  const params = [
    artifactClientOptions(),
    notebookId,
    [
      null,
      null,
      ArtifactTypeCode.QUIZ,
      sourceIdsTriple,
      null,
      null,
      null,
      null,
      null,
      [
        null,
        [
          1, // Variant: flashcards
          null,
          instructions || null,
          null,
          null,
          null,
          [
            quantity || QuizQuantity.STANDARD,
            difficulty || QuizDifficulty.MEDIUM,
          ],
        ],
      ],
    ],
  ];

  const result = await rpcCall(
    RPCMethod.CREATE_ARTIFACT, params,
    `/notebook/${notebookId}`,
    true
  );

  return parseGenerationResult(result);
}

/**
 * Generate a slide deck.
 * @param {string} language e.g. 'en'
 * Returns { taskId, status }
 */
async function generateSlideDeck(
  notebookId,
  sourceIds = null,
  deckFormat = SlideDeckFormat.DETAILED_DECK,
  deckLength = SlideDeckLength.DEFAULT,
  instructions = null,
  language = 'en'
) {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const sourceIdsTriple = sourceIds.map(sid => [[sid]]);

  const params = [
    artifactClientOptions(),
    notebookId,
    [
      null,
      null,
      ArtifactTypeCode.SLIDE_DECK,
      sourceIdsTriple,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [
        [
          instructions || null,
          language,
          deckFormat || null,
          deckLength || null,
        ],
      ],
    ],
  ];

  const result = await rpcCall(
    RPCMethod.CREATE_ARTIFACT, params,
    `/notebook/${notebookId}`,
    true
  );

  return parseGenerationResult(result);
}

/**
 * Generate a mind map.
 * Mind maps use a dedicated RPC and return immediately on success.
 * Returns { taskId, status }
 */
async function generateMindMap(notebookId, sourceIds = null) {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const sourceIdsNested = sourceIds.map(sid => [[sid]]);

  const params = [
    sourceIdsNested,
    null,
    null,
    null,
    null,
    ['interactive_mindmap', [['[CONTEXT]', '']], ''],
    null,
    [2, null, [1]],
  ];

  const result = await rpcCall(
    RPCMethod.GENERATE_MIND_MAP,
    params,
    `/notebook/${notebookId}`,
    true
  );

  let mindMapJson = null;
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0]) && result[0].length > 0) {
    mindMapJson = result[0][0];
  }

  if (mindMapJson === null || mindMapJson === undefined) {
    throw new Error('Mind map generation returned no content');
  }

  let title = 'Mind Map';
  let content = mindMapJson;

  if (typeof mindMapJson === 'string') {
    try {
      const parsed = JSON.parse(mindMapJson);
      if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.name.trim()) {
        title = parsed.name.trim();
      }
    } catch {
      // Keep raw string content.
    }
  } else if (typeof mindMapJson === 'object') {
    if (typeof mindMapJson.name === 'string' && mindMapJson.name.trim()) {
      title = mindMapJson.name.trim();
    }
    content = JSON.stringify(mindMapJson);
  } else {
    content = String(mindMapJson);
  }

  const note = await createNote(notebookId, title, String(content));
  return { taskId: note.id, status: 'completed' };
}

/**
 * Generate a data table.
 * @param {string} notebookId
 * @param {string[]|null} sourceIds
 * @param {string|null} instructions  Optional custom prompt.
 * @param {string} language e.g. 'en'
 * Returns { taskId, status }
 */
async function generateDataTable(notebookId, sourceIds = null, instructions = null, language = 'en') {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const sourceIdsTriple = sourceIds.map(sid => [[sid]]);

  const params = [
    artifactClientOptions(),
    notebookId,
    [
      null,
      null,
      ArtifactTypeCode.DATA_TABLE,
      sourceIdsTriple,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [
        null,
        [
          instructions || null,
          language,
        ],
      ],
    ],
  ];

  const result = await rpcCall(
    RPCMethod.CREATE_ARTIFACT, params,
    `/notebook/${notebookId}`,
    true
  );

  return parseGenerationResult(result);
}

/**
 * Generate an infographic.
 * @param {string} notebookId
 * @param {string[]|null} sourceIds
 * @param {string} language  e.g. 'en'
 * @param {number} orientation  InfographicOrientation.*
 * @param {number} detail  InfographicDetail.*
 * @param {number} style  InfographicStyle.*
 * @param {string|null} instructions  Optional custom prompt.
 * Returns { taskId, status }
 */
async function generateInfographic(
  notebookId,
  sourceIds = null,
  language = 'en',
  orientation = InfographicOrientation.LANDSCAPE,
  detail = InfographicDetail.STANDARD,
  style = InfographicStyle.AUTO_SELECT,
  instructions = null
) {
  if (!sourceIds) {
    sourceIds = await getSourceIds(notebookId);
  }

  const sourceIdsTriple = sourceIds.map(sid => [[sid]]);

  const params = [
    artifactClientOptions(),
    notebookId,
    [
      null,
      null,
      ArtifactTypeCode.INFOGRAPHIC,
      sourceIdsTriple,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [
        [
          instructions || null,
          language,
          null,
          orientation || null,
          detail || null,
          style || InfographicStyle.AUTO_SELECT,
        ],
      ],
    ],
  ];

  const result = await rpcCall(
    RPCMethod.CREATE_ARTIFACT, params,
    `/notebook/${notebookId}`,
    true
  );

  return parseGenerationResult(result);
}

function parseGenerationResult(result) {
  if (!result || !Array.isArray(result) || result.length === 0) {
    return { taskId: null, status: 'failed', error: 'No result from API' };
  }

  const artifactData = Array.isArray(result[0]) ? result[0] : result;
  const taskId = extractFirstIdFromResult(
    Array.isArray(artifactData) && artifactData.length > 0 ? artifactData[0] : result
  ) || extractFirstIdFromResult(result);

  if (!taskId) {
    return { taskId: null, status: 'failed', error: 'Could not parse task ID from API response' };
  }

  let status = 'in_progress';
  const statusCode = Array.isArray(artifactData) && artifactData.length > 4 ? artifactData[4] : null;
  switch (statusCode) {
    case ArtifactStatus.PROCESSING:
      status = 'in_progress';
      break;
    case ArtifactStatus.PENDING:
      status = 'pending';
      break;
    case ArtifactStatus.COMPLETED:
      status = 'completed';
      break;
    case ArtifactStatus.FAILED:
      status = 'failed';
      break;
    case ArtifactStatus.SUGGESTED:
      status = 'suggested';
      break;
    case ArtifactStatus.PENDING_REVIEW:
      status = 'pending_review';
      break;
    default:
      status = 'in_progress';
  }

  return { taskId: String(taskId), status };
}

function isValidMediaUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function findInfographicUrl(artifact) {
  for (const item of [...artifact].reverse()) {
    if (!Array.isArray(item) || item.length <= 2) continue;
    const content = item[2];
    if (!Array.isArray(content) || content.length === 0) continue;
    const firstContent = content[0];
    if (!Array.isArray(firstContent) || firstContent.length <= 1) continue;
    const imageData = firstContent[1];
    if (!Array.isArray(imageData) || imageData.length === 0) continue;
    if (isValidMediaUrl(imageData[0])) {
      return imageData[0];
    }
  }
  return null;
}

function isMediaArtifactReady(artifact, typeCode) {
  try {
    switch (typeCode) {
      case ArtifactTypeCode.AUDIO: {
        const mediaList = artifact?.[6]?.[5];
        return Array.isArray(mediaList)
          && mediaList.length > 0
          && Array.isArray(mediaList[0])
          && isValidMediaUrl(mediaList[0][0]);
      }
      case ArtifactTypeCode.VIDEO: {
        const mediaList = artifact?.[8];
        return Array.isArray(mediaList)
          && mediaList.some(item => Array.isArray(item) && isValidMediaUrl(item[0]));
      }
      case ArtifactTypeCode.INFOGRAPHIC:
        return !!findInfographicUrl(artifact);
      case ArtifactTypeCode.SLIDE_DECK:
        return isValidMediaUrl(artifact?.[16]?.[3]);
      default:
        return true;
    }
  } catch (_) {
    return ![
      ArtifactTypeCode.AUDIO,
      ArtifactTypeCode.VIDEO,
      ArtifactTypeCode.INFOGRAPHIC,
      ArtifactTypeCode.SLIDE_DECK,
    ].includes(typeCode);
  }
}

async function listArtifactStatuses(notebookId) {
  const params = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
  const result = await rpcCall(
    RPCMethod.LIST_ARTIFACTS, params,
    `/notebook/${notebookId}`,
    true
  );

  if (!result || !Array.isArray(result) || result.length === 0) {
    return new Map();
  }

  const artifactsData = Array.isArray(result[0]) ? result[0] : result;
  const statuses = new Map();

  for (const art of artifactsData) {
    if (!Array.isArray(art) || art.length === 0) continue;
    const artifactId = String(extractFirstIdFromResult(art[0]) || art[0]);
    const statusCode = art.length > 4 ? art[4] : 0;
    const typeCode = art.length > 2 ? art[2] : 0;

    let status;
    switch (statusCode) {
      case ArtifactStatus.PROCESSING: status = 'in_progress'; break;
      case ArtifactStatus.PENDING: status = 'pending'; break;
      case ArtifactStatus.COMPLETED:
        status = isMediaArtifactReady(art, typeCode) ? 'completed' : 'in_progress';
        break;
      case ArtifactStatus.FAILED: status = 'failed'; break;
      case ArtifactStatus.SUGGESTED: status = 'suggested'; break;
      case ArtifactStatus.PENDING_REVIEW: status = 'pending_review'; break;
      default: status = 'unknown';
    }

    statuses.set(artifactId, { taskId: artifactId, status, typeCode });
  }

  return statuses;
}

/**
 * Poll artifact status by listing all artifacts and finding the one we want.
 */
async function pollArtifactStatus(notebookId, taskId) {
  const statuses = await listArtifactStatuses(notebookId);
  if (statuses.has(String(taskId))) {
    return statuses.get(String(taskId));
  }
  return { taskId, status: 'pending' };
}

/**
 * Wait for an artifact generation to complete.
 */
async function waitForArtifact(notebookId, taskId, timeoutMs = 600000, intervalMs = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await pollArtifactStatus(notebookId, taskId);

    if (status.status === 'completed') {
      console.log(`[NotebookLM API] Artifact ${taskId} completed`);
      return status;
    }

    if (status.status === 'failed') {
      throw new Error(`Artifact ${taskId} generation failed`);
    }

    console.log(`[NotebookLM API] Artifact ${taskId} status=${status.status}, waiting ${intervalMs}ms...`);
    await sleep(intervalMs);
  }

  throw new Error(`Artifact ${taskId} timed out after ${timeoutMs}ms`);
}

// =========================================================================
// Utilities
// =========================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch the auto-generated title of a notebook from the NotebookLM API.
 * The title is generated after source ingestion and displayed to the user.
 *
 * NOTE: The exact GET_NOTEBOOK response shape is inferred (not confirmed from network
 * inspection). We search multiple positions defensively. This will never break the
 * pipeline -- it returns null silently if the title isn't found.
 *
 * @param {string} notebookId
 * @returns {Promise<string|null>}
 */
async function getNotebookTitle(notebookId) {
  // Params modeled after notebooklm-py GET_NOTEBOOK usage
  const params = [notebookId, null, requestTemplateOptions(), null, 0];
  let result;
  try {
    result = await rpcCall(
      RPCMethod.GET_NOTEBOOK, params,
      `/notebook/${notebookId}`
    );
  } catch (e) {
    console.warn('[API] getNotebookTitle RPC failed:', e.message);
    return null;
  }

  if (!Array.isArray(result) || result.length === 0) return null;

  // Search top-level result and one level down for the first non-trivial string
  // that looks like a notebook title (not a URL or ID).
  const candidates = Array.isArray(result[0]) ? result[0] : result;
  for (const item of candidates) {
    if (typeof item === 'string' && item.length > 1 && item.length < 200
      && !item.startsWith('http') && !/^[0-9a-f\-]{20,}$/i.test(item)) {
      return item;
    }
  }
  // Fallback: check result[0][2] which is a common position for titles
  const nbInfo = result[0];
  if (Array.isArray(nbInfo) && nbInfo.length > 2 && typeof nbInfo[2] === 'string' && nbInfo[2]) {
    return nbInfo[2];
  }
  return null;
}

// ES module exports for use in background.js
export {
  fetchTokens,
  ensureTokens,
  getNotebookUrl,
  createNotebook,
  deleteNotebook,
  listCollections,
  addNotebookToCollection,
  addUrlSource,
  addFileSource,
  listSources,
  getNotebookTitle,
  waitForSourceReady,
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
  pollArtifactStatus,
  waitForArtifact,
  ArtifactStatus,
  ArtifactTypeCode,
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
};

// Internal hooks used only by the deterministic Node test suite.
export const __testing = {
  RPCMethod,
  requestTemplateOptions,
  artifactClientOptions,
  collectionRequestOptions,
  rpcCall,
  resetTokens() {
    _csrfToken = null;
    _sessionId = null;
    _baseUrl = DEFAULT_BASE_URL;
  },
  getBaseUrl() {
    return _baseUrl;
  },
  setRetrySleep(fn) {
    _retrySleep = typeof fn === 'function' ? fn : sleep;
  },
  setMutationTimeout(ms) {
    _mutationTimeoutMs = Number.isFinite(ms) && ms >= 0 ? ms : 15000;
  },
};
