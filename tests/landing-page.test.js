import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../site/${path}`, import.meta.url), 'utf8');

test('landing page leads with automation and links to the existing store item', async () => {
  const html = await read('index.html');
  assert.match(html, /Automate your paper-to-study workflow/);
  assert.match(html, /epopghhfmpokhbalmnfcopmplffphdbb/g);
  assert.match(html, /id="language-select"/);
  assert.match(html, /id="share-button"/);
  assert.match(html, /automation-card\.svg/);
  assert.match(html, /automation-card\.png/);
  for (const locale of ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt-br', 'zh-Hans', 'x-default']) {
    assert.match(html, new RegExp(`hreflang="${locale}"`));
  }
});

test('landing page selects locale safely and shares the visual card with a URL fallback', async () => {
  const script = await read('app.js');
  for (const locale of ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt-BR', 'zh-CN']) assert.ok(script.includes(locale));
  assert.match(script, /navigator\.languages/);
  assert.match(script, /localStorage\.getItem\('scholar-relay-language'\)/);
  assert.match(script, /\|\|'en'/);
  assert.match(script, /navigator\.canShare/);
  assert.match(script, /automation-card\.png/);
  assert.match(script, /navigator\.clipboard\.writeText/);
});

test('landing layout avoids full-screen spacing and keeps information-dense cards', async () => {
  const [css, responsive] = await Promise.all([read('styles.css'), read('responsive.css')]);
  assert.doesNotMatch(`${css}\n${responsive}`, /100vh|min-height:\s*100vh/);
  assert.match(css, /grid-template-columns:repeat\(3,1fr\)/);
  assert.match(css, /padding:54px 0 44px/);
  assert.match(responsive, /overflow-x:\s*hidden/);
  assert.match(responsive, /max-width:\s*100%/);
});
