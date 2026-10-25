# Research notes (2026-10-25)

What limit-lens is built on, how each fact was checked, and what is still open. Measurements come from one heavy user's machine (14 GB of transcripts, Claude Code 2.1.310); only aggregates are recorded here.

## Transcript format (measured)

- **One line per content block.** Each API response is written as several `assistant` lines (thinking, text, tool_use), each with the full `message.usage`, the same `message.id` and `requestId`, and a different `uuid`. Sample over one day: 49,704 assistant lines for 25,808 distinct responses; all duplicates had identical usage. No response id appeared in two files.
- **Assistant lines** carry `message.model`, `message.usage` (`input_tokens`, `cache_creation_input_tokens` with `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `speed`, `inference_geo`), plus `effort`, `entrypoint`, `isSidechain`, `timestamp`. Key order inside `message` is `model, id, type, role, content, ..., usage`, so `"role":"assistant"` sits in the first bytes of the line.
- **User prompts** carry `origin.kind` (`human`, `task-notification`, `peer`, `unclassified`) and/or `promptSource` (`typed`, `sdk`, `system`, `queued`, `suggestion_accepted`). The desktop app sends prompts as `promptSource: sdk` with `origin.kind: human`. There is no dedicated marker for `/loop` firings; repetition of the same prompt is the signal (Claude Code's own `/usage` keys loops by prompt).
- **Subagents** live in `<session>/subagents/agent-*.jsonl`, workflow agents in `<session>/subagents/workflows/wf_*/agent-*.jsonl`, each with a `.meta.json` (`agentType`, `workflowPhase`, `spawnDepth`, `model`, `requestShape`).
- **Bytes per day by line type** (one heavy day): user lines 578 MB (mostly tool results), `api-request` 420 MB, `assistant` 134 MB, `api-request-blob` 122 MB, `attachment` 91 MB. Lines that lead with `{"type":"` are never user or assistant records today. Classifying lines from their first 8 KB cut a 7-day run from 103 s to 31 s with identical results (31,294 = 31,294 responses on a frozen window).

## What the heavy user's week showed (aggregates)

- Cache reads 63% of API-equivalent spend, cache writes 28%, output 9% (thinking 4%).
- Subagents 41% and workflow agents 36%; the main conversation 23%.
- Subagents start around 64K tokens and grow to ~390K on average over ~140 requests each: the cost is long-running agents re-reading their own context, not forks inheriting the parent's conversation (checked by first-request size).
- Main conversations averaged ~520K tokens per request.
- 72% of spend ran at `xhigh` or `max`; Opus 5.5 was 76%.
- The `security-guidance` plugin was ~0.4% (its commit reviews as SDK sessions plus stop reviews outside transcripts).

## Claude Code behavior (from the docs)

- Prompt caching: main conversation 1h TTL on a subscription within plan usage, 5m otherwise; subagents and workflows 5m. `promptCacheTtl` / `subagentPromptCacheTtl`. Switching model invalidates the cache; changing effort keeps it on the 5.5 models. https://code.claude.com/docs/en/prompt-caching
- Effort: levels `low`..`max`; 5.5 models default to `medium`; `effortLevel` and `modelSettings` can't hold `max`. https://code.claude.com/docs/en/model-config
- Auto-compact window: `/autocompact`, `autoCompactWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100K to 1M). Same page.
- Subagent model: resolution order is the per-call model, the definition's `model:`, `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model; `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` applies it to every subagent, teammate and workflow agent (2.1.257+). https://code.claude.com/docs/en/sub-agents
- Why usage climbs in long sessions (scheduled tasks, cross-session messages, goal check-ins): https://code.claude.com/docs/en/costs
- Skills: `!` command injection runs before the content reaches Claude, is checked against permission rules (pre-approve with `allowed-tools`), and `${CLAUDE_PLUGIN_ROOT}` is substituted in plugin skills. `commands/` is the older format. https://code.claude.com/docs/en/skills
- Marketplace layout and validation: https://code.claude.com/docs/en/plugin-marketplaces

## Prices

From https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-25. Fast mode is 2x on Opus 5.5, Opus 5 and Opus 4.8; US-only inference is 1.1x on 4.6 and later; Haiku 5.5 has a higher tier for prompts over 100K tokens. Footnotes on some cache-hit prices were not resolved; the table uses the listed figures.

## Landscape

Other tools read the same transcripts: cost trackers (ccusage and others) and at least one "why did my tokens burn" analyzer. limit-lens differs by deduplicating by `message.id`, covering effort, thinking, cache lifetime and rebuilds, loops, workflow agents and plugin spend, running as a Claude Code plugin that hands the fixes to Claude, and working on Windows without a native binary.

## Open questions

- Whether plan limits weigh models exactly by API price ratios (Anthropic does not publish this). The report says "API-equivalent" for that reason.
- How compaction requests are recorded; they are not singled out yet.
- A precise marker for `/loop` firings, if Claude Code adds one.
