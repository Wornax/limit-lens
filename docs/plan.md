# limit-lens: living plan

Status line: **v0.1 in progress** (started 2026-10-25). Update this file as work lands.

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

- [ ] Skeleton, plan, marketplace and plugin manifests
- [ ] Pricing (tests first)
- [ ] Transcript discovery and streaming analysis with dedupe (tests first)
- [ ] Categories: turns, loops, subagents, entry points, cache rebuilds (tests first)
- [ ] security-guidance adapter (tests first)
- [ ] Findings and fixes catalog (verified against docs)
- [ ] Markdown and JSON report, CLI flags
- [ ] `report` skill and `model-routing` skill
- [ ] Validate on the author's real transcripts (local only); `claude plugin validate`
- [ ] README, research notes, CHANGELOG
- [ ] Review, commit, push to the private repo
