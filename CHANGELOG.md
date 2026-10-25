# Changelog

## 0.3.0 (2026-10-25)

- `/limit-lens:fix` opens with what is eating your limit: the biggest lenses, the biggest projects, and plugin calls outside transcripts.
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

- `/limit-lens:fix`: lists the fixes that apply to you as settings, asks about each one, and applies only the chosen ones through the script, with a backup and a recorded experiment.
- `/limit-lens:fix compare`: spend per active day and per request, and lens shares, before and after the change; says when it is too early.
- `/limit-lens:fix revert`: restores only the keys an experiment changed, skipping keys changed since.
- CLI subcommands `plan`, `apply`, `compare`, `revert`; the report skill can only run flag-only commands, and `apply`/`revert` are never pre-approved.

## 0.1.0 (2026-10-25)

- `/limit-lens:report`: local report of API-equivalent spend by component, model, effort, source and entry point, with ranked findings and fixes checked against the Claude Code docs. Runs through the Bash tool with a permission rule pinned to the script.
- Lenses: re-reading context, subagents and workflow agents, effort, model mix, cache rewritten mid-session (pause, model switch, other), loops and automated turns, setup at startup, plugins that call the model (in and outside transcripts), fast mode.
- `security-guidance` log adapter, resolved the way the plugin resolves it, with coverage and project-scope notes.
- Responses deduplicated by `message.id`; fast line classification from the first bytes; untrusted values sanitized; malformed lines skipped one by one.
- `/limit-lens:model-routing`: guide for choosing Haiku, Sonnet or Opus and the effort level for delegated work.
- `--days`, `--project`, `--anonymize`, `--json`, `--config-dir`, also as `--flag=value`.
