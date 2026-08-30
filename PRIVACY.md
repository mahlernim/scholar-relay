# Privacy Policy for ScholarRelay

Last updated: August 30, 2026

ScholarRelay is an independent browser extension that helps a user add a PDF or webpage to the user's own Gemini Notebook account (formerly NotebookLM) and request artifacts. It is not affiliated with, authorized by, or endorsed by Google.

## Data the extension handles

The extension handles only data needed for a user-requested workflow:

- The URL and title of the active tab, and limited page content needed to detect a PDF link or paper title.
- A PDF selected by the user or detected in the active tab. PDF bytes are held temporarily in browser memory while the file is uploaded.
- Extension settings, custom artifact instructions, selected collection, and pipeline progress.
- Gemini Notebook notebook, source, collection, and artifact identifiers and status information.
- The existing authenticated Gemini Notebook browser session. The extension makes HTTPS requests that allow Chrome to attach the session already established by the user on Gemini Notebook.
- For a PDF hosted on a different website, the extension may request access to that specific website and use the site's existing browser session when downloading the user-selected PDF.

The extension never asks for, reads, stores, or transmits a Google password or multi-factor authentication code. It does not use the Chrome Cookies API. Temporary Gemini Notebook CSRF and session values are kept only in service-worker memory and are discarded when that worker stops.

## How data is used and shared

Data is used only to detect the source selected by the user, upload or import it into the user's Gemini Notebook account, apply the user's notebook settings, request the selected artifacts, and report progress.

Data is transmitted only over HTTPS to:

- Google's Gemini Notebook service, as necessary to perform the workflow requested by the user.
- The host of a user-selected PDF, when the extension must download that PDF. Cross-origin access is requested for that specific host before downloading.

The developer does not operate a server for this extension and does not receive extension data. The extension contains no analytics, advertising, tracking, or telemetry. Data is not sold, licensed, used for advertising, or made available for human review by the developer.

Google and source websites process data under their own terms and privacy policies. Users should upload only material they have the right to use.

## Local storage and retention

- Settings and custom instructions remain in Chrome local extension storage until the user changes them or removes the extension.
- Pipeline state, including source URLs, titles, Gemini Notebook identifiers, and status, remains until it is replaced by a new run, reset in the extension, or removed with the extension.
- PDF file bytes and Gemini Notebook authentication values are not saved in Chrome local storage.
- Website permissions remain until the user revokes them in Chrome or removes the extension.

Removing the extension deletes its Chrome-managed local storage and permission grants. Data already sent to Gemini Notebook remains under the user's control in Gemini Notebook.

## Chrome Web Store Limited Use

The use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the extension's disclosed, user-facing single purpose.

## Security

The extension uses HTTPS for network transmission, bundles all executable code inside the extension package, and does not load or execute remote code. Because the consumer Gemini Notebook web interface does not provide a supported public API for this workflow, compatibility may change when the service changes.

## Contact

Questions and privacy requests can be submitted through the project's public support tracker:

https://github.com/mahlernim/scholar-relay/issues
