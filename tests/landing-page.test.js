import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = path => readFile(new URL(`../site/${path}`, import.meta.url), 'utf8');

test('landing page leads with automation and links to the existing store item', async () => {
  const html = await read('index.html');
  assert.match(html, /Automate your paper-to-study workflow/);
  assert.match(html, /epopghhfmpokhbalmnfcopmplffphdbb/g);
  assert.match(html, /id="language-select"/);
  assert.match(html, /id="share-button"/);
  assert.match(html, /class="workflow-visual"/);
  assert.match(html, /assets\/screenshots\/en\/workflow\.png/);
  assert.match(html, /assets\/screenshots\/en\/settings\.png/);
  assert.match(html, /data-screenshot="workflow"/);
  assert.match(html, /Choose your study materials/);
  assert.match(html, /Each paper gets its own notebook/);
  assert.match(html, /Audio Overview/);
  assert.doesNotMatch(html, /A compact view of the repeatable workflow/);
  for (const locale of ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt-br', 'zh-Hans', 'x-default']) {
    assert.match(html, new RegExp(`hreflang="${locale}"`));
  }
});

test('landing page selects locale safely and shares its localized URL', async () => {
  const script = await read('app.js');
  for (const locale of ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt-BR', 'zh-CN']) assert.ok(script.includes(locale));
  assert.match(script, /navigator\.languages/);
  assert.match(script, /localStorage\.getItem\('scholar-relay-language'\)/);
  assert.match(script, /\|\|\s*'en'/);
  assert.match(script, /navigator\.share/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.match(script, /assets\/screenshots\/\$\{locale\}/);
});

test('every visible landing string is translated in all eight locales', async () => {
  const [html, script] = await Promise.all([read('index.html'), read('app.js')]);
  const context = {};
  vm.runInNewContext(
    script.slice(0, script.indexOf('const supported')).replace('const copy =', 'globalThis.copy ='),
    context
  );
  const usedKeys = new Set(
    [...html.matchAll(/data-i18n(?:-alt|-aria)?="([^"]+)"/g)].map(match => match[1])
  );
  for (const [locale, values] of Object.entries(context.copy)) {
    const missing = [...usedKeys].filter(key => !values[key]);
    assert.deepEqual(missing, [], `${locale} is missing ${missing.join(', ')}`);
  }
});

test('landing terminology follows current Gemini Notebook labels', async () => {
  const script = await read('app.js');
  for (const term of [
    'AI 오디오 오버뷰', '音声解説', 'Resumen de audio', 'Résumé audio',
    'Audio-Zusammenfassung', 'Resumo em Áudio', '音频概览'
  ]) assert.ok(script.includes(term), `missing official term: ${term}`);
});

test('landing hero ships real workflow and settings screenshots for every supported locale', async () => {
  for (const locale of ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt-BR', 'zh-CN']) {
    await access(new URL(`../site/assets/screenshots/${locale}/workflow.png`, import.meta.url));
    await access(new URL(`../site/assets/screenshots/${locale}/settings.png`, import.meta.url));
  }
});

test('landing layout avoids full-screen spacing and keeps information-dense cards', async () => {
  const [css, responsive, workflow] = await Promise.all([read('styles.css'), read('responsive.css'), read('workflow.css')]);
  assert.doesNotMatch(`${css}\n${responsive}\n${workflow}`, /100vh|min-height:\s*100vh/);
  assert.match(css, /grid-template-columns:repeat\(3,1fr\)/);
  assert.match(css, /padding:48px 0 40px/);
  assert.match(css, /\.product-showcase/);
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /\.product-shot\{position:absolute/);
  assert.match(workflow, /grid-template-columns: 1fr auto 1fr auto 1fr/);
  assert.match(responsive, /overflow-x:\s*hidden/);
  assert.match(responsive, /max-width:\s*100%/);
});
