# Store discovery plan

Research checked on September 10, 2026. Tracks [#66](https://github.com/mahlernim/scholar-relay/issues/66). This is a draft, not a published title change. Runtime behavior, generated catalogs, permissions, versions, and submitted packages remain unchanged.

## Baseline and evidence

The [public listing](https://chromewebstore.google.com/detail/epopghhfmpokhbalmnfcopmplffphdbb) was retrieved in English with version 1.4.3 and the displayed update date September 8. Its title was `ScholarRelay - PDF Importer for Gemini Notebook`. The summary already included NotebookLM, and the description already included `ScholarRelay (Scholar Relay)`. These observations establish visible listing copy, not the exact approval time, search position, or private dashboard state.

[#14](https://github.com/mahlernim/scholar-relay/issues/14) and #17 implemented the earlier copy change. #14 was closed at the owner's request without post-publication search verification. It remains closed. #66 tracks the remaining experiment and verification.

| Observation | Evidence and limitation |
| --- | --- |
| September 4 brand searches | #14 records an exact-name match and no spaced-name results. Locale, country, and inspected range for the brand searches were not recorded. |
| September 4 workflow search | #14 records no ScholarRelay entry among the first 20 results for `gemini notebook`. This is historical, not a current rank. |
| September 10 native store searches | Exact-name and spaced-name search pages could not be retrieved by the research fetcher. Both remain unobserved, not zero-result searches. |

## Research conclusions

Google identifies name and description relevance, popularity, and user experience as [ranking factors](https://support.google.com/chrome_webstore/answer/12225786?hl=en). The reviewed guidance does not disclose tokenization, field weights, query volumes, or an indexing deadline. A spaced title is a testable hypothesis, not a guaranteed fix.

Titles should describe the core function without keyword stuffing. Summaries should foreground relevant use cases. [Listing guidance](https://developer.chrome.com/docs/webstore/best-listing) and [listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements) reject misleading metadata and excessive keyword lists. The example about unnatural repetition beyond five occurrences is not a safe allowance to repeat every term five times.

Google's current [product help](https://support.google.com/gemininotebook/answer/16164461?hl=en) uses Gemini Notebook. The publisher's [NotebookLM Web Importer listing](https://chromewebstore.google.com/detail/notebooklm-web-importer/ijdefdijdmghafocfmmdojfghnpelnfn) retains NotebookLM in its name and foregrounds source collection. That supports retaining both names for recognition, not a claim about relative search volume or causality. ScholarRelay's positioning can instead foreground per-paper notebook setup and selected artifact generation. No competitor names belong in the listing copy.

## Proposed copy

| Candidate | Characters | Rationale |
| --- | --- | --- |
| Scholar Relay - Gemini Notebook (NotebookLM) Automation | 55 | Recommended next candidate. Includes the spaced brand, current and legacy product names, and the broader workflow. |
| Scholar Relay - PDF to Gemini Notebook (NotebookLM) | 51 | Import-focused alternative. More concrete, but underrepresents webpage support and generation automation. |

The alternatives are not simultaneous experiments. No keyword-volume estimate establishes a winner.

Proposed English summary, 129 characters

> PDFs, arXiv papers, and webpages become Gemini Notebook (NotebookLM) notebooks with audio overviews, slides, and study materials.

Proposed description opening

> ScholarRelay (Scholar Relay) automates the workflow from PDFs, arXiv papers, and webpages to Gemini Notebook, formerly NotebookLM. Each queued item receives a separate notebook and saved artifact settings. Selected audio overviews, slide decks, quizzes, flashcards, and other supported artifacts are requested after source processing.

The remaining description should retain sign-in requirements, browser-lifetime guidance, transfer limits, uncertain-result safeguards, and the independent-product disclosure. No arbitrary batch import into one notebook, paywall bypass, unlimited generation, or continued extension execution after Chrome closes should be implied.

[Seven-locale draft metadata](localization/metadata-discovery-draft.json) uses the existing `[title, summary]` format. Translations are editorial drafts, not independently certified native-language reviews. The popup brand and `short_name` remain ScholarRelay. Google's [name limit](https://developer.chrome.com/docs/extensions/reference/manifest/name) is 75 characters and [summary limit](https://developer.chrome.com/docs/extensions/reference/manifest/description) is 132. The [12-character short-name guidance](https://developer.chrome.com/docs/extensions/reference/manifest/short-name) is a recommendation, not the title limit. The test uses the generator's conservative JavaScript string-length check.

## Actionable rollout

1. Capture the current baseline before activating another title. In the same signed-out desktop Chrome profile and country, inspect the first 20 native store results under English and Korean listing languages. Record timestamp with timezone, actual country, browser/profile state, language, query, range, matching item ID, rank, and screenshot reference. Distinguish a failed page load, zero total results, and absence within the inspected range.
2. Check `ScholarRelay`, `scholar relay`, `Gemini Notebook`, `NotebookLM`, `PDF to NotebookLM`, `NotebookLM automation`, and `arXiv NotebookLM`. Add `논문 NotebookLM` and `노트북LM PDF` for Korean. External web search is a separate channel, not a substitute for native store results.
3. For the next title experiment, copy only the seven draft titles into `docs/localization/metadata.json`, retaining current summaries. Run `node scripts/build-locales.mjs`, `npm test`, and the existing Chrome smoke/package gates. Review install-dialog titles and English fallback. Update current release documentation without rewriting historical release notes. Keeping summaries and screenshots unchanged makes a title-only comparison less confounded.
4. After the title observation window, consider the draft summaries and description opening as a separate conversion experiment. An authentic screenshot of the queue and selected artifacts can demonstrate the differentiation. Preserve recognizable branding and the [independent-product disclosure](https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property).
5. Coordinate a version bump and equivalent English/Korean release notes with the normal release. Reuse the existing store item. A title derives from packaged localized manifest metadata, so a repository merge or dashboard description edit alone does not publish it. Follow the [update process](https://developer.chrome.com/docs/webstore/update), keep any pending review unchanged, and do not upload or submit during this research task.
6. Record publication observation and repeat searches on that day, then after 7 and 14 days. These are proposed sampling checkpoints, not promised indexing times. Compare equal-length windows of built-in impressions, installs, and uninstalls by country/language where available. [Dashboard metrics](https://developer.chrome.com/docs/webstore/metrics) include returning installs and are not query-level rank evidence. Small samples and unrelated releases prevent strong causal attribution. No runtime analytics or new permissions are needed.

## Completion

Preparation is complete when the researched plan, draft copy, and metadata checks are merged. #66 remains open until the chosen title is publicly verified and dated native-search evidence is recorded. The target is exact and spaced brand visibility within the inspected first 20 results in both tested languages, with workflow-query positions reported separately. A missing brand result requires a recorded investigation of publication, distribution, locale, indexing, and support options rather than another unsupported rename.
