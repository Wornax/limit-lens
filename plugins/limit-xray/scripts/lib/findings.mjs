// Turn a report into ranked findings. Every fix names a setting or command checked against the
// Claude Code docs (links in `docs`); keep it that way when adding fixes. Fixes that only make
// sense for some usage patterns are offered only when the evidence shows that pattern.
// Texts come from the language catalogs (i18n/), in the language given.
import { sumCost, topEntries } from './format.mjs';
import { locale, lookup } from './i18n/index.mjs';

const DOCS = 'https://code.claude.com/docs/en';

// Minimum share of total spend before a lens becomes a finding.
const THRESHOLDS = { reread: 0.25, agents: 0.2, effort: 0.3, opus: 0.6, rebuilds: 0.05, automation: 0.05, plugins: 0.01, startup: 0.03 };
// What counts as a long-running agent, and as a trivial one.
const LONG_AGENT = { requestsPerAgent: 50, avgPromptTokens: 100_000 };
const TRIVIAL_AGENT_REQUESTS = 10;

const isOpus = (k) => k.startsWith('opus');
const perAgent = (lens) => (lens.agents ? lens.requests / lens.agents : 0);

export function findings(r, { lang = 'en' } = {}) {
  const total = r.totals.cost;
  if (!total) return [];
  const { t, usd, pct, tokens, num } = locale(lang);
  const T = t.findings;
  const out = [];
  const share = (cost) => cost / total;
  const top = (map, n, label) => topEntries(map, total, n, label, pct);
  const sub = r.agents.subagent;
  const wf = r.agents.workflow;
  const longAgents = [sub, wf].some((l) => perAgent(l) >= LONG_AGENT.requestsPerAgent && l.avgPromptTokens >= LONG_AGENT.avgPromptTokens);

  // Re-reading the conversation on every request.
  const reread = r.components.cacheRead;
  if (share(reread) >= THRESHOLDS.reread) {
    const evidence = [T.reread.evidence({ share: pct(reread, total), cost: usd(reread) })];
    if (r.mainConversation.requests) {
      evidence.push(T.reread.context({ avg: tokens(r.context.avgPromptTokens), over: num(r.context.requestsOver200k) }));
    }
    const fixes = [T.reread.clear, T.reread.compact];
    if (r.context.requestsOver300k > 0) fixes.push(T.reread.autocompact);
    fixes.push(T.reread.subagent, T.reread.rewind);
    out.push({ id: 'reread', title: T.reread.title, cost: reread, evidence, fixes, docs: [`${DOCS}/costs#reduce-token-usage`, `${DOCS}/model-config#set-the-auto-compact-window`] });
  }

  // Subagents and workflow agents.
  const agentsCost = sub.cost + wf.cost;
  if (share(agentsCost) >= THRESHOLDS.agents) {
    const evidence = [T.agents.evidence({ sub: pct(sub.cost, total), wf: pct(wf.cost, total), cost: usd(agentsCost) })];
    for (const [kind, lens] of [['subagent', sub], ['workflow', wf]]) {
      if (!lens.requests) continue;
      evidence.push(T.agents.lens({
        name: t.names.agentLenses[kind],
        requests: num(lens.requests),
        agents: lens.agents ? num(lens.agents) : 0,
        each: num(Math.round(perAgent(lens))),
        avg: tokens(lens.avgPromptTokens),
      }));
    }
    const opusAgents = [sub.byModel, wf.byModel].flatMap((m) => Object.entries(m)).filter(([k]) => isOpus(k)).reduce((s, [, b]) => s + b.cost, 0);
    if (opusAgents > 0) evidence.push(T.agents.opus({ share: pct(opusAgents, agentsCost) }));
    const fixes = [T.agents.sonnet, T.agents.frontmatter, T.agents.force];
    if (longAgents) fixes.push(T.agents.bounded, T.agents.compactEarlier);
    out.push({ id: 'agents', title: T.agents.title, cost: agentsCost, evidence, fixes, docs: [`${DOCS}/sub-agents#choose-a-model`] });
  }

  // Effort level.
  const highEffort = (r.byEffort.xhigh?.cost || 0) + (r.byEffort.max?.cost || 0);
  if (share(highEffort) >= THRESHOLDS.effort) {
    const evidence = [T.effort.evidence({ share: pct(highEffort, total), levels: top(r.byEffort, 4) })];
    if (r.components.thinking > 0) evidence.push(T.effort.thinking({ share: pct(r.components.thinking, total) }));
    out.push({
      id: 'effort',
      title: T.effort.title,
      cost: highEffort,
      evidence,
      fixes: [T.effort.high, T.effort.everyModel, T.effort.hard, T.effort.frontmatter],
      docs: [`${DOCS}/model-config#adjust-effort-level`],
    });
  }

  // Model mix.
  const opus = sumCost(Object.fromEntries(Object.entries(r.byModel).filter(([k]) => isOpus(k))));
  if (share(opus) >= THRESHOLDS.opus) {
    out.push({
      id: 'models',
      title: T.models.title,
      cost: opus,
      evidence: [T.models.evidence({ share: pct(opus, total) })],
      fixes: [T.models.sonnet, T.models.opusplan, T.models.routing],
      docs: [`${DOCS}/model-config`],
    });
  }

  // Cache rewritten mid-session.
  const rb = r.cache.rebuilds;
  const rebuildCost = rb.afterIdle.cost + rb.modelSwitch.cost + rb.other.cost;
  if (share(rebuildCost) >= THRESHOLDS.rebuilds) {
    const count = rb.afterIdle.count + rb.modelSwitch.count + rb.other.count;
    const cause = (text, b) => b.count && text({ count: num(b.count), cost: usd(b.cost) });
    const causes = [cause(T.rebuilds.afterIdle, rb.afterIdle), cause(T.rebuilds.modelSwitch, rb.modelSwitch), cause(T.rebuilds.other, rb.other)].filter(Boolean);
    const fixes = [];
    if (rb.afterIdle.count) fixes.push(T.rebuilds.compact);
    if (rb.modelSwitch.count) fixes.push(T.rebuilds.model);
    if (rb.other.count) fixes.push(T.rebuilds.mcp);
    if (rb.afterIdle.count) fixes.push(T.rebuilds.ttl);
    out.push({
      id: 'rebuilds',
      title: T.rebuilds.title,
      cost: rebuildCost,
      evidence: [T.rebuilds.evidence({ count: num(count), cost: usd(rebuildCost), share: pct(rebuildCost, total), causes: causes.join('; ') })],
      fixes,
      docs: [`${DOCS}/prompt-caching`],
    });
  }

  // Automated turns and loops (loop firings are counted as automated).
  const auto = r.turns.automated;
  if (share(auto.cost) >= THRESHOLDS.automation) {
    const evidence = [T.automation.evidence({ cost: usd(auto.cost), share: pct(auto.cost, total), kinds: top(auto.byKind, 3), perRequest: usd(auto.cost / Math.max(auto.requests, 1)) })];
    if (r.loops.cost) evidence.push(T.automation.loops({ runs: num(r.loops.runs), sessions: num(r.loops.sessions), cost: usd(r.loops.cost) }));
    out.push({
      id: 'automation',
      title: T.automation.title,
      cost: auto.cost,
      evidence,
      fixes: [T.automation.rereads, T.automation.dedicated, T.automation.batches, T.automation.hold, T.automation.goal],
      docs: [`${DOCS}/costs#why-usage-climbs-in-a-long-session`],
    });
  }

  // Plugins and tools that call the model. Spend outside transcripts is not in the total, so it is
  // shown in dollars only and never divided by the total.
  const inTotal = sumCost(r.toolSessions);
  const outside = r.outside.cost;
  if (share(inTotal) >= THRESHOLDS.plugins || outside > 0) {
    const evidence = [];
    if (inTotal) evidence.push(T.plugins.inTotal({ cost: usd(inTotal), share: pct(inTotal, total), top: top(r.toolSessions, 3, (k) => lookup(t.names.toolSessions, k)) }));
    if (outside) evidence.push(T.plugins.outside({ cost: usd(outside) }));
    const fixes = [];
    if (r.toolSessions['security-guidance review'] || r.plugins.securityGuidance) fixes.push(T.plugins.securityGuidance);
    if (r.toolSessions['other SDK sessions']) fixes.push(T.plugins.otherSdk);
    out.push({ id: 'plugins', title: T.plugins.title, cost: inTotal, outsideCost: outside, evidence, fixes, docs: [`${DOCS}/plugins/overview`] });
  }

  // Setup written by every new session and agent.
  const st = r.startup;
  if (st && share(st.cost) >= THRESHOLDS.startup) {
    const kinds = ['main', 'subagent', 'workflow']
      .filter((k) => st.byKind[k].count)
      .map((k) => T.startup.kind({ count: num(st.byKind[k].count), name: t.names.startupKinds[k] }))
      .join(', ');
    const fixes = [T.startup.context, T.startup.short, T.startup.mcp];
    const trivialAgents = [sub, wf].some((l) => l.agents && perAgent(l) < TRIVIAL_AGENT_REQUESTS);
    if (trivialAgents) fixes.push(T.startup.inline);
    out.push({
      id: 'startup',
      title: T.startup.title,
      cost: st.cost,
      evidence: [T.startup.evidence({ kinds, avg: tokens(st.avgTokens), cost: usd(st.cost), share: pct(st.cost, total) })],
      fixes,
      docs: [`${DOCS}/costs#reduce-token-usage`, `${DOCS}/context-window`],
    });
  }

  // Fast mode.
  if (r.fastMode.cost > 0) {
    out.push({
      id: 'fast',
      title: T.fast.title,
      cost: r.fastMode.cost,
      evidence: [T.fast.evidence({ requests: num(r.fastMode.requests), cost: usd(r.fastMode.cost), share: pct(r.fastMode.cost, total) }), T.fast.credits],
      fixes: [T.fast.off, T.fast.start],
      docs: [`${DOCS}/fast-mode`],
    });
  }

  return out.sort((a, b) => b.cost - a.cost); // ranked by spend inside the total only
}
