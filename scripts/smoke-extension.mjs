import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', rejectOpen, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolveCall, reject) => this.pending.set(id, { resolve: resolveCall, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

async function json(port, path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

async function waitForPort() {
  const portFile = join(profileDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (port) return Number(port);
    } catch {}
    await delay(100);
  }
  throw new Error('Chrome DevTools port did not become available.');
}

async function findExtensionId(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await json(port, '/json');
    const worker = targets.find(item => item.type === 'service_worker' && item.url?.endsWith('/background.js'));
    const id = worker?.url?.match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (id) return id;
    try {
      const preferences = JSON.parse(await readFile(join(profileDir, 'Default', 'Preferences'), 'utf8'));
      const settings = preferences.extensions?.settings || {};
      for (const [extensionId, value] of Object.entries(settings)) {
        if (value?.path && resolve(value.path) === extensionRoot) return extensionId;
        if (value?.manifest?.name === 'ScholarRelay') return extensionId;
      }
    } catch {}
    await delay(100);
  }
  throw new Error('Loaded extension service worker was not found.');
}

async function openTarget(port, url) {
  const target = await json(port, `/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.open();
  await session.call('Page.enable');
  await session.call('Runtime.enable');
  return session;
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

async function openExtensionPopup(port, url) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const session = await openTarget(port, url);
    try {
      await waitForExtensionPage(session);
      return session;
    } catch (error) {
      lastError = error;
      session.close();
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

const server = createServer((request, response) => {
  if (request.url === '/paper.pdf' || request.url === '/paper-two.pdf') {
    response.writeHead(200, { 'content-type': 'application/pdf' });
    response.end('%PDF-1.7\n%%EOF');
    return;
  }
  if (request.url === '/article' || request.url === '/article-next') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Article</title><a id="pdf-link" href="/paper.pdf">Download PDF</a>');
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

  const chromePath = await resolveChrome();
  chrome = spawn(chromePath, [
    '--disable-gpu',
    '--enable-unsafe-extension-debugging',
    ...(process.env.CI ? ['--disable-dev-shm-usage', '--no-sandbox'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
  ], { windowsHide: true, stdio: 'ignore' });

  const devtoolsPort = await waitForPort();
  const extensionId = await findExtensionId(devtoolsPort);
  popup = await openExtensionPopup(devtoolsPort, `chrome-extension://${extensionId}/popup.html`);

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

  console.log('Chrome extension smoke test passed.');
} finally {
  popup?.close();
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
