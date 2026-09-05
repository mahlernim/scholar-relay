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

// Run the shipped worker with real policy modules and controlled browser/service IO.
const source = (await readFile(new URL('../background.js', import.meta.url), 'utf8'))
  .replace(/^import\s+[\s\S]*?from\s+'[^']+';\r?\n/gm, '');

async function worker() {
  const data = { pipelineState: { status: 'idle' }, userSettings: { chimeEnabled: false, notificationEnabled: false } };
  const logs = [];
  const notifications = [];
  let listener;
  const hooks = {};
  const noop = async () => {};
  const event = { addListener() {} };
  const apiMocks = Object.fromEntries(Object.entries(api).map(([key, value]) => [key,
    typeof value === 'function' ? () => { throw new Error(`Unexpected service call ${key}`); } : value]));
  const context = vm.createContext({
    ...apiMocks, ...runtime, ...fallback, ...detection, ...pdf, ...permissions, ...i18n,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
    crypto: webcrypto, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, setTimeout, clearTimeout,
    chrome: {
      storage: { local: {
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
  const functions = vm.runInContext('({startPipelineRequest, tickArtifactPoll, tickSourcePoll})', context);
  return { data, logs, notifications, hooks, context, listener, ...functions };
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
      if (key !== 'pipelineState') return;
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
    if (key !== 'pipelineState') return;
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
