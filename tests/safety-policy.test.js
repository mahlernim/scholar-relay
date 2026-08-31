import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindDetectionToTab,
  detectionMatchesTab,
  directDetectionMatchesTab,
} from '../detection-policy.js';
import {
  MAX_PDF_UPLOAD_BYTES,
  assertPdfUploadSize,
  decodedBase64ByteLength,
  hasBase64PdfSignature,
  hasPdfSignature,
  readResponseWithinLimit,
} from '../pdf-file-policy.js';
import {
  canStopPipeline,
  createPipelineStateCoordinator,
} from '../runtime-policy.js';

test('cached PDF detection is accepted only for the exact tab and URL', () => {
  const tab = { id: 7, url: 'https://example.org/article' };
  const detection = bindDetectionToTab({
    isPdf: true,
    pdfUrl: 'https://example.org/paper.pdf',
    pageUrl: tab.url,
  }, tab);

  assert.equal(detectionMatchesTab(detection, tab), true);
  assert.equal(detectionMatchesTab(detection, { ...tab, id: 8 }), false);
  assert.equal(detectionMatchesTab(detection, { ...tab, url: 'https://example.org/other' }), false);
  assert.equal(detectionMatchesTab({ ...detection, tabId: undefined }, tab), false);
  assert.equal(directDetectionMatchesTab(detection, tab), true);
  assert.equal(directDetectionMatchesTab({ ...detection, pageUrl: 'https://example.org/old' }, tab), false);
});

test('PDF size and base64 guards enforce a bounded local bridge', () => {
  assert.equal(assertPdfUploadSize(MAX_PDF_UPLOAD_BYTES), MAX_PDF_UPLOAD_BYTES);
  assert.throws(
    () => assertPdfUploadSize(MAX_PDF_UPLOAD_BYTES + 1),
    error => error?.code === 'PDF_TOO_LARGE' && /32 MiB/.test(error.message)
  );
  assert.equal(decodedBase64ByteLength('TQ=='), 1);
  assert.equal(decodedBase64ByteLength('TWE='), 2);
  assert.equal(decodedBase64ByteLength('TWFu'), 3);
});

test('PDF signature validation rejects renamed non-PDF content', () => {
  const pdf = new TextEncoder().encode('\n%PDF-1.7\nexample');
  const html = new TextEncoder().encode('<!doctype html><title>Error</title>');
  assert.equal(hasPdfSignature(pdf), true);
  assert.equal(hasPdfSignature(html), false);
  assert.equal(hasBase64PdfSignature(Buffer.from(pdf).toString('base64')), true);
  assert.equal(hasBase64PdfSignature(Buffer.from(html).toString('base64')), false);
});

test('streaming PDF reads stop before an unbounded response is allocated', async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    },
  }));
  assert.deepEqual([...await readResponseWithinLimit(response, 5)], [1, 2, 3, 4, 5]);

  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  }));
  await assert.rejects(
    () => readResponseWithinLimit(oversized, 5),
    error => error?.code === 'PDF_TOO_LARGE'
  );
});

test('serialized pipeline claims allow exactly one active run', async () => {
  let state = { status: 'idle', runId: null };
  const coordinator = createPipelineStateCoordinator({
    readState: async () => state,
    writeState: async next => { state = next; },
  });

  const [first, second] = await Promise.all([
    coordinator.claim('run-a', { status: 'running', runId: 'run-a', step: 'auth' }),
    coordinator.claim('run-b', { status: 'running', runId: 'run-b', step: 'auth' }),
  ]);
  assert.equal(Number(first.applied) + Number(second.applied), 1);
  assert.equal(state.status, 'running');
});

test('a post-commit effect failure cannot erase committed run ownership', async () => {
  let state = { status: 'idle', runId: null };
  const coordinator = createPipelineStateCoordinator({
    readState: async () => state,
    writeState: async next => { state = next; },
  });
  const result = await coordinator.claim('run-a', {
    status: 'running', runId: 'run-a', step: 'auth',
  }, {
    afterWrite: async () => { throw new Error('badge unavailable'); },
  });
  assert.equal(result.applied, true);
  assert.equal(result.effectError?.message, 'badge unavailable');
  assert.equal(state.runId, 'run-a');
});

test('inactive alarm cleanup finishes before a replacement run can claim state', async () => {
  let state = { status: 'idle', runId: null };
  const order = [];
  let releaseCleanup;
  const coordinator = createPipelineStateCoordinator({
    readState: async () => state,
    writeState: async next => { state = next; },
  });
  const cleanup = coordinator.effectWhen(
    current => current.status !== 'running',
    () => new Promise(resolve => {
      order.push('cleanup-start');
      releaseCleanup = () => { order.push('cleanup-end'); resolve(); };
    })
  );
  const claim = coordinator.claim('run-b', {
    status: 'running', runId: 'run-b', step: 'auth',
  }).then(result => { order.push('claim'); return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(order, ['cleanup-start']);
  releaseCleanup();
  assert.equal((await cleanup).applied, true);
  assert.equal((await claim).applied, true);
  assert.deepEqual(order, ['cleanup-start', 'cleanup-end', 'claim']);
});

test('stale pipeline work cannot update or stop a replacement run', async () => {
  let state = { status: 'idle', runId: null };
  let staleEffectRan = false;
  const coordinator = createPipelineStateCoordinator({
    readState: async () => state,
    writeState: async next => { state = next; },
  });

  assert.equal((await coordinator.claim('run-a', {
    status: 'running', runId: 'run-a', step: 'wait_source',
  })).applied, true);
  assert.equal(canStopPipeline(state, 'run-a'), true);
  assert.equal((await coordinator.invalidate('run-a', { status: 'idle', runId: null }, {
    expectedSteps: ['wait_source'],
  })).applied, true);
  assert.equal((await coordinator.claim('run-b', {
    status: 'running', runId: 'run-b', step: 'auth',
  })).applied, true);

  const stale = await coordinator.transition('run-a', { step: 'wait_artifacts' }, {
    afterWrite: async () => { staleEffectRan = true; },
  });
  assert.equal(stale.applied, false);
  assert.equal(staleEffectRan, false);
  assert.equal(state.runId, 'run-b');
  assert.equal((await coordinator.reset({ status: 'idle', runId: null })).applied, false);
});

test('only polling phases expose cooperative stop behavior', () => {
  for (const step of ['wait_source', 'wait_artifacts']) {
    assert.equal(canStopPipeline({ status: 'running', runId: 'run-a', step }, 'run-a'), true);
  }
  for (const step of ['auth', 'create_notebook', 'add_source', 'generate_artifacts']) {
    assert.equal(canStopPipeline({ status: 'running', runId: 'run-a', step }, 'run-a'), false);
  }
  assert.equal(canStopPipeline({ status: 'running', runId: 'run-b', step: 'wait_source' }, 'run-a'), false);
});
