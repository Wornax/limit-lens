// Render a report and its findings as compact Markdown. The output is injected into a
// conversation, so every line has to earn its tokens.
import { usd, pct, tokens, topEntries, modelName } from './format.mjs';
import { barBlock } from './charts.mjs';

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
    const q = { group: f.group || null, title: f.group ? GROUP_TITLES[f.group] || f.title : f.title, what: f.what, options: [f] };
    if (f.group) byGroup.set(f.group, q);
    out.push(q);
  }
  return out;
}

function fixLines(f, indent) {
  const pad = ' '.repeat(indent);
  const lines = [
    `${pad}- ${f.kind === 'cost-only' ? 'Cost only' : 'Changes how Claude works for you'}: ${f.effect}`,
    f.target === 'memory'
      ? `${pad}- Change: add to \`${f.file}\`: "${f.rule}"`
      : `${pad}- Change: \`${f.path.join('.')}\` ${show(f.current)} -> ${show(f.value)}`,
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

function diagnosisLines(report, found) {
  const lines = [];
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
  return lines;
}

function questionLines(fixes, settingsFile) {
  const lines = [`Settings file: \`${settingsFile}\` (backed up before any change; new settings apply to new sessions).`, ''];
  if (!fixes.length) lines.push('No fix applies right now: either nothing crossed its threshold, or your settings already have these values.', '');
  questions(fixes).forEach((q, i) => {
    lines.push(`### Question ${i + 1}: ${q.title}`, '');
    if (q.what) lines.push(`- What it is: ${q.what}`);
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
  return lines;
}

// One applied change, in a line.
export const describeChange = (c) => (c.kind === 'memory' ? 'the model-routing rule in `CLAUDE.md`' : `\`${c.path.join('.')}\` = \`${JSON.stringify(c.after)}\``);

const changesInEffect = (active) => active.reduce((s, e) => s + e.changes.length, 0);

function historyLines({ active = [], last, undo, warning }) {
  const lines = [];
  if (active.length) {
    lines.push('', '## Changes in effect', '');
    for (const e of active) lines.push(`- \`${e.id}\`, applied ${e.appliedAt.slice(0, 16).replace('T', ' ')} UTC: ${e.changes.map(describeChange).join('; ')}.`);
    lines.push('', 'Compare them after a few days of normal use with `/limit-lens:analyze compare`.');
  } else if (last) {
    const fixesList = last.changes.map((c) => `\`${c.fixId}\``).join(', ');
    lines.push('', '## Last experiment', '', `- \`${last.id}\`, applied ${last.appliedAt.slice(0, 16).replace('T', ' ')} UTC: ${fixesList}${last.revertedAt ? ' (reverted)' : ''}. Compare it after a few days of normal use.`);
  }
  if (undo) {
    lines.push('', `## Revert would restore (experiment \`${undo.id}\`)`, '');
    for (const c of undo.changes) {
      lines.push(c.kind === 'memory' ? `- \`${c.file}\`: the model-routing rule is removed` : `- \`${c.path.join('.')}\` -> ${c.hadKey ? show(c.restore) : '(removed)'}`);
    }
    lines.push('', `To undo exactly this, run revert with \`--experiment ${undo.id}\`.`);
  }
  if (warning) lines.push('', `Warning: ${warning}`);
  return lines;
}

// The fix plan: the diagnosis first, then one question per fix or per group of alternatives.
export function renderPlan({ report, found = [], fixes, habits, settingsFile, last, undo, active = [], warning }) {
  const lines = ['# limit-lens: fixes you can apply', ''];
  if (report) lines.push(...diagnosisLines(report, found));
  lines.push(...questionLines(fixes, settingsFile));
  if (habits.length) lines.push('', '## Habits (only the user can do these)', '', ...habits.map((h) => `- ${h}`));
  lines.push(...historyLines({ active, last, undo, warning }));
  return lines.join('\n') + '\n';
}

// A finding's suggestion that a question already asks, by the fix that asks it (id prefix).
const ASKED = [
  ['subagent-model-sonnet', /"CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"/],
  ['effort-high-', /^Use `\/effort high`/],
  ['autocompact-300k', /"autoCompactWindow": 300000/],
  ['default-model-sonnet', /^Start routine sessions with `\/model sonnet`/],
  ['model-routing-rule', /^Let Claude pick a model per task/],
  ['security-', /SECURITY_REVIEW_MODEL=/],
  ['fast-mode-off', /turn it off with `\/fast`/],
  ['cross-session-hold', /"crossSessionInbound": "hold"/],
];

// The findings' suggestions no question covers, grouped by finding, then the habits whose finding is not
// shown (a shown finding already carries the same advice).
export function otherSuggestions(found, fixes, habits) {
  const asked = (text) => ASKED.some(([id, re]) => re.test(text) && fixes.some((f) => f.id.startsWith(id)));
  const shown = found.slice(0, MAX_SHOWN);
  const groups = shown.map((f) => [f.title, f.fixes.filter((x) => !asked(x))]).filter(([, xs]) => xs.length);
  const rest = habits.filter((h) => !shown.some((f) => f.id === h.finding)).map((h) => h.text);
  if (rest.length) groups.push(['Habits', rest]);
  return groups;
}

function suggestionLines(found, fixes, habits) {
  const groups = otherSuggestions(found, fixes, habits);
  if (!groups.length) return [];
  const lines = ['## Other suggestions', '', 'Things only the user can do: slash commands to type, habits, and changes to their own agents and skills.', ''];
  for (const [title, xs] of groups) lines.push(`**${title}**`, ...xs.map((x) => `- ${x}`), '');
  return lines;
}

// What analyze found and what happens next, before the details.
function summaryLines(r, found, fixes, dashboard, active = []) {
  const total = r.totals.cost;
  const lines = ['## Summary', ''];
  if (found.length) lines.push(`- **What eats your limit:** ${found.slice(0, 3).map((f) => `${f.title} (${pct(f.cost, total)})`).join(', ')}. These overlap.`);
  const projects = topProjects(r, 3);
  if (projects.length) lines.push(`- **Biggest projects:** ${projects.map(([p, b]) => `${clean(p)} ${pct(b.cost, total)}`).join(', ')}`);
  const qs = questions(fixes);
  if (qs.length) {
    const first = qs[0].options[0].id === 'model-routing-rule' ? ', model routing first' : '';
    lines.push(`- **What happens next:** Claude asks ${qs.length} question${qs.length === 1 ? '' : 's'}, one per fix below${first}. Nothing changes until you choose; each change is backed up, and \`/limit-lens:analyze revert\` undoes it.`);
  } else {
    lines.push('- **What happens next:** no fix applies right now, so nothing is asked; the other suggestions below are yours to try.');
  }
  const inEffect = changesInEffect(active);
  if (inEffect) lines.push(`- **Already in effect:** ${inEffect} change${inEffect === 1 ? '' : 's'} from earlier runs ${inEffect === 1 ? 'is' : 'are'} in effect, listed under "Changes in effect".`);
  const best = fixes.filter((f) => f.savings?.weekly != null).sort((a, b) => b.savings.weekly - a.savings.weekly)[0];
  if (best) lines.push(`- **Largest estimated saving:** about ${usd(best.savings.weekly)} per week, from "${best.title}" (each fix alone; the estimates do not add up).`);
  if (dashboard) lines.push(`- **Dashboard:** \`${dashboard.file}\`, with charts of everything below${dashboard.opened ? ', opened in your browser' : ''}.`);
  lines.push('');
  return lines;
}

// `limit-lens analyze`: a summary, the report, the questions (the routing rule first), the suggestions no
// question covers, and the history of applied changes.
export function renderAnalyze({ report, found, fixes, habits = [], settingsFile, last, undo, active = [], warning, searched = [], dashboard = null }) {
  const head = renderMarkdown(report, found, { searched, withFixes: false, summary: report.totals.requests ? summaryLines(report, found, fixes, dashboard, active) : [] });
  if (!report.totals.requests) return head;
  const lines = ['', '## Questions', '', ...questionLines(fixes, settingsFile), ...suggestionLines(found, fixes, habits), ...historyLines({ active, last, undo, warning })];
  return head + lines.join('\n') + '\n';
}

// Every local calendar day in the window, oldest first, as YYYY-MM-DD.
export function windowDays(r) {
  const out = [];
  const to = new Date(r.window.to);
  const from = new Date(r.window.from);
  for (const d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to; d.setDate(d.getDate() + 1)) out.push(d.toLocaleDateString('en-CA'));
  return out;
}

// "Sat 10-24" for 2026-10-24.
export const dayLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return `${new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' })} ${key.slice(5)}`;
};

const EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low'];

export const topProjects = (r, n) => Object.entries(r.byProject || {}).filter(([, b]) => b.cost > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, n);

// The numbers behind the bars, shared by the Markdown and the dashboard. `name` maps a project folder name.
export function glanceData(r, { name = (p) => p, projects = 3 } = {}) {
  const c = r.components;
  const total = r.totals.cost;
  const top = (map, n) => Object.entries(map || {}).filter(([, b]) => b.cost > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, n);
  const effort = Object.entries(r.byEffort || {}).filter(([, b]) => b.cost > 0)
    .sort(([a], [b]) => (EFFORT_ORDER.indexOf(a) + 1 || 99) - (EFFORT_ORDER.indexOf(b) + 1 || 99));
  return [
    { id: 'days', title: 'Spend by day', rows: windowDays(r).map((k) => ({ key: k, label: dayLabel(k), cost: r.byDay?.[k]?.cost || 0, requests: r.byDay?.[k]?.requests || 0 })) },
    {
      id: 'where',
      title: 'Where it goes',
      rows: [
        { label: 'Re-reading context', cost: c.cacheRead },
        { label: 'Writing to the cache', cost: c.cacheWrite5m + c.cacheWrite1h },
        { label: `Output (thinking ${pct(c.thinking, total)})`, cost: c.output },
        { label: 'Uncached input', cost: c.input },
      ],
    },
    { id: 'models', title: 'By model', rows: top(r.byModel, 4).map(([k, b]) => ({ label: modelName(k), cost: b.cost })) },
    {
      id: 'source',
      title: 'By source',
      rows: [
        { label: 'You (main conversation)', cost: r.turns.human.cost },
        { label: 'Automated turns', cost: r.turns.automated.cost },
        { label: 'Subagents', cost: r.agents.subagent.cost },
        { label: 'Workflow agents', cost: r.agents.workflow.cost },
      ].filter((x) => x.cost > 0),
    },
    { id: 'effort', title: 'By effort', rows: effort.map(([k, b]) => ({ label: clean(k), cost: b.cost })) },
    { id: 'projects', title: 'Biggest projects', rows: topProjects(r, projects).map(([p, b]) => ({ label: clean(name(p)), cost: b.cost })) },
  ];
}

// The glance as text bars. Days scale to the busiest day; everything else to the total.
function glanceLines(sections, total) {
  const lines = ['```text'];
  const pad = Math.min(28, Math.max(...sections.flatMap((s) => s.rows.map((x) => String(x.label).length)))); // one bar column for every block
  for (const s of sections) {
    if (!s.rows.length || (s.id === 'days' && s.rows.length > 10)) continue;
    const max = Math.max(...s.rows.map((x) => x.cost));
    const rows = s.rows.map((x) => (s.id === 'days'
      ? { label: x.label, fraction: max ? x.cost / max : 0, value: usd(x.cost) }
      : { label: x.label, fraction: total ? x.cost / total : 0, value: `${pct(x.cost, total).padStart(4)}  ${usd(x.cost).padStart(7)}` }));
    lines.push(s.title, ...barBlock(rows, { pad }), '');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('```');
  return lines;
}

// What the report cannot see.
export function notCounted(r) {
  const total = r.totals.cost;
  const items = [
    'Usage from other computers, claude.ai chat and Cowork (they share your plan limits).',
    'Plugins and scripts that call the API without leaving a log limit-lens can read.',
  ];
  if (r.totals.estimatedCost > 0) items.push(`${pct(r.totals.estimatedCost, total)} of spend is on models missing from the price table, priced at the closest known model and marked with \`~\`.`);
  for (const n of r.notes || []) {
    if (n === 'history-shorter-than-window') items.push(historyNote(r));
    else if (NOTES[n]) items.push(NOTES[n]);
  }
  return items;
}

function historyNote(r) {
  const since = r.window.oldestData ? r.window.oldestData.slice(0, 10) : 'later';
  return `Your transcripts on this computer start on ${since}. Claude Code deletes transcripts after \`cleanupPeriodDays\` (30 days by default), so a window longer than that cannot be filled; raise it in settings.json to keep more history.`;
}

export function renderMarkdown(r, found, { anonymize = false, searched = [], withFixes = true, summary = [] } = {}) {
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
    ...summary,
    '## At a glance',
    '',
    ...glanceLines(glanceData(r, { name }), total),
    '',
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
    if (withFixes && f.fixes.length) {
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

  lines.push('## Not counted', '', ...notCounted(r).map((x) => `- ${x}`));
  return lines.join('\n') + '\n';
}
