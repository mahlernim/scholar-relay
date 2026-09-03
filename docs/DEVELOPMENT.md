# ScholarRelay development notes

Recorded on September 3, 2026. This history covers engineering decisions, validation, and Chrome Web Store submissions. Earlier sections describe v1.2.2. The v1.3.0 entry records the subsequent changes. Maintenance rules are in [AGENTS.md](../AGENTS.md).

The account below was reconstructed from commits, pull requests, release assets, recorded development and submission sessions, a targeted search of the maintainer's two mailboxes, and a signed-in developer-console check on September 3. Code links and release links provide publicly inspectable evidence. Session observations are identified where they add information that Git cannot establish. Email bodies, private account links, authentication values, and customer data are not included.

## Timeline and evidence

Commit and session dates below use Korea Standard Time. Store dates are transcribed as displayed, without an exposed timezone or time of day. A release date, submission date, and publication observation describe different events.

| Date | Milestone | Evidence |
| --- | --- | --- |
| February 19 | Initial GitHub preparation under the Chrome PDF to NotebookLM name. On-demand page inspection and upstream attribution were already part of the project. Internal audit material was removed from the user README. | [Initial preparation](https://github.com/mahlernim/scholar-relay/commit/0ce21a0), [README cleanup](https://github.com/mahlernim/scholar-relay/commit/b4eb5c6) |
| February 26 | Improved error handling and fallback guidance when NotebookLM could not import a PDF URL. | [Fallback changes](https://github.com/mahlernim/scholar-relay/commit/a9cdd79) |
| August 3 | Released v1.1.0 with updated request envelopes, safer mutation handling, corrected styles, and optional paper-title naming enabled by default. | [Compatibility changes](https://github.com/mahlernim/scholar-relay/commit/04ce972), [v1.1.0](https://github.com/mahlernim/scholar-relay/releases/tag/v1.1.0) |
| August 18 | Released v1.1.1 with host migration, corrected status and option values, and stricter recovery of uncertain source additions. | [PR #1](https://github.com/mahlernim/scholar-relay/pull/1), [v1.1.1](https://github.com/mahlernim/scholar-relay/releases/tag/v1.1.1) |
| August 30 | Added PDF metadata title extraction, remote PDF handling, and existing-collection assignment. Released v1.2.0, then prepared ScholarRelay branding and the v1.2.1 store submission. | [PDF changes](https://github.com/mahlernim/scholar-relay/commit/4cd1117), [collections](https://github.com/mahlernim/scholar-relay/commit/73cf65d), [store preparation](https://github.com/mahlernim/scholar-relay/commit/9ed7925) |
| August 30 | Store setup generated a payment receipt and a contact-email confirmation request. English and Korean listing resources were prepared. | Mailbox search performed September 3, [localizations](https://github.com/mahlernim/scholar-relay/commit/954d181) |
| August 31 | Hardened detection caching, pipeline ownership, cancellation, PDF ingestion, packaging, and browser smoke coverage. Several CI harness revisions were necessary. | [PR #2](https://github.com/mahlernim/scholar-relay/pull/2), [PR #3](https://github.com/mahlernim/scholar-relay/pull/3) |
| August 31 | Published the finalized v1.2.2 GitHub package. Canceled the older v1.2.1 store review and submitted v1.2.2 on the same item with automatic publication enabled. Dashboard observation was `Pending review`. | [PR #4](https://github.com/mahlernim/scholar-relay/pull/4), [v1.2.2](https://github.com/mahlernim/scholar-relay/releases/tag/v1.2.2), recorded submission session |
| September 3 | Confirmed a public ScholarRelay listing with `Add to Chrome` and version 1.2.2. Updated the README to lead with store installation. The signed-in console separately confirmed `Published - public` and published package version 1.2.2. | [Public listing](https://chromewebstore.google.com/detail/epopghhfmpokhbalmnfcopmplffphdbb), [README change](https://github.com/mahlernim/scholar-relay/commit/eef28e1), developer-console observation |

The store displayed August 31 as its update date when publication was checked on September 3. The signed-in console's Items table showed creation on August 30 and last update on August 31. These fields do not establish the exact approval timestamp, and the inspected Status and Package pages did not expose one. Searches in both maintainer mailboxes, including Spam and Trash, found no approval or rejection notice. The supported account is that v1.2.2 was pending on August 31 and publicly available by September 3. There is no evidence here of a reviewer rejection or its cause.

## Product direction and architecture

The project grew from sending a paper to NotebookLM for audio into a workflow for source ingestion, notebook naming, collection placement, and multiple artifact types. ScholarRelay became the product name during store preparation. Historical repository redirects and older release filenames still use Chrome PDF to NotebookLM. They are historical identifiers rather than additional products to maintain.

The browser already has the source page and the user's signed-in Google session. Keeping the workflow in an extension avoids introducing a separate developer service or a second sign-in flow. The resulting maintenance cost is dependence on the consumer web application's internal protocol. This implementation was informed by [teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py), but it is a JavaScript port with Chrome-specific runtime constraints.

| File | Responsibility |
| --- | --- |
| [`notebooklm-api.js`](../notebooklm-api.js) | Authentication discovery, host selection, RPC envelopes, uploads, collection operations, artifact generation and readiness |
| [`background.js`](../background.js) | Pipeline orchestration, persisted state, alarms, notifications, and remote work |
| [`runtime-policy.js`](../runtime-policy.js) | Serialized state changes, run ownership, recovery and cooperative stopping |
| [`popup.js`](../popup.js), [`popup.html`](../popup.html) | User actions, settings, detection presentation and progress |
| [`content.js`](../content.js), [`detection-policy.js`](../detection-policy.js) | Page metadata extraction and validation of cached detection against its tab and URL |
| [`pdf-file-policy.js`](../pdf-file-policy.js), [`pdf-metadata.js`](../pdf-metadata.js) | Bounded PDF transfers, signature checks and title selection |
| [`site-permissions.js`](../site-permissions.js) | Origin checks for optional PDF download access |
| [`offscreen.js`](../offscreen.js), [`offscreen.html`](../offscreen.html) | Completion audio outside the service worker |

## Problems and decisions

### 1. A working Python integration did not guarantee a working JavaScript port

The August audits focused on the shared wire contract, including authentication, source registration, notebook reads, uploads, generation, polling and media URLs. Python CLI conveniences were outside that compatibility scope.

The v1.1.0 repair updated nested template options and the artifact capability envelope. It also corrected video style values and added native infographic style support. A plausible-looking nested array can still be wrong for the service, so payload tests inspect the exact serialized positions rather than merely checking that a request was sent.

The v1.1.1 audit found additional changes. The preferred personal host became `notebook.google.com`, with `notebooklm.google.com` retained as a fallback. Token discovery, RPC calls, resumable uploads and returned notebook links use the selected host consistently. Flashcard options are serialized as `[quantity, difficulty]`, with `MORE = 3`. The artifact status mapping at that revision is `UNKNOWN = 0`, `PENDING = 1`, `PROCESSING = 2`, `COMPLETED = 3`, `FAILED = 4`, `SUGGESTED = 5` and `PENDING_REVIEW = 6`.

These are versioned implementation observations. Future compatibility work should compare the actual upstream payload builders and the extension's tests before changing individual constants. See [PR #1](https://github.com/mahlernim/scholar-relay/pull/1) and [`tests/notebooklm-api.test.js`](../tests/notebooklm-api.test.js).

### 2. A timeout could hide a successful mutation

The difficult failure was an uncertain result from a request that creates remote state. Resending `ADD_SOURCE` after a network error could create a duplicate. A matching source already in the notebook could also be mistaken for the result of the latest request.

The August 3 development record describes an earlier timeout implementation aborting a request and potentially interfering with a delayed source commit. That could lead to treating a notebook as empty and deleting it. The revised implementation stops waiting for a slow response body after headers have been accepted, while allowing the accepted transport to finish. It then uses bounded read-only probes to look for the committed source.

The August 18 refinement takes a snapshot of existing source IDs before mutation. Recovery succeeds only when exactly one matching source has an ID absent from that snapshot. An older match or multiple new matches cannot establish which source this request created, so the extension reports uncertainty rather than guessing.

Read-only requests can retry transient failures with a bounded budget and `Retry-After` handling. A confirmed authentication failure permits a single session refresh. Ambiguous mutation failures do not enter the ordinary transient retry loop. Collection assignment follows the same principle by checking membership after an uncertain response.

This deliberately trades some automatic recovery for protection against duplicate remote work. Recovery behavior belongs in tests that exercise stale matches, ambiguous matches and accepted-but-stalled responses, not only immediate success responses.

### 3. A completed artifact was not always ready to play

The service's lifecycle status alone was insufficient for audio and video. The v1.1.0 update continued polling until a usable media URL existed, even if the artifact status was already completed. Otherwise the UI could promise a playable result before one was available.

The August 3 session recorded a successful signed-in arXiv flow with infographic, audio and video output. A live local-PDF smoke was explicitly omitted during that release, although upload payloads remained covered by deterministic tests. That historical validation should not be expanded into a claim that every input path was tested live.

### 4. PDF URLs and paper titles required separate fallback decisions

A PDF accessible in the user's browser may not be importable by the remote service from its URL. The February error-handling changes made the manual-upload fallback clearer. Later work supported downloading a selected remote PDF in the browser and uploading its bytes, subject to permissions and size limits.

Naming presented a different problem. Automatic notebook titles could make it difficult to recognize the original paper. v1.1.0 added a default-on option to use the detected paper title while retaining an opt-out. v1.2.0 improved direct-PDF title handling through XMP and PDF Info metadata. Generic titles, URL-shaped strings and opaque filenames are rejected. When there is no trustworthy title, Gemini Notebook can choose the name.

The metadata reader is deliberately small. It recognizes the tested metadata forms and is not a general PDF parser. The fallback to service-generated naming is part of that design. See [`tests/pdf-metadata.test.js`](../tests/pdf-metadata.test.js).

### 5. Organization should not prevent artifact generation

v1.2.0 added assignment of a newly created notebook to an existing collection. The collection list comes from the signed-in account. Tests cover the observed type-3 listing payload, malformed rows, existing membership, confirmation after assignment and reconciliation after a stalled response.

Collection placement is useful organization, but source processing and artifact creation remain useful when placement fails. The pipeline therefore continues and exposes the placement issue. It does not discard the notebook because an optional organizational step failed.

### 6. Popup lifetime and service-worker lifetime differ from pipeline lifetime

The popup can close while work is running. A Manifest V3 worker can also stop between events. Long-running progress therefore uses persisted state and Chrome alarms, with a 0.5-minute polling baseline and Chrome 120 as the manifest minimum.

Recovery distinguishes waiting from mutation. The `wait_source` and `wait_artifacts` phases can restore a missing polling alarm. Interrupted setup and mutation phases produce an actionable error instead of automatically creating the same remote objects again. Elapsed time comes from stored timestamps, so delayed alarms do not make an old request appear new.

The August 31 audit identified additional races. Detection from one tab could be reused for another. Overlapping starts, stale stop messages, delayed alarms and old asynchronous continuations could overwrite a newer run.

The hardening bound cached detection to the exact tab and URL, serialized state changes, and attached ownership to `runId`. A continuation must still own the active run before changing its state or advancing it. A failure in a side effect after a committed state write cannot erase the committed ownership. Alarm cleanup is coordinated with replacement runs.

Stopping is cooperative and exposed only during polling phases. It stops later work by this extension. It cannot promise to undo a source or generation request already accepted by Google. See [PR #2](https://github.com/mahlernim/scholar-relay/pull/2) and [`tests/safety-policy.test.js`](../tests/safety-policy.test.js).

### 7. The 32 MiB limit bounds the extension's own memory use

The upload bridge can hold PDF bytes, a Base64 representation, serialized messages, decoded bytes and metadata strings during one workflow. Base64 alone expands a 32 MiB payload to approximately 42.7 MiB. Additional simultaneous copies increase the working footprint further.

The 32 MiB cap was chosen as a conservative engineering bound. It is not a demonstrated universal browser limit, a Google upload quota, or a Chrome Web Store review requirement. Raising it responsibly would require measuring memory use across the actual transfer path.

The hardening validates PDF signatures, bounds Base64 payloads and stops streaming reads before accumulating an unlimited response. Larger remote PDFs can fall back to URL import. Larger local files need direct upload in Gemini Notebook. The English and Korean store descriptions were updated to explain that behavior before resubmitting v1.2.2.

### 8. Permission declarations had to describe the actual data flow

Store preparation narrowed permanent access to the service hosts and the local-file path, with optional HTTP/S access requested for a selected cross-origin PDF. `activeTab` and on-demand scripting support inspection when the user invokes the extension. There is no `cookies` API permission, and no developer backend receives the user's documents.

That architecture still handles authentication information, page URLs and website content. The privacy description needed to explain those flows even though the developer does not collect them on a server. The store preparation distinguished session-backed requests from password collection, and temporarily held file bytes from persistent settings and pipeline state.

The independent-product wording, bundled executable code, optional-origin behavior, [privacy policy](../PRIVACY.md) and listing copy were aligned with the implementation. These changes make the product and its disclosures easier to assess. The available evidence does not identify which changes influenced Google's approval.

## Why the browser CI took several attempts

The August 31 history contains a series of harness repairs. Passing unit tests and packaging did not establish that a fresh browser could load the extension and use the popup. Notification emails corroborate failures on the relevant revisions, including a failure on merged `main` after PR #2.

| Obstacle | Revision and lesson |
| --- | --- |
| Browser and extension discovery differed across developer machines and hosted runners. | [Runner discovery](https://github.com/mahlernim/scholar-relay/commit/0b95ed4), followed by browser-selection experiments. Locally installed Chrome was not a reproducible CI baseline. |
| Waiting for page load did not establish extension readiness. | [Popup readiness](https://github.com/mahlernim/scholar-relay/commit/de00b69). Readiness needed checks for the actual extension page and controls. |
| The smoke environment needed a separate Linux browser job. | [Linux smoke](https://github.com/mahlernim/scholar-relay/commit/32b9191). Packaging remained on Windows, while browser smoke used Linux and Xvfb. |
| A Windows-specific temporary-path check broke cleanup on Linux. | [Portable cleanup](https://github.com/mahlernim/scholar-relay/commit/8a0c3cc). Compare path parents and basenames with platform-aware utilities before recursive removal. |
| A popup target could become a permanent `chrome-error` page before registration was ready. | [Fresh-target retry](https://github.com/mahlernim/scholar-relay/commit/d32d330). Close the failed target and open a fresh one within a bounded retry window. |
| Browser selection and flag-based extension loading still failed after those fixes. | [Pinned Chromium](https://github.com/mahlernim/scholar-relay/commit/d7d208d), then [DevTools pipe loading](https://github.com/mahlernim/scholar-relay/commit/d27e2bc). Pinning alone was insufficient. The final harness loads the unpacked extension explicitly and receives its ID. |

The final harness uses `--remote-debugging-pipe` and `Extensions.loadUnpacked`, an isolated copied extension and temporary browser profile, bounded command waits, and guarded cleanup. CI pins Chromium revision `1688779` and Node 24 in the recorded workflow.

The smoke checks tab-specific detection, visible pipeline errors, rejection of a second start, stale stop rejection and stopping the current run. It uses local fixtures and controlled state. It does not sign in to Google or prove live remote artifact generation. Those are separate acceptance checks.

The practical lesson is to verify the exact pushed or merged commit. A green local run or an earlier branch revision cannot establish that the final hosted run passed. The September 3 README revision passed both hosted jobs in [run 33703632683](https://github.com/mahlernim/scholar-relay/actions/runs/33703632683).

## Chrome Web Store submission history

### Initial preparation

The August 30 store work covered ScholarRelay identity, icons, two localized descriptions, screenshots, a promotional image, permission explanations, privacy declarations, support and privacy links, and reviewer instructions. The archived [listing document at v1.2.2](https://github.com/mahlernim/scholar-relay/blob/v1.2.2/docs/chrome-web-store-listing.md) preserves the prepared copy and asset paths.

Reviewer instructions described signing in with the reviewer's own account, importing a public paper, testing settings and permissions, and allowing time for artifact generation. No shared developer login was supplied.

The retrieved setup emails establish a payment receipt and a contact-email confirmation request on August 30. Those messages alone do not establish that an extension was submitted, reviewed or published. The submission account comes from the recorded dashboard work.

### Replacing the pending v1.2.1 submission

On August 31, the recorded store state still had v1.2.1 under review while the finalized v1.2.2 package was available. The decision was to cancel the old review and resubmit the finalized package, accepting the possible loss of review queue time. The rationale was to distribute the tested package and matching disclosures. A higher approval probability was not established.

The existing item ID `epopghhfmpokhbalmnfcopmplffphdbb` was retained. The v1.2.2 ZIP uploaded successfully, and the only identified description addition was the accurate PDF size-limit paragraph in English and Korean. The session recorded verification of package version, permissions, privacy declarations, public visibility, free pricing, all-region distribution and reviewer instructions.

Automatic publication after approval was selected. The final observed dashboard status was `Pending review`. This was a successful submission, not evidence of publication at that moment.

### Confirming publication and retiring the draft document

On September 3 the public listing exposed `Add to Chrome` for version 1.2.2. The README then changed from ZIP-first installation to store-first installation in both languages, with toolbar pinning, automatic updates, a support link and collapsed manual-install instructions.

The subsequent signed-in check under the MahlerLab publisher confirmed the following visible fields.

| Console surface | Observed state on September 3 |
| --- | --- |
| Items table | ScholarRelay 1.2.2, created August 30, last updated August 31, `Published - public` |
| Status, Published tab | The revision is published and available to the public |
| Package, Published table | Version 1.2.2 with English and Korean |
| Draft surfaces | A separate unpublished draft and draft package version 1.2.2 were visible alongside the published revision |

The unpublished-draft label describes the draft surface and does not override the published revision's status. No upload, save, submission, rollback or distribution change was performed during this inspection. The visible fields confirm publication but leave the exact approval time unresolved.

The old `Maintainer: store package` section and live submission-preparation document were removed. They were useful during application but had become a second copy of store content that could drift. Their historical versions remain in Git. This retrospective preserves the reasons and evidence without presenting an obsolete application draft as the current listing.

## Packaging and future development

The final v1.2.2 ZIP contains 19 allowlisted runtime files. It excludes the README, developer notes, tests, source artwork, CI configuration and temporary material. The same canonical ZIP is used for GitHub releases and store upload. GitHub's automatic source archive is a different artifact.

Published v1.2.2 package SHA-256, verified again against the local archive and GitHub asset digest on September 3, 2026.

```text
6c6af08ec0ae01218a31256d6e881714b3b60399d1123e3bcf1c5098ac28b489
```

Use the existing commands according to the change being made.

| Command | Purpose and scope |
| --- | --- |
| `npm test` | Deterministic API, metadata, permissions and lifecycle tests. The finalized v1.2.2 release recorded 51 passing tests. |
| `npm run smoke:chrome` | Real extension popup and local lifecycle smoke. Set `CHROME_PATH` to a compatible Chromium executable when discovery is insufficient. |
| `npm run package:store` | PowerShell packager producing `dist/scholar-relay-vX.Y.Z.zip` and its `.sha256` sidecar from the manifest version. |
| `npm run capture:assets` | Regenerate README screenshots and store compositions using an isolated profile and sample state. Inspect all regenerated images before committing. |

For a runtime release, align manifest and package versions, run the existing required gates, inspect the ZIP allowlist and embedded version, verify extracted bytes against the intended checkout, and preserve the submitted ZIP digest. A rebuilt ZIP can differ because archive metadata changes, even when runtime source bytes are identical. Record the exact upload artifact rather than assuming a later rebuild has the same hash.

If changing the protocol, record the upstream revision examined and the affected wire-contract tests. If changing permissions or data flows, update the relevant policy and store disclosures. If changing a screenshot-visible feature, regenerate and inspect the corresponding assets. Documentation-only edits do not require a new extension release.

A useful future decision entry should name the observed failure, supporting evidence, chosen change, practical tradeoff, validation performed, and any remaining uncertainty. For store updates, also record the previous review state, submitted version and digest, dashboard result, publication mode, and later public availability check.

## Local folder cleanup and retained assets

The September 3 inventory found a clean tracked checkout with `dist/` as the only ignored output directory. There were no loose temporary screenshots or Syncthing temporary files to remove. The existing ignore rule for `icons/~syncthing~*.tmp` remains useful if synchronization creates another transient file.

The old local `scholar-relay-v1.2.1.zip` and its checksum sidecar were removed after each file's SHA-256 matched the corresponding published GitHub asset digest. They totaled 63,916 bytes and remain recoverable from [release v1.2.1](https://github.com/mahlernim/scholar-relay/releases/tag/v1.2.1). The v1.2.2 ZIP and sidecar were retained as the current release artifacts.

| Retained material | Why it is useful |
| --- | --- |
| `docs/screenshots/` | Referenced by the README and used as inputs to the store compositions |
| `docs/store-assets/` | Published-size screenshots and promotional artwork, with HTML sources for future revisions |
| `icons/*.svg` and `icons/render-*.html` | Editable icon sources and render compositions, separate from runtime PNGs |
| `scripts/` and `tests/` | Release tooling and coverage of failures encountered during development |
| `dist/` | Ignored local build output, currently retaining only v1.2.2 and its checksum |

The screenshot capture utility still uses the earlier port-and-flag loading approach and a Windows-specific cleanup guard. It has not received the smoke harness's later DevTools pipe and portable-cleanup changes. Keep its source and existing artwork, but check compatibility before the next asset regeneration. This documentation and cleanup task did not run it or change its behavior.

The project is small enough that removing reusable artwork or release tools would save little space while making future updates harder. Retiring verified duplicate builds is the useful cleanup here.

## v1.3.0 URL import, recovery, and popup update

The previous remote PDF path downloaded and uploaded bytes to obtain metadata even when the article HTML already supplied a useful title. Issues #6 and #7 separate title detection from transfer and add one safe upload fallback. PR #9 merged recovery first, PR #10 then enabled URL-first import. The user subsequently included issue #5, completed in PR #11. Issue #8 raises the upload limit and prepares this release.

Title candidates follow scholarly metadata, article JSON-LD, Open Graph, article heading, and document title. Detection preserves arXiv versions and recognizes publisher metadata and full-paper download links, including eLife. Generic titles, filenames, URLs, challenge pages, figures, and supplements are excluded. A missing HTML title leaves naming to Gemini Notebook. A useful HTML title bypasses PDF metadata decoding.

Confirmed import rejection or a reported source-processing error can claim one upload fallback in the existing notebook. The failed URL source is retained and recorded. Artifact generation uses the replacement source. Authentication, quota errors, ambiguous mutation responses, pending processing, and the ten-minute timeout do not initiate another upload. Downloads that need access pause for a popup permission action or manual file selection. Interrupted uploads with unknown outcomes are never replayed automatically. Older saved states are handled conservatively.

The 40 MiB limit is 41,943,040 bytes. A real Chrome extension smoke transferred that payload through runtime messaging and the resumable upload client to a controlled local server. The server received exactly the expected bytes and SHA-256. The full JSON message was 55,924,172 bytes, below 64 MiB. A 40 MiB plus one byte message was rejected, as was an oversized streaming response without Content-Length.

On the local Windows run, the transfer and oversized-message check took about four seconds. The popup timer observed a 1.02 second maximum gap. Samples reached approximately 109 MiB of popup JavaScript heap, 107 MiB of worker heap, and 133 MiB of worker backing storage. These are sampled categories, not a measurement of total peak browser memory. Large Base64 messages still cause a brief pause and substantial temporary allocations. The cap is an engineering bound, not a guarantee for every device or a Google quota.

Validation includes 69 deterministic tests, real Chrome extension smoke, syntax and package gates, metadata precedence and publisher fixtures, immediate and delayed confirmed failure, permission resumption, overlapping fallback calls, cancellation, restart, ambiguous responses, and rejection above the size bound. Controlled transport uses synthetic PDF bytes and does not claim Google ingestion of a 40 MiB document.

Separately, the signed-in Gemini Notebook UI accepted the arXiv PDF at https://arxiv.org/pdf/1706.03762, the eLife PDF at https://elifesciences.org/articles/91194.pdf, and a small valid local PDF. The eLife source view exposed the full paper, including the Introduction. These live checks establish service acceptance. The isolated Chrome smoke exercises the extension itself against controlled responses.

The completed popup measured 344 pixels high at 360 pixels wide. Results and the notebook link remain visible, completed workflow details are collapsed, and settings use a bounded scroll area. README and store screenshots were regenerated and visually inspected. Korean and English release notes are in [v1.3.0](releases/v1.3.0.md).
