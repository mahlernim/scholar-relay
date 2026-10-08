import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { messageKey } from '../i18n.js';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedLocales = process.env.CAPTURE_LOCALES
  ? new Set(process.env.CAPTURE_LOCALES.split(',').map(locale => locale.trim()).filter(Boolean)) : null;
const captureLocale = locale => !requestedLocales || requestedLocales.has(locale);
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
  '--lang=en',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-position=-32000,-32000',
  '--window-size=400,700',
  '--remote-debugging-pipe',
  `--user-data-dir=${profileDir}`,
], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

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

async function capturePopup(connection, extensionId, locale = 'en') {
  const output = join(extensionRoot, 'docs', 'screenshots', ...(locale === 'en' ? [] : [locale]));
  await mkdir(output, { recursive: true });
  const catalog = JSON.parse(await readFile(join(extensionRoot, '_locales', locale, 'messages.json'), 'utf8'));
  const translated = (source, values = []) => catalog[messageKey(source)]?.message.replace(/\$(\d+)/g, (_, index) => values[index - 1]) || source;
  const localeScript = `chrome.i18n.getUILanguage=()=>${JSON.stringify(locale.replace('_', '-'))};
    chrome.i18n.getMessage=(key,values=[])=>(${JSON.stringify(catalog)})[key]?.message.replace(/\\$(\\d+)/g,(_,index)=>values[index-1]??'')||'';`;
  const setup = await openTarget(connection, `chrome-extension://${extensionId}/popup.html`);
  await setup.call('Page.addScriptToEvaluateOnNewDocument', { source: localeScript });
  await delay(400);
  const queueFixture = { version:1, paused:false, jobs:[
    { status:'running', runId:'example-a', step:'wait_artifacts', sourceTitle:'The Geometry of Character Counting in Language Models',
      pdfUrl:'https://arxiv.org/pdf/2601.04480', notebookUrl:'https://notebook.google.com/notebook/example',
      tasks:[{type:'audio',taskId:'example-audio',status:'in_progress'},{type:'infographic',taskId:'example-figure',status:'in_progress'}] },
    { status:'queued', runId:'example-b', step:'queued', sourceTitle:'Attention Is All You Need', pdfUrl:'https://arxiv.org/pdf/1706.03762',tasks:[] },
  ] };
  await setup.call('Page.addScriptToEvaluateOnNewDocument', {source: `
    const savedSend=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=(message,...args)=>message.type==='GET_QUEUE'?Promise.resolve(${JSON.stringify(queueFixture)}):savedSend(message,...args);
    chrome.tabs.query=async()=>[{id:12345,url:'https://arxiv.org/pdf/2303.08774'}];
    chrome.scripting.executeScript=async()=>[];
  `});
  await sessionReload(setup);
  await hidePageScrollbars(setup);
  await capture(setup, join(output, 'workflow.png'), 360, locale === 'ar' ? 600 : 550);
  await setup.close();

  const settings = await openTarget(connection, `chrome-extension://${extensionId}/popup.html`);
  await settings.call('Page.addScriptToEvaluateOnNewDocument', { source: localeScript });
  await delay(400);
  await evaluate(settings, `chrome.storage.local.set({jobQueue:{version:1,paused:false,jobs:[]},userSettings:{generateAudio:true,audioLength:'long',language:'en',generateInfographic:true,useSourceTitleForNotebook:true,notificationEnabled:true,chimeEnabled:true,autoOpenNotebook:false,collectionId:'research-papers'}})`);
  await sessionReload(settings);
  await evaluate(settings, `document.getElementById('btn-gear').click()`);
  await delay(500);
  await evaluate(settings, `(() => { const select=document.getElementById('s-collectionId'); select.replaceChildren(new Option(${JSON.stringify(translated('No collection'))},''),new Option('📚 Research Papers (2)','research-papers')); select.value='research-papers'; document.getElementById('collection-load-status').textContent=${JSON.stringify(translated('Collections available: $1.', ['3']))}; })()`);
  await evaluate(settings, `document.querySelectorAll('.s-section.expanded').forEach(section => section.classList.remove('expanded'))`);
  await evaluate(settings, `(() => { const pane=document.querySelector('.settings-inner'); pane.scrollTop+=document.querySelector('.settings-group-artifacts').getBoundingClientRect().top-pane.getBoundingClientRect().top; })()`);
  await hidePageScrollbars(settings);
  await capture(settings, join(output, 'settings.png'), 360, 480);
  await settings.close();
}

async function sessionReload(session) {
  await session.call('Page.reload', { ignoreCache: true });
  await delay(500);
}

async function captureStoreAsset(connection, relativeSource, relativeOutput, width, height, localized = null) {
  const url = pathToFileURL(join(extensionRoot, relativeSource)).href;
  const session = await openTarget(connection, url);
  // RTL fixed-width pages anchor to the viewport's right edge. Measure using
  // the output viewport, rather than the small popup window used previously.
  await session.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await delay(500);
  if (!relativeSource.endsWith('promo.html')) {
    await evaluate(session, `(() => {
      document.querySelector('.layout').style.gridTemplateColumns=${JSON.stringify(relativeSource.endsWith('settings.html') ? '460px minmax(0, 1fr)' : 'minmax(0, 1fr) 460px')};
      document.querySelector('.copy').style.minWidth='0';
      document.querySelector('.copy h1').style.overflowWrap='anywhere';
    })()`);
  }
  if (localized) {
    await evaluate(session, `(() => {
      const {locale,kind,copy}=${JSON.stringify(localized)};
      document.documentElement.lang=locale.replace('_','-');
      document.documentElement.dir=locale==='ar'?'rtl':'ltr';
      document.querySelector('.shot img').src='../../screenshots/'+locale+'/'+kind+'.png';
      document.querySelector('.kicker').textContent=copy[0];
      document.querySelector('.copy h1').textContent=copy[1];
      document.querySelector('.copy p').textContent=copy[2];
      document.querySelectorAll('.tag,.row').forEach((el,index)=>{
        if(el.classList.contains('row')) el.lastChild.textContent=copy[index+3];
        else el.textContent=copy[index+3];
      });
      document.querySelector('.copy h1').style.fontSize='44px';
      document.querySelector('.copy p').style.fontSize='21px';
      document.querySelector('.kicker').style.letterSpacing='normal';
      if(locale==='ko') document.querySelector('.copy h1').style.wordBreak='keep-all';
    })()`);
    await delay(300);
  }
  if (!relativeSource.endsWith('promo.html')) {
    const clipped = await evaluate(session, `Array.from(document.querySelectorAll('.copy,.copy h1,.copy p,.row,.tag,.shot img'))
      .filter(el=>{const r=el.getBoundingClientRect();return r.right>1280||r.bottom>800||r.left<0||r.top<0||el.scrollWidth>el.clientWidth+1;})
      .map(el=>el.className||el.tagName)`);
    if(clipped.length) throw new Error('Store asset overflow '+relativeOutput+': '+clipped.join(', '));
  }
  await capture(session, join(extensionRoot, relativeOutput), width, height);
  await session.close();
}

const browserConnection = new PipeConnection(chrome.stdio[4], chrome.stdio[3]);
try {
  const connection = browserConnection;
  await browserConnection.call('Browser.getVersion');
  const extensionId = await loadUnpackedExtension(browserConnection, extensionRoot);
  const localizedCopy = JSON.parse(await readFile(join(extensionRoot, 'docs', 'localization', 'asset-copy.json'), 'utf8'));
  if (requestedLocales && [...requestedLocales].some(locale => locale !== 'en' && !Object.hasOwn(localizedCopy, locale))) {
    throw new Error('CAPTURE_LOCALES contains a locale without store-asset copy.');
  }
  if (captureLocale('en')) {
    await capturePopup(connection, extensionId);
    await captureStoreAsset(connection, 'docs/store-assets/source/workflow.html', 'docs/store-assets/screenshot-workflow-1280x800.png', 1280, 800);
    await captureStoreAsset(connection, 'docs/store-assets/source/settings.html', 'docs/store-assets/screenshot-settings-1280x800.png', 1280, 800);
    await captureStoreAsset(connection, 'docs/store-assets/source/promo.html', 'docs/store-assets/small-promo-440x280.png', 440, 280);
  }
  for (const [locale, copy] of Object.entries(localizedCopy)) {
    if (!captureLocale(locale)) continue;
    await capturePopup(connection, extensionId, locale);
    await mkdir(join(extensionRoot, 'docs', 'store-assets', locale), { recursive: true });
    for (const kind of ['workflow', 'settings']) {
      await captureStoreAsset(connection, `docs/store-assets/source/${kind}.html`,
        `docs/store-assets/${locale}/screenshot-${kind}-1280x800.png`, 1280, 800, {locale,kind,copy:copy[kind]});
    }
  }
  // Use the real selector captured by smoke:chrome, with localized store framing.
  for (const locale of ['en', ...Object.keys(localizedCopy)]) {
    if (!captureLocale(locale)) continue;
    const catalog = JSON.parse(await readFile(join(extensionRoot, '_locales', locale, 'messages.json'), 'utf8'));
    const label = key => catalog[messageKey(key)].message;
    const folder = join(extensionRoot, 'docs', 'screenshots', locale);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'papers.png'), await readFile(join(extensionRoot, 'dist', 'localization-qa', `${locale}-papers.png`)));
    await mkdir(join(extensionRoot, 'docs', 'store-assets', locale), { recursive: true });
    await captureStoreAsset(connection, 'docs/store-assets/source/workflow.html',
      `docs/store-assets/${locale}/screenshot-papers-1280x800.png`, 1280, 800,
      {locale, kind:'papers', copy:[label('Create notebooks'), label('Papers on this page'),
        label('Include this webpage as context'), label('One per paper'), label('One notebook'), label('Get titles from arXiv')]});
  }
  console.log('Captured ScholarRelay README and Chrome Web Store assets.');
} finally {
  browserConnection.close();
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
  if (process.env.CAPTURE_KEEP_PROFILE === '1') {
    console.log(`Capture profile retained at ${resolvedProfile}`);
  } else {
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
