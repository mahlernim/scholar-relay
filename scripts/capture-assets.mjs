import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = await resolveCaptureBrowser();
const profileDir = await mkdtemp(join(tmpdir(), 'scholar-relay-capture-'));

async function resolveCaptureBrowser() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.env.LOCALAPPDATA) {
    const playwrightRoot = join(process.env.LOCALAPPDATA, 'ms-playwright');
    try {
      const installs = (await readdir(playwrightRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const install of installs) {
        candidates.push(join(playwrightRoot, install, 'chrome-win64', 'chrome.exe'));
      }
    } catch {}
  }
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('No compatible Chromium executable was found. Set CHROME_PATH and retry.');
}

const chrome = spawn(chromePath, [
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-position=-32000,-32000',
  '--window-size=400,700',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  `--disable-extensions-except=${extensionRoot}`,
  `--load-extension=${extensionRoot}`,
], { windowsHide: true, stdio: 'ignore' });

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function waitForDevToolsPort() {
  const portFile = join(profileDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (port) return Number(port);
    } catch {}
    await delay(100);
  }
  throw new Error('Chrome DevTools port did not become available.');
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
      const { resolve: resolveCall, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolveCall(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolveCall, reject) => this.pending.set(id, { resolve: resolveCall, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
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

async function findExtensionId(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await json(port, '/json');
    const target = targets.find(item => item.type === 'service_worker' && item.url?.endsWith('/background.js'));
    const match = target?.url?.match(/^chrome-extension:\/\/([^/]+)/);
    if (match) return match[1];
    try {
      const preferences = JSON.parse(await readFile(join(profileDir, 'Default', 'Preferences'), 'utf8'));
      const settings = preferences.extensions?.settings || {};
      for (const [id, value] of Object.entries(settings)) {
        if (value?.path && resolve(value.path) === extensionRoot) return id;
        if (value?.manifest?.name === 'ScholarRelay') return id;
      }
    } catch {}
    await delay(100);
  }
  throw new Error('Loaded extension target was not found.');
}

async function openTarget(port, url) {
  const target = await json(port, `/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.open();
  await session.call('Page.enable');
  await session.call('Runtime.enable');
  return session;
}

async function evaluate(session, expression, awaitPromise = true) {
  const result = await session.call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(detail || 'Runtime evaluation failed.');
  }
  return result.result?.value;
}

async function capture(session, outputPath, width, height) {
  await session.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(250);
  const result = await session.call('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  await writeFile(outputPath, Buffer.from(result.data, 'base64'));
}

async function hidePageScrollbars(session) {
  await evaluate(session, `(() => { const style=document.createElement('style'); style.textContent='html,body{overflow:hidden!important}'; document.head.appendChild(style); })()`);
}

async function capturePopup(port, extensionId) {
  const setup = await openTarget(port, `chrome-extension://${extensionId}/popup.html`);
  await delay(400);
  const pipelineState = {
    status: 'completed',
    step: 'done',
    stepDetail: 'All requested artifacts are ready.',
    pdfUrl: 'https://arxiv.org/pdf/2601.04480',
    sourceType: 'pdf',
    notebookUrl: 'https://notebook.google.com/notebook/example',
    notebookTitle: 'The Geometry of Character Counting in Language Models',
    collectionAssignment: { status: 'completed', name: 'Research Papers' },
    tasks: [
      { type: 'audio', status: 'completed' },
      { type: 'infographic', status: 'completed' },
      { type: 'mind_map', status: 'completed' },
    ],
  };
  await evaluate(setup, `chrome.storage.local.set({pipelineState:${JSON.stringify(pipelineState)}})`);
  await sessionReload(setup);
  await hidePageScrollbars(setup);
  await capture(setup, join(extensionRoot, 'docs', 'screenshots', 'workflow.png'), 360, 350);
  setup.close();

  const settings = await openTarget(port, `chrome-extension://${extensionId}/popup.html`);
  await delay(400);
  await evaluate(settings, `chrome.storage.local.set({pipelineState:{status:'idle'},userSettings:{generateAudio:true,audioLength:'long',language:'en',generateInfographic:true,useSourceTitleForNotebook:true,notificationEnabled:true,chimeEnabled:true,autoOpenNotebook:false,collectionId:'research-papers'}})`);
  await sessionReload(settings);
  await evaluate(settings, `document.getElementById('btn-gear').click()`);
  await delay(500);
  await evaluate(settings, `(() => { const select=document.getElementById('s-collectionId'); select.replaceChildren(new Option('Do not add to a collection',''),new Option('📚 Research Papers (2)','research-papers')); select.value='research-papers'; document.getElementById('collection-load-status').textContent='3 collections available.'; })()`);
  await evaluate(settings, `document.querySelectorAll('.s-section.expanded').forEach(section => section.classList.remove('expanded'))`);
  await hidePageScrollbars(settings);
  await capture(settings, join(extensionRoot, 'docs', 'screenshots', 'settings.png'), 360, 480);
  settings.close();
}

async function sessionReload(session) {
  await session.call('Page.reload', { ignoreCache: true });
  await delay(500);
}

async function captureStoreAsset(port, relativeSource, relativeOutput, width, height) {
  const url = pathToFileURL(join(extensionRoot, relativeSource)).href;
  const session = await openTarget(port, url);
  await delay(500);
  await capture(session, join(extensionRoot, relativeOutput), width, height);
  session.close();
}

try {
  const port = await waitForDevToolsPort();
  const extensionId = await findExtensionId(port);
  await capturePopup(port, extensionId);
  await captureStoreAsset(port, 'docs/store-assets/source/workflow.html', 'docs/store-assets/screenshot-workflow-1280x800.png', 1280, 800);
  await captureStoreAsset(port, 'docs/store-assets/source/settings.html', 'docs/store-assets/screenshot-settings-1280x800.png', 1280, 800);
  await captureStoreAsset(port, 'docs/store-assets/source/promo.html', 'docs/store-assets/small-promo-440x280.png', 440, 280);
  console.log('Captured ScholarRelay README and Chrome Web Store assets.');
} finally {
  chrome.kill();
  if (chrome.exitCode === null) {
    await Promise.race([
      new Promise(resolveExit => chrome.once('exit', resolveExit)),
      delay(3000),
    ]);
  }
  const safeTempRoot = resolve(tmpdir());
  const resolvedProfile = resolve(profileDir);
  if (!resolvedProfile.startsWith(`${safeTempRoot}\\`) || !resolvedProfile.includes('scholar-relay-capture-')) {
    throw new Error(`Refusing to remove unexpected profile path: ${resolvedProfile}`);
  }
  await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
