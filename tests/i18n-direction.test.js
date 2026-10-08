import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeStaticDocument } from '../i18n.js';

function emptyDocument() {
    return {
        documentElement: {}, body: {},
        createTreeWalker: () => ({ nextNode: () => null }),
        querySelectorAll: () => [],
    };
}

test('static localization uses the shipped catalog direction and preserves the UI locale', () => {
    const original = globalThis.chrome;
    try {
        for (const [language, direction] of [['ar', 'rtl'], ['ar-SA', 'rtl'], ['en', 'ltr'], ['ko', 'ltr'], ['he', 'ltr'], ['fa', 'ltr']]) {
            globalThis.chrome = { i18n: { getUILanguage: () => language, getMessage: key => key === '@@bidi_dir' ? 'rtl' : '' } };
            const doc = emptyDocument();
            localizeStaticDocument(doc);
            assert.deepEqual(doc.documentElement, { lang: language, dir: direction });
        }
    } finally { globalThis.chrome = original; }
});

test('locale fixtures and missing browser APIs have a deterministic direction fallback', () => {
    const original = globalThis.chrome;
    try {
        for (const [language, direction] of [['ar', 'rtl'], ['ar-EG', 'rtl'], ['ar_SA', 'rtl'], ['hi', 'ltr'], ['en', 'ltr']]) {
            globalThis.chrome = { i18n: { getUILanguage: () => language, getMessage: () => '' } };
            const doc = emptyDocument();
            localizeStaticDocument(doc);
            assert.deepEqual(doc.documentElement, { lang: language, dir: direction });
        }
        delete globalThis.chrome;
        const doc = emptyDocument();
        localizeStaticDocument(doc);
        assert.deepEqual(doc.documentElement, { lang: 'en', dir: 'ltr' });
    } finally { globalThis.chrome = original; }
});
