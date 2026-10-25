// Render a report and its findings as compact Markdown. The output is injected into a
// conversation, so every line has to earn its tokens. Texts come from the language catalogs (i18n/).
import { topEntries, modelName } from './format.mjs';
import { barBlock } from './charts.mjs';
import { locale, lookup } from './i18n/index.mjs';

const MAX_SHOWN = 6;
// Entry point names come from disk; one the catalog does not name is cleaned.
export const entrypointName = (t, k) => lookup(t.names.entrypoints, k, clean(k));
export const kindLabel = (f, t) => (f.kind === 'cost-only' ? t.report.costOnly : t.report.changesWork);

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

const show = (v, t) => (v === undefined || v === null ? t.names.notSet : `\`${JSON.stringify(v)}\``);

// Project, agent type and session names come from disk and are cleaned; review names are limit-xray's own.
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
export function questions(fixes, { lang = 'en' } = {}) {
  const groups = locale(lang).t.names.groups;
  const out = [];
  const byGroup = new Map();
  for (const f of fixes) {
    if (f.group && byGroup.has(f.group)) {
      byGroup.get(f.group).options.push(f);
      continue;
    }
    const q = { group: f.group || null, title: f.group ? lookup(groups, f.group, f.title) : f.title, what: f.what, options: [f] };
    if (f.group) byGroup.set(f.group, q);
    out.push(q);
  }
  return out;
}

function fixLines(f, indent, { t, usd }) {
  const R = t.report;
  const pad = ' '.repeat(indent);
  const lines = [
    `${pad}- ${kindLabel(f, t)}: ${f.effect}`,
    pad + (f.target === 'memory'
      ? R.changeMemory({ file: f.file, rule: f.rule })
      : R.changeSetting({ path: f.path.join('.'), from: show(f.current, t), to: show(f.value, t) })),
    pad + R.why({ why: f.why }),
  ];
  const kinds = [...new Set((f.contributors || []).map((c) => c.kind))];
  for (const k of kinds) {
    const items = f.contributors.filter((c) => c.kind === k).map((c) => `${contributorName(c)} (${usd(c.cost)}${c.detail ? `, ${c.detail}` : ''})`);
    lines.push(`${pad}- ${lookup(t.names.contributors, k)}: ${items.join('; ')}`);
  }
  lines.push(
    pad + (f.savings?.weekly == null ? R.savingNone({ basis: f.savings?.basis }) : R.saving({ cost: usd(f.savings.weekly), basis: f.savings.basis })),
    pad + R.source({ docs: f.docs }),
  );
  return lines;
}

function diagnosisLines(report, found, { t, usd, pct }) {
  const R = t.report;
  const d = diagnosis(report, found);
  const lines = [R.eating, '', R.diagnosisSpend({ cost: usd(d.spend), days: d.days, outside: d.outside ? usd(d.outside) : '' }), ''];
  for (const l of d.lenses) lines.push(`- ${l.title}: ${pct(l.cost, d.spend)} (${usd(l.cost)})`);
  if (d.projects.length) lines.push(R.biggestProjectsPlain({ list: d.projects.map((p) => `${p.name} ${pct(p.cost, d.spend)}`).join(', ') }));
  if (d.lenses.length > 1) lines.push('', R.overlap);
  lines.push('');
  return lines;
}

function questionLines(fixes, settingsFile, loc) {
  const R = loc.t.report;
  const lines = [R.settingsFile({ file: settingsFile }), ''];
  if (!fixes.length) lines.push(R.noFix, '');
  questions(fixes, { lang: loc.lang }).forEach((q, i) => {
    lines.push(R.question({ n: i + 1, title: q.title }), '');
    if (q.what) lines.push(R.what({ what: q.what }));
    if (q.options.length === 1) {
      lines.push(...fixLines(q.options[0], 0, loc), R.options({ ids: `\`${q.options[0].id}\`` }), '');
    } else {
      for (const f of q.options) lines.push(`- \`${f.id}\`: ${f.title}`, ...fixLines(f, 2, loc));
      lines.push(R.alternatives({ ids: q.options.map((f) => `\`${f.id}\``).join(R.or) }), '');
    }
  });
  if (fixes.filter((f) => f.savings?.weekly != null).length > 1) lines.push(R.notAdditive, '');
  return lines;
}

// One applied change, in a line.
export const describeChange = (c, lang = 'en') => (c.kind === 'memory' ? locale(lang).t.report.routingRule : `\`${c.path.join('.')}\` = \`${JSON.stringify(c.after)}\``);

const changesInEffect = (active) => active.reduce((s, e) => s + e.changes.length, 0);

function historyLines({ active = [], last, undo, warning }, { t, lang, utc }) {
  const R = t.report;
  const lines = [];
  if (active.length) {
    lines.push('', R.inEffectTitle, '');
    for (const e of active) lines.push(R.applied({ id: e.id, when: utc(e.appliedAt), changes: e.changes.map((c) => describeChange(c, lang)).join('; ') }));
    lines.push('', R.compareThem);
  } else if (last) {
    lines.push('', R.lastTitle, '', R.last({ id: last.id, when: utc(last.appliedAt), fixes: last.changes.map((c) => `\`${c.fixId}\``).join(', '), reverted: Boolean(last.revertedAt) }));
  }
  if (undo) {
    lines.push('', R.undoTitle({ id: undo.id }), '');
    for (const c of undo.changes) {
      lines.push(c.kind === 'memory' ? R.undoMemory({ file: c.file }) : R.undoSetting({ path: c.path.join('.'), to: c.hadKey ? show(c.restore, t) : R.removed }));
    }
    lines.push('', R.undoHow({ id: undo.id }));
  }
  if (warning) lines.push('', R.warning({ warning }));
  return lines;
}

// The fix plan: the diagnosis first, then one question per fix or per group of alternatives.
export function renderPlan({ report, found = [], fixes, habits, settingsFile, last, undo, active = [], warning, lang = 'en' }) {
  const loc = locale(lang);
  const R = loc.t.report;
  const lines = [R.planTitle, ''];
  if (report) lines.push(...diagnosisLines(report, found, loc));
  lines.push(...questionLines(fixes, settingsFile, loc));
  if (habits.length) lines.push('', R.habits, '', ...habits.map((h) => `- ${h}`));
  lines.push(...historyLines({ active, last, undo, warning }, loc));
  return lines.join('\n') + '\n';
}

// A finding's suggestion that a question already asks: the fix that asks it (id prefix) and the
// suggestion's text in the findings catalog.
const ASKED = [
  ['subagent-model-sonnet', (F) => F.agents.sonnet],
  ['effort-high-', (F) => F.effort.high],
  ['autocompact-300k', (F) => F.reread.autocompact],
  ['default-model-sonnet', (F) => F.models.sonnet],
  ['model-routing-rule', (F) => F.models.routing],
  ['security-', (F) => F.plugins.securityGuidance],
  ['fast-mode-off', (F) => F.fast.off],
  ['cross-session-hold', (F) => F.automation.hold],
];

// The findings' suggestions no question covers, grouped by finding, then the habits whose finding is not
// shown (a shown finding already carries the same advice). Findings and fixes must be in `lang`.
export function otherSuggestions(found, fixes, habits, { lang = 'en' } = {}) {
  const { t } = locale(lang);
  const asked = (text) => ASKED.some(([id, pick]) => text === pick(t.findings) && fixes.some((f) => f.id.startsWith(id)));
  const shown = found.slice(0, MAX_SHOWN);
  const groups = shown.map((f) => [f.title, f.fixes.filter((x) => !asked(x))]).filter(([, xs]) => xs.length);
  const rest = habits.filter((h) => !shown.some((f) => f.id === h.finding)).map((h) => h.text);
  if (rest.length) groups.push([t.report.habitsGroup, rest]);
  return groups;
}

function suggestionLines(found, fixes, habits, loc) {
  const groups = otherSuggestions(found, fixes, habits, { lang: loc.lang });
  if (!groups.length) return [];
  const R = loc.t.report;
  const lines = [R.other, '', R.otherNote, ''];
  for (const [title, xs] of groups) lines.push(`**${title}**`, ...xs.map((x) => `- ${x}`), '');
  return lines;
}

// What analyze found and what happens next, before the details.
function summaryLines(r, found, fixes, dashboard, active, loc) {
  const { t, usd, pct } = loc;
  const R = t.report;
  const total = r.totals.cost;
  const lines = [R.summary, ''];
  if (found.length) lines.push(R.eats({ list: found.slice(0, 3).map((f) => `${f.title} (${pct(f.cost, total)})`).join(', ') }));
  const projects = topProjects(r, 3);
  if (projects.length) lines.push(R.biggestProjects({ list: projects.map(([p, b]) => `${clean(p)} ${pct(b.cost, total)}`).join(', ') }));
  const qs = questions(fixes, { lang: loc.lang });
  if (qs.length) lines.push(R.next({ n: qs.length, first: qs[0].options[0].id === 'model-routing-rule' ? R.routingFirst : '' }));
  else lines.push(R.nextNone);
  const inEffect = changesInEffect(active);
  if (inEffect) lines.push(R.inEffect({ n: inEffect }));
  const best = fixes.filter((f) => f.savings?.weekly != null).sort((a, b) => b.savings.weekly - a.savings.weekly)[0];
  if (best) lines.push(R.best({ cost: usd(best.savings.weekly), title: best.title }));
  if (dashboard) lines.push(R.dashboard({ file: dashboard.file, opened: Boolean(dashboard.opened) }));
  lines.push('');
  return lines;
}

// `limit-xray analyze`: a summary, the report, the questions (the routing rule first), the suggestions no
// question covers, and the history of applied changes.
export function renderAnalyze({ report, found, fixes, habits = [], settingsFile, last, undo, active = [], warning, searched = [], dashboard = null, lang = 'en' }) {
  const loc = locale(lang);
  const summary = report.totals.requests ? summaryLines(report, found, fixes, dashboard, active, loc) : [];
  const head = renderMarkdown(report, found, { searched, withFixes: false, summary, lang });
  if (!report.totals.requests) return head;
  const lines = ['', loc.t.report.questions, '', ...questionLines(fixes, settingsFile, loc), ...suggestionLines(found, fixes, habits, loc), ...historyLines({ active, last, undo, warning }, loc)];
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

const EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low'];

export const topProjects = (r, n) => Object.entries(r.byProject || {}).filter(([, b]) => b.cost > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, n);

// The numbers behind the bars, shared by the Markdown and the dashboard. `name` maps a project folder name.
export function glanceData(r, { name = (p) => p, projects = 3, lang = 'en' } = {}) {
  const { t, pct, dayLabel } = locale(lang);
  const G = t.glance;
  const c = r.components;
  const total = r.totals.cost;
  const top = (map, n) => Object.entries(map || {}).filter(([, b]) => b.cost > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, n);
  const effort = Object.entries(r.byEffort || {}).filter(([, b]) => b.cost > 0)
    .sort(([a], [b]) => (EFFORT_ORDER.indexOf(a) + 1 || 99) - (EFFORT_ORDER.indexOf(b) + 1 || 99));
  return [
    { id: 'days', title: G.days, rows: windowDays(r).map((k) => ({ key: k, label: dayLabel(k), cost: r.byDay?.[k]?.cost || 0, requests: r.byDay?.[k]?.requests || 0 })) },
    {
      id: 'where',
      title: G.where,
      rows: [
        { label: G.cacheRead, cost: c.cacheRead },
        { label: G.cacheWrite, cost: c.cacheWrite5m + c.cacheWrite1h },
        { label: G.output({ share: pct(c.thinking, total) }), cost: c.output },
        { label: G.input, cost: c.input },
      ],
    },
    { id: 'models', title: G.models, rows: top(r.byModel, 4).map(([k, b]) => ({ label: modelName(k), cost: b.cost })) },
    {
      id: 'source',
      title: G.source,
      rows: [
        { label: G.human, cost: r.turns.human.cost },
        { label: G.automated, cost: r.turns.automated.cost },
        { label: G.subagents, cost: r.agents.subagent.cost },
        { label: G.workflow, cost: r.agents.workflow.cost },
      ].filter((x) => x.cost > 0),
    },
    { id: 'effort', title: G.effort, rows: effort.map(([k, b]) => ({ label: clean(k), cost: b.cost })) },
    { id: 'projects', title: G.projects, rows: topProjects(r, projects).map(([p, b]) => ({ label: clean(name(p)), cost: b.cost })) },
  ];
}

// The glance as text bars. Days scale to the busiest day; everything else to the total.
function glanceLines(sections, total, { usd, pct }) {
  const lines = ['```text'];
  const pad = Math.min(28, Math.max(...sections.flatMap((s) => s.rows.map((x) => String(x.label).length)))); // one bar column for every block
  const money = Math.max(7, ...sections.flatMap((s) => s.rows.map((x) => usd(x.cost).length))); // one width, so the shares line up too
  for (const s of sections) {
    if (!s.rows.length || (s.id === 'days' && s.rows.length > 10)) continue;
    const max = Math.max(...s.rows.map((x) => x.cost));
    const rows = s.rows.map((x) => (s.id === 'days'
      ? { label: x.label, fraction: max ? x.cost / max : 0, value: usd(x.cost) }
      : { label: x.label, fraction: total ? x.cost / total : 0, value: `${pct(x.cost, total).padStart(4)}  ${usd(x.cost).padStart(money)}` }));
    lines.push(s.title, ...barBlock(rows, { pad }), '');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('```');
  return lines;
}

const NOTE_CODES = new Set(['plugin-log-unscoped', 'plugin-log-partial', 'unreadable-transcript', 'malformed-line']);

// What the report cannot see.
export function notCounted(r, { lang = 'en' } = {}) {
  const { t, pct, date } = locale(lang);
  const N = t.notCounted;
  const items = [N.elsewhere, N.noLog];
  if (r.totals.estimatedCost > 0) items.push(N.estimated({ share: pct(r.totals.estimatedCost, r.totals.cost) }));
  for (const n of r.notes || []) {
    if (n === 'history-shorter-than-window') items.push(N.history({ since: r.window.oldestData ? date(r.window.oldestData) : N.historyLater }));
    else if (NOTE_CODES.has(n)) items.push(N.notes[n]);
  }
  return items;
}

export function renderMarkdown(r, found, { anonymize = false, searched = [], withFixes = true, summary = [], lang = 'en' } = {}) {
  const loc = locale(lang);
  const { t, usd, pct, tokens, num, date } = loc;
  const R = t.report;
  const name = anonymizer(anonymize, { shorten: true });
  const total = r.totals.cost;
  const lines = [R.title({ days: r.window.days }), ''];
  // The filter text is usually part of a real folder name, so --anonymize hides it too.
  const filterText = r.filter ? (anonymize ? R.filterHidden : `\`${clean(r.filter.project)}\``) : null;
  if (filterText) lines.push(R.onlyProjects({ filter: filterText }), '');

  if (!r.totals.requests) {
    if (r.filter && !r.filter.matchingFolders) {
      lines.push(R.noFolder({ filter: filterText }));
      return lines.join('\n') + '\n';
    }
    lines.push(r.filter ? R.noUsageFiltered : R.noUsage);
    if (searched.length && anonymize) lines.push('', R.lookedHidden);
    else if (searched.length) {
      // JSON.stringify escapes newlines and control characters, so a path cannot leave its code span.
      lines.push('', R.lookedIn, ...searched.map((d) => `- \`${JSON.stringify(String(d)).slice(0, 200).replace(/`/g, '')}\``));
    }
    lines.push('', R.tryLonger);
    return lines.join('\n') + '\n';
  }

  lines.push(
    R.spend({ cost: usd(total), requests: num(r.totals.requests), sessions: num(r.totals.sessions), asOf: date(r.pricesAsOf) }),
    R.notABill,
    '',
    ...summary,
    R.atAGlance,
    '',
    ...glanceLines(glanceData(r, { name, lang }), total, loc),
    '',
    R.startedFrom({ list: topEntries(r.byEntrypoint, total, 4, (k) => entrypointName(t, k), pct) }),
  );
  if (r.outside.cost) lines.push(R.outside({ cost: usd(r.outside.cost) }));
  lines.push('');

  const heading = (f) => {
    const inside = f.cost ? `${pct(f.cost, total)}, ${usd(f.cost)}` : '';
    const outside = f.outsideCost ? R.outsideTotal({ cost: usd(f.outsideCost) }) : '';
    return [inside, outside].filter(Boolean).join(R.plus);
  };
  lines.push(R.findings, '');
  if (!found.length) lines.push(R.nothing, '');
  found.slice(0, MAX_SHOWN).forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.title} (${heading(f)})`, '');
    for (const e of f.evidence) lines.push(`- ${e}`);
    if (withFixes && f.fixes.length) {
      lines.push('', R.fixes);
      f.fixes.forEach((x, j) => lines.push(`${j + 1}. ${x}`));
    }
    lines.push(`${R.docs} ${f.docs.join(' · ')}`, '');
  });
  if (found.length > MAX_SHOWN) {
    lines.push(R.alsoAbove({ list: found.slice(MAX_SHOWN).map((f) => `${f.title} (${heading(f)})`).join('; ') }), '');
  }

  if (r.topSessions.length) {
    lines.push(R.sessions, '', R.sessionsHeader, '| :- | :- | :- | -: | -: | -: | -: |');
    r.topSessions.forEach((s, i) => {
      lines.push(
        `| ${clean(name(s.project))} | ${sessionLabel(s.sessionId, i, anonymize)} | ${entrypointName(t, s.entrypoint)} | ${usd(s.cost)} | ${num(s.requests)} | ${tokens(s.avgPromptTokens)} | ${pct(s.rereadCost, s.cost)} |`,
      );
    });
    lines.push('', R.sessionsNote, '');
  }

  lines.push(R.notCounted, '', ...notCounted(r, { lang }).map((x) => `- ${x}`));
  return lines.join('\n') + '\n';
}
