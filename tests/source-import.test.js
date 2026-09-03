import assert from 'node:assert/strict';
import test from 'node:test';
import { canFallback, createPdfFallback, isPdfImport, isConfirmedImportRejection } from '../source-import.js';
import { createPipelineStateCoordinator, runtimeRecoveryAction, canStopPipeline } from '../runtime-policy.js';

function harness(overrides = {}) {
  let state = { status: 'running', runId: 'run', step: 'wait_source', notebookId: 'notebook',
    importMethod: 'url', originalPdfUrl: 'https://arxiv.org/pdf/1706.03762', pdfEvidence: 'arxiv_abstract',
    sourceId: 'failed-source', fallbackAttempted: false };
  const calls = [];
  const getState = async () => ({ ...state });
  const coordinator = createPipelineStateCoordinator({ getState, readState: getState, writeState: async next => { state = next; } });
  const fallback = createPdfFallback({ getState, transition: async (...args) => (await coordinator.transition(...args)).applied,
    download: async () => { calls.push('download'); return { filename: 'paper.pdf' }; },
    upload: async (notebookId) => { calls.push(`upload:${notebookId}`); return { id: 'replacement' }; },
    poll: async () => calls.push('poll'),
    fail: async (runId, error) => { state = { ...state, status: 'error', error }; },
    ...overrides,
  });
  return { fallback, getState, calls, set: updates => { state = { ...state, ...updates }; }, coordinator };
}

test('PDF evidence supports extensionless imports and fails closed for arbitrary pages and legacy state', () => {
  assert.equal(isPdfImport('https://arxiv.org/pdf/1706.03762', 'arxiv_abstract'), true);
  assert.equal(isPdfImport('https://publisher.org/file?id=123', 'citation_pdf_url'), true);
  assert.equal(isPdfImport('https://publisher.org/article', null), false);
  assert.equal(isPdfImport('javascript:alert(1)', 'citation_pdf_url'), false);
  assert.equal(canFallback({ status: 'running', originalPdfUrl: 'https://x.org/a.pdf' }), false);
  for (const code of ['TRANSIENT_MUTATION_UNCERTAIN', 'SOURCE_RECOVERY_AMBIGUOUS', 'AUTH_REQUIRED', 'RATE_LIMITED', undefined]) {
    assert.equal(isConfirmedImportRejection({ code }), false);
  }
  assert.equal(isConfirmedImportRejection({ code: 'SOURCE_IMPORT_REJECTED' }), true);
});

for (const step of ['add_source', 'wait_source']) {
  test(`confirmed failure during ${step} uploads once into the same notebook`, async () => {
    const h = harness(); h.set({ step });
    await Promise.all([h.fallback('run'), h.fallback('run')]);
    await h.fallback('run');
    assert.deepEqual(h.calls, ['download', 'upload:notebook', 'poll']);
    const state = await h.getState();
    assert.equal(state.sourceId, 'replacement');
    assert.equal(state.failedUrlSourceId, 'failed-source');
    assert.equal(state.importMethod, 'file');
  });
}

test('blocked download resumes with a selected file and does not create another notebook', async () => {
  const h = harness({ download: async () => { throw new Error('SITE_ACCESS_REQUIRED'); } });
  await h.fallback('run');
  assert.equal((await h.getState()).step, 'wait_pdf_access');
  await Promise.all([h.fallback('run', { resume: true, file: { filename: 'paper.pdf' } }),
    h.fallback('run', { resume: true, file: { filename: 'paper.pdf' } })]);
  assert.deepEqual(h.calls, ['upload:notebook', 'poll']);
});

test('cancellation during download prevents upload', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ download: () => pending });
  const running = h.fallback('run');
  await new Promise(resolve => setImmediate(resolve));
  h.set({ status: 'idle', runId: null });
  release({ filename: 'paper.pdf' });
  await running;
  assert.deepEqual(h.calls, []);
});

test('unknown upload outcome is never replayed', async () => {
  let uploads = 0;
  const h = harness({ upload: async () => { uploads++; throw new Error('Network failure'); } });
  await h.fallback('run');
  await h.fallback('run', { resume: true });
  assert.equal(uploads, 1);
  assert.equal((await h.getState()).status, 'error');
  assert.equal(runtimeRecoveryAction({ status: 'running', step: 'upload_pdf' }, true), 'interrupt');
});

test('restart pauses downloads and preserves permission waits without replaying writes', () => {
  for (const step of ['wait_pdf_access', 'download_pdf']) {
    assert.equal(runtimeRecoveryAction({ status: 'running', step }, false), 'wait_pdf_access');
    assert.equal(canStopPipeline({ status: 'running', runId: 'run', step }), true);
  }
});
