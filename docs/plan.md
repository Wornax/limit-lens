# limit-lens: living plan

Status line: **v0.3: `/limit-lens:analyze` with a summary, text bar charts and a browser dashboard, then model routing (CLAUDE.md rule), settings fixes with "What it is" and other suggestions; three review rounds fixed, 174 tests green, headless run passes. Pending: the author trying it interactively, then the go-ahead to make the repo public** (2026-10-25).

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

## v0.2 review (2026-10-25)

Two finders (Opus on the settings-writing path, Sonnet on settings accuracy) with an Opus skeptic per finding: 11 confirmed, 1 refuted, all fixed with tests in `tests/review-v02.test.mjs`. A damaged `experiments.json` now stops apply and revert instead of being overwritten; `plan` shows exactly what `revert --experiment ID` restores; writes keep indentation, line endings and BOM, follow a symlinked file, keep its mode, and leave nothing behind on failure; each security-guidance fix needs its own evidence and the model fixes are skipped on third-party providers; the effort and auto-compact fixes skip environment overrides; `opusplan` is left alone; the hold fix states that held messages are not delivered.

## v0.3: decide with the evidence in front of you (2026-10-25)

Why: in the first interactive test of `/limit-lens:fix`, the questions showed the setting and a one-line why, but not what caused the spend, how much each fix would save, or whether it changes how Claude works. The tester answered "Apply" to all seven, including both security-guidance alternatives.

Decisions:

1. **Diagnosis first.** `plan` opens with "What is eating your limit": the spend for the window, the three biggest lenses with their share, and the three biggest projects, with a note that lenses overlap and that dollars are API-equivalent.
2. **Each fix carries its evidence.** `contributors` (projects, agent types, sessions with the most requests over 200K, plugin reviews), `savings` (`weekly`, scaled from the window to 7 days, plus a `basis` sentence) and `kind` (`cost-only` or `changes-work`) with an `effect` sentence. Effort and auto-compaction have `weekly: null`: their effect depends on behaviour, so compare measures it.
3. **Savings are upper bounds from list prices.** Model fixes save at most half of the Opus spend they move (Sonnet 5.5 lists at half of Opus 5.5); the per-turn review fixes use the plugin log's cost; the hold fix uses what peer-started turns cost.
4. **Alternatives share one question.** Fixes with the same `group` are rendered as one question with "Options: `a` or `b`", and `apply` refuses two of them before writing anything.
5. **Skip first.** The skill orders the options Skip, Show details, then Apply (or one option per alternative), and does not soften a "changes how Claude works" label.
6. **Attribution in the report.** `byProject` splits spend into main and agents, Opus, high effort and requests over 200K; `contextSessions` lists the sessions with the most requests over 200K. `plan --json` adds the diagnosis and the questions, with names from disk cleaned.

## v0.3 review (2026-10-25)

Three Sonnet finders (numbers, safety, spec) with an Opus skeptic per finding: 5 confirmed, 6 refuted; the 6 findings past the per-axis cap were checked by hand (4 real, 2 duplicates). Fixed with tests in `tests/review-v03.test.mjs`:

- Model savings use the Sonnet 5.5 discount of each Opus version (`sonnetSaving` in `pricing.mjs`, the token kind where Sonnet saves least), not a flat half, and the plan says "about", not "up to".
- The security-guidance Sonnet fixes are offered only while the review runs on Opus (its variable unset or an Opus id), priced at that model; the per-turn fixes disappear once `ENABLE_STOP_REVIEW` is exactly "0" (the plugin ignores "false" and "off"); the commit and push fix falls back to the log cost.
- The diagnosis shows plugin calls outside transcripts; the plan says the estimates do not add up.
- Auto-compaction at 300K needs requests past 300K (`requestsOver300k`, counted for main conversations), and its contributors are those sessions; the effort fix names projects by that model's high-effort spend (`highEffortByModel`); agent types are merged across the two agent lenses.
- `report --json` adds up projects whose cleaned names collide.
- Found while checking against real data: the shell outranks too. `CLAUDE_CODE_SUBAGENT_MODEL` stops the agents fix, `ANTHROPIC_MODEL` (priority 3, above the `model` setting) stops the default-model fix, and `CLAUDE_CODE_DISABLE_1M_CONTEXT` stops the 300K fix. Tests clear these variables in `tests/helpers.mjs`, because a Claude Code session exports its settings' env block.

## One command: `/limit-lens:analyze` (2026-10-25)

Why: the author asked for a single command that reports what is eating the limit, then offers the model-routing skill, then the other suggestions, instead of separate `report` and `fix` commands.

Decisions:

1. **`/limit-lens:analyze` is the door.** It is model-invoked (it fires when the user asks why they keep hitting the limit) and runs `limit-lens.mjs analyze`, which prints the report, the questions and the other suggestions from one pass over the transcripts. `compare` and `revert` are its arguments. The `fix` skill is gone; `report` stays for a read-only or shareable report and is user-invoked only, so the two skills never compete for the same trigger.
2. **"Install the router" means a rule in the user's CLAUDE.md.** The `model-routing` skill already ships with the plugin; the fix `model-routing-rule` appends a marked three-line block to `<config dir>/CLAUDE.md` so Claude reads the guide before it starts any agent (the same pattern the author uses for his own routing skill). It is asked first, only when agents spend at least 1% and CLAUDE.md does not route already; its saving cannot be estimated in advance.
3. **The script writes CLAUDE.md like settings:** validated first, backed up, atomic, symlink-safe; if the settings write fails after it, CLAUDE.md is put back. Revert removes exactly what was added (block, its line ending and separator) and leaves an edited block alone. Experiments record memory changes with `kind: 'memory'`; v0.2 records have no kind and are settings changes.
4. **Other suggestions are the findings' own suggestions,** grouped by finding, minus the ones a question already asks (a fixed map from fix id to suggestion text, `ASKED` in `report.mjs`). Each habit names the finding that carries the same advice; analyze lists a habit under "Habits" only when that finding is not shown.

## Review of the analyze command (2026-10-25)

Two Sonnet finders (the CLAUDE.md writes, the flow and its docs) with an Opus skeptic per finding: 8 confirmed, plus 1 checked by hand; all fixed with tests in `tests/review-analyze.test.mjs`. CLAUDE.md that is not UTF-8 is refused instead of rewritten; revert keeps the user's lines apart, deletes a CLAUDE.md that apply created, writes CLAUDE.md only after settings succeed (and puts settings back if CLAUDE.md then fails), needs valid settings only when the experiment changed them, and notes a routing mention left outside the block. The goal check-in tip and the `/compact` advice no longer vanish with the suggestion a question covers; habits whose finding is not shown appear under "Habits"; `analyze`, `plan`, `apply`, `compare` and `revert` refuse `--days`, `--project` and `--anonymize` instead of ignoring them.

## Charts and a dashboard (2026-10-25)

Why: the author found the flow "too raw": it should summarize what it is about to do, show more, and draw it ("charts, bars, something nice on screen").

Decisions:

1. **Text bars in the conversation.** The report's "At a glance" block draws spend by day, where it goes, by model, source and effort, and the biggest projects with Unicode eighth blocks (`scripts/lib/charts.mjs`), all bars in one column, values printed beside them. Skills show it verbatim inside a code block.
2. **A dashboard page.** `analyze --open` writes `<config dir>/limit-lens/dashboard.html` (`scripts/lib/dashboard.mjs`) and opens it with the system's default app; `LIMIT_LENS_NO_OPEN=1` turns the opening off. One self-contained file, nothing loaded from the network, built with the dataviz method: one hero figure, share cards with meters, columns for spend by day (busiest day and today labelled, tooltips, a table view), single-hue bar lists with every value printed, finding cards, fix cards with "What it is", a savings chart in a second hue (validated with the palette script; the light aqua needs visible labels, which every bar has), light and dark. Every string is HTML-escaped; names from disk are already reduced to plain characters.
3. **A summary first.** analyze opens with "## Summary" (what eats the limit, biggest projects, how many questions come next, the largest estimated saving, the dashboard path); the skill says in two sentences what is about to happen before running, and sums up the chosen changes before applying.
