# ScholarRelay localization

The supported UI locales are English, Korean, Japanese, Spanish, French, German, and Brazilian Portuguese. Chrome selects the interface language through its native extension locale fallback. Unsupported locales fall back to English. The existing artifact output setting remains independent, including the existing `pt` output value. No Google account language or generated-content preference is changed by localization.

Edit `messages.json` and `metadata.json`, then run `node scripts/build-locales.mjs`. Each message row contains Korean, Japanese, Spanish, French, German, and Brazilian Portuguese, in that order. English is the source key. The generator emits the seven Chrome `messages.json` files and checks placeholders, completeness, metadata limits, and key collisions. `npm test` rejects stale generated catalogs or missing static popup labels. Source-English keys are hashed only to satisfy Chrome message identifiers. English changes deliberately require translation review.

Only UI text is translated. Notebook titles, collection names, URLs, custom prompts, persisted enum values, and API payloads remain unchanged. Worker diagnostic strings remain original for support and error classification, displayed inside collapsed Details. Primary recovery guidance and desktop notifications are localized. Progress derives from stable state, including state saved by earlier releases. No locale-dependent strings drive mutations, retries, ownership, or cancellation.

## Terminology evidence

Checked Google's localized help on September 4, 2026. These are published help terms, not a claim of inspecting every signed-in localized interface. Help pages can themselves contain machine translations and inconsistent wording. Prefer the named Studio control over a generic term elsewhere in the article. Extension-specific concepts such as layout presets, collections, and Stop Monitoring use clear local translations, not a claim of official Google terminology.

| Locale | Audio Overview | Flashcards | Quiz | Sources |
| --- | --- | --- | --- | --- |
| Korean | AI 오디오 오버뷰 | 플래시카드 | 퀴즈 | [Audio](https://support.google.com/gemininotebook/answer/16212820?hl=ko) |
| Japanese | 音声解説 | フラッシュカード | クイズ | [Audio](https://support.google.com/gemininotebook/answer/16212820?hl=ja), [Study tools](https://support.google.com/gemininotebook/answer/16958963?hl=ja) |
| Spanish | Resumen de audio | Tarjetas didácticas | Cuestionario | [Audio](https://support.google.com/gemininotebook/answer/16212820?hl=es) |
| French | Résumé audio | Flashcards | Quiz | [Audio](https://support.google.com/gemininotebook/answer/16212820?hl=fr), [Study tools](https://support.google.com/gemininotebook/answer/16958963?hl=fr) |
| German | Audio-Zusammenfassung | Lernkarten | Quizfragen | [Audio](https://support.google.com/gemininotebook/answer/16212820?hl=de), [Study tools](https://support.google.com/gemininotebook/answer/16958963?hl=de) |
| Brazilian Portuguese | Resumo em Áudio | Cartões didáticos | Teste | [Audio](https://support.google.com/gemininotebook/answer/16212820?hl=pt-BR), [Study tools](https://support.google.com/gemininotebook/answer/16958963?hl=pt-BR) |

The audio articles also expose localized links to video, infographic, and slide-deck help. Japanese difficulty labels use 初級, 中級, 上級 from the study-tool control guidance. The Spanish study-tool article was rate-limited during verification, so those two Spanish terms are editorial translations pending a future direct UI check. Keep product names unchanged.

## Validation

The isolated Chrome smoke uses the real popup with shipped catalogs under deterministic locale fixtures. It checks seven locales, expanded settings overflow at 360 pixels, translated completion, permission and uncertain-result states, saved output language with audio disabled, unchanged user prompts and titles, and accessible toggle labels. Its screenshots and machine-readable report go to ignored `dist/localization-qa/`. This is controlled UI validation, not live Google generation in seven languages or independent native-speaker certification.
