// Turn a report into ranked findings. Every fix names a setting or command checked against the
// Claude Code docs (links in `docs`); keep it that way when adding fixes. Fixes that only make
// sense for some usage patterns are offered only when the evidence shows that pattern.
import { usd, pct, tokens, sumCost, topEntries } from './format.mjs';

const DOCS = 'https://code.claude.com/docs/en';

// Minimum share of total spend before a lens becomes a finding.
const THRESHOLDS = { reread: 0.25, agents: 0.2, effort: 0.3, opus: 0.6, rebuilds: 0.05, automation: 0.05, plugins: 0.01, startup: 0.03 };
// What counts as a long-running agent, and as a trivial one.
const LONG_AGENT = { requestsPerAgent: 50, avgPromptTokens: 100_000 };
const TRIVIAL_AGENT_REQUESTS = 10;

const isOpus = (k) => k.startsWith('opus');
const perAgent = (lens) => (lens.agents ? lens.requests / lens.agents : 0);

export function findings(r) {
  const total = r.totals.cost;
  if (!total) return [];
  const out = [];
  const share = (cost) => cost / total;
  const sub = r.agents.subagent;
  const wf = r.agents.workflow;
  const longAgents = [sub, wf].some((l) => perAgent(l) >= LONG_AGENT.requestsPerAgent && l.avgPromptTokens >= LONG_AGENT.avgPromptTokens);

  // Re-reading the conversation on every request.
  const reread = r.components.cacheRead;
  if (share(reread) >= THRESHOLDS.reread) {
    const evidence = [`Cache reads are ${pct(reread, total)} of spend (${usd(reread)}): every request, including each tool call, re-sends the whole conversation (main sessions and agents alike).`];
    if (r.mainConversation.requests) {
      evidence.push(`Main conversations average ${tokens(r.context.avgPromptTokens)} tokens per request; ${r.context.requestsOver200k.toLocaleString('en-US')} requests were over 200K tokens.`);
    }
    const fixes = ['Run `/clear` between unrelated tasks (`/rename` first so you can `/resume` it later).'];
    fixes.push(r.context.requestsOver200k > 0
      ? 'Compact at natural breaks with `/compact`, or compact earlier automatically: `/autocompact 300k`, or `"autoCompactWindow": 300000` in settings.json.'
      : 'Compact at natural breaks with `/compact`.');
    fixes.push('Send verbose work (test runs, logs, wide searches) to a subagent so only its summary lands in the main conversation.', 'Use `/rewind` to drop a dead end instead of carrying it.');
    out.push({ id: 'reread', title: 'Re-reading long conversations', cost: reread, evidence, fixes, docs: [`${DOCS}/costs#reduce-token-usage`, `${DOCS}/model-config#set-the-auto-compact-window`] });
  }

  // Subagents and workflow agents.
  const agentsCost = sub.cost + wf.cost;
  if (share(agentsCost) >= THRESHOLDS.agents) {
    const evidence = [`Subagents ${pct(sub.cost, total)} and workflow agents ${pct(wf.cost, total)} of spend (${usd(agentsCost)}).`];
    for (const [name, lens] of [['subagents', sub], ['workflow agents', wf]]) {
      if (!lens.requests) continue;
      const each = lens.agents ? ` over ${lens.agents.toLocaleString('en-US')} agents (~${Math.round(perAgent(lens))} requests each)` : '';
      evidence.push(`Your ${name} made ${lens.requests.toLocaleString('en-US')} requests${each}, averaging ${tokens(lens.avgPromptTokens)} tokens of context per request.`);
    }
    const opusAgents = [sub.byModel, wf.byModel].flatMap((m) => Object.entries(m)).filter(([k]) => isOpus(k)).reduce((s, [, b]) => s + b.cost, 0);
    if (opusAgents > 0) evidence.push(`Opus runs ${pct(opusAgents, agentsCost)} of agent spend.`);
    const fixes = [
      'Run agents on a smaller model: `"env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" }` in settings.json sets the model for agents that do not choose one themselves.',
      'Give custom agents a `model:` and an `effort:` in their frontmatter, and pick per task with `/limit-lens:model-routing`.',
      'The blunt option: `"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"` together with `CLAUDE_CODE_SUBAGENT_MODEL` puts every subagent, teammate and workflow agent on that model and ignores frontmatter and per-call choices (Claude Code 2.1.257+).',
    ];
    if (longAgents) {
      fixes.push(
        'Keep agent tasks bounded: an agent that makes hundreds of tool calls re-reads its own growing context on every one.',
        'Let long-running custom agents compact earlier: `autoCompactWindow: 200000` in their frontmatter (a plain integer, Claude Code 2.1.296+).',
      );
    }
    out.push({ id: 'agents', title: 'Subagents and workflow agents', cost: agentsCost, evidence, fixes, docs: [`${DOCS}/sub-agents#choose-a-model`] });
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
        'Use `/effort high` or `/effort medium` for routine work. Typed with a level, `/effort` saves it for the current model (under `modelSettings` in your user settings). Opus, Sonnet and Haiku 5.5 start at medium.',
        'To set one level for every model, put `"effortLevel": "high"` in project or local settings; in your user settings that key no longer applies to Opus 5.5 and newer models. `max` cannot be saved in settings.',
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

  // Cache rewritten mid-session.
  const rb = r.cache.rebuilds;
  const rebuildCost = rb.afterIdle.cost + rb.modelSwitch.cost + rb.other.cost;
  if (share(rebuildCost) >= THRESHOLDS.rebuilds) {
    const count = rb.afterIdle.count + rb.modelSwitch.count + rb.other.count;
    const causes = [
      rb.afterIdle.count && `${rb.afterIdle.count.toLocaleString('en-US')} after a pause longer than the cache lifetime (${usd(rb.afterIdle.cost)})`,
      rb.modelSwitch.count && `${rb.modelSwitch.count.toLocaleString('en-US')} after a model switch (${usd(rb.modelSwitch.cost)})`,
      rb.other.count && `${rb.other.count.toLocaleString('en-US')} with no pause or model switch (${usd(rb.other.cost)}): compaction, or a change at the start of the prompt such as new tools or a Claude Code upgrade`,
    ].filter(Boolean);
    const fixes = [];
    if (rb.afterIdle.count) fixes.push('Before stepping away from a large session, run `/compact` while the cache is still warm. After a long break, start fresh (`/clear`) instead of continuing or compacting a huge conversation: once the cache has expired, the next request, including the one `/compact` sends, reprocesses the whole conversation.');
    if (rb.modelSwitch.count) fixes.push('Pick model and effort at the start of a session: `/model` mid-session rebuilds the cache (effort changes keep it on the 5.5 models).');
    if (rb.other.count) fixes.push('If tool search is off on your setup, connect MCP servers at the start of a session: adding or removing one mid-session rebuilds the cache. With tool search on (the default) it does not, and plugin skills, commands, agents and hooks never do.');
    if (rb.afterIdle.count) fixes.push('On an API key or usage credits the main conversation gets a 5-minute cache; `"promptCacheTtl": "1h"` keeps it through longer pauses.');
    out.push({
      id: 'rebuilds',
      title: 'Cache rewritten mid-session',
      cost: rebuildCost,
      evidence: [`${count.toLocaleString('en-US')} requests rewrote most of their prompt into the cache instead of reading it (${usd(rebuildCost)}, ${pct(rebuildCost, total)}): ${causes.join('; ')}.`],
      fixes,
      docs: [`${DOCS}/prompt-caching`],
    });
  }

  // Automated turns and loops (loop firings are counted as automated).
  const auto = r.turns.automated;
  if (share(auto.cost) >= THRESHOLDS.automation) {
    const evidence = [`Turns not started by you cost ${usd(auto.cost)} (${pct(auto.cost, total)}): ${topEntries(auto.byKind, total, 3)}, about ${usd(auto.cost / Math.max(auto.requests, 1))} per request.`];
    if (r.loops.cost) evidence.push(`Repeated prompts (loops) ran ${r.loops.runs} times in ${r.loops.sessions} sessions for ${usd(r.loops.cost)}.`);
    out.push({
      id: 'automation',
      title: 'Loops and automated turns',
      cost: auto.cost,
      evidence,
      fixes: [
        'Every automated turn (a loop firing, a background task reporting back, a message from another session) re-reads the whole conversation: keep them out of long sessions.',
        'Run loops in a short, dedicated session, on Sonnet or a lower effort; `/usage` (press `w`) lists your heaviest loops.',
        'Launch background work in fewer, larger batches so fewer notifications wake a big conversation.',
        'If you do not rely on your sessions messaging each other, `"crossSessionInbound": "hold"` stops their messages from starting turns (they are shown as notices, not delivered). Turn off goal check-ins with `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`.',
      ],
      docs: [`${DOCS}/costs#why-usage-climbs-in-a-long-session`],
    });
  }

  // Plugins and tools that call the model. Spend outside transcripts is not in the total, so it is
  // shown in dollars only and never divided by the total.
  const inTotal = sumCost(r.toolSessions);
  const outside = r.outside.cost;
  if (share(inTotal) >= THRESHOLDS.plugins || outside > 0) {
    const evidence = [];
    if (inTotal) evidence.push(`Sessions started by tools through the Agent SDK cost ${usd(inTotal)} (${pct(inTotal, total)}): ${topEntries(r.toolSessions, total, 3)}.`);
    if (outside) evidence.push(`Plugin calls that never reach transcripts cost another ${usd(outside)}, not included in the total.`);
    const fixes = [];
    if (r.toolSessions['security-guidance review'] || r.plugins.securityGuidance) {
      fixes.push('security-guidance: `SECURITY_REVIEW_MODEL=claude-sonnet-5-5` and `SG_AGENTIC_MODEL=claude-sonnet-5-5` move its reviews to Sonnet; `ENABLE_STOP_REVIEW=0` drops the review after every turn and keeps the commit and push reviews.');
    }
    if (r.toolSessions['other SDK sessions']) {
      fixes.push('Other SDK sessions come from your own scripts or plugins built on the Agent SDK: give them a cheaper `model` in their SDK options.');
    }
    out.push({ id: 'plugins', title: 'Plugins that call the model', cost: inTotal, outsideCost: outside, evidence, fixes, docs: [`${DOCS}/plugins/overview`] });
  }

  // Setup written by every new session and agent.
  const st = r.startup;
  if (st && share(st.cost) >= THRESHOLDS.startup) {
    const kinds = [['sessions', st.byKind.main], ['subagents', st.byKind.subagent], ['workflow agents', st.byKind.workflow]]
      .filter(([, k]) => k.count)
      .map(([n, k]) => `${k.count.toLocaleString('en-US')} ${n}`)
      .join(', ');
    const fixes = [
      'Run `/context` to see what loads at startup; `/memory` opens the CLAUDE.md and memory files.',
      'Keep CLAUDE.md short (the docs suggest under 200 lines) and move instructions for specific workflows into skills, which load only when used.',
      'Disable MCP servers you are not using in `/mcp`, and remove plugins and skills you do not use.',
    ];
    const trivialAgents = [sub, wf].some((l) => l.agents && perAgent(l) < TRIVIAL_AGENT_REQUESTS);
    if (trivialAgents) fixes.push('Do not start an agent for a one-step job you could do inline: each new agent pays the setup again. The built-in Explore and Plan agents start without your CLAUDE.md files.');
    out.push({
      id: 'startup',
      title: 'Setup written by every new session and agent',
      cost: st.cost,
      evidence: [`${kinds} started in this window, each writing about ${tokens(st.avgTokens)} tokens of setup (system prompt, tools, CLAUDE.md, memory, skill descriptions) before doing any work: ${usd(st.cost)} (${pct(st.cost, total)}).`],
      fixes,
      docs: [`${DOCS}/costs#reduce-token-usage`, `${DOCS}/context-window`],
    });
  }

  // Fast mode.
  if (r.fastMode.cost > 0) {
    out.push({
      id: 'fast',
      title: 'Fast mode',
      cost: r.fastMode.cost,
      evidence: [
        `${r.fastMode.requests.toLocaleString('en-US')} requests ran in fast mode (${usd(r.fastMode.cost)}, ${pct(r.fastMode.cost, total)}).`,
        'On Pro, Max, Team and Enterprise plans fast mode is paid from usage credits, not your plan limit, even while plan usage remains.',
      ],
      fixes: [
        'Fast mode bills Opus 5.5, Opus 5 and Opus 4.8 at twice the standard price: turn it off with `/fast` when you do not need the speed.',
        'If you use it, turn it on at the start of a session: the first time it is turned on in a conversation, the whole context is billed once at the uncached fast-mode input price.',
      ],
      docs: [`${DOCS}/fast-mode`],
    });
  }

  return out.sort((a, b) => b.cost - a.cost); // ranked by spend inside the total only
}
