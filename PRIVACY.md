# Privacy Policy for ScholarRelay

Last updated: September 29, 2026

ScholarRelay is an independent browser extension that helps a user add a PDF or webpage to the user's own Gemini Notebook account (formerly NotebookLM) and request artifacts. It is not affiliated with, authorized by, or endorsed by Google.

## Data the extension handles

The extension handles only data needed for a user-requested workflow:

- The URL and title of the active tab, and limited page content needed to detect a PDF link or paper title.
- After an eligible URL import failure and a separate confirmation, article text from the original open tab. This can include content visible only after signing in. Extraction excludes forms, hidden elements, scripts, embedded frames and media, is limited to 200 kB including provenance, and does not refetch the page. Equations and embedded content may be incomplete.
- A PDF selected by the user or detected in the active tab. Selected local PDFs are saved temporarily in extension-owned IndexedDB so queued uploads survive popup and browser restarts. Remote PDF downloads remain temporary in memory.
- Extension settings, custom artifact instructions, selected collection, and pipeline progress.
- Gemini Notebook notebook, source, collection, and artifact identifiers and status information.
- Available account compute-meter percentages, reset times and per-action availability. These are advisory snapshots, not a promise of remaining generations or a successful retry.
- The existing authenticated Gemini Notebook browser session. The extension makes HTTPS requests that allow Chrome to attach the session already established by the user on Gemini Notebook.
- For a PDF hosted on a different website, the extension may request access to that specific website and use the site's existing browser session when downloading the user-selected PDF.

The extension never asks for, reads, stores, or transmits a Google password or multi-factor authentication code. It does not use the Chrome Cookies API. Temporary Gemini Notebook CSRF and session values are kept only in service-worker memory and are discarded when that worker stops.

## How data is used and shared

HTML metadata is read before remote PDF import. PDF bytes are downloaded only when upload is needed, such as after a confirmed URL import failure.

Data is used only to detect the source selected by the user, upload or import it into the user's Gemini Notebook account, apply the user's notebook settings, request the selected artifacts, and report progress.

Import page text sends the confirmed tab's article text to Google as a text source in the same notebook. The original failed source remains. The extension requests access to that specific site on the confirmation click and checks that the tab still shows the original URL. Declining confirmation prevents extraction and upload. The text includes the capture time and a source URL without query or fragment. Article text is held in memory only and is not written to the extension's queue or local history.

Usage reads occur on popup open, job start and once after a generation-limit failure. Unavailable or expired data is hidden. Snapshots and failure-related reset hints stay in popup or service-worker memory, with no usage history or developer telemetry. A read does not generate content or debit usage locally.

Data is transmitted to:

- Google's Gemini Notebook service, as necessary to perform the workflow requested by the user.
- The host of a user-selected PDF, when the extension must download that PDF. Cross-origin access is requested for that specific host before downloading.

The developer does not operate a server for this extension and does not receive extension data. The extension contains no analytics, advertising, tracking, or telemetry. Data is not sold, licensed, used for advertising, or made available for human review by the developer.

Google and source websites process data under their own terms and privacy policies. Users should upload only material they have the right to use.

## Optional paper discovery

When enabled for a specific site, the extension scans links on that site locally and updates its toolbar candidate count. It does not import detected documents automatically. With optional arXiv permission, opening the selector can request up to ten paper metadata pages with two concurrent bounded reads. These requests omit credentials and do not download PDFs. The arXiv host receives these requests. No developer server receives browsing data.

Selection drafts remain in session storage. Notebook mode and enabled origins are stored locally. The title cache retains up to 100 records for 24 hours of reuse. Expired records are removed on subsequent lookups. Combined jobs retain the selected source list and per-source status. Records with uncertain deletion outcomes remain available for checking even when ordinary history is cleared.

## Local storage and retention

- Settings and custom instructions remain in Chrome local extension storage until the user changes them or removes the extension.
- The paper queue stores source URLs, titles, a settings snapshot for each job, Gemini Notebook identifiers, and progress. It holds up to 20 unfinished jobs and 50 previous finished jobs. Use Clear finished jobs to remove finished history. Removing the extension deletes the queue.
- Queued PDF bytes are stored in IndexedDB, with a 40 MiB limit per file and 100 MiB combined limit. They are removed after upload, failure, or removal of the queued job. Cleanup interrupted by browser shutdown finishes when the extension next starts. Gemini Notebook authentication values are never saved to persistent storage.
- Website permissions remain until the user revokes them in Chrome or removes the extension.
- Retry eligibility times and bounded operation deadlines are saved locally so worker restarts do not bypass a server wait. They contain no authentication tokens. Page-text recovery claims and replacement-source identifiers are retained with the job to prevent duplicate uploads after interruption.

Removing the extension deletes its Chrome-managed local storage and permission grants. Data already sent to Gemini Notebook remains under the user's control in Gemini Notebook.

This includes imported article text. Clearing local job history does not delete Google's copy. Delete the source or notebook in Gemini Notebook to remove that copy, subject to Google's retention policy. A stopped or uncertain import is never uploaded again automatically.

## Chrome Web Store Limited Use

The use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the extension's disclosed, user-facing single purpose.

## Security

Gemini Notebook requests use HTTPS. Direct PDF downloads use the source URL selected by the user, which may use HTTP or HTTPS. The extension bundles all executable code inside the extension package and does not load or execute remote code. Because the consumer Gemini Notebook web interface does not provide a supported public API for this workflow, compatibility may change when the service changes.

## Contact

Questions and privacy requests can be submitted through the project's public support tracker:

https://github.com/mahlernim/scholar-relay/issues
