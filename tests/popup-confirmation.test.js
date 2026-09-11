import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function startPipelineFromCurrentPageUrl()'),
  source.indexOf('\nasync function abortPipeline('));

test('declining no-paper confirmation leaves standby intact and permits a later start', async () => {
  const button = { disabled: false, textContent: 'Create' };
  let accepted = false;
  let queries = 0;
  const starts = [];
  const context = vm.createContext({
    document: { getElementById: () => button },
    t: value => value,
    confirm: () => {
      assert.equal(button.disabled, false);
      assert.equal(button.textContent, 'Create');
      return accepted;
    },
    chrome: { tabs: { query: async () => {
      queries++;
      assert.equal(button.disabled, true);
      return [{ url: 'https://example.org/page' }];
    } } },
    detectSourceTitleFromTab: async () => 'Example',
    startPipeline: async (...args) => starts.push(args),
    showError: message => assert.fail(message),
    console,
  });
  vm.runInContext(handler, context);
  await context.startPipelineFromCurrentPageUrl();
  assert.deepEqual(button, { disabled: false, textContent: 'Create' });
  assert.equal(queries, 0);
  assert.equal(starts.length, 0);
  accepted = true;
  await context.startPipelineFromCurrentPageUrl();
  assert.equal(queries, 1);
  assert.deepEqual(starts, [['https://example.org/page', 'https://example.org/page', 'webpage', 'Example']]);
});
