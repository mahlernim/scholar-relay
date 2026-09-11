import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as api from '../notebooklm-api.js';
import * as runtime from '../runtime-policy.js';
import * as fallback from '../source-import.js';
import * as detection from '../detection-policy.js';
import * as pdf from '../pdf-file-policy.js';
import * as permissions from '../site-permissions.js';
import * as i18n from '../i18n.js';
import * as jobs from '../job-queue.js';
import * as settings from '../settings.js';
import { withRequestDeadline } from '../request-deadline.js';

// Run the shipped worker with real policy modules and controlled browser/service IO.
const source = (await readFile(new URL('../background.js', import.meta.url), 'utf8'))
  .replace(/^import\s+[\s\S]*?from\s+'[^']+';\r?\n/gm, '');

async function worker({ failInitialQueueRead = false, initialQueue = null, initialFiles = [], initialTargets = {} } = {}) {
  const data = { pipelineState: { status: 'idle' }, userSettings: { chimeEnabled: false, notificationEnabled: false } };
  Object.defineProperty(data, 'pipelineState', {
    get: () => data.jobQueue?.jobs.at(-1) || { status: 'idle' },
    set: state => { data.jobQueue = { version: 1, paused: false, jobs: state.runId ? [structuredClone(state)] : [] }; },
  });
  if (initialQueue) data.jobQueue = structuredClone(initialQueue);
  data.notificationTargets = structuredClone(initialTargets);
  const files = new Map(initialFiles);
  const logs = [];
  const notifications = [];
  const opened = [];
  const notificationEvents = {};
  let listener;
  let messageListener;
  const hooks = {};
  if (failInitialQueueRead) {
    hooks.read = key => {
      if (key === 'jobQueue') {
        hooks.read = null;
        throw new Error('Temporary queue read failure');
      }
    };
  }
  const noop = async () => {};
  const event = { addListener() {} };
  const apiMocks = Object.fromEntries(Object.entries(api).map(([key, value]) => [key,
    typeof value === 'function' ? () => { throw new Error(`Unexpected service call ${key}`); } : value]));
  const context = vm.createContext({
    ...apiMocks, ...runtime, ...fallback, ...detection, ...pdf, ...permissions, ...i18n, ...jobs, ...settings, withRequestDeadline,
    createQueuedPdfStore: () => ({ put: async (id,file) => files.set(id,structuredClone(file)), get: async id => files.get(id), remove: async id => files.delete(id), prune: async () => {} }),
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
    crypto: webcrypto, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, setTimeout, clearTimeout,
    chrome: {
      storage: { local: {
        async remove(key) { if(key!=='pipelineState') delete data[key]; },
        async get(key) { const result = structuredClone({ [key]: data[key] }); await hooks.read?.(key); return result; },
        async set(update) { await hooks.write?.(update); Object.assign(data, structuredClone(update)); },
      } },
      alarms: { get: async () => null, clear: noop, create: noop, onAlarm: { addListener(fn) { listener = fn; } } },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      runtime: { getURL: path => `chrome-extension://scholarrelay-test/${path}`, onMessage: { addListener(fn) { messageListener = fn; } } },
      notifications: { onClicked: { addListener(fn) { notificationEvents.clicked = fn; } },
        onButtonClicked: { addListener(fn) { notificationEvents.button = fn; } }, onClosed: event, clear: noop,
        create: async (id, options) => notifications.push({ id, ...options }) },
      tabs: { create: async options => opened.push(options.url) },
    },
  });
  vm.runInContext(source, context);
  await vm.runInContext('bootReconciliationPromise', context);
  await new Promise(resolve => setImmediate(resolve));
  const functions = vm.runInContext('({startPipelineRequest, stopPipelineRequest, tickArtifactPoll, tickSourcePoll, resumePdfFallback, reconcilePipelineRuntime, getQueue, decodeQueuedPdf, shouldRetainJobPdf, ensureBootReconciled, failPipeline, holdForSession, safeNotificationTarget, inspectNotebookCleanup, deleteJobNotebook})', context);
  return { data, logs, notifications, opened, notificationEvents, hooks, context, listener, messageListener, files, ...functions };
}

function sendWorkerMessage(workerState, message, sender = {}) {
  return new Promise(resolve => {
    const asyncResponse = workerState.messageListener(message, sender, resolve);
    if (asyncResponse !== true) resolve(undefined);
  });
}

test('completion and failure notifications use localized guidance without changing worker diagnostics', async () => {
  const catalog = JSON.parse(await readFile(new URL('../_locales/ko/messages.json', import.meta.url), 'utf8'));
  const w = await worker();
  w.data.userSettings.notificationEnabled = true;
  try {
    globalThis.chrome = { i18n: { getMessage(key, values) {
      return catalog[key]?.message.replace(/\$(\d+)/g, (_, index) => values[index - 1]) || '';
    } } };
    w.data.pipelineState = { ...running(), notebookTitle: 'My unchanged title' };
    await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
    assert.equal(w.notifications[0].title, 'Gemini Notebook 준비 완료!');
    assert.ok(w.notifications[0].message.includes('My unchanged title'));
    assert.equal(w.notifications[0].buttons[0].title, '노트북 열기');
    w.data.pipelineState = running([{status:'failed'}]);
    w.context.listArtifactStatuses = async () => new Map();
    await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
    assert.equal(w.notifications[1].title, 'ScholarRelay 오류');
    assert.match(w.notifications[1].message, /상세 내용/);
    assert.match(w.data.pipelineState.error, /All artifact generations failed/);
  } finally { delete globalThis.chrome; }
});

function running(tasks = []) {
  return { status: 'running', runId: 'old', step: 'wait_artifacts', notebookId: 'notebook',
    stepStartedAt: new Date().toISOString(), tasks };
}

test('all-failed generation retains quota diagnostics and notifies with the affected artifact', async () => {
  const w = await worker();
  w.data.userSettings.notificationEnabled = true;
  w.context.listArtifactStatuses = async () => new Map();
  w.data.pipelineState = running([{ type: 'audio', status: 'failed', code: 'RATE_LIMITED', error: 'RATE_LIMITED: API limit' }]);
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.match(w.notifications[0].message, /Generation is limited.*Audio Overview/);
  assert.equal(w.data.pipelineState.tasks[0].code, 'RATE_LIMITED');
});

test('failed setup offers explicit cleanup without deleting the notebook automatically', async () => {
  const w = await worker();
  let deletions = 0;
  w.context.deleteNotebook = async () => { deletions++; };
  w.data.pipelineState = { ...running(), step: 'add_source', notebookId: 'notebook-owned' };
  await w.failPipeline('old', 'Source failed', 'notebook-owned');
  assert.equal(deletions, 0);
  assert.equal(w.data.pipelineState.cleanupAvailable, true);
  assert.equal(w.data.pipelineState.notebookId, 'notebook-owned');
});

test('cleanup inspection refuses notebooks with useful or possibly active artifacts', async () => {
  const w = await worker();
  w.data.pipelineState = { ...running(), status: 'error', step: 'error', notebookId: 'notebook-owned', cleanupAvailable: true };
  w.context.listSources = async () => [{ id: 'source-1', status: 3 }];
  w.context.listArtifactStatuses = async () => new Map([['artifact-1', { taskId: 'artifact-1', status: 'completed' }]]);
  await assert.rejects(w.inspectNotebookCleanup('old'), /completed or possibly active work/);
});

test('confirmed cleanup rechecks the notebook and deletes only the matching owned job', async () => {
  const w = await worker();
  let deletions = 0;
  w.data.pipelineState = { ...running(), status: 'error', step: 'error', notebookId: 'notebook-owned', notebookUrl: 'https://notebook.google.com/notebook/notebook-owned', cleanupAvailable: true };
  w.context.listSources = async () => [{ id: 'source-1', status: 4 }];
  w.context.listArtifactStatuses = async () => new Map([['artifact-1', { taskId: 'artifact-1', status: 'failed' }]]);
  w.context.deleteNotebook = async id => { assert.equal(id, 'notebook-owned'); deletions++; return { ok: true }; };
  const check = await w.inspectNotebookCleanup('old');
  const result = await w.deleteJobNotebook({ runId: 'old', snapshot: check.snapshot });
  assert.equal(result.ok, true);
  assert.equal(deletions, 1);
  assert.equal(w.data.pipelineState.cleanupStatus, 'deleted');
  assert.equal(w.data.pipelineState.notebookUrl, null);
});

test('cleanup never deletes after notebook contents change or an outcome becomes uncertain', async () => {
  const w = await worker();
  w.data.pipelineState = { ...running(), status: 'stopped', step: 'wait_artifacts', notebookId: 'notebook-owned', cleanupAvailable: true };
  w.context.listSources = async () => [];
  w.context.listArtifactStatuses = async () => new Map();
  const check = await w.inspectNotebookCleanup('old');
  w.context.listSources = async () => [{ id: 'new-source', status: 3 }];
  await assert.rejects(w.deleteJobNotebook({ runId: 'old', snapshot: check.snapshot }), /changed after confirmation/);
  w.context.listSources = async () => [];
  w.context.deleteNotebook = async () => { throw Object.assign(new Error('Unknown outcome'), { code: 'TRANSIENT_MUTATION_UNCERTAIN' }); };
  await assert.rejects(w.deleteJobNotebook({ runId: 'old', snapshot: check.snapshot }), /Unknown outcome/);
  assert.equal(w.data.pipelineState.cleanupStatus, 'unknown');
  assert.equal(w.data.pipelineState.notebookUrl, undefined);
});

test('boot preserves PDF wait diagnostics and sends only one recovery notification', async () => {
  const job = { ...running(), step: 'wait_pdf_access', pdfWaitReason: 'publisher',
    stepDetail: 'HTTP 403 while downloading source PDF', attentionSince: '2026-09-08T00:00:00Z',
    settings: { notificationEnabled: true } };
  const w = await worker({ initialQueue: { version: 1, paused: true, jobs: [job] } });
  assert.match(w.notifications[0].message, /publisher blocked/);
  await w.reconcilePipelineRuntime();
  assert.equal(w.notifications.length, 1);
  assert.equal(w.data.jobQueue.jobs[0].stepDetail, job.stepDetail);
  assert.equal(w.data.jobQueue.jobs[0].attentionSince, job.attentionSince);
  assert.equal(w.data.jobQueue.jobs[0].notebookId, job.notebookId);
});

test('backend rejects no-artifact starts without creating or claiming a notebook', async () => {
  const w = await worker();
  Object.assign(w.data.userSettings, { generateAudio: false, generateInfographic: false });
  await assert.rejects(w.startPipelineRequest({ pdfUrl: 'https://example.org/paper.pdf' }),
    { code: 'NO_ARTIFACT_SELECTED' });
  assert.equal(w.data.pipelineState.status, 'idle');
});

test('legacy empty tasks complete before timeout without listing artifacts', async () => {
  const w = await worker();
  w.data.pipelineState = { ...running(), stepStartedAt: '2000-01-01T00:00:00Z' };
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(w.data.pipelineState.status, 'completed');
  assert.match(w.data.pipelineState.stepDetail, /Source imported successfully/);
});

test('nonempty all-failed tasks still fail, while partial success completes', async () => {
  for (const tasks of [[{ status: 'failed' }], [{ status: 'completed' }, { status: 'failed' }]]) {
    const w = await worker();
    w.context.listArtifactStatuses = async () => new Map();
    w.data.pipelineState = running(tasks);
    await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
    assert.equal(w.data.pipelineState.status, tasks.length === 1 ? 'error' : 'completed');
  }
});

test('alarm swallows ownership races and preserves the replacement run', async () => {
  for (const step of ['wait_source', 'wait_artifacts']) {
    const w = await worker();
    w.data.pipelineState = { ...running(), step };
    w.hooks.read = key => {
      if (key !== 'jobQueue') return;
      w.hooks.read = null;
      w.data.pipelineState = { ...running(), runId: 'replacement', step };
    };
    await assert.doesNotReject(w.listener({ name: runtime.PIPELINE_ALARM_NAME }));
    assert.equal(w.data.pipelineState.runId, 'replacement');
    assert.equal(w.data.pipelineState.status, 'running');
    assert.ok(w.logs.some(row => row[1].includes('Ignoring stale tick')));
  }
});

test('alarm logs unexpected errors and unlocks for the next tick', async () => {
  const w = await worker();
  w.data.pipelineState = running();
  w.hooks.write = () => { throw new Error('Storage unavailable'); };
  await assert.doesNotReject(w.listener({ name: runtime.PIPELINE_ALARM_NAME }));
  assert.ok(w.logs.some(row => row[0] === 'error' && row[1].includes('wait_artifacts')));
  w.hooks.write = null;
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(w.data.pipelineState.status, 'completed');
});

test('alarm overlap warning remains reachable', async () => {
  const w = await worker();
  w.data.pipelineState = running();
  let release;
  w.hooks.read = key => {
    if (key !== 'jobQueue') return;
    w.hooks.read = null;
    return new Promise(resolve => { release = resolve; });
  };
  const first = w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  while (!release) await Promise.resolve();
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.ok(w.logs.some(row => row[1].includes('skipping overlap')));
  release();
  await first;
});

test('alarm cleanup failures are logged rather than lost in an effect result', async () => {
  const w = await worker();
  w.context.chrome.alarms.clear = async () => { throw new Error('Alarm unavailable'); };
  await assert.doesNotReject(w.listener({ name: runtime.PIPELINE_ALARM_NAME }));
  assert.ok(w.logs.some(row => row[0] === 'error' && row[2]?.message === 'Alarm unavailable'));
});

test('settings changed during ingestion stop generation without deleting the imported notebook', async () => {
  const w = await worker();
  w.data.pipelineState = { ...running(), step: 'wait_source', sourceId: 'source' };
  Object.assign(w.data.userSettings, { generateAudio: false, generateInfographic: false });
  w.context.listSources = async () => [{ id: 'source', status: api.SourceStatus.READY }];
  w.context.getNotebookTitle = async () => 'Imported paper';
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(w.data.pipelineState.status, 'error');
  assert.match(w.data.pipelineState.error, /Select at least one artifact/);
  assert.equal(w.data.pipelineState.notebookId, 'notebook');
});

test('uncertain generation preserves inspection guidance and never adopts an unrelated artifact', async () => {
  const w = await worker();
  w.data.userSettings.generateInfographic = false;
  w.data.pipelineState = { ...running(), step: 'wait_source', sourceId: 'source' };
  w.context.listSources = async () => [{ id: 'source', status: api.SourceStatus.READY }];
  w.context.getNotebookTitle = async () => 'Paper';
  let mutations = 0;
  w.context.generateAudio = async () => {
    mutations++;
    throw Object.assign(new Error('Accepted response stalled'), { code: 'TRANSIENT_MUTATION_UNCERTAIN' });
  };
  w.context.listArtifactStatuses = async () => new Map([['unattributable-id', { status: 'completed' }]]);
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(w.data.pipelineState.tasks[0].status, 'uncertain');
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(w.data.pipelineState.status, 'error');
  assert.match(w.data.pipelineState.error, /Uncertain.*Check this notebook/);
  assert.equal(w.data.pipelineState.tasks[0].error, 'Accepted response stalled');
  assert.equal(w.data.pipelineState.tasks[0].taskId, null);
  assert.equal(mutations, 1);
});

test('unknown ingestion status does not start generation', async () => {
  const w = await worker();
  w.data.pipelineState = { ...running(), step: 'wait_source', sourceId: 'source' };
  w.context.listSources = async () => [{ id: 'source', status: api.SourceStatus.UNKNOWN }];
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(w.data.pipelineState.step, 'wait_source');
  assert.equal(w.data.pipelineState.tasks.length, 0);
});

async function settleUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), 'Worker did not reach expected state');
}

function installQueueService(w) {
  const writes = [];
  w.context.fetchTokens = async () => {};
  w.context.getNotebookUrl = id => `https://notebook.google.com/notebook/${id}`;
  w.context.createNotebook = async title => {
    const id = `notebook-${writes.length}`;
    writes.push({ kind: 'notebook', id, title });
    return { id };
  };
  w.context.addUrlSource = async (id, url) => {
    writes.push({ kind: 'source', id, url });
    return { id: `source-${id}` };
  };
  w.context.listSources = async id => [{ id: `source-${id}`, status: api.SourceStatus.READY }];
  w.context.getNotebookTitle = async id => id;
  for (const [fn, kind] of [['generateAudio', 'audio'], ['generateInfographic', 'infographic']]) {
    w.context[fn] = async (id, ...args) => {
      writes.push({ kind, id, args });
      return { taskId: `artifact-${id}`, status: 'in_progress' };
    };
  }
  w.context.listArtifactStatuses = async id => new Map([[`artifact-${id}`, { status: 'completed' }]]);
  return writes;
}

test('two papers retain settings and ownership while generation overlaps the next preparation', async () => {
  const w = await worker();
  const writes = installQueueService(w);
  Object.assign(w.data.userSettings, { generateInfographic: false, language: 'ko', audioPrompt: 'First prompt' });
  const a = await w.startPipelineRequest({ pdfUrl: 'https://example.org/a.pdf', sourceTitle: 'Paper A' });
  await settleUntil(() => w.data.jobQueue.jobs[0]?.step === 'wait_source');
  Object.assign(w.data.userSettings, { generateAudio: false, generateInfographic: true, language: 'en' });
  const b = await w.startPipelineRequest({ pdfUrl: 'https://example.org/b.pdf', sourceTitle: 'Paper B' });
  assert.equal(w.data.jobQueue.jobs[1].status, 'queued');
  const aJob = () => w.data.jobQueue.jobs.find(job => job.runId === a.runId);
  const bJob = () => w.data.jobQueue.jobs.find(job => job.runId === b.runId);
  await w.tickSourcePoll(aJob());
  await settleUntil(() => bJob().step === 'wait_source');
  assert.equal(aJob().step, 'wait_artifacts');
  assert.equal(aJob().settings.language, 'ko');
  assert.deepEqual(writes.filter(write => ['audio', 'infographic'].includes(write.kind)).map(write => write.kind), ['audio']);
  assert.equal(writes.find(write => write.kind === 'audio').args[1], 'ko');
  assert.equal(writes.find(write => write.kind === 'audio').args[4], 'First prompt');
  await w.tickArtifactPoll(aJob());
  assert.equal(aJob().status, 'completed');
  assert.equal(bJob().step, 'wait_source');
  await w.tickSourcePoll(bJob());
  await w.tickArtifactPoll(bJob());
  assert.equal(bJob().status, 'completed');
  assert.equal(bJob().tasks[0].type, 'infographic');
  assert.equal(writes.filter(write => write.kind === 'notebook').length, 2);
  assert.equal(writes.filter(write => write.kind === 'source').length, 2);
  assert.notEqual(aJob().notebookId, bJob().notebookId);
});

test('pause stops new starts, duplicates reuse the saved job, and removing one job preserves others', async () => {
  const w = await worker();
  const writes = installQueueService(w);
  w.data.jobQueue.paused = true;
  const message = { requestId: 'request-a', pdfUrl: 'https://example.org/a.pdf' };
  const [first, repeated] = await Promise.all([w.startPipelineRequest(message), w.startPipelineRequest(message)]);
  assert.equal(first.runId, repeated.runId);
  const b = await w.startPipelineRequest({ pdfUrl: 'https://example.org/b.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 0);
  await w.stopPipelineRequest(first.runId);
  assert.equal(w.data.jobQueue.jobs.find(job => job.runId === b.runId).status, 'queued');
  w.data.jobQueue.paused = false;
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  await settleUntil(() => w.data.jobQueue.jobs.find(job => job.runId === b.runId).step === 'wait_source');
  assert.equal(writes.filter(write => write.kind === 'notebook').length, 1);
});

test('three monitored notebooks prevent another start until a generation slot is released', async () => {
  const w = await worker();
  const writes = installQueueService(w);
  w.data.jobQueue.jobs = [1,2,3].map(i => ({ ...running([{ taskId: `a-${i}`, status: 'in_progress' }]), runId: `run-${i}`, notebookId: `nb-${i}` }));
  const queued = await w.startPipelineRequest({ pdfUrl: 'https://example.org/next.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 0);
  await w.stopPipelineRequest('run-1', 'keep');
  await settleUntil(() => w.data.jobQueue.jobs.find(job => job.runId === queued.runId).step === 'wait_source');
  assert.equal(w.data.jobQueue.jobs.find(job => job.runId === 'run-2').status, 'running');
});

test('restart preserves queued jobs and polling IDs but never replays interrupted writes', async () => {
  const w = await worker();
  const writes = installQueueService(w);
  w.data.jobQueue.paused = true;
  await w.startPipelineRequest({ pdfUrl: 'https://example.org/queued.pdf' });
  w.data.jobQueue.jobs.push({ ...running([{ taskId: 'accepted-id', status: 'in_progress' }]), runId: 'accepted' },
    { ...running(), runId: 'uncertain', step: 'generate_artifacts' });
  await w.reconcilePipelineRuntime();
  assert.equal(w.data.jobQueue.jobs[0].status, 'queued');
  assert.equal(w.data.jobQueue.jobs[1].tasks[0].taskId, 'accepted-id');
  assert.equal(w.data.jobQueue.jobs[2].status, 'error');
  assert.match(w.data.jobQueue.jobs[2].error, /avoid duplicate/);
  assert.equal(writes.length, 0);
});

test('queued PDFs are persisted before acknowledgment and removed with only their own job', async () => {
  const w = await worker();
  w.data.jobQueue.paused = true;
  const file = { filename: 'paper.pdf', fileData: btoa('%PDF-1.7\n durable test') };
  const job = await w.startPipelineRequest({}, file);
  const saved = w.files.get(job.runId);
  assert.equal(new TextDecoder().decode(saved.fileData), '%PDF-1.7\n durable test');
  assert.equal(w.data.jobQueue.jobs[0].payloadId, job.runId);
  const repeated = await w.startPipelineRequest({}, file);
  assert.equal(repeated.runId, job.runId);
  await w.stopPipelineRequest(job.runId);
  assert.equal(w.files.size, 0);
  w.data.jobQueue.jobs.push({ ...running(), runId: 'large-saved-file', payloadBytes: jobs.MAX_QUEUED_PDF_BYTES });
  await assert.rejects(w.startPipelineRequest({}, file), /100 MiB/);
});

test('queued PDF data URLs decode correctly and payloads survive permission waits', async () => {
  const w = await worker();
  const raw = '%PDF-1.7\n durable fallback';
  const decoded = w.decodeQueuedPdf(`data:application/pdf;base64,${btoa(raw)}`, 'fallback.pdf');
  assert.equal(new TextDecoder().decode(decoded.fileData), raw);
  assert.equal(w.shouldRetainJobPdf({ step: 'wait_pdf_access' }), true);
  assert.equal(w.shouldRetainJobPdf({ step: 'wait_source' }), false);
});

test('boot reconciliation retries after a transient failure and message errors respond', async () => {
  const w = await worker({ failInitialQueueRead: true });
  assert.ok(w.logs.some(row => row[0] === 'error' && row[1].includes('Initial reconciliation failed')));
  const recovered = await sendWorkerMessage(w, { type: 'GET_STATE', runId: 'missing' });
  assert.equal(recovered.status, 'idle');

  w.hooks.read = key => {
    if (key === 'jobQueue') throw new Error('Queue unavailable');
  };
  const stateError = await sendWorkerMessage(w, { type: 'GET_STATE', runId: 'missing' });
  assert.equal(stateError.ok, false);
  assert.equal(stateError.message, 'Queue unavailable');
  w.hooks.read = null;

  w.hooks.write = () => { throw new Error('Storage unavailable'); };
  const detectionError = await sendWorkerMessage(w, { type: 'DETECT_PDF', data: { pageUrl: 'https://example.org/paper.pdf' } },
    { tab: { id: 7, url: 'https://example.org/paper.pdf' } });
  assert.equal(detectionError.ok, false);
  assert.equal(detectionError.message, 'Storage unavailable');
});

test('a paper awaiting PDF access does not block the next paper or let resume steal its slot', async () => {
  const w = await worker();
  installQueueService(w);
  w.data.jobQueue.jobs.push({ ...running(), runId: 'needs-access', step: 'wait_pdf_access',
    importMethod: 'url', fallbackAttempted: true, originalPdfUrl: 'https://example.org/blocked.pdf' });
  const next = await w.startPipelineRequest({ pdfUrl: 'https://example.org/next.pdf' });
  await settleUntil(() => w.data.jobQueue.jobs.find(job => job.runId === next.runId).step === 'wait_source');
  const response = await w.resumePdfFallback({ runId: 'needs-access' });
  assert.equal(response.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.data.jobQueue.jobs.find(job => job.runId === 'needs-access').step, 'queued_pdf');
  assert.equal(w.data.jobQueue.jobs.find(job => job.runId === next.runId).step, 'wait_source');
});

test('queue storage failures do not acknowledge a job or retain its PDF outside the budget', async () => {
  const w = await worker();
  const writes = installQueueService(w);
  w.data.jobQueue.paused = true;
  w.hooks.write = update => {
    if (update.jobQueue?.jobs.length) throw new Error('Storage quota exceeded');
  };
  await assert.rejects(w.startPipelineRequest({}, { filename: 'paper.pdf', fileData: btoa('%PDF-1.7\n') }), /Storage quota/);
  assert.equal(w.data.jobQueue.jobs.length, 0);
  assert.equal(w.files.size, 0);
  assert.equal(writes.length, 0);
});

test('queue capacity rejects a twenty-first unfinished job before any remote writes', async () => {
  const w = await worker();
  const writes = installQueueService(w);
  w.data.jobQueue.paused = true;
  for (let i = 0; i < jobs.MAX_QUEUED_JOBS; i++) {
    await w.startPipelineRequest({ pdfUrl: `https://example.org/${i}.pdf` });
  }
  await assert.rejects(w.startPipelineRequest({ pdfUrl: 'https://example.org/extra.pdf' }), /queue is full/);
  assert.equal(w.data.jobQueue.jobs.length, 20);
  assert.equal(writes.length, 0);
});


function discoveryFailure() {
  return Object.assign(new Error('SESSION_UNAVAILABLE: Gemini Notebook could not be reached. notebook.google.com: service HTTP 503'),
    { code: 'SESSION_UNAVAILABLE', phase: 'auth_discovery' });
}

async function makeHeldQueue() {
  const w = await worker();
  const writes = installQueueService(w);
  w.data.userSettings.notificationEnabled = true;
  w.data.jobQueue.paused = true;
  const first = await w.startPipelineRequest({}, { filename: 'saved.pdf', fileData: btoa('%PDF-1.7\n retained bytes') });
  await w.startPipelineRequest({ pdfUrl: 'https://example.org/second.pdf' });
  let attempts = 0;
  w.context.fetchTokens = async () => { attempts++; throw discoveryFailure(); };
  await sendWorkerMessage(w, { type: 'PAUSE_QUEUE', paused: false });
  await settleUntil(() => w.notifications.length === 1);
  return { w, writes, first, attempts: () => attempts };
}

test('shared session outage holds all unstarted jobs and PDFs without repeated notifications', async () => {
  const { w, writes, first, attempts } = await makeHeldQueue();
  assert.ok(w.data.jobQueue.serviceBlock.id);
  assert.equal(w.data.jobQueue.serviceBlock.code, 'SESSION_UNAVAILABLE');
  assert.equal(w.data.jobQueue.paused, false);
  assert.ok(w.data.jobQueue.jobs.every(job => job.status === 'queued'));
  assert.equal(w.files.size, 1);
  assert.equal(w.data.jobQueue.jobs[0].payloadId, first.runId);
  for (let i = 0; i < 3; i++) await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(attempts(), 1);
  assert.equal(w.notifications.length, 1);
  assert.equal(writes.length, 0);
  assert.doesNotMatch(w.notifications[0].message, /Sign in/);
});

test('connection hold survives worker restart and resume uploads the retained PDF only once', async () => {
  const { w, first } = await makeHeldQueue();
  const restarted = await worker({ initialQueue: w.data.jobQueue, initialFiles: [...w.files] });
  const writes = installQueueService(restarted);
  let uploads = 0;
  restarted.context.addFileSource = async (id, filename, bytes) => {
    uploads++;
    assert.equal(filename, 'saved.pdf');
    assert.equal(new TextDecoder().decode(bytes), '%PDF-1.7\n retained bytes');
    return { id: 'source-' + id };
  };
  assert.equal(writes.length, 0);
  assert.equal(restarted.files.size, 1);
  const response = await sendWorkerMessage(restarted, { type: 'RESUME_SERVICE', blockId: restarted.data.jobQueue.serviceBlock.id });
  assert.equal(response.ok, true);
  await settleUntil(() => restarted.data.jobQueue.jobs[0].step === 'wait_source' && restarted.files.size === 0);
  assert.equal(restarted.data.jobQueue.jobs[0].runId, first.runId);
  assert.equal(restarted.data.jobQueue.jobs[1].status, 'queued');
  assert.equal(uploads, 1);
  assert.equal(writes.filter(item => item.kind === 'notebook').length, 1);
});

test('stale resume does not clear a newer connection hold and resume preserves user pause', async () => {
  const { w, writes } = await makeHeldQueue();
  w.data.jobQueue.paused = true;
  const id = w.data.jobQueue.serviceBlock.id;
  assert.equal((await sendWorkerMessage(w, { type: 'RESUME_SERVICE', blockId: 'stale' })).ok, false);
  assert.equal(w.data.jobQueue.serviceBlock.id, id);
  assert.equal((await sendWorkerMessage(w, { type: 'RESUME_SERVICE', blockId: id })).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.data.jobQueue.serviceBlock, null);
  assert.equal(w.data.jobQueue.paused, true);
  assert.equal(writes.length, 0);
  assert.equal((await sendWorkerMessage(w, { type: 'RESUME_SERVICE', blockId: id })).ok, false);
});

test('already accepted jobs are monitored while connection discovery holds new starts', async () => {
  const { w, attempts } = await makeHeldQueue();
  w.data.jobQueue.jobs.push({ ...running([{ taskId: 'artifact-notebook-existing', status: 'in_progress' }]),
    runId: 'accepted', notebookId: 'notebook-existing', settings: { notificationEnabled: false } });
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(w.data.jobQueue.jobs.find(job => job.runId === 'accepted').status, 'completed');
  assert.ok(w.data.jobQueue.serviceBlock);
  assert.equal(attempts(), 1);
});

test('session errors after setup and uncertain mutations cannot be requeued by the hold guard', async () => {
  const w = await worker();
  for (const step of ['create_notebook', 'add_source', 'generate_artifacts', 'wait_artifacts']) {
    w.data.pipelineState = { ...running(), step };
    assert.equal(await w.holdForSession('old', discoveryFailure()), false);
    assert.equal(w.data.jobQueue.serviceBlock, undefined);
  }
  const writes = installQueueService(w);
  w.data.jobQueue.jobs = [];
  w.context.createNotebook = async () => { writes.push({ kind: 'uncertain' }); throw Object.assign(new Error('Mutation outcome unknown'), { code: 'TRANSIENT_MUTATION_UNCERTAIN' }); };
  await w.startPipelineRequest({ pdfUrl: 'https://example.org/uncertain.pdf' });
  await settleUntil(() => w.data.jobQueue.jobs[0]?.status === 'error');
  await w.listener({ name: runtime.PIPELINE_ALARM_NAME });
  assert.equal(writes.length, 1);
  assert.equal(w.data.jobQueue.jobs[0].failedStep, 'create_notebook');
  assert.equal(w.data.jobQueue.jobs[0].failure.code, 'TRANSIENT_MUTATION_UNCERTAIN');
});

test('paper-specific import errors do not hold the next queued paper', async () => {
  const w = await worker();
  installQueueService(w);
  w.data.jobQueue.paused = true;
  await w.startPipelineRequest({ pdfUrl: 'https://example.org/first.pdf' });
  await w.startPipelineRequest({ pdfUrl: 'https://example.org/next.pdf' });
  let imports = 0;
  w.context.addUrlSource = async () => { if (++imports === 1) throw new Error('Paper unavailable'); return { id: 'next-source' }; };
  await sendWorkerMessage(w, { type: 'PAUSE_QUEUE', paused: false });
  await settleUntil(() => w.data.jobQueue.jobs[1].step === 'wait_source');
  assert.equal(w.data.jobQueue.jobs[0].status, 'error');
  assert.equal(w.data.jobQueue.jobs[0].failedStep, 'add_source');
  assert.equal(w.data.jobQueue.serviceBlock, undefined);
  assert.equal(imports, 2);
});

test('error notifications preserve the failed stage and open that job after restart or history clearing', async () => {
  const w = await worker();
  w.data.userSettings.notificationEnabled = true;
  w.data.pipelineState = { ...running([{ type: 'audio', status: 'completed' }]), sourceTitle: 'Named paper' };
  await w.failPipeline('old', Object.assign(new Error('Polling failed'), { code: 'READ_FAILED' }));
  assert.equal(w.data.pipelineState.failedStep, 'wait_artifacts');
  assert.equal(w.data.pipelineState.tasks[0].status, 'completed');
  assert.equal(w.data.pipelineState.failure.code, 'READ_FAILED');
  assert.match(w.notifications[0].message, /^Named paper/);
  const restarted = await worker({ initialQueue: w.data.jobQueue, initialTargets: w.data.notificationTargets });
  restarted.data.jobQueue.jobs = [];
  await restarted.notificationEvents.clicked('pipeline-error:old');
  assert.deepEqual(restarted.opened, ['chrome-extension://scholarrelay-test/popup.html?runId=old']);
});

test('notification routing rejects unsafe targets and preserves valid completion navigation', async () => {
  const w = await worker();
  for (const url of ['javascript:alert(1)', 'https://example.org/notebook/id',
    'https://notebook.google.com.evil.test/notebook/id', 'https://user:pass@notebook.google.com/notebook/id',
    'chrome-extension://other-extension/popup.html']) assert.equal(w.safeNotificationTarget(url), null);
  w.data.notificationTargets['pipeline-complete:one'] = { notebookUrl: 'javascript:alert(1)' };
  await w.notificationEvents.clicked('pipeline-complete:one');
  assert.equal(w.opened.length, 0);
  w.data.notificationTargets['pipeline-complete:two'] = { notebookUrl: 'https://notebook.google.com/notebook/accepted-id' };
  await w.notificationEvents.clicked('pipeline-complete:two');
  assert.deepEqual(w.opened, ['https://notebook.google.com/notebook/accepted-id']);
  await w.notificationEvents.clicked('pipeline-error:missing');
  assert.equal(w.opened.at(-1), 'chrome-extension://scholarrelay-test/popup.html?runId=missing');
});

test('cancel during creation persists intent and deletes the late notebook once', async () => {
  const w = await worker();
  let resolveCreate;
  let deleted = 0;
  w.context.fetchTokens = async () => ({});
  w.context.createNotebook = () => new Promise(resolve => { resolveCreate = resolve; });
  w.context.getNotebookUrl = id => 'https://notebook.google.com/notebook/' + id;
  w.context.deleteNotebook = async id => { assert.equal(id, 'late'); deleted++; };
  const request = await w.startPipelineRequest({ pdfUrl: 'https://example.org/a.pdf' });
  await settleUntil(() => !!resolveCreate);
  assert.equal((await w.stopPipelineRequest(request.runId)).code, 'CANCEL_CHOICE_REQUIRED');
  await w.stopPipelineRequest(request.runId, 'delete');
  assert.equal(w.data.jobQueue.jobs[0].status, 'stopping');
  await w.stopPipelineRequest(request.runId, 'delete');
  assert.equal(deleted, 0);
  resolveCreate({ id: 'late' });
  await settleUntil(() => w.data.jobQueue.jobs[0].cleanupStatus === 'deleted');
  assert.equal(deleted, 1);
  assert.equal(w.data.jobQueue.jobs[0].notebookId, 'late');
});

test('explicit failed-job cleanup allows partial successes and never replays uncertain deletion', async () => {
  const w = await worker();
  w.data.pipelineState = { ...running([{ taskId: 'useful', status: 'completed' }]), status: 'error' };
  let deletes = 0;
  w.context.deleteNotebook = async () => { deletes++; throw new Error('Unknown result'); };
  await assert.rejects(vm.runInContext("deleteCancelledNotebook('old')", w.context), /Unknown result/);
  const second = await vm.runInContext("deleteCancelledNotebook('old')", w.context);
  assert.equal(second.ok, false);
  assert.equal(deletes, 1);
  assert.equal(w.data.pipelineState.cleanupStatus, 'unknown');
});

test('restart preserves unknown creation identity without creating or deleting another notebook', async () => {
  const w = await worker({ initialQueue: { version: 1, paused: true, jobs: [{ runId: 'cancelled', status: 'stopping', step: 'create_notebook', cancelledStep: 'create_notebook', cancelIntent: 'delete' }] } });
  assert.equal(w.data.jobQueue.jobs[0].status, 'stopped');
  assert.equal(w.data.jobQueue.jobs[0].cleanupStatus, 'unknown');
});

test('cancelling an accepted source request keeps its notebook and prevents generation', async () => {
  const w = await worker();
  installQueueService(w);
  let finishSource;
  w.context.addUrlSource = () => new Promise(resolve => { finishSource = resolve; });
  const request = await w.startPipelineRequest({ pdfUrl: 'https://example.org/a.pdf' });
  await settleUntil(() => !!finishSource);
  await w.stopPipelineRequest(request.runId, 'keep');
  finishSource({ id: 'accepted-source' });
  await settleUntil(() => w.data.jobQueue.jobs[0].status === 'stopped');
  assert.ok(w.data.jobQueue.jobs[0].notebookId);
  assert.equal(w.data.jobQueue.jobs[0].tasks.length, 0);
});

test('cancelling during artifact generation prevents the next artifact request', async () => {
  const w = await worker();
  const writes = installQueueService(w);
  const request = await w.startPipelineRequest({ pdfUrl: 'https://example.org/a.pdf' });
  await settleUntil(() => w.data.jobQueue.jobs[0].step === 'wait_source');
  let finishAudio;
  w.context.generateAudio = () => new Promise(resolve => { finishAudio = resolve; });
  const poll = w.tickSourcePoll(w.data.jobQueue.jobs[0]);
  await settleUntil(() => !!finishAudio);
  await w.stopPipelineRequest(request.runId, 'keep');
  finishAudio({ taskId: 'accepted-audio', status: 'in_progress' });
  await poll;
  assert.equal(w.data.jobQueue.jobs[0].status, 'stopped');
  assert.equal(writes.filter(item => item.kind === 'infographic').length, 0);
});
