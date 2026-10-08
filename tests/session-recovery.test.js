import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTokens, fetchTokens, listArtifactStatuses, __testing } from '../notebooklm-api.js';
import { resetRetryMemoryForTesting } from '../retry-policy.js';

const PRIMARY = 'https://notebook.google.com/';
const LEGACY = 'https://notebooklm.google.com/';
const METHOD = __testing.RPCMethod.LIST_ARTIFACTS;
const originalFetch = globalThis.fetch;

function response(body = '', { status = 200, url = PRIMARY } = {}) {
  return { ok: status >= 200 && status < 300, status, url, headers: new Headers(),
    text: async () => body };
}

function tokens(value = 'fresh') {
  return response(`"SNlM0e":"csrf-${value}","FdrFJe":"session-${value}"`);
}

function authFailure(kind = 'rpc') {
  return kind === 'rpc'
    ? response(JSON.stringify([['wrb.fr', METHOD, null, null, null, [16], 'generic']]))
    : response('', { status: kind });
}

function emptyListing() {
  return response(JSON.stringify([['wrb.fr', METHOD, '[]']]));
}

async function warmTokens() {
  globalThis.fetch = async () => tokens('old');
  await ensureTokens();
}

test.beforeEach(() => {
  __testing.resetTokens();
  __testing.setReadTimeout(15000);
  resetRetryMemoryForTesting();
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __testing.setReadTimeout(15000);
});

for (const kind of [401, 403, 'rpc']) {
  for (const [label, html] of [
    ['missing CSRF', '"FdrFJe":"session-only"'],
    ['missing session', '"SNlM0e":"csrf-only"'],
    ['empty CSRF', '"SNlM0e":"","FdrFJe":"session-only"'],
  ]) {
    test(`${kind} read rejection recovers an app page with ${label} using one same-host read`, async () => {
      await warmTokens();
      const homes = [], rpcTokens = [];
      globalThis.fetch = async (url, options = {}) => {
        if (options.method !== 'POST') {
          homes.push(url);
          if (url !== PRIMARY) return response('', { status: 503, url });
          return homes.length === 1 ? response(html, { url: `${PRIMARY}trynow` }) : tokens();
        }
        rpcTokens.push(new URLSearchParams(options.body).get('at'));
        return rpcTokens.length === 1 ? authFailure(kind) : emptyListing();
      };

      assert.equal((await listArtifactStatuses('notebook-id-one')).size, 0);
      assert.deepEqual(homes, [PRIMARY, PRIMARY]);
      assert.deepEqual(rpcTokens, ['csrf-old', 'csrf-fresh']);
    });
  }
}

test('concurrent rejected reads share one tokenless-page recovery', async () => {
  await warmTokens();
  const homes = [], rpcTokens = [];
  let releaseRecovery;
  let signalRecovery;
  const recoveryStarted = new Promise(resolve => { signalRecovery = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (options.method !== 'POST') {
      homes.push(url);
      if (homes.length === 1) {
        signalRecovery();
        return new Promise(resolve => { releaseRecovery = () => resolve(response('<html>Anonymous app</html>')); });
      }
      return url === PRIMARY ? tokens() : response('', { status: 503, url });
    }
    const csrf = new URLSearchParams(options.body).get('at');
    rpcTokens.push(csrf);
    return csrf === 'csrf-old' ? authFailure() : emptyListing();
  };
  const first = listArtifactStatuses('notebook-id-one');
  const second = listArtifactStatuses('notebook-id-two');
  const results = Promise.all([first, second]);
  await recoveryStarted;
  // Let the second rejection join the in-flight refresh before completing it.
  await new Promise(resolve => setImmediate(resolve));
  releaseRecovery();

  assert.ok((await results).every(result => result.size === 0));
  assert.deepEqual(homes, [PRIMARY, PRIMARY]);
  assert.equal(rpcTokens.filter(value => value === 'csrf-old').length, 2);
  assert.equal(rpcTokens.filter(value => value === 'csrf-fresh').length, 2);
});

test('persistent tokenless pages consume one extra homepage read across both hosts', async () => {
  await warmTokens();
  const homes = [];
  let rpcCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') { rpcCalls++; return authFailure(); }
    homes.push(url);
    return response('<html>Anonymous app</html>', { url });
  };

  await assert.rejects(listArtifactStatuses('notebook-id-one'), { code: 'SESSION_UNRECOGNIZED' });
  assert.deepEqual(homes, [PRIMARY, PRIMARY, LEGACY]);
  assert.equal(rpcCalls, 1);
  globalThis.fetch = async () => tokens('later');
  assert.equal((await ensureTokens()).csrfToken, 'csrf-later');
});

test('ordinary discovery does not reread tokenless app pages', async () => {
  const homes = [];
  globalThis.fetch = async url => {
    homes.push(url);
    return response('<html>Anonymous app</html>', { url });
  };

  await assert.rejects(fetchTokens(), { code: 'SESSION_UNRECOGNIZED' });
  assert.deepEqual(homes, [PRIMARY, LEGACY]);
});

for (const [label, target, code] of [
  ['unknown redirect', 'https://example.org/?secret=hidden', 'SESSION_UNRECOGNIZED'],
  ['access gate', 'https://notebook.google/?location=unsupported', 'SESSION_UNRECOGNIZED'],
  ['cookie mismatch', 'https://accounts.google.com/CookieMismatch?secret=hidden', 'SESSION_UNRECOGNIZED'],
  ['login redirect', 'https://accounts.google.com/ServiceLogin?secret=hidden', 'AUTH_REQUIRED'],
]) {
  test(`read auth recovery does not reread the ${label}`, async () => {
    await warmTokens();
    const homes = [];
    let rpcCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') { rpcCalls++; return authFailure(); }
      homes.push(url);
      return response('<html>Redirect page</html>', { url: target });
    };

    await assert.rejects(listArtifactStatuses('notebook-id-one'), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message + JSON.stringify(error), /secret=|hidden/);
      return true;
    });
    assert.deepEqual(homes, [PRIMARY, LEGACY]);
    assert.equal(rpcCalls, 1);
  });
}

test('tokenless recovery does not expand the one-replay budget for a rejected read', async () => {
  await warmTokens();
  const homes = [];
  let rpcCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') { rpcCalls++; return authFailure(); }
    homes.push(url);
    if (url !== PRIMARY) return response('', { status: 503, url });
    return homes.length === 1 ? response('<html>Anonymous app</html>') : tokens();
  };

  await assert.rejects(listArtifactStatuses('notebook-id-one'), /AUTH_REQUIRED/);
  assert.deepEqual(homes, [PRIMARY, PRIMARY]);
  assert.equal(rpcCalls, 2);
});

test('a read rejection upgrades an ordinary refresh already in flight', async () => {
  await warmTokens();
  const homes = [];
  let rpcCalls = 0, releaseRead, releaseHomepage, signalRead, signalHomepage;
  const readStarted = new Promise(resolve => { signalRead = resolve; });
  const homepageStarted = new Promise(resolve => { signalHomepage = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      rpcCalls++;
      if (rpcCalls > 1) return emptyListing();
      signalRead();
      return new Promise(resolve => { releaseRead = () => resolve(authFailure()); });
    }
    homes.push(url);
    if (homes.length > 1) return url === PRIMARY ? tokens() : response('', { status: 503, url });
    signalHomepage();
    return new Promise(resolve => { releaseHomepage = () => resolve(response('<html>Anonymous app</html>')); });
  };
  const listing = listArtifactStatuses('notebook-id-one');
  await readStarted;
  const ordinaryRefresh = fetchTokens();
  const completed = Promise.all([listing, ordinaryRefresh]);
  await homepageStarted;
  releaseRead();
  await new Promise(resolve => setImmediate(resolve));
  releaseHomepage();

  const [result, refreshed] = await completed;
  assert.equal(result.size, 0);
  assert.equal(refreshed.csrfToken, 'csrf-fresh');
  assert.deepEqual(homes, [PRIMARY, PRIMARY]);
  assert.equal(rpcCalls, 2);
});

test('the extra homepage read has a timeout and cannot consume another retry', async () => {
  await warmTokens();
  __testing.setReadTimeout(5);
  const homes = [], signals = [];
  let rpcCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') return ++rpcCalls === 1 ? authFailure() : emptyListing();
    homes.push(url);
    signals.push(options.signal);
    if (homes.length === 1) return response('<html>Anonymous app</html>');
    if (homes.length === 2) return new Promise(() => {});
    return tokens();
  };

  assert.equal((await listArtifactStatuses('notebook-id-one')).size, 0);
  assert.deepEqual(homes, [PRIMARY, PRIMARY, LEGACY]);
  assert.deepEqual(signals.map(signal => signal.aborted), [false, true, false]);
  assert.equal(rpcCalls, 2);
});

for (const siblingRecovered of [false, true]) {
test(`a late read rejection ${siblingRecovered ? 'uses the refreshed cache' : 'retains recovery after a sibling refresh fails'}`, async () => {
  await warmTokens();
  const homes = [];
  let phase = 1, phaseOneHomes = 0, phaseTwoHomes = 0, rpcCalls = 0, releaseLateRead, signalLateRead;
  const lateReadStarted = new Promise(resolve => { signalLateRead = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      rpcCalls++;
      if (rpcCalls === 1) return authFailure();
      if (rpcCalls > 2) return emptyListing();
      signalLateRead();
      return new Promise(resolve => { releaseLateRead = () => resolve(authFailure()); });
    }
    homes.push(url);
    if (phase === 1) {
      phaseOneHomes++;
      return siblingRecovered && phaseOneHomes > 1 ? tokens() : response('<html>Anonymous app</html>', { url });
    }
    phaseTwoHomes++;
    if (url !== PRIMARY) return response('', { status: 503, url });
    return phaseTwoHomes === 1 ? response('<html>Anonymous app</html>') : tokens();
  };
  const firstListing = listArtifactStatuses('notebook-id-one');
  const first = siblingRecovered ? firstListing
    : assert.rejects(firstListing, { code: 'SESSION_UNRECOGNIZED' });
  const late = listArtifactStatuses('notebook-id-two');
  await lateReadStarted;
  await first;
  phase = 2;
  releaseLateRead();

  assert.equal((await late).size, 0);
  assert.deepEqual(homes, siblingRecovered ? [PRIMARY, PRIMARY]
    : [PRIMARY, PRIMARY, LEGACY, PRIMARY, PRIMARY]);
  assert.equal(rpcCalls, siblingRecovered ? 4 : 3);
});
}
