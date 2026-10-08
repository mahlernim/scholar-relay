import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __testing,
  addFileSource,
  addNotebookToCollection,
  addTextSource,
  addUrlSource,
  createNotebook,
  ensureTokens,
  generateAudio,
  listSources,
} from '../notebooklm-api.js';
import { resetRetryMemoryForTesting } from '../retry-policy.js';

const notebookId = 'notebook-id-12345';
const sourceId = 'source-id-12345';
const articleUrl = 'https://example.org/paper.pdf';
const uncertain = { code: 'TRANSIENT_MUTATION_UNCERTAIN' };
const { RPCMethod } = __testing;

function response({ status = 200, body = '', url = 'https://notebook.google.com/' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    url,
    headers: new Headers(),
    text: async () => body,
  };
}

function tokens(version) {
  return response({ body: `"SNlM0e":"csrf-${version}","FdrFJe":"session-${version}"` });
}

function result(method, value) {
  return response({ body: JSON.stringify([['wrb.fr', method, JSON.stringify(value)]]) });
}

function sourceRow(id) {
  return [[id], articleUrl, [null, null, null, null, null, null, null, [articleUrl]], [null, 2]];
}

function service({ onRpc, onHomepage = count => tokens(count) }) {
  const calls = { homepages: [], rpcs: [], uploads: [] };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/') {
      calls.homepages.push(url.href);
      return onHomepage(calls.homepages.length);
    }
    if (url.pathname.includes('batchexecute')) {
      const body = new URLSearchParams(options.body);
      const call = {
        method: url.searchParams.get('rpcids'),
        csrf: body.get('at'),
        session: url.searchParams.get('f.sid'),
        params: JSON.parse(JSON.parse(body.get('f.req'))[0][0][1]),
      };
      calls.rpcs.push(call);
      return onRpc(call, calls);
    }
    calls.uploads.push(url.href);
    throw new Error('File bytes must not be sent after uncertain registration');
  };
  return calls;
}

async function waitFor(callback) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (callback()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('The expected request did not start');
}

test.beforeEach(() => {
  __testing.resetTokens();
  resetRetryMemoryForTesting();
  __testing.setRetrySleep(async () => {});
  __testing.setMutationTimeout(15000);
  __testing.setReadTimeout(15000);
});

const mutations = [
  { name: 'notebook creation', method: RPCMethod.CREATE_NOTEBOOK, run: () => createNotebook('Paper') },
  { name: 'URL import', method: RPCMethod.ADD_SOURCE, run: () => addUrlSource(notebookId, articleUrl) },
  { name: 'file registration', method: RPCMethod.ADD_SOURCE_FILE, run: () => addFileSource(notebookId, 'paper.pdf', [1, 2, 3]) },
  { name: 'artifact generation', method: RPCMethod.CREATE_ARTIFACT, run: () => generateAudio(notebookId, [sourceId]) },
  { name: 'text import', method: RPCMethod.ADD_SOURCE, run: () => addTextSource(notebookId, 'Paper', 'Article body') },
];

for (const status of [401, 403]) {
  for (const mutation of mutations) {
    test(`${mutation.name} sends once after HTTP ${status} and refreshes credentials for later reads`, async () => {
      const calls = service({
        onRpc: call => call.method === RPCMethod.GET_NOTEBOOK
          ? result(call.method, [[null, []]])
          : response({ status }),
      });

      await assert.rejects(mutation.run(), uncertain);
      assert.equal(calls.rpcs.filter(call => call.method === mutation.method).length, 1);
      assert.equal(calls.homepages.length, 2);
      assert.equal(calls.uploads.length, 0);

      assert.deepEqual(await listSources(notebookId), []);
      const nextRead = calls.rpcs.at(-1);
      assert.equal(nextRead.csrf, 'csrf-2');
      assert.equal(nextRead.session, 'session-2');
      assert.equal(calls.homepages.length, 2);
    });

    test(`${mutation.name} retains uncertainty after HTTP ${status} when credential refresh fails`, async () => {
      const calls = service({
        onHomepage: count => count === 1 ? tokens(1) : response({ status: 503 }),
        onRpc: call => call.method === RPCMethod.GET_NOTEBOOK
          ? result(call.method, [[null, []]])
          : response({ status }),
      });

      await assert.rejects(mutation.run(), uncertain);
      assert.equal(calls.rpcs.filter(call => call.method === mutation.method).length, 1);
      assert.equal(calls.uploads.length, 0);
      assert.ok(calls.homepages.length > 1, 'Refresh is attempted without masking the original uncertain write');
    });
  }

  test(`URL import reconciles a committed source after HTTP ${status} without resending`, async () => {
    let reads = 0;
    const calls = service({
      onRpc: call => {
        if (call.method === RPCMethod.GET_NOTEBOOK) {
          reads++;
          return result(call.method, [[null, reads === 1 ? [] : [sourceRow(sourceId)]]]);
        }
        return response({ status });
      },
    });

    const recovered = await addUrlSource(notebookId, articleUrl);
    assert.equal(recovered.id, sourceId);
    assert.equal(recovered.url, articleUrl);
    assert.equal(calls.rpcs.filter(call => call.method === RPCMethod.ADD_SOURCE).length, 1);
    assert.equal(reads, 2);
    assert.equal(calls.homepages.length, 2);
    assert.equal(calls.rpcs.at(-1).csrf, 'csrf-2');
  });

  test(`safe reads still retry once after HTTP ${status}`, async () => {
    const calls = service({
      onRpc: (call, calls) => calls.rpcs.length === 1
        ? response({ status })
        : result(call.method, [[null, [sourceRow(sourceId)]]]),
    });

    assert.equal((await listSources(notebookId))[0].id, sourceId);
    assert.equal(calls.rpcs.length, 2);
    assert.equal(calls.homepages.length, 2);
    assert.deepEqual(calls.rpcs.map(call => call.csrf), ['csrf-1', 'csrf-2']);
  });

  test(`collection assignment preserves HTTP ${status} uncertainty when reconciliation cannot authenticate`, async () => {
    const collectionId = 'collection-id-12345';
    const calls = service({
      onHomepage: count => count === 1 ? tokens(1) : response({ status: 503 }),
      onRpc: call => call.method === RPCMethod.LIST_LABELS
        ? result(call.method, [null, [['Research', [], collectionId, null]]])
        : response({ status }),
    });

    await assert.rejects(addNotebookToCollection(collectionId, notebookId), uncertain);
    assert.equal(calls.rpcs.filter(call => call.method === RPCMethod.UPDATE_LABEL).length, 1);
    assert.equal(calls.rpcs.filter(call => call.method === RPCMethod.LIST_LABELS).length, 1);
  });
}

test('concurrent rejected writes share one refresh and neither request is resent', async () => {
  let releaseRefresh;
  const calls = service({
    onHomepage: count => count === 1 ? tokens(1) : new Promise(resolve => {
      releaseRefresh = () => resolve(tokens(count));
    }),
    onRpc: call => call.method === RPCMethod.GET_NOTEBOOK
      ? result(call.method, [[null, []]])
      : response({ status: call.method === RPCMethod.CREATE_NOTEBOOK ? 401 : 403 }),
  });
  await ensureTokens();

  const first = assert.rejects(createNotebook('Paper'), uncertain);
  const second = assert.rejects(generateAudio(notebookId, [sourceId]), uncertain);
  await waitFor(() => releaseRefresh);
  const laterRead = listSources(notebookId);
  assert.equal(calls.homepages.length, 2);
  releaseRefresh();
  await Promise.all([first, second, laterRead]);

  assert.equal(calls.homepages.length, 2);
  assert.deepEqual(calls.rpcs.map(call => call.method), [
    RPCMethod.CREATE_NOTEBOOK, RPCMethod.CREATE_ARTIFACT, RPCMethod.GET_NOTEBOOK,
  ]);
  assert.equal(calls.rpcs.at(-1).csrf, 'csrf-2');
});

test('a late rejection of old credentials reuses the refreshed session without resending', async () => {
  let rejectOlderWrite;
  const calls = service({
    onRpc: (call, calls) => {
      if (call.method === RPCMethod.CREATE_ARTIFACT &&
          calls.rpcs.filter(item => item.method === RPCMethod.CREATE_ARTIFACT).length === 1) {
        return new Promise(resolve => { rejectOlderWrite = () => resolve(response({ status: 403 })); });
      }
      if ([RPCMethod.CREATE_NOTEBOOK, RPCMethod.CREATE_ARTIFACT].includes(call.method)) return response({ status: 401 });
      return result(call.method, [[null, []]]);
    },
  });
  await ensureTokens();

  const olderWrite = assert.rejects(generateAudio(notebookId, [sourceId]), uncertain);
  await waitFor(() => rejectOlderWrite);
  const newerWrite = assert.rejects(createNotebook('Paper'), uncertain)
    .finally(() => rejectOlderWrite());
  await Promise.all([olderWrite, newerWrite]);
  await listSources(notebookId);

  assert.equal(calls.homepages.length, 2);
  assert.equal(calls.rpcs.filter(call => call.method === RPCMethod.CREATE_ARTIFACT).length, 1);
  assert.equal(calls.rpcs.filter(call => call.method === RPCMethod.CREATE_NOTEBOOK).length, 1);
  assert.equal(calls.rpcs.at(-1).csrf, 'csrf-2');
});
