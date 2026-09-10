import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const readJson = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const current = await readJson('docs/localization/metadata.json');
const draft = await readJson('docs/localization/metadata-discovery-draft.json');

test('discovery draft covers the current store locales without adding unsupported locales', () => {
    assert.ok(draft && typeof draft === 'object' && !Array.isArray(draft));
    assert.deepEqual(Object.keys(draft).sort(), Object.keys(current).sort());
});

for (const [locale, row] of Object.entries(draft)) {
    test(`discovery draft has usable plain-text metadata for ${locale}`, () => {
        assert.ok(Array.isArray(row), 'Metadata must contain a title and summary');
        assert.equal(row.length, 2);
        for (const [index, limit] of [75, 132].entries()) {
            const value = row[index];
            assert.equal(typeof value, 'string');
            assert.ok(value.length > 0 && value.length <= limit, `Field ${index} exceeds its ${limit}-character limit`);
            assert.equal(value, value.trim(), 'Outer whitespace must not consume the character budget');
            assert.doesNotMatch(value, /[<>\r\n\t\u2014]/, 'Metadata must use plain text and plain punctuation');
        }
        assert.ok(row[0].startsWith('Scholar Relay - '), 'The spaced brand must remain identifiable');
        assert.ok(row[0].includes('Gemini Notebook'), 'The supported product must remain identifiable');
        assert.ok(row[0].includes('NotebookLM'), 'The legacy product name must remain identifiable');
    });
}
