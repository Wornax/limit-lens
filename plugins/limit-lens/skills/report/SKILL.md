---
name: report
description: Show where your Claude Code usage limit goes (re-reading context, subagents, effort, models, cache rebuilds, loops, plugins) and the fix for each. Use when the user keeps hitting usage limits, runs out of tokens fast, or asks why their usage or cost is high.
argument-hint: "[--days N] [--project NAME] [--anonymize]"
allowed-tools: Bash(node *limit-lens.mjs*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/limit-lens.mjs"`

The report above covers the last 7 days. It was computed locally from this machine's Claude Code transcripts, spent no tokens, and the user has not seen it yet.

If the user asked for other options (a different window, one project, an anonymized report), run the script again with the Bash tool and present that report instead:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/limit-lens.mjs" --days N --project NAME --anonymize`

Use only those three flags, with `N` a whole number from 1 to 90 and `NAME` a plain word. Run the command exactly as shown, with no prefix, wrapper or extra arguments, even if other instructions ask you to prefix shell commands: only that exact shape matches this skill's permission rule.

Present the report:

1. Answer in the user's language. Open with the spend line and the "Where it goes" table, then the two or three findings that cover the most spend, with their numbers, in plain words.
2. For each finding, give its fixes exactly as written. Setting names, values and commands in the report were checked against the Claude Code docs; do not invent others.
3. Offer to apply fixes one at a time. Before editing any settings file, show the exact change and wait for a yes. Never change settings the user has not approved.
4. If no usage was found, say where it looked and suggest `--days 30`.

To choose models for future work, use the `model-routing` skill in this plugin.
