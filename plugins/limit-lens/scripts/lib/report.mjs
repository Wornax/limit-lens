// Render a report and its findings as compact Markdown. The output is injected into a
// conversation, so every line has to earn its tokens.
import { usd, pct, tokens, topEntries, modelName } from './format.mjs';

const MAX_SHOWN = 6;
const ENTRYPOINT_NAMES = Object.assign(Object.create(null), { cli: 'terminal', 'claude-desktop': 'desktop app', 'sdk-py': 'Python SDK', 'sdk-ts': 'TypeScript SDK' });
const entrypointName = (k) => ENTRYPOINT_NAMES[k] || clean(k);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Folder and file names come from disk and can contain anything (Linux allows newlines):
// keep only characters that cannot change the Markdown around them.
export const clean = (s) => String(s).replace(/[^\w.@+-]/g, '_');

export function anonymizer(enabled, { shorten = false } = {}) {
  const names = new Map();
  return (project) => {
    if (enabled) {
      if (!names.has(project)) names.set(project, `project-${names.size + 1}`);
      return names.get(project);
    }
    return shorten && project.length > 40 ? `...${project.slice(-37)}` : project;
  };
}

// Session ids are UUIDs; anything else is a file name, hidden under --anonymize.
export const sessionLabel = (id, i, anonymize) => (UUID.test(id) || !anonymize ? clean(String(id).slice(0, 8)) : `session-${i + 1}`);

const NOTES = {
  'plugin-log-unscoped': 'The security-guidance log is not split by project, so its spend is left out of a `--project` report.',
  'plugin-log-partial': 'The security-guidance log rotates at 1 MB and does not reach back to the start of this window, so some plugin spend is missing.',
  'unreadable-transcript': 'Some transcript files could not be read and were skipped.',
  'malformed-line': 'Some transcript lines had unexpected fields and were skipped.',
};

const show = (v) => (v === undefined || v === null ? '(not set)' : `\`${JSON.stringify(v)}\``);

const GROUP_TITLES = { 'security-turn-review': 'security-guidance: the review after every turn' };
const CONTRIBUTOR_TITLES = { project: 'Biggest projects', 'agent type': 'Biggest agent types', session: 'Largest sessions', review: 'Reviews' };
// Project, agent type and session names come from disk and are cleaned; review names are limit-lens's own.
// Session contributors are "project/session"; a folder name cannot contain "/", so each part is cleaned.
export const contributorName = (c) => (c.kind === 'review' ? c.name : String(c.name).split('/').map(clean).join('/'));

// What is eating the limit: the biggest lenses and the biggest projects, before any question is asked.
export function diagnosis(r, found) {
  const total = r.totals.cost;
  return {
    spend: total,
    outside: r.outside?.cost || 0,
    days: r.window.days,
    lenses: found.slice(0, 3).map((f) => ({ title: f.title, share: total ? f.cost / total : 0, cost: f.cost })),
    projects: Object.entries(r.byProject || {})
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, 3)
      .map(([name, b]) => ({ name: clean(name), share: total ? b.cost / total : 0, cost: b.cost })),
  };
}

// Fixes grouped into questions: alternatives (same `group`) share one question.
export function questions(fixes) {
  const out = [];
  const byGroup = new Map();
  for (const f of fixes) {
    if (f.group && byGroup.has(f.group)) {
      byGroup.get(f.group).options.push(f);
      continue;
    }
    const q = { group: f.group || null, title: f.group ? GROUP_TITLES[f.group] || f.title : f.title, options: [f] };
    if (f.group) byGroup.set(f.group, q);
    out.push(q);
  }
  return out;
}

function fixLines(f, indent) {
  const pad = ' '.repeat(indent);
  const lines = [
    `${pad}- ${f.kind === 'cost-only' ? 'Cost only' : 'Changes how Claude works for you'}: ${f.effect}`,
    `${pad}- Change: \`${f.path.join('.')}\` ${show(f.current)} -> ${show(f.value)}`,
    `${pad}- Why: ${f.why}`,
  ];
  const kinds = [...new Set((f.contributors || []).map((c) => c.kind))];
  for (const k of kinds) {
    const items = f.contributors.filter((c) => c.kind === k).map((c) => `${contributorName(c)} (${usd(c.cost)}${c.detail ? `, ${c.detail}` : ''})`);
    lines.push(`${pad}- ${CONTRIBUTOR_TITLES[k] || k}: ${items.join('; ')}`);
  }
  lines.push(
    f.savings?.weekly == null
      ? `${pad}- Estimated savings: ${f.savings?.basis || 'not estimated.'}`
      : `${pad}- Estimated savings: about ${usd(f.savings.weekly)} per week (API-equivalent). How: ${f.savings.basis}`,
    `${pad}- Source: ${f.docs}`,
  );
  return lines;
}

// The fix plan the `fix` skill walks through with the user: the diagnosis first, then one question
// per fix or per group of alternatives.
export function renderPlan({ report, found = [], fixes, habits, settingsFile, last, undo, warning }) {
  const lines = ['# limit-lens: fixes you can apply', ''];
  if (report) {
    const d = diagnosis(report, found);
    lines.push(
      '## What is eating your limit',
      '',
      `API-equivalent spend ${usd(d.spend)} in the last ${d.days} days${d.outside ? `, plus ${usd(d.outside)} of plugin calls outside transcripts` : ''} (list prices; on a subscription, read dollars as a share of your limit).`,
      '',
    );
    for (const l of d.lenses) lines.push(`- ${l.title}: ${pct(l.cost, d.spend)} (${usd(l.cost)})`);
    if (d.projects.length) lines.push(`- Biggest projects: ${d.projects.map((p) => `${p.name} ${pct(p.cost, d.spend)}`).join(', ')}`);
    if (d.lenses.length > 1) lines.push('', 'These overlap: one request can count under several headings.');
    lines.push('');
  }
  lines.push(`Settings file: \`${settingsFile}\` (backed up before any change; new settings apply to new sessions).`, '');
  if (!fixes.length) lines.push('No settings fix applies right now: either nothing crossed its threshold, or your settings already have these values.', '');
  questions(fixes).forEach((q, i) => {
    lines.push(`### Question ${i + 1}: ${q.title}`, '');
    if (q.options.length === 1) {
      lines.push(...fixLines(q.options[0], 0), `Options: \`${q.options[0].id}\``, '');
    } else {
      for (const f of q.options) lines.push(`- \`${f.id}\`: ${f.title}`, ...fixLines(f, 2));
      lines.push(`Options: ${q.options.map((f) => `\`${f.id}\``).join(' or ')} (alternatives: choose at most one)`, '');
    }
  });
  if (fixes.filter((f) => f.savings?.weekly != null).length > 1) {
    lines.push('Each estimate assumes that fix alone; fixes can save on the same requests, so the estimates do not add up.', '');
  }
  if (habits.length) lines.push('', '## Habits (only the user can do these)', '', ...habits.map((h) => `- ${h}`));
  if (last) {
    const fixesList = last.changes.map((c) => `\`${c.fixId}\``).join(', ');
    lines.push('', '## Last experiment', '', `- \`${last.id}\`, applied ${last.appliedAt.slice(0, 16).replace('T', ' ')} UTC: ${fixesList}${last.revertedAt ? ' (reverted)' : ''}. Compare it after a few days of normal use.`);
  }
  if (undo) {
    lines.push('', `## Revert would restore (experiment \`${undo.id}\`)`, '');
    for (const c of undo.changes) lines.push(`- \`${c.path.join('.')}\` -> ${c.hadKey ? show(c.restore) : '(removed)'}`);
    lines.push('', `To undo exactly this, run revert with \`--experiment ${undo.id}\`.`);
  }
  if (warning) lines.push('', `Warning: ${warning}`);
  return lines.join('\n') + '\n';
}

function historyNote(r) {
  const since = r.window.oldestData ? r.window.oldestData.slice(0, 10) : 'later';
  return `Your transcripts on this computer start on ${since}. Claude Code deletes transcripts after \`cleanupPeriodDays\` (30 days by default), so a window longer than that cannot be filled; raise it in settings.json to keep more history.`;
}

export function renderMarkdown(r, found, { anonymize = false, searched = [] } = {}) {
  const name = anonymizer(anonymize, { shorten: true });
  const total = r.totals.cost;
  const lines = [`# limit-lens: last ${r.window.days} day${r.window.days === 1 ? '' : 's'}`, ''];
  // The filter text is usually part of a real folder name, so --anonymize hides it too.
  const filterText = r.filter ? (anonymize ? 'the filter text (hidden by `--anonymize`)' : `\`${clean(r.filter.project)}\``) : null;
  if (filterText) lines.push(`Only projects whose folder name contains ${filterText}.`, '');

  if (!r.totals.requests) {
    if (r.filter && !r.filter.matchingFolders) {
      lines.push(`No project folder name contains ${filterText}. Folder names are encoded paths (for example \`C--Users-me-repo\` or \`-home-me-repo\`): try a shorter part of the repository name.`);
      return lines.join('\n') + '\n';
    }
    lines.push(r.filter ? 'No Claude Code usage found in this window for the matching projects.' : 'No Claude Code usage found in this window.');
    if (searched.length && anonymize) lines.push('', 'Looked in the Claude config folders (paths hidden by `--anonymize`).');
    else if (searched.length) {
      // JSON.stringify escapes newlines and control characters, so a path cannot leave its code span.
      lines.push('', 'Looked in:', ...searched.map((d) => `- \`${JSON.stringify(String(d)).slice(0, 200).replace(/`/g, '')}\``));
    }
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
    `- **Started from:** ${topEntries(r.byEntrypoint, total, 4, entrypointName)}`,
  );
  if (r.outside.cost) lines.push(`- **Plugin calls outside transcripts:** ${usd(r.outside.cost)} (not in the total above)`);
  lines.push('');

  const heading = (f) => {
    const inside = f.cost ? `${pct(f.cost, total)}, ${usd(f.cost)}` : '';
    const outside = f.outsideCost ? `${usd(f.outsideCost)} outside the total` : '';
    return [inside, outside].filter(Boolean).join(', plus ');
  };
  lines.push('## Findings', '');
  if (!found.length) lines.push('Nothing stands out: no lens crossed its threshold.', '');
  found.slice(0, MAX_SHOWN).forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.title} (${heading(f)})`, '');
    for (const e of f.evidence) lines.push(`- ${e}`);
    if (f.fixes.length) {
      lines.push('', 'Fixes:');
      f.fixes.forEach((x, j) => lines.push(`${j + 1}. ${x}`));
    }
    lines.push(`Docs: ${f.docs.join(' · ')}`, '');
  });
  if (found.length > MAX_SHOWN) {
    const rest = found.slice(MAX_SHOWN).map((f) => `${f.title} (${heading(f)})`).join('; ');
    lines.push(`Also above its threshold: ${rest}.`, '');
  }

  if (r.topSessions.length) {
    lines.push('## Costliest sessions', '', '| Project | Session | From | Spend | Requests | Avg context | Re-read |', '| :- | :- | :- | -: | -: | -: | -: |');
    r.topSessions.forEach((s, i) => {
      lines.push(
        `| ${clean(name(s.project))} | ${sessionLabel(s.sessionId, i, anonymize)} | ${entrypointName(s.entrypoint)} | ${usd(s.cost)} | ${s.requests.toLocaleString('en-US')} | ${tokens(s.avgPromptTokens)} | ${pct(s.rereadCost, s.cost)} |`,
      );
    });
    lines.push('', 'Spend per session counts its main conversation only, not its subagents.', '');
  }

  lines.push('## Not counted', '');
  lines.push('- Usage from other computers, claude.ai chat and Cowork (they share your plan limits).');
  lines.push('- Plugins and scripts that call the API without leaving a log limit-lens can read.');
  if (r.totals.estimatedCost > 0) lines.push(`- ${pct(r.totals.estimatedCost, total)} of spend is on models missing from the price table, priced at the closest known model and marked with \`~\`.`);
  for (const n of r.notes || []) {
    if (n === 'history-shorter-than-window') lines.push(`- ${historyNote(r)}`);
    else if (NOTES[n]) lines.push(`- ${NOTES[n]}`);
  }
  return lines.join('\n') + '\n';
}
