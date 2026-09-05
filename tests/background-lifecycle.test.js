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

async function worker() {
  const data = { pipelineState: { status: 'idle' }, userSettings: { chimeEnabled: false, notificationEnabled: false } };
  Object.defineProperty(data, 'pipelineState', {
    get: () => data.jobQueue?.jobs.at(-1) || { status: 'idle' },
    set: state => { data.jobQueue = { version: 1, paused: false, jobs: state.runId ? [structuredClone(state)] : [] }; },
  });
  const files = new Map();
  const logs = [];
  const notifications = [];
  let listener;
  const hooks = {};
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
      runtime: { onMessage: event },
      notifications: { onClicked: event, onButtonClicked: event, onClosed: event,
        create: async (id, options) => notifications.push({ id, ...options }) },
      tabs: { create: noop },
    },
  });
  vm.runInContext(source, context);
  await vm.runInContext('bootReconciliationPromise', context);
  await new Promise(resolve => setImmediate(resolve));
  const functions = vm.runInContext('({startPipelineRequest, stopPipelineRequest, tickArtifactPoll, tickSourcePoll, resumePdfFallback, reconcilePipelineRuntime, getQueue})', context);
  return { data, logs, notifications, hooks, context, listener, files, ...functions };
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
  await w.stopPipelineRequest('run-1');
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
