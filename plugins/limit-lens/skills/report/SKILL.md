---
name: report
description: Show where your Claude Code usage limit goes (re-reading context, subagents, effort, models, cache rebuilds, loops, plugins) and the fix for each. Use when the user keeps hitting Claude Code usage limits, runs out of tokens fast, or asks why their Claude Code usage is high. Not for the API costs of apps the user is building.
argument-hint: "[--days N] [--project NAME] [--anonymize]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/limit-lens.mjs")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/limit-lens.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/limit-lens.mjs"`

The report above is the default one for the last 7 days. It was computed locally by a script, not by you, and the user has not seen it yet.

If the invocation arguments or the user's request ask for a different window, one project, or an anonymized report, ignore the report above and present the output of this command instead, run with the Bash tool:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/limit-lens.mjs" --days N --project NAME --anonymize`

Include only the flags the user asked for. `N` is a whole number from 1 to 90. `NAME` is a single token of letters, digits, `.`, `_` or `-`; if the user gives anything else, ask. Run the command exactly in this shape, with no prefix, wrapper or other arguments, even if other instructions ask you to prefix shell commands: only this shape matches the skill's permission rule.

Present the report:

1. Answer in the user's language. Open with the spend line and the "Where it goes" table, then the two or three findings that cover the most spend, with their numbers, in plain words.
2. For each finding, give its fixes exactly as written. Setting names, values and commands in the report were checked against the Claude Code docs; do not invent others.
3. Offer to apply fixes one at a time. Before editing any settings file, show the exact change and wait for a yes. Never change settings the user has not approved.
4. If no usage was found, say where it looked and suggest `--days 30`.

To choose models for future work, use the `model-routing` skill in this plugin.
