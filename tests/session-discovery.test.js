import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchTokens, ensureTokens, listSources, __testing } from '../notebooklm-api.js';
import { errorSummary } from '../i18n.js';

const response = (status = 200, body = '', url = 'https://notebook.google.com/') => ({
  ok: status >= 200 && status < 300, status, url, headers: new Headers(),
  text: async () => body,
});
const tokens = value => response(200, `"SNlM0e":"csrf-${value}","FdrFJe":"session-${value}"`);
const originalFetch = globalThis.fetch;
test.beforeEach(() => __testing.resetTokens());
test.afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.chrome; });

for (const [label, reply, code] of [
  ['quota', () => response(429), 'SESSION_RATE_LIMITED'],
  ['service', () => response(503), 'SESSION_UNAVAILABLE'],
  ['network', () => { throw new Error('private response text'); }, 'SESSION_UNAVAILABLE'],
  ['markup', () => response(200, '<html>private markup</html>'), 'SESSION_UNRECOGNIZED'],
  ['unrecognized redirect', () => response(200, '', 'https://example.org/?secret=abc'), 'SESSION_UNRECOGNIZED'],
  ['forbidden', () => response(403), 'SESSION_UNRECOGNIZED'],
  ['login redirect', () => response(200, '', 'https://accounts.google.com/ServiceLogin?secret=abc'), 'AUTH_REQUIRED'],
  ['unauthorized', () => response(401), 'AUTH_REQUIRED'],
]) {
  test(`${label} discovery failures retain a safe category and localized summary`, async () => {
    globalThis.fetch = async () => reply();
    let error;
    try { await fetchTokens(); } catch (caught) { error = caught; }
    assert.equal(error?.code, code);
    assert.equal(error?.phase, 'auth_discovery');
    assert.equal(error.failures.length, 2);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /secret=|private/);
    assert.equal(errorSummary(error), errorSummary(error.message));
    if (code === 'AUTH_REQUIRED') assert.match(errorSummary(error), /Sign in/);
    else assert.doesNotMatch(errorSummary(error), /Sign in/);
    const catalog = JSON.parse(await readFile(new URL('../_locales/ko/messages.json', import.meta.url)));
    globalThis.chrome = { i18n: { getMessage: key => catalog[key]?.message || '' } };
    assert.match(errorSummary(error), /[가-힣]/);
    if (code !== 'AUTH_REQUIRED') assert.doesNotMatch(errorSummary(error), /로그인한 뒤/);
  });
}

test('mixed login and temporary failures do not assert logout; valid fallback still wins', async () => {
  globalThis.fetch = async url => url.includes('notebooklm') ? response(503)
    : response(200, '', 'https://accounts.google.com/ServiceLogin');
  await assert.rejects(fetchTokens(), { code: 'SESSION_UNAVAILABLE' });
  globalThis.fetch = async url => url.includes('notebooklm')
    ? response(200, '"SNlM0e":"legacy","FdrFJe":"session"', 'https://notebooklm.google.com/') : response(429);
  assert.equal((await fetchTokens()).csrfToken, 'legacy');
  assert.equal(__testing.getBaseUrl(), 'https://notebooklm.google.com');
});

test('forced and cached token callers share the same refresh, including with a warm cache', async () => {
  globalThis.fetch = async () => tokens('old');
  await ensureTokens();
  const releases = []; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise(resolve => { releases.push(resolve); }); };
  const requests = [fetchTokens(), ensureTokens(), fetchTokens(), ensureTokens()];
  await new Promise(resolve => setImmediate(resolve));
  for (const release of releases) release(tokens('new'));
  assert.equal(calls, 1);
  for (const result of await Promise.all(requests)) {
    assert.deepEqual(result, { csrfToken: 'csrf-new', sessionId: 'session-new' });
  }
  assert.equal((await ensureTokens()).csrfToken, 'csrf-new');
  assert.equal(calls, 1);
});

test('rejected shared refresh is released and a subsequent request can recover', async () => {
  globalThis.fetch = async () => response(503);
  const results = await Promise.allSettled([fetchTokens(), ensureTokens()]);
  assert.ok(results.every(item => item.status === 'rejected' && item.reason.code === 'SESSION_UNAVAILABLE'));
  globalThis.fetch = async () => tokens('recovered');
  assert.equal((await ensureTokens()).csrfToken, 'csrf-recovered');
});

test('overlapping RPC authentication rejections share one forced refresh', async () => {
  let homes = 0, writes = 0;
  const method = __testing.RPCMethod.GET_NOTEBOOK;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/')) { homes++; await new Promise(resolve => setImmediate(resolve)); return tokens(homes); }
    writes++;
    if (new URLSearchParams(options.body).get('at') === 'csrf-1') return response(401);
    return response(200, JSON.stringify([['wrb.fr', method, JSON.stringify([[null, []]])]]));
  };
  await Promise.all([listSources('notebook-id-one'), listSources('notebook-id-two')]);
  assert.equal(homes, 2);
  assert.equal(writes, 4);
});
