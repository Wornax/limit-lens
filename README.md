# limit-lens

**See where your Claude Code usage limit goes, then fix it.**

limit-lens is a Claude Code plugin with one command, `/limit-lens:analyze`:

1. **Report.** A small local script reads your session transcripts, works out what each request would cost at API list prices, and shows what eats your limit: models, effort, agents, re-read context, loops, plugins, and the biggest projects. Finding out costs few tokens: the script does the math, and Claude only reads the short result.
2. **Model routing.** Claude asks whether to turn on `model-routing`, a skill shipped with the plugin that has Claude pick Haiku, Sonnet or Opus (and an effort level) for each agent it starts.
3. **Fixes.** Claude asks about each settings fix that would help you, one question at a time, and applies only the ones you choose, with a backup.
4. **Other suggestions.** The habits and commands only you can adopt.

A few days later, `/limit-lens:analyze compare` shows your usage before and after, and `/limit-lens:analyze revert` undoes the change.

## What you get

An example report (numbers are illustrative):

```text
# limit-lens: last 7 days

API-equivalent spend $1,240 over 18,400 requests in 46 sessions (list prices as of 2026-10-25).

| What                              | Share | Spend |
| Re-reading context (cache reads)  |   61% |  $756 |
| Writing context to the cache      |   27% |  $335 |
| Output (thinking 5%)              |   12% |  $149 |

- By model: Opus 5.5 74%, Sonnet 5.5 26%
- By effort: xhigh 51%, medium 30%, high 19%
- By source: main conversation 31% (you 22%, automated 9%), subagents 44%, workflow agents 25%

### 1. Subagents and workflow agents (69%, $856)
- Your subagents made 7,900 requests over 61 agents (~130 requests each), averaging 310K tokens of context per request.
Fixes:
1. Run agents on a smaller model: "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" } ...
```

Each finding lists fixes that use real settings and commands, checked against the [Claude Code docs](https://code.claude.com/docs/en/costs), with links.

## Analyze, fix, then measure

`/limit-lens:analyze` turns the report into changes you approve one by one:

1. It opens with what is eating your limit: where the spend goes, the biggest projects, and the findings with their numbers.
2. Then it asks about the fixes that apply to you. The first is usually model routing: a three-line block in your `CLAUDE.md` (`<config dir>/CLAUDE.md`, the instructions Claude Code loads in every session) that makes Claude read the `model-routing` guide before it starts a subagent or workflow agent. The rest are settings. Each fix shows:
   - what it is, in plain words, for someone who has never heard of it;
   - whether it is "cost only" or "changes how Claude works for you", and how;
   - the change (the setting with its current and new value, or the line added to `CLAUDE.md`), and why;
   - the projects, agent types, sessions or plugin reviews behind it, when the transcripts can tell;
   - the weekly saving it estimates at list prices, and how. The estimates assume one fix at a time and do not add up. Effort and auto-compaction say they cannot be estimated in advance; compare measures them.

   A fix is offered only when your usage shows the problem and the change would take effect: not when your user settings or environment already have that value, outrank it, or switch the feature off. Project and managed settings files also outrank the user file, and the plan does not read them.
3. Claude asks one question per fix, with "Skip" first and "Show details" next. Alternatives, such as running the security-guidance per-turn review on Sonnet or dropping it, share one question, and the script refuses both together.
4. The script, not Claude, writes the chosen changes into your user `settings.json` and `CLAUDE.md`, after backing them up. The apply command also goes through Claude Code's own permission prompt, so you approve twice. In auto mode the classifier may approve that command without asking; the question in the conversation is then your only check.
5. It ends with the other suggestions: habits such as `/clear` and `/compact`, and changes to your own agents and skills. Slash commands are yours to type.
6. After a few days of normal use, `/limit-lens:analyze compare` shows spend per active day and per request, and the share of each lens, before and after. `/limit-lens:analyze revert` puts back only what it changed: the settings keys, and the routing block in `CLAUDE.md`. It leaves alone anything you changed since.

What it can change: the routing block in `CLAUDE.md`; in `settings.json`, `env.CLAUDE_CODE_SUBAGENT_MODEL`, per-model `effortLevel` under `modelSettings`, `autoCompactWindow`, `crossSessionInbound`, `fastMode`, `model`, and the security-guidance plugin's model variables. Records and backups live in `<config dir>/limit-lens/`.

## Install

```text
/plugin marketplace add Wornax/limit-lens
/plugin install limit-lens@limit-lens
```

Requires Node.js 18 or later on your `PATH`. No other dependencies.

## Use

| Command | What it does |
| :- | :- |
| `/limit-lens:analyze` | Report on the last 7 days, then ask about model routing and each fix, and apply the ones you choose |
| `/limit-lens:analyze compare` | Compare usage before and after the last change |
| `/limit-lens:analyze revert` | Undo the last change |
| `/limit-lens:report` | Report only, nothing asked or changed |
| `/limit-lens:report --days 30` | Longer window (1 to 90 days; Claude Code deletes transcripts after `cleanupPeriodDays`, 30 days by default) |
| `/limit-lens:report --project api` | Only projects whose folder name contains `api` |
| `/limit-lens:report --anonymize` | Replace project folder names, so you can share the report |
| `/limit-lens:model-routing` | Load the model-routing guide (Claude also loads it on its own before delegating) |

Claude runs `/limit-lens:analyze` on its own when you ask why you keep hitting your limit; `/limit-lens:report` runs only when you type it. Run either in a fresh session: the analysis adds a few thousand tokens of context. You can also run the script directly, outside Claude Code:

```bash
node plugins/limit-lens/scripts/limit-lens.mjs --days 7
node plugins/limit-lens/scripts/limit-lens.mjs --json > usage.json
node plugins/limit-lens/scripts/limit-lens.mjs analyze
node plugins/limit-lens/scripts/limit-lens.mjs apply model-routing-rule subagent-model-sonnet
node plugins/limit-lens/scripts/limit-lens.mjs compare
```

## What it measures

| Lens | Why it matters |
| :- | :- |
| Re-reading context | Every request, including each tool call, re-sends the whole conversation. Cache reads are cheap per token, but at 500K tokens of context they dominate. |
| Subagents and workflow agents | Each agent has its own context and cache; long-running agents re-read their own growing context hundreds of times. |
| Effort | `xhigh` and `max` think longer and make more tool calls. |
| Models | Sonnet 5.5 lists at half the price of Opus 5.5. |
| Cache rebuilds | After a pause longer than the cache lifetime, or a model switch, the next request rewrites the whole prompt at the cache-write price. |
| Loops and automated turns | Loop firings, background-task notifications and messages from other sessions each re-read the conversation. |
| Setup at startup | Every new session and agent first writes its setup (system prompt, tools, CLAUDE.md, memory, skill descriptions) before doing any work. |
| Plugins that call the model | Sessions started by tools through the Agent SDK, plus plugin calls that never reach transcripts (read from the `security-guidance` log). |
| Fast mode | Fast mode bills Opus at twice the standard price; on a subscription it is paid from usage credits, not your plan limit. |

Lenses overlap: a subagent's cache reads count under both "Re-reading context" and "Subagents".

## How it works

- Reads `projects/**/*.jsonl` under `CLAUDE_CONFIG_DIR`, `~/.claude` and `~/.config/claude`, including subagent and workflow agent transcripts.
- **Counts each API response once.** Claude Code writes one transcript line per content block (thinking, text, tool call), each carrying the full usage of the response, the same `message.id` and a different `uuid`. Deduplicating by `(requestId, uuid)` counts a response once per block, about twice on real data; limit-lens deduplicates by `message.id`.
- Skips the lines it never needs (tool results, request blobs) from their first bytes without decoding them, so a heavy week of transcripts (several GB) takes well under a minute.
- Prices each response with the [API list prices](https://platform.claude.com/docs/en/about-claude/pricing) (cache writes by TTL, cache reads, thinking, fast mode, US-only inference, Haiku 5.5's long-prompt tier). The table's date is printed on every report.

## Privacy

- No network calls. Everything stays on your machine.
- It writes only what you approve, through the script: keys in your user `settings.json` and the routing block in your user `CLAUDE.md`, each backed up first.
- The report contains numbers, project folder names and short session ids (`--json` prints full session ids). It never contains prompt, response or tool output text. `--anonymize` replaces folder names with `project-1`, `project-2`, and so on, and hides custom agent names and searched paths.
- Names read from disk are reduced to plain characters before they reach the report, so a hostile file or folder name cannot inject text into the conversation.

## Limits

- The spend is **API-equivalent**: on a Pro, Max, Team or Enterprise plan it is not a bill, it shows how your usage limit was spent. Anthropic does not publish plan limits in tokens.
- It cannot see usage from other computers, claude.ai chat or Cowork, which share your plan limits, nor plugins and scripts that call the API without leaving a log it can read.
- The transcript format is not a public API and may change between Claude Code versions.

## Contributing

- **A plugin that calls the model?** Add its log reader under `plugins/limit-lens/scripts/lib/plugins/`, or its first-prompt signature to `signatures.mjs`, with a test.
- **Prices changed?** Update `PRICES` and `PRICES_AS_OF` in `pricing.mjs`; the tests carry worked examples from the pricing page.
- Run the tests with `npm test`. Tests use synthetic transcripts only: never commit real ones.

## License

MIT
