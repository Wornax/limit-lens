# Changelog

## 0.1.0 (2026-10-25)

- `/limit-lens:report`: local report of API-equivalent spend by component, model, effort, source and entry point, with ranked findings and fixes checked against the Claude Code docs.
- Lenses: re-reading context, subagents and workflow agents, effort, model mix, cache rebuilds after pauses and model switches, loops and automated turns, plugins that call the model, fast mode.
- `security-guidance` log adapter, including stop reviews that never reach transcripts.
- Responses deduplicated by `message.id`; fast line classification from the first bytes.
- `/limit-lens:model-routing`: guide for choosing Haiku, Sonnet or Opus and the effort level for delegated work.
- `--days`, `--project`, `--anonymize`, `--json`, `--config-dir`.
