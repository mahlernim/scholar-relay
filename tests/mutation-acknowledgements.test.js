import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing, deleteNotebook, generateMindMap } from '../notebooklm-api.js';

const NOTEBOOK_ID = 'notebook-id-12345';
const NOTE_ID = 'mind-map-note-12345';
const originalFetch = globalThis.fetch;

function response(body) {
  return { ok: true, status: 200, statusText: 'OK',
    url: 'https://notebook.google.com/', headers: new Headers(),
    async text() { return body; } };
}

function rpcResponse(method, result, status = null) {
  return response(`)]}'\n${JSON.stringify([
    ['wrb.fr', method, result === null ? null : JSON.stringify(result), null, null, status],
  ])}`);
}

function mockMutations(finalMethod, finalResponse) {
  const writes = [];
  let homepages = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method !== 'POST') {
      homepages++;
      return response('"SNlM0e":"csrf-token","FdrFJe":"session-id"');
    }
    const method = new URL(url).searchParams.get('rpcids');
    writes.push(method);
    if (method === finalMethod) return finalResponse(method);
    if (method === __testing.RPCMethod.GENERATE_MIND_MAP) {
      return rpcResponse(method, [[JSON.stringify({ name: 'Paper concepts', children: [] })]]);
    }
    if (method === __testing.RPCMethod.CREATE_NOTE) return rpcResponse(method, [[NOTE_ID]]);
    assert.fail(`Unexpected mutation ${method}`);
  };
  return { writes, homepages: () => homepages };
}

test.beforeEach(() => {
  __testing.resetTokens();
  __testing.setRetrySleep(async () => {});
  __testing.setMutationTimeout(15000);
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __testing.resetTokens();
});

for (const rpcCode of [3, 7, 16]) {
  test(`mind map saving surfaces status ${rpcCode} and retains the accepted note identity`, async () => {
    const calls = mockMutations(__testing.RPCMethod.UPDATE_NOTE,
      method => rpcResponse(method, null, [rpcCode]));

    await assert.rejects(generateMindMap(NOTEBOOK_ID, ['source-id-12345']), error => {
      assert.equal(error.code, 'RPC_NULL_STATUS');
      assert.equal(error.rpcCode, rpcCode);
      assert.equal(error.notebookId, NOTEBOOK_ID);
      assert.equal(error.noteId, NOTE_ID);
      return true;
    });
    assert.deepEqual(calls.writes, [__testing.RPCMethod.GENERATE_MIND_MAP,
      __testing.RPCMethod.CREATE_NOTE, __testing.RPCMethod.UPDATE_NOTE]);
    assert.equal(calls.homepages(), 1);
  });
}

test('mind map saving accepts an untagged empty update acknowledgement', async () => {
  const calls = mockMutations(__testing.RPCMethod.UPDATE_NOTE,
    method => rpcResponse(method, null));

  assert.deepEqual(await generateMindMap(NOTEBOOK_ID, ['source-id-12345']),
    { taskId: NOTE_ID, status: 'completed' });
  assert.equal(calls.writes.filter(method => method === __testing.RPCMethod.UPDATE_NOTE).length, 1);
});

test('uncertain mind map update retains its accepted note identity without another write', async () => {
  const calls = mockMutations(__testing.RPCMethod.UPDATE_NOTE,
    () => { throw new TypeError('Connection lost after sending update'); });

  await assert.rejects(generateMindMap(NOTEBOOK_ID, ['source-id-12345']), error => {
    assert.equal(error.code, 'TRANSIENT_MUTATION_UNCERTAIN');
    assert.equal(error.notebookId, NOTEBOOK_ID);
    assert.equal(error.noteId, NOTE_ID);
    return true;
  });
  assert.deepEqual(calls.writes, [__testing.RPCMethod.GENERATE_MIND_MAP,
    __testing.RPCMethod.CREATE_NOTE, __testing.RPCMethod.UPDATE_NOTE]);
});

for (const rpcCode of [3, 7, 16]) {
  test(`notebook deletion rejects status ${rpcCode} without repeating the delete`, async () => {
    const calls = mockMutations(__testing.RPCMethod.DELETE_NOTEBOOK,
      method => rpcResponse(method, null, [rpcCode]));

    await assert.rejects(deleteNotebook(NOTEBOOK_ID), error => {
      assert.equal(error.code, 'RPC_NULL_STATUS');
      assert.equal(error.rpcCode, rpcCode);
      return true;
    });
    assert.deepEqual(calls.writes, [__testing.RPCMethod.DELETE_NOTEBOOK]);
    assert.equal(calls.homepages(), 1);
  });
}

test('notebook deletion accepts an already absent notebook without repeating the delete', async () => {
  const calls = mockMutations(__testing.RPCMethod.DELETE_NOTEBOOK,
    method => rpcResponse(method, null, [5]));

  assert.equal((await deleteNotebook(NOTEBOOK_ID)).ok, true);
  assert.deepEqual(calls.writes, [__testing.RPCMethod.DELETE_NOTEBOOK]);
});

test('notebook deletion accepts an untagged empty acknowledgement', async () => {
  const calls = mockMutations(__testing.RPCMethod.DELETE_NOTEBOOK,
    method => rpcResponse(method, null));

  assert.equal((await deleteNotebook(NOTEBOOK_ID)).ok, true);
  assert.deepEqual(calls.writes, [__testing.RPCMethod.DELETE_NOTEBOOK]);
});
