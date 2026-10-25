// Render a report and its findings as compact Markdown. The output is injected into a
// conversation, so every line has to earn its tokens.
import { usd, pct, tokens, topEntries, modelName } from './format.mjs';

const ENTRYPOINT_NAMES = { cli: 'terminal', 'claude-desktop': 'desktop app', 'sdk-py': 'Python SDK', 'sdk-ts': 'TypeScript SDK' };

export function anonymizer(enabled) {
  const names = new Map();
  return (project) => {
    if (!enabled) return project.length > 40 ? `…${project.slice(-39)}` : project;
    if (!names.has(project)) names.set(project, `project-${names.size + 1}`);
    return names.get(project);
  };
}

export function renderMarkdown(r, found, { anonymize = false, searched = [] } = {}) {
  const name = anonymizer(anonymize);
  const total = r.totals.cost;
  const lines = [`# limit-lens: last ${r.window.days} day${r.window.days === 1 ? '' : 's'}`, ''];

  if (!r.totals.requests) {
    lines.push('No Claude Code usage found in this window.');
    if (searched.length) lines.push('', 'Looked in:', ...searched.map((d) => `- ${d}`));
    lines.push('', 'Try a longer window (`--days 30`) or point at another folder (`--config-dir`).');
    return lines.join('\n') + '\n';
  }

  lines.push(
    `API-equivalent spend **${usd(total)}** over ${r.totals.requests.toLocaleString('en-US')} requests in ${r.totals.sessions.toLocaleString('en-US')} sessions (list prices as of ${r.pricesAsOf}).`,
    'On a subscription this is not a bill: it shows how your usage limit was spent. Lenses overlap, so shares do not add up to 100%.',
    '',
    '## Where it goes',
    '',
    '| What | Share | Spend |',
    '| :- | -: | -: |',
  );
  const c = r.components;
  const rows = [
    ['Re-reading context (cache reads)', c.cacheRead],
    ['Writing context to the cache', c.cacheWrite5m + c.cacheWrite1h],
    [`Output (thinking ${pct(c.thinking, total)})`, c.output],
    ['Uncached input', c.input],
  ];
  for (const [label, cost] of rows) lines.push(`| ${label} | ${pct(cost, total)} | ${usd(cost)} |`);
  lines.push('');

  const sub = r.agents.subagent;
  const wf = r.agents.workflow;
  lines.push(
    `- **By model:** ${topEntries(r.byModel, total, 4, modelName)}`,
    `- **By effort:** ${topEntries(r.byEffort, total, 5)}`,
    `- **By source:** main conversation ${pct(r.mainConversation.cost, total)} (you ${pct(r.turns.human.cost, total)}, automated ${pct(r.turns.automated.cost, total)}), subagents ${pct(sub.cost, total)}, workflow agents ${pct(wf.cost, total)}`,
    `- **Started from:** ${topEntries(r.byEntrypoint, total, 4, (k) => ENTRYPOINT_NAMES[k] || k)}`,
  );
  if (r.outside.cost) lines.push(`- **Plugin calls outside transcripts:** ${usd(r.outside.cost)} (not in the total above)`);
  lines.push('');

  lines.push('## Findings', '');
  if (!found.length) lines.push('Nothing stands out: no lens crossed its threshold.', '');
  found.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.title} (${pct(f.cost, total)}, ${usd(f.cost)})`, '');
    for (const e of f.evidence) lines.push(`- ${e}`);
    lines.push('', 'Fixes:');
    f.fixes.forEach((x, j) => lines.push(`${j + 1}. ${x}`));
    lines.push(`Docs: ${f.docs.join(' · ')}`, '');
  });

  if (r.topSessions.length) {
    lines.push('## Costliest sessions', '', '| Project | Session | From | Spend | Requests | Avg context | Re-read |', '| :- | :- | :- | -: | -: | -: | -: |');
    for (const s of r.topSessions) {
      lines.push(
        `| ${name(s.project)} | ${s.sessionId.slice(0, 8)} | ${ENTRYPOINT_NAMES[s.entrypoint] || s.entrypoint} | ${usd(s.cost)} | ${s.requests.toLocaleString('en-US')} | ${tokens(s.avgPromptTokens)} | ${pct(s.rereadCost, s.cost)} |`,
      );
    }
    lines.push('', 'Spend per session counts its main conversation only, not its subagents.', '');
  }

  lines.push('## Not counted', '');
  lines.push('- Usage from other computers, claude.ai chat and Cowork (they share your plan limits).');
  lines.push('- Plugins and scripts that call the API without leaving a log limit-lens can read.');
  if (r.totals.estimatedCost > 0) lines.push(`- ${pct(r.totals.estimatedCost, total)} of spend is on models missing from the price table and was priced at a fallback.`);
  return lines.join('\n') + '\n';
}
