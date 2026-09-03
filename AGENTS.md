# ScholarRelay maintenance

Read [development history](docs/DEVELOPMENT.md) for the reasons behind existing behavior.

- Keep issues and PRs compact and in English. State the problem, resulting behavior, and relevant validation. Link the closing issue.
- Use plain punctuation. Do not use em dashes. Minimize colons and semicolons in prose.
- Write equivalent Korean and English release notes. Keep current README and store descriptions consistent with shipped behavior.
- Prefer HTML metadata and URL import. Download PDFs only when needed. Keep transfers bounded and validate PDF signatures.
- A timeout or malformed mutation response is an unknown outcome. Reconcile with reads and never blindly replay source creation, uploads, or artifact generation.
- Preserve run ownership, cancellation, and restart safeguards. Use focused behavioral tests and the existing release gates.
- Merge only after CI passes for the exact PR head. Run merged-main CI before releasing. Align manifest and package versions.
- Verify the ZIP allowlist, embedded version, extracted file bytes, and SHA-256. Publish and submit the same ZIP to the existing Chrome Web Store item.
- Record submitted version, digest, and dashboard status. Pending review is not publication. Verify the public listing after approval.
- Keep unrelated issues and user changes outside the current task. Do not add approval checkpoints to already authorized work.
