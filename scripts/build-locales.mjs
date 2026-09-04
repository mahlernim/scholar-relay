import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { messageKey } from '../i18n.js';

export const locales = ['en', 'ko', 'ja', 'es', 'fr', 'de', 'pt_BR'];
const root = new URL('../', import.meta.url);
const rows = JSON.parse(await readFile(new URL('docs/localization/messages.json', root), 'utf8'));
const metadata = JSON.parse(await readFile(new URL('docs/localization/metadata.json', root), 'utf8'));
const seen = new Set();
for (const [source, translations] of Object.entries(rows)) {
    const key = messageKey(source);
    if (seen.has(key)) throw new Error(`Message key collision for ${source}`);
    seen.add(key);
    if (translations.length !== 6 || translations.some(value => typeof value !== 'string' || !value.trim())) {
        throw new Error(`Incomplete translations for ${source}`);
    }
    const placeholders = value => [...value.matchAll(/\$\d+/g)].map(match => match[0]).sort().join(',');
    if (translations.some(value => placeholders(value) !== placeholders(source))) {
        throw new Error(`Placeholder mismatch for ${source}`);
    }
}
for (const [index, locale] of locales.entries()) {
    const [name, description] = metadata[locale];
    if (name.length > 75 || description.length > 132) throw new Error(`Store metadata too long for ${locale}`);
    const messages = {
        extensionName: { message: name },
        extensionDescription: { message: description },
    };
    for (const [source, translations] of Object.entries(rows)) {
        messages[messageKey(source)] = {
            message: index === 0 ? source : translations[index - 1],
            description: source,
        };
    }
    const target = new URL(`_locales/${locale}/messages.json`, root);
    const content = `${JSON.stringify(messages, null, 2)}\n`;
    if (process.argv.includes('--check')) {
        if ((await readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== content) throw new Error(`Regenerate ${locale}`);
    } else {
        await mkdir(new URL(`_locales/${locale}/`, root), { recursive: true });
        await writeFile(target, content);
    }
}
console.log(`Verified ${Object.keys(rows).length} UI messages in ${locales.length} locales.`);
