# Queue wording review

Issue [#105](https://github.com/mahlernim/scholar-relay/issues/105) aligns queue phases, activity and hints with known task outcomes. This record covers five English messages in all eleven interface locales.

Both models received the same [prompt](prompt.txt) independently, without seeing the other's proposal. The prompt describes the state conditions and asks for natural, compact wording without inventing a retry or an outcome. These are extension-specific status messages.

| Role | Requested model | Reported model | Evidence |
| --- | --- | --- | --- |
| Initial Opus attempt | `claude-opus-6` | Unavailable | [Provider rejection](opus-6-unavailable.json) |
| Opus proposal | `opus` | `claude-opus-5-5` | [Full proposal](opus.json) |
| Gemini proposal | `gemini-3.8-flash-high` | Not returned by the CLI | [Full proposal](gemini-3.8-flash.json) |
| Final reviewer | `gpt-6-astra` | Explicitly selected Codex agent | [Final decisions](final-decisions.json) |

Gemini's selected model was listed by the installed provider client, but its response did not independently identify the served model. The rejected Opus 6 request is not counted as a translation proposal. Neither successful proposal is described as Opus 6.

Astra's decisions compare semantic accuracy, existing terminology, register and brevity. Correct existing wording can be retained even when both proposals suggest another form. Failure guidance applies to one or more confirmed failures, including all-failed jobs, without promising that another result succeeded. Unknown outcomes remain uncertain.

The raw proposals include their own unverified linguistic and layout claims. Those claims are not validation results. The final catalog checks and real popup smoke determine completeness, placeholder preservation and fit. The review does not claim native-speaker validation or inspection of Google's localized product UI. The full Simplified Chinese terminology audit remains in [#87](https://github.com/mahlernim/scholar-relay/issues/87).
