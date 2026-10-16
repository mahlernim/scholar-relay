# Simplified Chinese review

Issue [#87](https://github.com/mahlernim/scholar-relay/issues/87) audits all 292 existing Simplified Chinese interface messages. Two compact count labels introduced by issue #95 bring the reviewed catalog to 294 messages. The final pass changes 192 existing translations and adds both labels.

The coordinating reviewer inspected the signed-in Chinese interface at `notebook.google.com` with `hl=zh-CN` on October 16, 2026. The sanitized [terminology evidence](terminology-evidence.txt) records observed labels without private notebook titles or IDs. The original [shared prompt](prompt.txt) includes that evidence and the complete input catalog. Both providers received identical input independently. Neither saw the other's proposal. An identical [supplement](supplement-prompt.txt) separately covers the two new count labels and later slide-dialog observations.

| Role | Requested model | Reported model | Evidence |
| --- | --- | --- | --- |
| Opus proposal | `opus` | `claude-opus-5-5` | [Raw reply](opus-raw.json), [provenance](opus-provenance.json) |
| Gemini proposal | `gemini-3.8-flash-high` | Not returned | [Raw reply](gemini-raw.json), [provenance](gemini-provenance.json) |
| Opus supplement | `opus` | `claude-opus-5-5` | [Raw reply](opus-supplement-raw.json), [provenance](opus-supplement-provenance.json) |
| Gemini supplement | `gemini-3.8-flash-high` | Not returned | [Raw reply](gemini-supplement-raw.json), [provenance](gemini-supplement-provenance.json) |
| Final reviewer | `gpt-6-astra` | Explicitly selected Codex agent | [All-key decisions](final-decisions.json) |

The installed Gemini client listed the requested model before dispatch. Its successful responses do not independently establish the served model ID. It warned that requested plan mode had no effect with slash command expansion disabled, so the no-tools restriction for Gemini was a prompt instruction, not a verified mode control. The Claude alias resolved to Opus 5.5, not Opus 6. Raw replies are preserved, including CLI metadata and unverified linguistic claims. Parsed proposals are convenience copies. SHA-256 hashes cover the exact UTF-8 prompt and raw-reply files.

The final review compares both proposals for each key, including unchanged entries. It fixes unrelated dictionary translations, language names, missing icons, untranslated labels, inconsistent source and collection nouns, and unnatural queue guidance. Verified product labels include 音频概览, 演示文稿, 视频概览, 思维导图, 报告, 闪卡, 测验, 信息图 and 数据表格. Generic 学习资料 and 集合 remain extension wording, not claimed exact Google labels.

Further signed-in infographic observations arrived after the proposals. Astra uses their exact applicable labels, including 泥塑风, 编辑风, 教学风, Bento 网格 and 简短. These later observations are recorded in the evidence file and final decisions. They were not part of the original provider prompts. Existing icons stay intact and the observed BETA badge is not added to the extension text.

The shared Length key uses 长度 because it serves both audio and slides. Detailed remains 详细 because it also serves infographic detail. Presenter uses the compact 演示用 derived from observed 演示用幻灯片. The new 幻灯片 $1 and 来源 $1 labels report returned counts without claiming completeness. Time queued uses 排队时长 because the existing clock reports elapsed duration. Failure wording retains 有请求失败 so an all-failed job does not imply a successful sibling. Unknown outcomes still require inspection, and stopping the extension does not promise to stop remote generation.

The review checks complete key coverage, numbered placeholders, source icons, and punctuation. All 294 entries pass these structural checks. The parent release workflow regenerates shipped catalogs and runs popup layout and behavioral smoke tests. Those runtime gates are separate from this editorial record. This is machine-assisted review with observed product terminology, not native-speaker certification.

The Chinese metadata and asset copy were inspected for terminology consistency. They already use 音频概览, 学习资料 and 集合. Store assets and release descriptions remain with the release workflow.

The raw provider metadata retains conversation/session IDs, timing, token usage and provider-reported price estimates. These are provenance, not verified billing. A publication audit found no credential patterns, email addresses, local user paths or private notebook URLs in the packet. The replies contain the requested translations and terminology caveats, with no captured unrelated conversation context.

The proposal scripts now replay the frozen prompts into a required new `--output-dir`. They do not replace this evidence packet or regenerate the original prompt from the current catalog. They invoke paid or quota-consuming provider clients and should only be rerun intentionally. CLI executables resolve from PATH, or from the `SCHOLAR_REVIEW_CLAUDE` and `SCHOLAR_REVIEW_AGY` environment overrides. On Windows, the runner can resolve the native Claude executable beside an npm launcher. No user-specific installation path is embedded.

The finalization script uses the recorded replies without inference and derives the repository root from its file location. It intentionally rewrites the Chinese catalog and derived decisions, so it should only be rerun when rebuilding this editorial decision record. The portability audit checked Python syntax and both proposal help commands without making new model calls. All eight recorded evidence hashes remained unchanged.
