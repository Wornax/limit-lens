# Changelog

## 0.3.0 (2026-10-25)

- `/limit-lens:fix` opens with what is eating your limit: the biggest lenses and the biggest projects.
- Each fix is labelled "cost only" or "changes how Claude works for you", with its effect, and names its biggest contributors: projects, agent types, large-context sessions or plugin reviews.
- Each fix estimates its weekly saving and says how; effort and auto-compaction say they cannot be estimated in advance and point to compare.
- Alternatives (the security-guidance per-turn review on Sonnet, or dropped) share one question, and `apply` refuses both together.
- Questions offer "Skip" first and "Show details" next.
- The report attributes spend by project (main conversation and agents, Opus, high effort, requests over 200K) and lists the sessions with the most requests over 200K.
- `plan --json` adds the diagnosis and the questions, with names from disk cleaned.

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
