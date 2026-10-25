# Changelog

## 0.1.0 (2026-10-25)

- `/limit-lens:report`: local report of API-equivalent spend by component, model, effort, source and entry point, with ranked findings and fixes checked against the Claude Code docs. Runs through the Bash tool with a permission rule pinned to the script.
- Lenses: re-reading context, subagents and workflow agents, effort, model mix, cache rewritten mid-session (pause, model switch, other), loops and automated turns, setup at startup, plugins that call the model (in and outside transcripts), fast mode.
- `security-guidance` log adapter, resolved the way the plugin resolves it, with coverage and project-scope notes.
- Responses deduplicated by `message.id`; fast line classification from the first bytes; untrusted values sanitized; malformed lines skipped one by one.
- `/limit-lens:model-routing`: guide for choosing Haiku, Sonnet or Opus and the effort level for delegated work.
- `--days`, `--project`, `--anonymize`, `--json`, `--config-dir`, also as `--flag=value`.
