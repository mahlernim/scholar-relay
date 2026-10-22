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

for (const host of ['notebook.google', 'notebooklm.google']) {
  test(`the exact ${host} access page is classified before token-shaped markup`, async () => {
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(url);
      return response(200, '"SNlM0e":"wrong-page","FdrFJe":"wrong-page"', `https://${host}/?private=value`);
    };
    await assert.rejects(fetchTokens(), error => {
      assert.equal(error.code, 'SESSION_ACCESS_REQUIRED');
      assert.ok(error.failures.every(item => item.kind === 'access'));
      assert.doesNotMatch(error.message + JSON.stringify(error), /private|wrong-page/);
      return true;
    });
    assert.equal(calls.length, 2);
  });
}

for (const target of [
  'https://notebook.google.example.org/', 'https://notebook.google.com.example.org/',
  'http://notebook.google.com/', 'https://notebook.google.com:444/',
  'https://user:private@notebook.google.com/',
]) {
  test(`an untrusted session destination cannot supply tokens (${target})`, async () => {
    globalThis.fetch = async () => response(200, '"SNlM0e":"wrong-page","FdrFJe":"wrong-page"', target);
    await assert.rejects(fetchTokens(), { code: 'SESSION_UNRECOGNIZED' });
  });
}

test('tokenless app pages share one final sign-in probe and retain the default account route', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, 'include');
    assert.equal(options.redirect, 'follow');
    assert.equal(options.method, undefined);
    assert.equal(new URL(url).search, '');
    return url.endsWith('/login')
      ? response(200, '"SNlM0e":"login-token","FdrFJe":"login-session"', 'https://accounts.google.com/v3/signin/identifier?private=value')
      : response(200, '<a href="https://accounts.google.com/ServiceLogin">Sign in</a>', url);
  };
  await assert.rejects(fetchTokens(), error => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.ok(error.failures.some(item => item.kind === 'signin'));
    assert.doesNotMatch(error.message + JSON.stringify(error), /private|login-token|login-session/);
    return true;
  });
  assert.deepEqual(calls, ['https://notebook.google.com/', 'https://notebooklm.google.com/', 'https://notebook.google.com/login']);
});

test('a valid fallback avoids the sign-in probe after a tokenless page', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return url.includes('notebooklm')
      ? response(200, '"SNlM0e":"legacy","FdrFJe":"session"', url)
      : response(200, '<html>Tokenless app</html>', url);
  };
  assert.equal((await fetchTokens()).csrfToken, 'legacy');
  assert.deepEqual(calls, ['https://notebook.google.com/', 'https://notebooklm.google.com/']);
});

for (const [label, probe, code] of [
  ['signed-in app', () => tokens('probe-only'), 'SESSION_UNRECOGNIZED'],
  ['blocked redirect fetch', () => { throw new TypeError('Failed to fetch'); }, 'SESSION_UNRECOGNIZED'],
  ['aborted redirect fetch', () => { throw new DOMException('Aborted', 'AbortError'); }, 'SESSION_UNRECOGNIZED'],
  ['timed-out redirect fetch', () => { throw new Error('The network request timed out.'); }, 'SESSION_UNRECOGNIZED'],
  ['unknown redirect', () => response(200, '', 'https://example.org/'), 'SESSION_UNRECOGNIZED'],
  ['cookie mismatch', () => response(200, '', 'https://accounts.google.com/CookieMismatch'), 'SESSION_UNRECOGNIZED'],
  ['unauthorized probe', () => response(401, '', 'https://accounts.google.com/ServiceLogin'), 'SESSION_UNRECOGNIZED'],
  ['forbidden probe', () => response(403, '', 'https://accounts.google.com/ServiceLogin'), 'SESSION_UNRECOGNIZED'],
  ['rate-limited probe', () => response(429, '', 'https://accounts.google.com/ServiceLogin'), 'SESSION_RATE_LIMITED'],
  ['service-error probe', () => response(503, '', 'https://accounts.google.com/ServiceLogin'), 'SESSION_UNAVAILABLE'],
  ['access gate', () => response(200, '', 'https://notebook.google/'), 'SESSION_ACCESS_REQUIRED'],
]) {
  test(`${label} from the probe does not establish sign-out`, async () => {
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(url);
      return url.endsWith('/login') ? probe() : response(200, '<html>Tokenless app</html>', url);
    };
    await assert.rejects(fetchTokens(), { code });
    assert.equal(calls.filter(url => url.endsWith('/login')).length, 1);
    assert.equal(calls.length, 3);
  });
}

for (const [label, fallback, code] of [
  ['rate limit', () => response(429), 'SESSION_RATE_LIMITED'],
  ['service error', () => response(503), 'SESSION_UNAVAILABLE'],
  ['access gate', () => response(200, '', 'https://notebooklm.google/'), 'SESSION_ACCESS_REQUIRED'],
  ['unknown redirect', () => response(200, '', 'https://example.org/'), 'SESSION_UNRECOGNIZED'],
  ['forbidden', () => response(403), 'SESSION_UNRECOGNIZED'],
]) {
  test(`a confirmed probe does not erase ${label} evidence from another host`, async () => {
    globalThis.fetch = async url => url.endsWith('/login')
      ? response(200, '', 'https://accounts.google.com/ServiceLogin')
      : url.includes('notebooklm') ? fallback() : response(200, '<html>Tokenless app</html>', url);
    await assert.rejects(fetchTokens(), { code });
  });
}

test('concurrent refresh callers share the single sign-in probe', { timeout: 1000 }, async () => {
  let releaseProbe, probeStarted;
  const started = new Promise(resolve => { probeStarted = resolve; });
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    if (!url.endsWith('/login')) return response(200, '<html>Tokenless app</html>', url);
    probeStarted();
    return new Promise(resolve => { releaseProbe = () => resolve(response(200, '', 'https://accounts.google.com/ServiceLogin')); });
  };
  const results = Promise.allSettled([fetchTokens(), ensureTokens(), fetchTokens({ recoverMissingTokens: true })]);
  await started;
  releaseProbe();
  assert.ok((await results).every(item => item.status === 'rejected' && item.reason.code === 'AUTH_REQUIRED'));
  assert.equal(calls.filter(url => url.endsWith('/login')).length, 1);
  assert.equal(calls.length, 4);
});
