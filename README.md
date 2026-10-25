# limit-lens

**See where your Claude Code usage limit goes, then fix it.**

limit-lens is a Claude Code plugin. Run `/limit-lens:report` and a small local script reads your session transcripts, works out what each request would cost at API list prices, and tells you which habits and settings eat your limit, with the exact fix for each. Finding out costs no tokens: the script does the math, and Claude only reads the short report.

It also ships `model-routing`, a skill that teaches Claude to pick Haiku, Sonnet or Opus (and an effort level) for each piece of delegated work.

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

Each finding lists fixes that use real settings and commands, checked against the [Claude Code docs](https://code.claude.com/docs/en/costs), with links. Claude offers to apply them one at a time and shows every settings change before making it.

## Install

```text
/plugin marketplace add Wornax/limit-lens
/plugin install limit-lens@limit-lens
```

Requires Node.js 18 or later on your `PATH`. No other dependencies.

## Use

| Command | What it does |
| :- | :- |
| `/limit-lens:report` | Report on the last 7 days |
| `/limit-lens:report --days 30` | Longer window (1 to 90 days; Claude Code deletes transcripts after `cleanupPeriodDays`, 30 days by default) |
| `/limit-lens:report --project api` | Only projects whose folder name contains `api` |
| `/limit-lens:report --anonymize` | Replace project folder names, so you can share the report |
| `/limit-lens:model-routing` | Load the model-routing guide (Claude also loads it on its own before delegating) |

Run the report in a fresh session: it adds about 1,500 tokens of context. You can also run the script directly, outside Claude Code:

```bash
node plugins/limit-lens/scripts/limit-lens.mjs --days 7
node plugins/limit-lens/scripts/limit-lens.mjs --json > usage.json
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
