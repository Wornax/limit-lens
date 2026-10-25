# limit-lens: living plan

Status line: **v0.1 done: reviewed in three rounds, 79 tests green, end-to-end runs pass (default and `--days 2 --anonymize`: no permission denials, no real names reach the model, about $0.01 each on Haiku). Pending: the author's go-ahead to make the repo public** (2026-10-25).

## Goal

A Claude Code plugin (also its own marketplace) that shows where a user's usage limit goes and how to spend less, without spending tokens to find out.

## Decisions (from the design interview, 2026-10-24/25)

1. **The script does the math, Claude only explains.** A local Node script reads transcripts and plugin logs and prints a short report. The skill injects that report with `!`; Claude never reads raw transcripts.
2. **Unit:** API-equivalent cost at list price, shown as share of the total. Raw tokens are detail. The report states what it cannot see (other devices, claude.ai chat, plugins that call the API without logging).
3. **Fixes are suggested, never applied silently.** Claude applies one fix at a time, only when asked, showing the settings change first.
4. **English only** (code, skills, README).
5. **Personal repo, MIT.** The repo is the marketplace: `/plugin marketplace add <owner>/limit-lens`.
6. **The model-routing skill ships in v1** (translated from the author's `dividir-modelos`).
7. **Report sections:** model and effort, thinking, re-reading context, cache rebuilds, subagents and workflows, loops and automation, sessions started by tools (SDK/hooks), plugin calls outside transcripts.
8. **Plugin logs:** only `security-guidance` in v1, behind a small adapter so others can add theirs.
9. **Window:** last 7 days by default (`--days`), streamed line by line, files filtered by mtime first.
10. **Prices:** embedded table with its date; unknown models priced at a fallback and marked `~`.
11. **Node 18+, zero dependencies.**
12. **Nothing leaves the machine.** No network calls; the report has numbers and folder names only, never prompt or response text; `--anonymize` replaces folder names.
13. **Name:** `limit-lens` (`token-diet` and `tokdiet` are taken).
14. **Tests:** synthetic transcripts only; real data is used for local validation and never committed.

## Facts the design rests on (verified 2026-10-25)

- Each API response is written as one transcript line **per content block** (thinking, text, tool_use). All copies carry the full `usage`, the same `message.id` and `requestId`, and a different `uuid`. Sample: 49,704 assistant lines for 25,808 distinct responses. **Dedupe by `message.id`**; deduping by `(requestId, uuid)` double counts.
- Assistant lines carry `message.model`, `message.usage` (input, `cache_creation_input_tokens` split into `ephemeral_5m`/`ephemeral_1h`, `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `speed`, `inference_geo`), `effort`, `entrypoint`, `isSidechain`, `timestamp`.
- User prompts carry `origin.kind` (`human`, `task-notification`, `peer`, `unclassified`) and/or `promptSource` (`typed`, `sdk`, `system`, `queued`, `suggestion_accepted`). Desktop app prompts are `promptSource: sdk` with `origin.kind: human`.
- Subagents live in `<session>/subagents/agent-*.jsonl`, workflow agents in `<session>/subagents/workflows/wf_*/agent-*.jsonl`, each with a `.meta.json` (`agentType`, `workflowPhase`, `spawnDepth`).
- `security-guidance` logs `Review usage: review=<stop|commit|push> ... est_cost_usd=` to `<config>/security/log.txt` (rotates to `log.txt.1`). Stop reviews call the API directly and are **not** in transcripts; commit/push reviews run through Claude Code and **are** (as `sdk-*` sessions).
- Plan limits are not published in tokens; the main conversation uses a 1h cache TTL on a subscription, subagents 5m.

## Seams under test

1. `analyze(options) → report object`, run on synthetic transcript folders (main seam: dedupe, categories, cache rebuilds, loops, subagents).
2. `requestCost(model, usage)` (price math, worked examples from the pricing page).
3. `readSecurityGuidanceLog(dir, window)` (log adapter).
4. `renderMarkdown(report, options)` (no prompt text, anonymization, size).

## Steps

- [x] Skeleton, plan, marketplace and plugin manifests
- [x] Pricing (tests first)
- [x] Transcript discovery and streaming analysis with dedupe (tests first)
- [x] Categories: turns, loops, subagents, entry points, cache rebuilds (tests first)
- [x] security-guidance adapter (tests first)
- [x] Findings and fixes catalog (verified against docs)
- [x] Markdown and JSON report, CLI flags
- [x] `report` skill and `model-routing` skill
- [x] Validate on the author's real transcripts (local only); `claude plugin validate`
- [x] README, research notes, CHANGELOG
- [x] Review, commit, push to the private repo

## Notes from building v0.1

- The `!` line in the report skill takes no user input: substituting `$ARGUMENTS` into a shell command would let crafted arguments reach the shell. Other options go through a normal Bash tool call that must match `Bash(node *limit-lens.mjs*)`.
- End-to-end check: `claude -p "/limit-lens:report --days 2 --anonymize" --plugin-dir plugins/limit-lens --model haiku --permission-mode default` runs with no permission denials (about $0.01).
- Real 7-day run on a heavy machine: 31-35 s, ~135 MB RSS, report ~1,000 words.

## Review rounds (2026-10-25)

1. **Code review (one Sonnet agent):** fixed loop detection, unreadable files, untrusted transcript values, pricing edge cases, plugin log location, CLI validation, linked folders, BOM.
2. **Five-lens adversarial workflow (Sonnet finders, Opus skeptics):** 11 confirmed, then 24 more after a resume; all fixed with regression tests (`tests/review-fixes*.test.mjs`). Highlights: JSON and Markdown name sanitizing, numeric validation, prototype lookups, plugin spend kept outside the total, rebuilds only when the cache was actually lost, retention note only when retention can be the cause, root-level `agent-*.jsonl` counted as subagents, estimated prices bucketed with `~`, advice corrected against the docs (compact before a break, MCP and tool search, effortLevel vs modelSettings on Opus 5.5, fast mode billed to usage credits, FORCE as the blunt option).
3. **The report skill no longer uses a `!` line.** It runs the script through the Bash tool, pre-approved by `allowed-tools` pinned to the exact script path, so `--anonymize` applies before anything reaches the conversation and no user text ever reaches a shell line.

## v0.2: apply fixes and measure before and after (started 2026-10-25)

Goal: close the loop. `/limit-lens:fix` walks through the fixes that can be applied as settings, asks the user about each one, applies only the chosen ones, and later compares usage before and after.

Decisions:

1. **Only settings are applied.** Habits (`/clear`, `/compact`, `/model` at the start) are listed for the user to adopt; structural changes (shorter agents, a smaller CLAUDE.md) stay manual. Agent frontmatter edits are out of scope for v0.2.
2. **Only documented keys, only the user settings file** (`<config dir>/settings.json`): `env.CLAUDE_CODE_SUBAGENT_MODEL`, `modelSettings.<model id>.effortLevel`, `autoCompactWindow`, `crossSessionInbound`, `fastMode`, `model`, and the security-guidance variables in `env`. A fix is offered only when the evidence supports it and the setting is not already at that value.
3. **The script writes, not Claude.** `limit-lens.mjs apply <fix ids>` merges the keys into the JSON, refuses to touch a file that is not valid JSON, and saves a backup first. No "apply all".
4. **Two approvals.** The user picks each fix in the conversation, and the `apply` command is not pre-approved by the skill, so Claude Code's own permission prompt shows the exact command too. The report skill's rule is narrowed to flag-only commands so it can never run `apply`.
5. **Experiments.** Each apply records the fixes, the previous value of every key it changed, and a baseline snapshot of the 7 days before. State lives in `<config dir>/limit-lens/experiments.json`, the same place whether run from the skill or the CLI.
6. **Before and after.** `compare` measures the time since the apply against the baseline: spend per active day and per request, and the shares of each lens. It says "too early" until there are at least 2 active days and 200 requests, and it reminds that workload differs between periods.
7. **Undo.** `revert` restores only the keys the experiment changed, and skips any key the user has changed since.
