import test from 'node:test';
import assert from 'node:assert/strict';
import { jobElapsedText, jobReadyCount, hasJobActivity, jobHandoff, jobPhase } from '../job-queue.js';

const start = '2026-09-08T00:00:00Z';
const now = Date.parse(start) + 125000;

test('action-needed clocks measure only known waiting time, never total job age', () => {
  const job = { status: 'running', step: 'wait_pdf_access', startedAt: '2026-09-07T16:00:00Z' };
  assert.equal(jobElapsedText(job, now), '');
  assert.equal(jobElapsedText({ ...job, attentionSince: start }, now), '02:05');
  assert.equal(hasJobActivity(job), false);
});

test('queued and running clocks use their persisted timestamps after reopening', () => {
  assert.equal(jobElapsedText({ status: 'queued', queuedAt: start }, now), '02:05');
  assert.equal(jobElapsedText({ status: 'running', startedAt: start }, now), '02:05');
  assert.equal(jobElapsedText({ status: 'running', startedAt: start }, now + 3600000), '1:02:05');
  assert.equal(jobElapsedText({ status: 'running', startedAt: start }, now + 86400000), '24:02:05');
});

test('terminal clocks freeze, including a queued job removed before it started', () => {
  for (const status of ['completed', 'error', 'stopped']) {
    const job = { status, startedAt: start, completedAt: new Date(now).toISOString() };
    assert.equal(jobElapsedText(job, now + 10000), '02:05');
    assert.equal(jobElapsedText(job, now + 999999), '02:05');
  }
  assert.equal(jobElapsedText({ status: 'stopped', queuedAt: start, completedAt: new Date(now).toISOString() }), '02:05');
});

test('missing or invalid timestamps do not fabricate elapsed time; clock skew clamps to zero', () => {
  assert.equal(jobElapsedText({ status: 'running' }, now), '');
  assert.equal(jobElapsedText({ status: 'stopped', startedAt: start }, now), '');
  assert.equal(jobElapsedText({ status: 'running', startedAt: 'invalid' }, now), '');
  assert.equal(jobElapsedText({ status: 'queued', queuedAt: start }, Date.parse(start) - 1000), '00:00');
});

test('artifact counts are shown only after the submission list is settled', () => {
  const tasks = [{ status: 'completed' }, { status: 'failed' }, { status: 'uncertain' }];
  assert.equal(jobReadyCount({ step: 'generate_artifacts', tasks }), null);
  assert.equal(jobReadyCount({ step: 'error', failedStep: 'generate_artifacts', tasks }), null);
  assert.deepEqual(jobReadyCount({ step: 'wait_artifacts', tasks }), { ready: 1, total: 3 });
  assert.deepEqual(jobReadyCount({ step: 'error', failedStep: 'wait_artifacts', tasks }), { ready: 1, total: 3 });
  assert.equal(jobReadyCount({ step: 'done', tasks: [] }), null);
});

test('only active work animates, not queued, stopped or permission-wait jobs', () => {
  for (const status of ['queued', 'stopped', 'error', 'completed']) {
    assert.equal(hasJobActivity({ status, step: 'wait_artifacts' }), false);
  }
  for (const step of ['queued_pdf', 'wait_pdf_access']) assert.equal(hasJobActivity({ status: 'running', step }), false);
  assert.equal(hasJobActivity({ status: 'running', step: 'generate_artifacts' }), true);
  assert.equal(hasJobActivity({ status: 'running', step: 'wait_source' }), true);
});

test('artifact polling shows activity only for a known in-progress task', () => {
  const running = { status: 'running', step: 'wait_artifacts' };
  const active = { taskId: 'audio-task', status: 'in_progress' };
  const uncertain = { taskId: null, status: 'uncertain' };
  for (const tasks of [undefined, [], [uncertain], [{ status: 'in_progress' }],
    [{ taskId: 'unknown-task' }], [{ taskId: 'failed-task', status: 'failed' }],
    [{ status: 'completed' }, uncertain]]) {
    const job = { ...running, tasks };
    assert.equal(jobPhase(job), 'check', JSON.stringify(tasks));
    assert.equal(hasJobActivity(job), false, JSON.stringify(tasks));
  }
  for (const sibling of [uncertain, { status: 'failed' }, { status: 'completed', taskId: 'report-task' }]) {
    const job = { ...running, tasks: [active, sibling] };
    assert.equal(jobPhase(job), 'generating');
    assert.equal(hasJobActivity(job), true);
    assert.equal(jobHandoff(job), sibling.status === 'completed' ? 'accepted' : 'check');
  }
});

test('known failures get failure guidance while unresolved outcomes keep check guidance', () => {
  const failed = { status: 'failed' };
  const completed = { status: 'completed' };
  for (const status of ['running', 'completed', 'stopped']) {
    for (const tasks of [[failed], [completed, failed]]) {
      const job = { status, step: 'wait_artifacts', tasks };
      assert.equal(jobHandoff(job), 'failed');
      assert.equal(jobPhase(job), status === 'stopped' ? 'stopped' : 'check');
      assert.equal(hasJobActivity(job), false);
    }
  }
  for (const unresolved of [{ status: 'uncertain' }, { status: 'pending' },
    { status: 'in_progress' }, {}]) {
    assert.equal(jobHandoff({ status: 'completed', step: 'done', tasks: [failed, unresolved] }), 'check');
  }
  assert.equal(jobHandoff({ status: 'error', step: 'error', failedStep: 'wait_artifacts', tasks: [failed] }), 'attention');
});

test('fully completed results and source-only completion remain ready without activity', () => {
  for (const status of ['running', 'completed']) {
    const job = { status, step: status === 'running' ? 'wait_artifacts' : 'done',
      tasks: [{ status: 'completed' }, { taskId: 'audio-task', status: 'completed' }] };
    assert.equal(jobPhase(job), 'ready');
    assert.equal(jobHandoff(job), 'ready');
    assert.equal(hasJobActivity(job), false);
    assert.deepEqual(jobReadyCount(job), { ready: 2, total: 2 });
  }
  for (const tasks of [undefined, []]) {
    const job = { status: 'completed', step: 'done', tasks };
    assert.equal(jobPhase(job), 'ready');
    assert.equal(jobHandoff(job), 'ready');
    assert.equal(hasJobActivity(job), false);
    assert.equal(jobReadyCount(job), null);
  }
});
