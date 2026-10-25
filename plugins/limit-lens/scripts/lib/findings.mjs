// Turn a report into ranked findings. Every fix names a setting or command checked against the
// Claude Code docs (links in `docs`); keep it that way when adding fixes.
import { usd, pct, tokens, sumCost, topEntries, modelName } from './format.mjs';

const DOCS = 'https://code.claude.com/docs/en';
const MAX_FINDINGS = 6;

// Minimum share of total spend before a lens becomes a finding.
const THRESHOLDS = { reread: 0.25, agents: 0.2, effort: 0.3, opus: 0.6, rebuilds: 0.05, automation: 0.05, plugins: 0.01 };

const isOpus = (k) => k.startsWith('opus');

export function findings(r) {
  const total = r.totals.cost;
  if (!total) return [];
  const out = [];
  const share = (cost) => cost / total;

  // Re-reading the conversation on every request.
  const reread = r.components.cacheRead;
  if (share(reread) >= THRESHOLDS.reread) {
    const evidence = [`Cache reads are ${pct(reread, total)} of spend (${usd(reread)}): every request, including each tool call, re-sends the whole conversation.`];
    if (r.mainConversation.requests) {
      evidence.push(`Main conversations average ${tokens(r.context.avgPromptTokens)} tokens per request; ${r.context.requestsOver200k.toLocaleString('en-US')} requests were over 200K tokens.`);
    }
    out.push({
      id: 'reread',
      title: 'Re-reading long conversations',
      cost: reread,
      evidence,
      fixes: [
        'Run `/clear` between unrelated tasks (`/rename` first so you can `/resume` it later).',
        'Compact at natural breaks with `/compact`, or compact earlier automatically: `/autocompact 300k`, or `"autoCompactWindow": 300000` in settings.json.',
        'Send verbose work (test runs, logs, wide searches) to a subagent so only its summary lands in the main conversation.',
        'Use `/rewind` to drop a dead end instead of carrying it.',
      ],
      docs: [`${DOCS}/costs#reduce-token-usage`, `${DOCS}/model-config#set-the-auto-compact-window`],
    });
  }

  // Subagents and workflow agents.
  const sub = r.agents.subagent;
  const wf = r.agents.workflow;
  const agentsCost = sub.cost + wf.cost;
  if (share(agentsCost) >= THRESHOLDS.agents) {
    const evidence = [`Subagents ${pct(sub.cost, total)} and workflow agents ${pct(wf.cost, total)} of spend (${usd(agentsCost)}).`];
    for (const [name, lens] of [['subagents', sub], ['workflow agents', wf]]) {
      if (!lens.requests) continue;
      const perAgent = lens.agents ? ` over ${lens.agents.toLocaleString('en-US')} agents (~${Math.round(lens.requests / lens.agents)} requests each)` : '';
      evidence.push(`Your ${name} made ${lens.requests.toLocaleString('en-US')} requests${perAgent}, averaging ${tokens(lens.avgPromptTokens)} tokens of context per request.`);
    }
    const opusAgents = [sub.byModel, wf.byModel]
      .flatMap((m) => Object.entries(m))
      .filter(([k]) => isOpus(k))
      .reduce((s, [, b]) => s + b.cost, 0);
    if (opusAgents > 0) evidence.push(`Opus runs ${pct(opusAgents, agentsCost)} of agent spend.`);
    out.push({
      id: 'agents',
      title: 'Subagents and workflow agents',
      cost: agentsCost,
      evidence,
      fixes: [
        'Run agents on a smaller model: `"env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" }` in settings.json sets the default; add `"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"` to apply it to every subagent, teammate and workflow agent (Claude Code 2.1.257+).',
        'Give custom agents a `model:` and an `effort:` in their frontmatter.',
        'Keep agent tasks short and scoped: an agent that makes hundreds of tool calls re-reads its own growing context on every one.',
        'In workflows, give each agent the smallest model that can do its step (see `/limit-lens:model-routing`).',
      ],
      docs: [`${DOCS}/sub-agents#choose-a-model`],
    });
  }

  // Effort level.
  const highEffort = (r.byEffort.xhigh?.cost || 0) + (r.byEffort.max?.cost || 0);
  if (share(highEffort) >= THRESHOLDS.effort) {
    const evidence = [`${pct(highEffort, total)} of spend ran at xhigh or max effort (${topEntries(r.byEffort, total, 4)}).`];
    if (r.components.thinking > 0) evidence.push(`Thinking tokens alone were ${pct(r.components.thinking, total)} of spend; higher effort also means more tool calls.`);
    out.push({
      id: 'effort',
      title: 'High effort by default',
      cost: highEffort,
      evidence,
      fixes: [
        'Use `/effort high` or `/effort medium` for routine work (Opus, Sonnet and Haiku 5.5 default to medium).',
        'Save it per model in `modelSettings`, or set `"effortLevel": "high"` in settings.json (`max` cannot be saved in settings).',
        'Keep xhigh and max for hard problems; the docs warn that `max` can overthink.',
        'Set `effort:` in the frontmatter of skills and subagents that do repetitive work.',
      ],
      docs: [`${DOCS}/model-config#adjust-effort-level`],
    });
  }

  // Model mix.
  const opus = sumCost(Object.fromEntries(Object.entries(r.byModel).filter(([k]) => isOpus(k))));
  if (share(opus) >= THRESHOLDS.opus) {
    out.push({
      id: 'models',
      title: 'Most spend is on Opus',
      cost: opus,
      evidence: [`Opus models are ${pct(opus, total)} of spend.`],
      fixes: [
        'Start routine sessions with `/model sonnet`: Sonnet 5.5 lists at half the price of Opus 5.5. Choose at the start, since switching mid-session rebuilds the cache.',
        '`opusplan` plans on Opus and executes on Sonnet (each plan-mode toggle starts a fresh cache).',
        'Let Claude pick a model per task with the model-routing skill (`/limit-lens:model-routing`).',
      ],
      docs: [`${DOCS}/model-config`],
    });
  }

  // Cache rebuilds.
  const rb = r.cache.rebuilds;
  const rebuildCost = rb.afterIdle.cost + rb.modelSwitch.cost + rb.other.cost;
  if (share(rebuildCost) >= THRESHOLDS.rebuilds) {
    const evidence = [`${(rb.afterIdle.count + rb.modelSwitch.count + rb.other.count).toLocaleString('en-US')} requests rewrote most of their prompt into the cache (${usd(rebuildCost)}, ${pct(rebuildCost, total)}).`];
    if (rb.afterIdle.count) evidence.push(`${rb.afterIdle.count.toLocaleString('en-US')} came after a pause longer than the cache lifetime (${usd(rb.afterIdle.cost)}); ${rb.modelSwitch.count} after a model switch.`);
    out.push({
      id: 'rebuilds',
      title: 'Cache rebuilt after pauses',
      cost: rebuildCost,
      evidence,
      fixes: [
        'After a long break, `/compact` or start a fresh session instead of continuing a huge one: the first request after the cache expires rewrites the whole prompt at the cache-write price.',
        'Pick model and effort at the start of a session: `/model` mid-session rebuilds the cache (effort changes keep it on the 5.5 models).',
        'Avoid connecting or removing MCP servers and plugins mid-session.',
        'On an API key or usage credits the main conversation gets a 5-minute cache; `"promptCacheTtl": "1h"` keeps it through longer pauses.',
      ],
      docs: [`${DOCS}/prompt-caching`],
    });
  }

  // Automated turns and loops.
  const auto = r.turns.automated;
  const automationCost = auto.cost; // includes loop firings, which are reclassified as automated
  if (share(automationCost) >= THRESHOLDS.automation) {
    const evidence = [];
    if (auto.cost) {
      evidence.push(`Turns not started by you cost ${usd(auto.cost)} (${pct(auto.cost, total)}): ${topEntries(auto.byKind, total, 3)}, about ${usd(auto.cost / Math.max(auto.requests, 1))} per request.`);
    }
    if (r.loops.cost) evidence.push(`Repeated prompts (loops) ran ${r.loops.runs} times in ${r.loops.sessions} sessions for ${usd(r.loops.cost)}.`);
    out.push({
      id: 'automation',
      title: 'Loops and automated turns',
      cost: automationCost,
      evidence,
      fixes: [
        'Every automated turn (a loop firing, a background task reporting back, a message from another session) re-reads the whole conversation: keep them out of long sessions.',
        'Run loops in a short, dedicated session, on Sonnet or a lower effort; `/usage` (press `w`) lists your heaviest loops.',
        'Launch background work in fewer, larger batches so fewer notifications wake a big conversation.',
        'Hold messages from other sessions while idle with `"crossSessionInbound": "hold"`; turn off goal check-ins with `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`.',
      ],
      docs: [`${DOCS}/costs#why-usage-climbs-in-a-long-session`],
    });
  }

  // Plugins and tools that call the model.
  const toolCost = sumCost(r.toolSessions) + r.outside.cost;
  if (share(toolCost) >= THRESHOLDS.plugins) {
    const evidence = [`Sessions started by tools and plugin calls outside transcripts cost ${usd(toolCost)} (${pct(toolCost, total)}): ${topEntries(r.toolSessions, total, 3)}${r.outside.cost ? `, plus ${usd(r.outside.cost)} of plugin calls that never reach transcripts` : ''}.`];
    const fixes = ['Check which plugin or script starts these sessions and whether it lets you choose a cheaper model.'];
    if (r.toolSessions['security-guidance review'] || r.plugins.securityGuidance) {
      fixes.unshift('security-guidance: `SECURITY_REVIEW_MODEL=claude-sonnet-5-5` and `SG_AGENTIC_MODEL=claude-sonnet-5-5` move its reviews to Sonnet; `ENABLE_STOP_REVIEW=0` drops the review after every turn and keeps the commit and push reviews.');
    }
    out.push({ id: 'plugins', title: 'Plugins that call the model', cost: toolCost, evidence, fixes, docs: [`${DOCS}/plugins/overview`] });
  }

  // Fast mode.
  if (r.fastMode.cost > 0) {
    out.push({
      id: 'fast',
      title: 'Fast mode',
      cost: r.fastMode.cost,
      evidence: [`${r.fastMode.requests.toLocaleString('en-US')} requests ran in fast mode (${usd(r.fastMode.cost)}, ${pct(r.fastMode.cost, total)}).`],
      fixes: ['Fast mode bills Opus at twice the standard price: turn it off with `/fast` when you do not need the speed.'],
      docs: [`${DOCS}/fast-mode`],
    });
  }

  return out.sort((a, b) => b.cost - a.cost).slice(0, MAX_FINDINGS);
}
