import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { DEFAULT_SETTINGS } from '../settings.js';
const popup = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const fields = ['notificationEnabled', 'chimeEnabled', 'autoOpenNotebook'];
for (const disabled of [null, ...fields]) {
  test(`completion preferences survive popup and worker loading with ${disabled || 'fresh defaults'}`, async () => {
    const saved = disabled ? Object.fromEntries(fields.map(k => [k, k !== disabled])) : undefined;
    const elements = Object.fromEntries(fields.map(k => [k, {}]));
    const context = vm.createContext({ DEFAULTS: DEFAULT_SETTINGS, DEFAULT_SETTINGS,
      chrome: { storage: { local: { get: async () => ({ userSettings: saved }) } } },
      document: { getElementById: id => elements[id] }, SELECT_MAP: {}, RADIO_NAMES: [], TEXTAREA_MAP: {},
      TOGGLE_MAP: Object.fromEntries(fields.map(k => [k, k])), updateReportPromptHint() {},
    });
    vm.runInContext(popup.slice(popup.indexOf('async function loadSettings()'), popup.indexOf('async function refreshCollections()')), context);
    vm.runInContext(worker.slice(worker.indexOf('async function getSettings()'), worker.indexOf('// Map string keys')), context);
    await context.loadSettings();
    const background = await context.getSettings();
    for (const field of fields) {
      assert.equal(elements[field].checked, field !== disabled);
      assert.equal(background[field], field !== disabled);
    }
  });
}
