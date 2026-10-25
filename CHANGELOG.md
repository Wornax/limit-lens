# Changelog

## 0.4.0 (2026-10-25)

- Reports in Brazilian Portuguese: the report, analyze, the plan, compare, apply and revert, the dashboard, and every finding and fix, with numbers written the Brazilian way (US$ 1.234,56) and days as "sáb 24/10". The language comes from `--lang en|pt`, then `LIMIT_XRAY_LANG`, then Claude Code's `language` setting, then English; the skills pass `--lang pt` when the conversation is in Portuguese. Setting names, values, commands and the routing line written to `CLAUDE.md` stay as they are.
- Texts live in language catalogs (`scripts/lib/i18n/`). A missing text falls back to English, and a test checks every catalog against the English one: same keys, same values, same commands.
- Fixed: the dashboard that `analyze` writes listed the habits as empty items.
- The "At a glance" block keeps its share column aligned when amounts are long.
- The dashboard footer prints the date as `2026-10-25 14:03`.

## 0.3.0 (2026-10-25)

- Renamed from limit-lens to **limit-xray**: several similar projects already used "limit lens" (including the `limitlens` npm package for Claude and Codex quotas). Commands are now `/limit-xray:analyze` and `/limit-xray:report`, the state folder is `<config dir>/limit-xray/`, and the repository is `Wornax/limit-xray`.
- One command, `/limit-xray:analyze`: the report, then model routing, then each settings fix, then the other suggestions, from one pass over the transcripts. It replaces `/limit-xray:fix`; `compare` and `revert` move to `/limit-xray:analyze compare` and `/limit-xray:analyze revert`.
- Model routing as a fix: a marked three-line block in the user's `CLAUDE.md` that makes Claude read the `model-routing` guide before it starts an agent. Offered first when agents spend and `CLAUDE.md` does not route already; applied by the script with a backup; revert removes exactly that block (and a `CLAUDE.md` that apply created), leaves an edited one alone, and writes `CLAUDE.md` only after settings succeed. A `CLAUDE.md` that is not UTF-8 is never rewritten.
- `analyze`, `plan`, `apply`, `compare` and `revert` refuse `--days`, `--project` and `--anonymize`, which only the report takes.
- Every question opens with what the thing is, in plain words ("What it is"): model routing, agents, effort, auto-compaction, cross-session messages, the security-guidance plugin, fast mode, the default model. The routing question is now "Turn on model routing for agents".
- The analyze skill shows the report as its own message, in a fixed shape, before the first question.
- Charts: the report draws spend by day, where it goes, by model, source and effort, and the biggest projects as text bars ("At a glance"); analyze opens with a "Summary" (what eats the limit, what happens next, the largest estimated saving) and, before applying, Claude sums up the chosen changes.
- Dashboard: `analyze --open` writes `<config dir>/limit-xray/dashboard.html`, one self-contained page (no network, light and dark) with the spend, share cards, spend by day, bar charts, findings, every fix with what it is and its estimated saving, other suggestions and the costliest sessions, and opens it in the default browser (`LIMIT_XRAY_NO_OPEN=1` turns the opening off).
- The report counts spend per local day (`byDay` in `--json`).
- "Changes in effect": the plan, analyze and the dashboard list every change limit-xray made that is still in place, newest first, setting by setting; when no fix applies, the summary says how many changes from earlier runs are already in effect.
- `/limit-xray:report` runs only when you type it, for a read-only or shareable report, and lists the biggest projects.
- `limit-xray analyze [--json]` on the command line; `plan` remains for scripts.
- The plan opens with what is eating your limit: the biggest lenses, the biggest projects, and plugin calls outside transcripts.
- Each fix is labelled "cost only" or "changes how Claude works for you", with its effect, and names its biggest contributors when the transcripts can tell: projects, agent types, sessions past 300K tokens or plugin reviews.
- Each fix estimates its weekly saving at list prices and says how. Model fixes use the Sonnet 5.5 discount for each Opus version (half for Opus 5.5, more for older Opus). Effort and auto-compaction say they cannot be estimated in advance and point to compare. The plan says the estimates do not add up.
- Alternatives (the security-guidance per-turn review on Sonnet, or dropped) share one question, and `apply` refuses both together.
- Questions offer "Skip" first and "Show details" next.
- The security-guidance Sonnet fixes are offered only while that review runs on Opus, and the per-turn ones not at all once `ENABLE_STOP_REVIEW` is "0".
- Auto-compaction at 300K is offered only when requests went past 300K, and not when `CLAUDE_CODE_DISABLE_1M_CONTEXT` already caps the window at 200K.
- A variable in the shell counts like one in the settings file: `CLAUDE_CODE_SUBAGENT_MODEL` stops the agents fix, and `ANTHROPIC_MODEL`, which outranks the `model` setting, stops the default-model fix.
- A fix is not offered when it would change nothing: Explore and Plan agents (the subagent variable does not move them), cross-session messages already refused, fast mode that cannot carry over (`fastModePerSessionOptIn`, `CLAUDE_CODE_DISABLE_FAST_MODE`), automatic compaction turned off, an effort cap at or below high (`maxEffortLevel`), the security-guidance plugin switched off or on any third-party provider. A model alias such as `opus` is priced as the newest of its family.
- `--json` reports attribute spend by project (main conversation and agents, Opus, high effort per model, requests over 200K and 300K) and list the sessions with the most requests over 300K; projects whose cleaned names collide are added up.
- `plan --json` adds the diagnosis and the questions, with names from disk cleaned.
- Tests clear the settings variables a Claude Code session exports, so they see only their own fixtures.

## 0.2.0 (2026-10-25)

- `/limit-xray:fix`: lists the fixes that apply to you as settings, asks about each one, and applies only the chosen ones through the script, with a backup and a recorded experiment.
- `/limit-xray:fix compare`: spend per active day and per request, and lens shares, before and after the change; says when it is too early.
- `/limit-xray:fix revert`: restores only the keys an experiment changed, skipping keys changed since.
- CLI subcommands `plan`, `apply`, `compare`, `revert`; the report skill can only run flag-only commands, and `apply`/`revert` are never pre-approved.

## 0.1.0 (2026-10-25)

- `/limit-xray:report`: local report of API-equivalent spend by component, model, effort, source and entry point, with ranked findings and fixes checked against the Claude Code docs. Runs through the Bash tool with a permission rule pinned to the script.
- Lenses: re-reading context, subagents and workflow agents, effort, model mix, cache rewritten mid-session (pause, model switch, other), loops and automated turns, setup at startup, plugins that call the model (in and outside transcripts), fast mode.
- `security-guidance` log adapter, resolved the way the plugin resolves it, with coverage and project-scope notes.
- Responses deduplicated by `message.id`; fast line classification from the first bytes; untrusted values sanitized; malformed lines skipped one by one.
- `/limit-xray:model-routing`: guide for choosing Haiku, Sonnet or Opus and the effort level for delegated work.
- `--days`, `--project`, `--anonymize`, `--json`, `--config-dir`, also as `--flag=value`.
