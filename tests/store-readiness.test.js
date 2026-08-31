import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PIPELINE_ALARM_NAME,
  PIPELINE_POLL_PERIOD_MINUTES,
  createExclusiveRunner,
  canStopPipeline,
  interruptedPipelineUpdate,
  pollingElapsedMs,
  runtimeRecoveryAction,
} from '../runtime-policy.js';
import {
  httpOriginPattern,
  needsOptionalPdfAccess,
  sameHttpOrigin,
} from '../site-permissions.js';

test('store manifest uses minimum permissions and a production-safe alarm baseline', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

  assert.equal(manifest.name, '__MSG_extensionName__');
  assert.equal(manifest.description, '__MSG_extensionDescription__');
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.version, '1.2.2');
  assert.equal(manifest.minimum_chrome_version, '120');
  assert.equal(manifest.permissions.includes('cookies'), false);
  assert.equal(manifest.host_permissions.includes('*://*/*'), false);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(PIPELINE_ALARM_NAME, 'pipeline-poll');
  assert.equal(PIPELINE_POLL_PERIOD_MINUTES, 0.5);
});

test('ScholarRelay branding, package identity, and localized store copy stay aligned', async () => {
  const [manifestText, packageText, englishLocaleText, koreanLocaleText, popupText, backgroundText, readmeText, privacyText, listingText, packageScript] =
    await Promise.all([
      readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'),
      readFile(new URL('../_locales/ko/messages.json', import.meta.url), 'utf8'),
      readFile(new URL('../popup.html', import.meta.url), 'utf8'),
      readFile(new URL('../background.js', import.meta.url), 'utf8'),
      readFile(new URL('../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../PRIVACY.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/chrome-web-store-listing.md', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/package-store.ps1', import.meta.url), 'utf8'),
    ]);

  const manifest = JSON.parse(manifestText);
  const packageJson = JSON.parse(packageText);
  const englishLocale = JSON.parse(englishLocaleText);
  const koreanLocale = JSON.parse(koreanLocaleText);
  assert.equal(packageJson.name, 'scholar-relay');
  assert.equal(packageJson.version, manifest.version);
  assert.equal(englishLocale.extensionName.message, 'ScholarRelay');
  assert.equal(koreanLocale.extensionName.message, 'ScholarRelay');
  assert.match(englishLocale.extensionDescription.message, /Gemini Notebook/);
  assert.match(koreanLocale.extensionDescription.message, /Gemini Notebook/);
  assert.doesNotMatch(`${popupText}\n${backgroundText}`, /Chrome PDF to NotebookLM/);
  assert.match(popupText, /Open in Gemini Notebook|Gemini Notebook chooses/);
  assert.match(readmeText, /formerly NotebookLM/);
  assert.match(privacyText, /^# Privacy Policy for ScholarRelay/m);
  assert.match(listingText, /## English listing/);
  assert.match(listingText, /## 한국어 스토어 등록 문구/);
  assert.match(packageScript, /scholar-relay-v\$\(\$manifest\.version\)\.zip/);
  assert.doesNotMatch(packageScript, /\$outputPath\s*=.*-store\.zip/);
  assert.match(packageScript, /\$checksumPath = "\$outputPath\.sha256"/);
  assert.match(packageScript, /detection-policy\.js/);
  assert.match(packageScript, /pdf-file-policy\.js/);
  assert.match(packageScript, /_locales\/en\/messages\.json/);
  assert.match(packageScript, /_locales\/ko\/messages\.json/);
});

test('runtime recovery recreates only missing polling alarms', () => {
  assert.equal(runtimeRecoveryAction({ status: 'running', step: 'wait_source' }, false), 'create_alarm');
  assert.equal(runtimeRecoveryAction({ status: 'running', step: 'wait_artifacts' }, false), 'create_alarm');
  assert.equal(runtimeRecoveryAction({ status: 'running', step: 'wait_artifacts' }, true), 'none');
  assert.equal(runtimeRecoveryAction({ status: 'completed', step: 'done' }, true), 'clear_alarm');
});

test('runtime recovery stops interrupted non-idempotent phases', () => {
  for (const step of ['auth', 'create_notebook', 'add_source', 'generate_artifacts']) {
    assert.equal(runtimeRecoveryAction({ status: 'running', step }, false), 'interrupt');
  }

  const update = interruptedPipelineUpdate({
    step: 'generate_artifacts',
    notebookUrl: 'https://notebook.google.com/notebook/example',
  });
  assert.equal(update.status, 'error');
  assert.match(update.error, /avoid duplicate notebooks or artifacts/i);
  assert.match(update.error, /Open the existing notebook/i);
});

test('pipeline stop is limited to the matching run in polling phases', () => {
  assert.equal(canStopPipeline({ status: 'running', runId: 'a', step: 'wait_source' }, 'a'), true);
  assert.equal(canStopPipeline({ status: 'running', runId: 'a', step: 'wait_artifacts' }, 'a'), true);
  assert.equal(canStopPipeline({ status: 'running', runId: 'a', step: 'generate_artifacts' }, 'a'), false);
  assert.equal(canStopPipeline({ status: 'running', runId: 'b', step: 'wait_source' }, 'a'), false);
});

test('delayed alarm timing preserves the original wall-clock timeout', () => {
  const startedAt = '2026-08-30T00:00:00.000Z';
  const delayedWake = Date.parse('2026-08-30T00:21:00.000Z');
  assert.equal(pollingElapsedMs(startedAt, delayedWake), 21 * 60 * 1000);
  assert.equal(pollingElapsedMs('invalid', delayedWake), Number.POSITIVE_INFINITY);
});

test('exclusive poll runner skips overlap and unlocks after completion', async () => {
  const runExclusive = createExclusiveRunner();
  let releaseFirst;
  const first = runExclusive(() => new Promise(resolve => { releaseFirst = resolve; }));
  assert.equal(await runExclusive(async () => {}), false);
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(await runExclusive(async () => {}), true);
});

test('PDF permission helpers request only a different HTTP origin', () => {
  assert.equal(httpOriginPattern('https://cdn.example.org/paper.pdf'), 'https://cdn.example.org/*');
  assert.equal(httpOriginPattern('file:///C:/paper.pdf'), null);
  assert.equal(sameHttpOrigin('https://example.org/page', 'https://example.org/paper.pdf'), true);
  assert.equal(sameHttpOrigin('https://example.org/page', 'https://cdn.example.org/paper.pdf'), false);
  assert.equal(needsOptionalPdfAccess('https://example.org/page', 'https://example.org/paper.pdf'), false);
  assert.equal(needsOptionalPdfAccess('https://example.org/page', 'https://cdn.example.org/paper.pdf'), true);
});
