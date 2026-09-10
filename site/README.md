# Scholar Relay landing page

Static landing page prepared for `https://ahn-lab.org/scholar-relay/`.

- `index.html` contains the crawlable English fallback and compact product structure.
- `app.js` selects a supported language from an explicit query, saved preference, or browser locale. Unsupported locales fall back to English.
- The language selector always overrides automatic selection.
- `assets/automation-card.svg` is the on-page workflow card. Its 1200 by 630 PNG render is the social preview and share attachment.
- The share button attaches the PNG when supported, uses ordinary Web Share otherwise, and falls back to copying the localized URL.

Before production deployment, render desktop and 390 px mobile views, validate the final absolute URL, and add the deployment target's sitemap and `hreflang` routing.
