# Scholar Relay landing page

Static landing page prepared for `https://ahn-lab.org/scholar-relay/`.

- `index.html` contains the crawlable English fallback and compact product structure.
- `app.js` selects a supported language from an explicit query, saved preference, or browser locale. Unsupported locales fall back to English.
- The language selector always overrides automatic selection.
- The on-page workflow visual uses localized HTML so every visible label changes with the selected language. `assets/automation-card.png` remains the English social preview for the canonical URL.
- `assets/screenshots/` contains the real extension workflow and settings captures shown in the hero. The page selects the matching locale with the rest of the interface.
- The share button uses Web Share with localized copy and falls back to copying the localized URL.

Before production deployment, render desktop and 390 px mobile views, validate the final absolute URL, and add the deployment target's sitemap and `hreflang` routing.
