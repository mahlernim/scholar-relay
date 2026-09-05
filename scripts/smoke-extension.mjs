import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { localizationSmoke } from './localization-smoke.mjs';

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
let queueMode = false;
let generationComplete = false;
const notebooks = new Map();
const generations = [];
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
    if (method === 'CCqFvf') { imports.notebookTitles.push(params[0]); const id='smoke-notebook-'+imports.notebookTitles.length; notebooks.set(id,{title:params[0],sources:[]}); result = [params[0], null, id]; }
    if (method === 'izAoDd') { const url=params[0][0][2][0]; imports.urls.push(url); const id='source-'+params[1]; notebooks.get(params[1])?.sources.push([[id],url,[null,null,null,null,null,null,null,[url]],[null,2]]); result = [[id]]; }
    if (method === 'o4cbdc') { imports.uploads++; result = [['smoke-file-source-id']]; }
    if (queueMode && method==='rLM1Ne') { const notebook=notebooks.get(params[0]); result=[[notebook?.title || 'Paper', notebook?.sources || [], params[0]]]; }
    if (queueMode && method==='R7cb6c') { const item={notebookId:params[1],taskId:'artifact-'+params[1],type:params[2][2],language:params[2][6]?.[1]?.[4]}; generations.push(item); result=[[item.taskId,null,item.type,null,1]]; }
    if (queueMode && method==='gArtLc') result=[generations.filter(item=>item.notebookId===params[1]).map(item=>[item.taskId,null,item.type,null,generationComplete?3:2,null,[null,null,null,null,null,[[origin+'/audio.mp3']]]])];
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
  const workerPath = join(extensionRoot, 'background.js');
  await writeFile(workerPath, (await readFile(workerPath,'utf8')) + '\nchrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.type!=="SMOKE_TICK")return;handlePollAlarm({name:ALARM_NAME}).then(()=>reply({ok:true}));return true;});\n');
  const popupPath = join(extensionRoot, 'popup.js');
  await writeFile(popupPath, `${await readFile(popupPath, 'utf8')}\nglobalThis.__smoke = { startPipelineFile, async setFixtureState(state, extra = {}) { await chrome.storage.local.set({ jobQueue: {version:1,paused:false,jobs:state.status==='idle'?[]:[{runId:'fixture',...state}]}, ...extra }); } };\n`);

  const chromePath = await resolveChrome();
  chrome = spawn(chromePath, [
    '--disable-gpu',
    '--lang=en',
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
  await evaluate(popup, `globalThis.__smoke.setFixtureState({status:'error',runId:'smoke',step:'error',stepDetail:${JSON.stringify(errorText)},error:${JSON.stringify(errorText)},pdfUrl:'smoke.pdf',tasks:[]})`);
  await reload(popup);
  await evaluate(popup, `document.querySelector('[data-show]')?.click()`);
  view = await evaluate(popup, `({summary:document.querySelector('.pipeline-error-box')?.innerText,details:document.querySelector('.workflow-details')?.textContent,collapsed:!document.querySelector('.workflow-details')?.open})`);
  assert(view.summary && view.details.includes(errorText) && view.collapsed, 'Error summary and collapsed diagnostics were not preserved');
  await evaluate(popup, `document.querySelector('.workflow-details').open=true`);
  assert((await evaluate(popup, `document.getElementById('content').innerText`)).includes(errorText), 'Expanded error diagnostics are inaccessible');

  await evaluate(popup, `globalThis.__smoke.setFixtureState({status:'error',runId:'uncertain-ui',step:'error',error:'Uncertain artifact generation. Check this notebook before starting again.',pdfUrl:'paper.pdf',tasks:[{type:'audio',status:'uncertain',error:'Accepted response stalled'}]})`);
  await reload(popup);
  await evaluate(popup, `document.querySelector('[data-show]')?.click()`);
  view = await evaluate(popup, `({summary:document.querySelector('.pipeline-error-box')?.innerText,details:[...document.querySelectorAll('details')].find(el=>el.querySelector('summary')?.textContent==='Artifact details')?.textContent})`);
  assert(view.summary.includes('could not be confirmed') && view.details?.includes('Needs checking') && view.details.includes('Accepted response stalled'), 'Uncertain task diagnostics were lost');

  await evaluate(popup, `document.getElementById('btn-gear').click()`);
  await delay(150);
  await evaluate(popup, `document.getElementById('s-generateAudio').checked=false;document.getElementById('sec-audio').classList.remove('expanded');document.getElementById('s-language').value='ko';document.getElementById('btn-save-close').click()`);
  await delay(150);
  await reload(popup);
  await evaluate(popup, `document.getElementById('btn-gear').click()`);
  view = await evaluate(popup, `({language:document.getElementById('s-language').value,audio:document.getElementById('s-generateAudio').checked,shared:!document.getElementById('s-language').closest('#sec-audio'),visible:document.getElementById('s-language').getBoundingClientRect().height>0})`);
  assert(view.language==='ko' && !view.audio && view.shared && view.visible, 'Shared language is not accessible and persistent with Audio disabled');
  await evaluate(popup, `document.getElementById('btn-gear').click()`);

  await popup.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 600, deviceScaleFactor: 1, mobile: false });
  for (const step of ['wait_source','wait_pdf_access']) {
    await evaluate(popup, `globalThis.__smoke.setFixtureState({status:'running',runId:'ui-state',step:${JSON.stringify(step)},stepDetail:'Permission diagnostic',pdfUrl:'paper.pdf',originalPdfUrl:'${origin}/paper.pdf',notebookUrl:'${origin}/notebook/smoke',failedUrlSourceId:'failed-source',tasks:[]})`);
    await reload(popup);
  await evaluate(popup, `document.querySelector('[data-show]')?.click()`);
    view = await evaluate(popup, `({text:document.getElementById('content').innerText,resume:!!document.getElementById('btn-resume-pdf'),file:!!document.getElementById('btn-fallback-file'),stop:!!document.getElementById('btn-abort'),width:document.documentElement.scrollWidth})`);
    assert(view.stop && view.width<=360, 'Running popup lacks stop control or clips horizontally');
    assert(!view.text.includes('failed-source'), 'Internal source ID leaked into primary wording');
    assert(step==='wait_pdf_access' ? view.resume && view.file && view.text.includes('needs attention') : view.text.includes('Keep Chrome running'), `Permission wait incorrectly presents background progress: ${JSON.stringify(view)}`);
  }


  await evaluate(popup, `globalThis.__smoke.setFixtureState({status:'running',runId:'existing-run',step:'auth',stepDetail:'Busy',pdfUrl:'busy.pdf',tasks:[]})`);
  const busyResponse = await evaluate(popup, `chrome.runtime.sendMessage({type:'START_PIPELINE',pdfUrl:${JSON.stringify(`${origin}/plain`)},pageUrl:${JSON.stringify(`${origin}/plain`)},sourceType:'webpage'})`);
  assert(busyResponse?.ok === true, 'A second paper was not queued');
  let storedState = await evaluate(popup, `chrome.runtime.sendMessage({type:'GET_STATE'})`);
  assert(storedState.status === 'queued', 'A second paper stole the preparation slot');
  const existing = await evaluate(popup, `chrome.runtime.sendMessage({type:'GET_STATE',runId:'existing-run'})`);
  assert(existing.step==='auth', 'Queue insertion changed the first job');

  await evaluate(popup, `globalThis.__smoke.setFixtureState({status:'running',runId:'stoppable-run',step:'wait_source',stepDetail:'Waiting',pdfUrl:'wait.pdf',tasks:[]})`);
  const staleStop = await evaluate(popup, `chrome.runtime.sendMessage({type:'ABORT_PIPELINE',runId:'old-run'})`);
  assert(staleStop?.ok === false, 'A stale popup stopped a replacement run');
  const acceptedStop = await evaluate(popup, `chrome.runtime.sendMessage({type:'ABORT_PIPELINE',runId:'stoppable-run'})`);
  assert(acceptedStop?.ok === true, 'The matching polling run could not be stopped');
  storedState = await evaluate(popup, `chrome.runtime.sendMessage({type:'GET_STATE'})`);
  assert(storedState.status === 'stopped' && storedState.runId === 'stoppable-run', 'Stopped job lost its history');

  await evaluate(popup, `chrome.tabs.update(${tabA.id},{active:true})`);
  await reload(popup);
  const downloadsBefore = imports.pdfDownloads;
  await evaluate(popup, `document.getElementById('btn-start').click()`);
  for (let attempt = 0; attempt < 50; attempt++) {
    storedState = await evaluate(popup, `chrome.runtime.sendMessage({type:'GET_STATE'})`);
    if ((storedState.status === 'running' && storedState.step === 'wait_source') || storedState.status === 'error') break;
    await delay(100);
  }
  assert(storedState.step === 'wait_source', `URL import did not reach source polling: ${storedState.error}`);
  assert(imports.notebookTitles.at(-1) === 'A scholarly HTML title', 'HTML title did not reach notebook creation: '+JSON.stringify({titles:imports.notebookTitles,state:storedState}));
  assert(imports.urls.at(-1) === `${origin}/paper-two.pdf`, 'Detected PDF URL was not imported');
  assert(imports.pdfDownloads === downloadsBefore && imports.uploads === 0, 'URL-first import downloaded or uploaded a PDF');

  // Two real popup requests through the shipped worker and wire client.
  await evaluate(popup, `chrome.runtime.sendMessage({type:'ABORT_PIPELINE',runId:${JSON.stringify(storedState.runId)}})`);
  await evaluate(popup, `chrome.runtime.sendMessage({type:'RESET_STATE'})`);
  queueMode=true;
  const jobSettings={generateAudio:true,generateInfographic:false,chimeEnabled:false,notificationEnabled:false};
  const first=await evaluate(popup, `chrome.runtime.sendMessage({type:'START_PIPELINE',pdfUrl:'${origin}/queue-a.pdf',sourceTitle:'Queued paper A',settings:${JSON.stringify({...jobSettings,language:'ko'})}})`);
  const queueState=()=>evaluate(popup, `chrome.runtime.sendMessage({type:'GET_QUEUE'})`);
  const waitForJob=async (id,step)=>{
    for(let i=0;i<100;i++) { const job=(await queueState()).jobs.find(job=>job.runId===id); if(job?.step===step)return job; if(job?.status==='error')throw new Error(job.error); await delay(50); }
    throw new Error('Queued job did not reach '+step);
  };
  await waitForJob(first.runId,'wait_source');
  const second=await evaluate(popup, `chrome.runtime.sendMessage({type:'START_PIPELINE',pdfUrl:'${origin}/queue-b.pdf',sourceTitle:'Queued paper B',settings:${JSON.stringify({...jobSettings,language:'en'})}})`);
  assert((await queueState()).jobs.find(job=>job.runId===second.runId).status==='queued','Second paper bypassed the preparation slot');
  await evaluate(popup, `chrome.runtime.sendMessage({type:'SMOKE_TICK'})`);
  await waitForJob(first.runId,'wait_artifacts');
  await waitForJob(second.runId,'wait_source');
  await reload(popup);
  const queueView=await evaluate(popup, `({text:document.getElementById('job-queue').innerText,current:!!document.getElementById('btn-start'),width:document.documentElement.scrollWidth})`);
  assert(queueView.current && queueView.width<=360 && queueView.text.includes('Requests accepted') && queueView.text.includes('Preparing'),'Popup does not explain the handoff while allowing another paper');
  await evaluate(popup, `chrome.runtime.sendMessage({type:'SMOKE_TICK'})`);
  await waitForJob(second.runId,'wait_artifacts');
  generationComplete=true;
  await evaluate(popup, `chrome.runtime.sendMessage({type:'SMOKE_TICK'})`);
  const pair=(await queueState()).jobs;
  assert(pair.length===2 && pair.every(job=>job.status==='completed') && pair[0].notebookId!==pair[1].notebookId,'Two papers did not produce independent notebook/artifact pairs');
  assert(generations.length===2 && generations[0].language==='ko' && generations[1].language==='en','Queue changed settings or repeated an artifact mutation');
  queueMode=false;
  console.log('Two queued papers completed with separate notebook IDs and saved languages.');

  await popup.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 600, deviceScaleFactor: 1, mobile: false });
  const completedState = { status: 'completed', step: 'done', pdfUrl: 'paper.pdf',
    notebookTitle: 'Harness-of-Harness: Multi-Day Autonomous Software Development with Continual Improvement',
    notebookUrl: `${origin}/notebook/smoke`, collectionAssignment: { status: 'completed', name: 'Research papers' },
    tasks: [{ type: 'audio', status: 'completed' }, { type: 'infographic', status: 'completed' }] };
  await evaluate(popup, `globalThis.__smoke.setFixtureState(${JSON.stringify(completedState)})`);
  await reload(popup);
  await evaluate(popup, `document.querySelector('[data-show]')?.click()`);
  const layout = await evaluate(popup, `({height:document.body.getBoundingClientRect().height,width:document.documentElement.scrollWidth,
    resultBottom:document.querySelector('.completed-box').getBoundingClientRect().bottom,
    linkBottom:document.querySelector('.notebook-link').getBoundingClientRect().bottom,
    collapsed:!document.querySelector('.workflow-details').open})`);
  assert(layout.height <= 600 && layout.width <= 360, 'Completed popup overflows its viewport');
  assert(layout.resultBottom < 600 && layout.linkBottom < 600 && layout.collapsed, 'Results are not immediately visible');
  console.log(`Completed popup layout: ${JSON.stringify(layout)}`);

  const quotedTitle = `A "quoted" title 'with' <markup> & symbols`;
  const quotedUrl = `${origin}/notebook/smoke?q="quoted"&other='value'`;
  await evaluate(popup, `globalThis.__smoke.setFixtureState(${JSON.stringify({ ...completedState, notebookTitle: quotedTitle, notebookUrl: quotedUrl, tasks: [] })})`);
  await reload(popup);
  await evaluate(popup, `document.querySelector('[data-show]')?.click()`);
  const escaped = await evaluate(popup, `({title:document.querySelector('.nb-title').getAttribute('title'),text:document.querySelector('.nb-title').textContent,attributes:document.querySelector('.nb-title').getAttributeNames(),href:document.querySelector('.notebook-link').getAttribute('href'),rel:document.querySelector('.notebook-link').rel,summary:document.querySelector('.completed-box').innerText})`);
  assert(escaped.title === quotedTitle && escaped.text === quotedTitle, 'Quoted notebook title was corrupted');
  assert(escaped.attributes.length === 2 && escaped.href === quotedUrl, 'Title or URL created unexpected markup');
  assert(escaped.rel.includes('noopener') && escaped.rel.includes('noreferrer'), 'Notebook link lacks isolation');
  assert(escaped.summary.includes('Source imported. No artifacts requested.'), 'Empty-task completion claims artifact output');

  await localizationSmoke({ popup, evaluate, reload, root: sourceRoot, completedState });

  // Exercise the real Chrome message bridge and the complete file upload client.
  await evaluate(popup, `globalThis.__smoke.setFixtureState({status:'idle'})`);
  await evaluate(popup, `chrome.runtime.sendMessage({type:'PAUSE_QUEUE',paused:true})`);
  const size = 40 * 1024 * 1024;
  const expectedBytes = Buffer.alloc(size, 32);
  expectedBytes.write('%PDF-1.7\n');
  const expectedHash = createHash('sha256').update(expectedBytes).digest('hex');
  const started = Date.now();
  const baselineHeap = await popup.call('Runtime.getHeapUsage');
  const transfer = await evaluate(popup, `(async()=>{
    const bytes=new Uint8Array(${size}).fill(32); bytes.set(new TextEncoder().encode('%PDF-1.7\\n'));
    let last=performance.now(),maxGapMs=0,ticks=0;
    const timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;ticks++;},25);
    const file=new File([bytes],'paper.pdf',{type:'application/pdf'});
    let metadataReadBytes=0,messageBytes=0;
    const slice=file.slice.bind(file);
    file.slice=(...args)=>{const part=slice(...args);metadataReadBytes+=part.size;return part;};
    file.arrayBuffer=()=>{throw new Error('Full-file metadata read');};
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=(message,...args)=>{
      if(message.type==='START_PIPELINE_FILE') messageBytes=new TextEncoder().encode(JSON.stringify(message)).byteLength;
      return send(message,...args);
    };
    try {
      const ok=await globalThis.__smoke.startPipelineFile(file,null);
      return {response:{ok},messageBytes,maxGapMs,ticks,metadataReadBytes};
    } finally {clearInterval(timer);chrome.runtime.sendMessage=send;}
  })()`);
  assert(transfer.response.ok, `Large PDF start failed: ${JSON.stringify(transfer.response)}`);
  assert(transfer.messageBytes < 64 * 1024 * 1024, 'Large PDF message exceeds Chrome limit');
  assert(transfer.metadataReadBytes === 2 * 256 * 1024 + 1024, 'Large local metadata read was not bounded');
  const queuedBeforeRestart = await evaluate(popup, `chrome.runtime.sendMessage({type:'GET_STATE'})`);
  assert(queuedBeforeRestart.status==='queued' && queuedBeforeRestart.payloadBytes===size, 'PDF was not durably queued before acknowledgment');
  await popup.call('ServiceWorker.enable');
  await popup.call('ServiceWorker.stopAllWorkers');
  const afterRestart = await evaluate(popup, `chrome.runtime.sendMessage({type:'GET_QUEUE'})`);
  assert(afterRestart.paused && afterRestart.jobs.at(-1).runId===queuedBeforeRestart.runId, 'Worker restart lost the saved queue');
  await evaluate(popup, `chrome.runtime.sendMessage({type:'PAUSE_QUEUE',paused:false})`);
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
    storedState = await evaluate(popup, `chrome.runtime.sendMessage({type:'GET_STATE'})`);
    if ((storedState.status === 'running' && storedState.step === 'wait_source') || storedState.status === 'error') break;
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
  console.log(`40 MiB transfer: ${JSON.stringify({messageBytes:transfer.messageBytes,metadataReadBytes:transfer.metadataReadBytes,elapsedMs:Date.now()-started,maxTimerGapMs:transfer.maxGapMs,peak,sha256:imports.uploadedHash})}`);

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
