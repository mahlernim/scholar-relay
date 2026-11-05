import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { fetchPdfInPage } from '../pdf-file-policy.js';

function page() {
  const timers = new Map();
  let nextTimer = 0, signal, calls = 0;
  const context = vm.createContext({
    Map, Symbol, URL, AbortController,
    location: { href: 'https://publisher.example/article', origin: 'https://publisher.example' },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(_url, options) {
      calls++;
      signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  });
  vm.runInContext(`globalThis.transfer = ${fetchPdfInPage.toString()}`, context);
  return { context, timers, get signal() { return signal; }, get calls() { return calls; },
    run(operation = 'start', id = 'transfer') { return context.transfer('https://publisher.example/paper.pdf', 1024, 'https://publisher.example/article', id, operation); } };
}

test('cancelling a page transfer aborts the actual fetch and clears its timers', async () => {
  const p = page();
  const pending = p.run();
  assert.equal(p.calls, 1);
  await p.run('cancel');
  assert.equal(p.signal.aborted, true);
  assert.equal(await pending, null);
  assert.equal(p.timers.size, 0);
});

test('worker loss expires the page lease while heartbeat renews it', async () => {
  const p = page();
  const pending = p.run();
  const firstLease = [...p.timers].find(([, timer]) => timer.delay === 15000)[0];
  await p.run('pulse');
  assert.equal(p.timers.has(firstLease), false);
  [...p.timers.values()].find(timer => timer.delay === 15000).callback();
  assert.equal(p.signal.aborted, true);
  await pending;
  assert.equal(p.timers.size, 0);
});

test('cancellation arriving before injection and navigation prevent a page fetch', async () => {
  const p = page();
  await p.run('cancel');
  assert.equal(await p.run(), null);
  p.context.location.href = 'https://publisher.example/another-article';
  assert.equal(await p.run('start', 'other'), null);
  assert.equal(p.calls, 0);
});
