import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { messageKey, t, progressDetail, errorSummary } from '../i18n.js';

const locales = ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt_BR'];
const rows = JSON.parse(await readFile(new URL('../docs/localization/messages.json', import.meta.url), 'utf8'));
const catalogs = Object.fromEntries(await Promise.all(locales.map(async locale => [locale,
    JSON.parse(await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'))])));

test('all seven shipped catalogs match the translation source and preserve placeholders', () => {
    execFileSync(process.execPath, ['scripts/build-locales.mjs', '--check']);
    for (const catalog of Object.values(catalogs)) {
        assert.deepEqual(Object.keys(catalog), Object.keys(catalogs.en));
        for (const entry of Object.values(catalog)) assert.ok(entry.message.trim());
    }
});

test('every static popup label and attribute has a catalog entry', async () => {
    const html = (await readFile(new URL('../popup.html', import.meta.url), 'utf8'))
        .split('<body>')[1].replace(/<!--[\s\S]*?-->/g, '');
    const text = [...html.matchAll(/>([^<>]*)</g)].map(match => match[1].trim());
    const attrs = [...html.matchAll(/(?:title|placeholder|aria-label)="([^"]+)"/g)].map(match => match[1]);
    for (const value of [...text, ...attrs]) {
        if (!/[\p{L}\p{N}]/u.test(value) || value === 'ScholarRelay') continue;
        assert.ok(rows[value], `Missing static UI translation: ${value}`);
    }
});

test('literal translation calls have catalog entries', async () => {
    for (const path of ['popup.js', 'background.js', 'i18n.js']) {
        const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
        for (const match of source.matchAll(/\bt\((['"])((?:\\.|(?!\1).)*?)\1/g)) {
            const key = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
            assert.ok(rows[key], `${path} missing ${key}`);
        }
    }
});

test('translation uses Chrome UI locale, preserves substitutions literally and falls back to English', () => {
    try {
        for (const locale of locales) {
            globalThis.chrome = { i18n: { getMessage(key, values) {
                return catalogs[locale][key]?.message.replace(/\$(\d+)/g, (_, index) => values[index - 1]) || '';
            } } };
            const title = 'Settings "$1" <img src=x> & 日本語';
            assert.equal(t('Added to $1', [title]), rows['Added to $1']?.[locales.indexOf(locale)-1]?.replace('$1', () => title) || `Added to ${title}`);
            assert.ok(progressDetail({ step: 'wait_artifacts', tasks: [{ status: 'completed' }] }).includes('1'));
            assert.equal(errorSummary('Mutation outcome unknown'), t('The result could not be confirmed. Check Gemini Notebook before starting again.'));
            assert.equal(errorSummary('PDF signature missing'), t("This file isn't a valid PDF. Choose another file."));
            assert.equal(errorSummary('40 MiB size limit'), t('This PDF exceeds the upload limit. Upload it directly in Gemini Notebook.'));
            assert.equal(t('Unknown future message $1', ['$&']), 'Unknown future message $&');
        }
        delete globalThis.chrome;
        assert.equal(t('Added to $1', ['A']), 'Added to A');
    } finally { delete globalThis.chrome; }
});

test('all UI catalogs and runtime translator are explicitly packaged', async () => {
    for (const path of ['scripts/package-store.ps1', '.github/workflows/ci.yml']) {
        const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
        for (const locale of locales) assert.ok(source.includes(`'_locales/${locale}/messages.json'`));
        assert.ok(source.includes("'i18n.js'"));
    }
    assert.equal(new Set(Object.keys(rows).map(messageKey)).size, Object.keys(rows).length);
});
