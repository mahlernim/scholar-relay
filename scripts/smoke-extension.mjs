import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(join(tmpdir(), 'scholar-relay-smoke-'));
const extensionRoot = join(tempRoot, 'extension');
const profileDir = join(tempRoot, 'profile');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function resolveChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.env.LOCALAPPDATA) {
    const playwrightRoot = join(process.env.LOCALAPPDATA, 'ms-playwright');
    try {
      const installs = (await readdir(playwrightRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const install of installs) candidates.push(join(playwrightRoot, install, 'chrome-win64', 'chrome.exe'));
    } catch {}
  }
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Chrome was not found. Set CHROME_PATH and retry.');
}

class PipeConnection {
  constructor(readable, writable) {
    this.readable = readable;
    this.writable = writable;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    readable.on('data', chunk => this.receive(chunk));
    readable.on('error', error => this.fail(error));
    readable.on('end', () => this.fail(new Error('Chromium closed the DevTools pipe.')));
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let separator = this.buffer.indexOf(0); separator !== -1; separator = this.buffer.indexOf(0)) {
      const packet = this.buffer.subarray(0, separator);
      this.buffer = this.buffer.subarray(separator + 1);
      if (!packet.length) continue;
      const message = JSON.parse(packet.toString('utf8'));
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }

  call(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolveCall, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out on the Chromium DevTools pipe.`));
      }, 15000);
      this.pending.set(id, { resolve: resolveCall, reject, timeout });
      this.writable.write(`${JSON.stringify(message)}\0`, error => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.writable.end();
    this.readable.destroy();
  }
}

class TargetSession {
  constructor(connection, sessionId, targetId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.closed = false;
  }

  call(method, params = {}) {
    return this.connection.call(method, params, this.sessionId);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.connection.call('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

async function loadUnpackedExtension(connection, path) {
  const result = await connection.call('Extensions.loadUnpacked', { path });
  if (!result?.id) throw new Error('Chromium did not return an extension ID.');
  return result.id;
}

async function openTarget(connection, url) {
  const { targetId } = await connection.call('Target.createTarget', { url });
  const { sessionId } = await connection.call('Target.attachToTarget', { targetId, flatten: true });
  const session = new TargetSession(connection, sessionId, targetId);
  try {
    await session.call('Page.enable');
    await session.call('Runtime.enable');
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

async function evaluate(session, expression) {
  const result = await session.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Evaluation failed');
  }
  return result.result?.value;
}

async function waitForExtensionPage(session) {
  let state;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      state = await evaluate(session, `({href:location.href,readyState:document.readyState,hasChrome:typeof globalThis.chrome !== 'undefined',hasTabs:typeof globalThis.chrome?.tabs !== 'undefined',ready:location.protocol === 'chrome-extension:' && document.readyState === 'complete' && typeof globalThis.chrome?.tabs?.create === 'function'})`);
      if (state.ready) return;
      if (state.href === 'chrome-error://chromewebdata/' && state.readyState === 'complete') break;
    } catch {}
    await delay(100);
  }
  state ||= await evaluate(session, `({href:location.href,readyState:document.readyState,hasChrome:typeof globalThis.chrome !== 'undefined',hasTabs:typeof globalThis.chrome?.tabs !== 'undefined'})`)
    .catch(error => ({ evaluationError: error.message }));
  throw new Error(`Extension popup did not become ready: ${JSON.stringify(state)}`);
}

async function openExtensionPopup(connection, url) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const session = await openTarget(connection, url);
    try {
      await waitForExtensionPage(session);
      return session;
    } catch (error) {
      lastError = error;
      await session.close();
      await delay(250);
    }
  }
  throw new Error(`Extension popup could not be opened after bounded retries. ${lastError?.message || ''}`.trim());
}

async function reload(session) {
  await session.call('Page.reload', { ignoreCache: true });
  await delay(500);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const imports = { urls: [], uploads: 0, pdfDownloads: 0, notebookTitles: [], uploadedBytes: 0, uploadedHash: null };
const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://localhost');
  if (requestUrl.pathname === '/upload/_/') {
    response.writeHead(200, { 'x-goog-upload-url': `${origin}/upload-bytes` });
    response.end();
    return;
  }
  if (requestUrl.pathname === '/upload-bytes') {
    const hash = createHash('sha256');
    for await (const chunk of request) { imports.uploadedBytes += chunk.length; hash.update(chunk); }
    imports.uploadedHash = hash.digest('hex');
    response.end('ok');
    return;
  }
  if (requestUrl.searchParams.has('rpcids')) {
    let body = '';
    for await (const chunk of request) body += chunk;
    const params = JSON.parse(JSON.parse(new URLSearchParams(body).get('f.req'))[0][0][1]);
    const method = requestUrl.searchParams.get('rpcids');
    let result = [[null, []]];
    if (method === 'CCqFvf') { imports.notebookTitles.push(params[0]); result = [['smoke-notebook-id']]; }
    if (method === 'izAoDd') { imports.urls.push(params[0][0][2][0]); result = [['smoke-url-source-id']]; }
    if (method === 'o4cbdc') { imports.uploads++; result = [['smoke-file-source-id']]; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`)]}'\n${JSON.stringify([['wrb.fr', method, JSON.stringify(result)]])}`);
    return;
  }
  if (request.url === '/') {
    response.end('"SNlM0e":"smoke-csrf","FdrFJe":"smoke-session"');
    return;
  }
  if (request.url === '/paper.pdf' || request.url === '/paper-two.pdf') {
    imports.pdfDownloads++;
    response.writeHead(200, { 'content-type': 'application/pdf' });
    response.end('%PDF-1.7\n%%EOF');
    return;
  }
  if (request.url === '/article' || request.url === '/article-next') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Article</title><meta name="citation_title" content="A scholarly HTML title"><a id="pdf-link" href="/paper.pdf">Download PDF</a>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Ordinary page</title><h1>No PDF here</h1>');
});
await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
const serverPort = server.address().port;
const origin = `http://127.0.0.1:${serverPort}`;

let chrome;
let popup;
let browserConnection;
try {
  await cp(sourceRoot, extensionRoot, {
    recursive: true,
    filter: source => !source.includes(`${join(sourceRoot, '.git')}`) &&
      !source.includes(`${join(sourceRoot, 'dist')}`),
  });
  const manifestPath = join(extensionRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions.push(`${origin}/*`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Route the copied test extension to a controlled server. Production files are untouched.
  const apiPath = join(extensionRoot, 'notebooklm-api.js');
  await writeFile(apiPath, (await readFile(apiPath, 'utf8'))
    .replace("const DEFAULT_BASE_URL = 'https://notebook.google.com';", `const DEFAULT_BASE_URL = '${origin}';`)
    .replace("const LEGACY_BASE_URL = 'https://notebooklm.google.com';", `const LEGACY_BASE_URL = '${origin}';`));

  const chromePath = await resolveChrome();
  chrome = spawn(chromePath, [
    '--disable-gpu',
    '--enable-unsafe-extension-debugging',
    ...(process.env.CI ? ['--disable-dev-shm-usage', '--no-sandbox'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

  browserConnection = new PipeConnection(chrome.stdio[4], chrome.stdio[3]);
  await browserConnection.call('Browser.getVersion');
  const extensionId = await loadUnpackedExtension(browserConnection, extensionRoot);
  popup = await openExtensionPopup(browserConnection, `chrome-extension://${extensionId}/popup.html`);

  const tabA = await evaluate(popup, `chrome.tabs.create({url:${JSON.stringify(`${origin}/article`)},active:true})`);
  await delay(300);
  await reload(popup);
  let view = await evaluate(popup, `({text:document.getElementById('content').innerText,hasStart:!!document.getElementById('btn-start')})`);
  assert(view.hasStart && view.text.includes('/paper.pdf'), 'Linked PDF was not detected in the article tab');
  let cachedDetection = await evaluate(popup, `chrome.storage.local.get('detectedPdf').then(result=>result.detectedPdf)`);
  assert(cachedDetection?.tabId === tabA.id, 'Content detection was not bound to its sender tab');
  assert(cachedDetection?.tabUrl === `${origin}/article`, 'Content detection stored the wrong sender URL');

  await evaluate(popup, `chrome.tabs.create({url:${JSON.stringify(`${origin}/plain`)},active:true})`);
  await delay(300);
  await reload(popup);
  view = await evaluate(popup, `({text:document.getElementById('content').innerText,hasUrl:!!document.getElementById('btn-start-url')})`);
  assert(view.hasUrl, 'Ordinary tab did not render the webpage fallback');
  assert(!view.text.includes('/paper.pdf'), 'A stale PDF leaked into another tab');

  await evaluate(popup, `chrome.scripting.executeScript({target:{tabId:${tabA.id}},func:()=>{history.pushState({},'', '/article-next');document.getElementById('pdf-link').href='/paper-two.pdf';}})`);
  await evaluate(popup, `chrome.tabs.update(${tabA.id},{active:true})`);
  await delay(300);
  await reload(popup);
  view = await evaluate(popup, `({text:document.getElementById('content').innerText,hasStart:!!document.getElementById('btn-start')})`);
  assert(view.hasStart && view.text.includes('/paper-two.pdf'), 'SPA navigation did not refresh the detected PDF');
  assert(!view.text.includes(`${origin}/paper.pdf`), 'A stale PDF survived navigation in the same tab');

  const errorText = 'Smoke test visible pipeline error';
  await evaluate(popup, `chrome.storage.local.set({pipelineState:{status:'error',runId:'smoke',step:'error',stepDetail:${JSON.stringify(errorText)},error:${JSON.stringify(errorText)},pdfUrl:'smoke.pdf',tasks:[]}})`);
  await reload(popup);
  view = await evaluate(popup, `document.querySelector('.pipeline-error-box')?.innerText`);
  assert(view === errorText, 'Pipeline error was not visibly rendered');

  await evaluate(popup, `chrome.storage.local.set({pipelineState:{status:'running',runId:'existing-run',step:'auth',stepDetail:'Busy',pdfUrl:'busy.pdf',tasks:[]}})`);
  const busyResponse = await evaluate(popup, `chrome.runtime.sendMessage({type:'START_PIPELINE',pdfUrl:${JSON.stringify(`${origin}/plain`)},pageUrl:${JSON.stringify(`${origin}/plain`)},sourceType:'webpage'})`);
  assert(busyResponse?.ok === false && busyResponse?.code === 'PIPELINE_ALREADY_RUNNING', 'A second pipeline start was not rejected');
  let storedState = await evaluate(popup, `chrome.storage.local.get('pipelineState').then(result=>result.pipelineState)`);
  assert(storedState.runId === 'existing-run', 'A rejected start replaced the active run');

  await evaluate(popup, `chrome.storage.local.set({pipelineState:{status:'running',runId:'stoppable-run',step:'wait_source',stepDetail:'Waiting',pdfUrl:'wait.pdf',tasks:[]}})`);
  const staleStop = await evaluate(popup, `chrome.runtime.sendMessage({type:'ABORT_PIPELINE',runId:'old-run'})`);
  assert(staleStop?.ok === false, 'A stale popup stopped a replacement run');
  const acceptedStop = await evaluate(popup, `chrome.runtime.sendMessage({type:'ABORT_PIPELINE',runId:'stoppable-run'})`);
  assert(acceptedStop?.ok === true, 'The matching polling run could not be stopped');
  storedState = await evaluate(popup, `chrome.storage.local.get('pipelineState').then(result=>result.pipelineState)`);
  assert(storedState.status === 'idle' && storedState.runId === null, 'Stopped run did not return to idle state');

  await evaluate(popup, `chrome.tabs.update(${tabA.id},{active:true})`);
  await reload(popup);
  const downloadsBefore = imports.pdfDownloads;
  await evaluate(popup, `document.getElementById('btn-start').click()`);
  for (let attempt = 0; attempt < 50; attempt++) {
    storedState = await evaluate(popup, `chrome.storage.local.get('pipelineState').then(result=>result.pipelineState)`);
    if (storedState.step === 'wait_source' || storedState.status === 'error') break;
    await delay(100);
  }
  assert(storedState.step === 'wait_source', `URL import did not reach source polling: ${storedState.error}`);
  assert(imports.notebookTitles.at(-1) === 'A scholarly HTML title', 'HTML title did not reach notebook creation');
  assert(imports.urls.at(-1) === `${origin}/paper-two.pdf`, 'Detected PDF URL was not imported');
  assert(imports.pdfDownloads === downloadsBefore && imports.uploads === 0, 'URL-first import downloaded or uploaded a PDF');

  await popup.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 600, deviceScaleFactor: 1, mobile: false });
  const completedState = { status: 'completed', step: 'done', pdfUrl: 'paper.pdf',
    notebookTitle: 'Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement',
    notebookUrl: `${origin}/notebook/smoke`, collectionAssignment: { status: 'completed', name: 'Research papers' },
    tasks: [{ type: 'audio', status: 'completed' }, { type: 'infographic', status: 'completed' }] };
  await evaluate(popup, `chrome.storage.local.set({pipelineState:${JSON.stringify(completedState)}})`);
  await reload(popup);
  const layout = await evaluate(popup, `({height:document.body.getBoundingClientRect().height,width:document.documentElement.scrollWidth,
    resultBottom:document.querySelector('.completed-box').getBoundingClientRect().bottom,
    linkBottom:document.querySelector('.notebook-link').getBoundingClientRect().bottom,
    collapsed:!document.querySelector('.workflow-details').open})`);
  assert(layout.height <= 600 && layout.width <= 360, 'Completed popup overflows its viewport');
  assert(layout.resultBottom < 600 && layout.linkBottom < 600 && layout.collapsed, 'Results are not immediately visible');
  console.log(`Completed popup layout: ${JSON.stringify(layout)}`);

  // Exercise the real Chrome message bridge and the complete file upload client.
  await evaluate(popup, `chrome.storage.local.set({pipelineState:{status:'idle'}})`);
  const size = 40 * 1024 * 1024;
  const expectedBytes = Buffer.alloc(size, 32);
  expectedBytes.write('%PDF-1.7\n');
  const expectedHash = createHash('sha256').update(expectedBytes).digest('hex');
  const started = Date.now();
  const baselineHeap = await popup.call('Runtime.getHeapUsage');
  const transfer = await evaluate(popup, `(async()=>{
    const bytes=new Uint8Array(${size}).fill(32); bytes.set(new TextEncoder().encode('%PDF-1.7\\n'));
    const fileDataBase64=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob([bytes],{type:'application/pdf'}));});
    let last=performance.now(),maxGapMs=0,ticks=0;
    const timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;ticks++;},25);
    const message={type:'START_PIPELINE_FILE',fileName:'large-smoke.pdf',fileDataBase64,sourceTitle:'Large PDF validation'};
    const messageBytes=new TextEncoder().encode(JSON.stringify(message)).byteLength;
    const response=await chrome.runtime.sendMessage(message);
    clearInterval(timer);
    return {response,messageBytes,maxGapMs,ticks};
  })()`);
  assert(transfer.response.ok, `Large PDF start failed: ${JSON.stringify(transfer.response)}`);
  assert(transfer.messageBytes < 64 * 1024 * 1024, 'Large PDF message exceeds Chrome limit');
  const targets = await browserConnection.call('Target.getTargets');
  const workerTarget = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.includes(extensionId));
  const workerAttachment = workerTarget ? await browserConnection.call('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: true }) : null;
  const peak = { popupHeap: baselineHeap.usedSize, workerHeap: 0, workerBacking: 0 };
  for (let attempt = 0; attempt < 200; attempt++) {
    const heap = await popup.call('Runtime.getHeapUsage');
    peak.popupHeap = Math.max(peak.popupHeap, heap.usedSize);
    if (workerAttachment) {
      const workerHeap = await browserConnection.call('Runtime.getHeapUsage', {}, workerAttachment.sessionId);
      peak.workerHeap = Math.max(peak.workerHeap, workerHeap.usedSize);
      peak.workerBacking = Math.max(peak.workerBacking, workerHeap.backingStorageSize || 0);
    }
    storedState = await evaluate(popup, `chrome.storage.local.get('pipelineState').then(result=>result.pipelineState)`);
    if (storedState.step === 'wait_source' || storedState.status === 'error') break;
    await delay(50);
  }
  assert(storedState.step === 'wait_source', `Large upload failed: ${storedState.error || storedState.step}`);
  assert(imports.uploadedBytes === size && imports.uploadedHash === expectedHash, 'Large uploaded bytes differ from the selected PDF');
  await evaluate(popup, `chrome.runtime.sendMessage({type:'ABORT_PIPELINE',runId:${JSON.stringify(storedState.runId)}})`);
  const rejected = await evaluate(popup, `(async()=>{
    const bytes=new Uint8Array(${size + 1}).fill(32);bytes.set(new TextEncoder().encode('%PDF-1.7\\n'));
    const b64=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(new Blob([bytes]));});
    return chrome.runtime.sendMessage({type:'START_PIPELINE_FILE',fileName:'too-large.pdf',fileDataBase64:b64});
  })()`);
  assert(!rejected.ok && rejected.code === 'PDF_TOO_LARGE', '40 MiB plus one byte was not rejected');
  console.log(`40 MiB transfer: ${JSON.stringify({messageBytes:transfer.messageBytes,elapsedMs:Date.now()-started,maxTimerGapMs:transfer.maxGapMs,peak,sha256:imports.uploadedHash})}`);

  console.log('Chrome extension smoke test passed.');
} finally {
  await popup?.close();
  browserConnection?.close();
  if (chrome) {
    chrome.kill();
    if (chrome.exitCode === null) {
      await Promise.race([new Promise(resolveExit => chrome.once('exit', resolveExit)), delay(3000)]);
    }
  }
  await new Promise(resolveClose => server.close(resolveClose));
  const safeTempRoot = resolve(tmpdir());
  const resolvedTemp = resolve(tempRoot);
  if (dirname(resolvedTemp) !== safeTempRoot || !basename(resolvedTemp).startsWith('scholar-relay-smoke-')) {
    throw new Error(`Refusing to remove unexpected temporary path: ${resolvedTemp}`);
  }
  await rm(resolvedTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
