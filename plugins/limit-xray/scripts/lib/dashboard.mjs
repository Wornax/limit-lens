// The analyze dashboard: one self-contained HTML page with the report's numbers drawn as cards and bar
// charts. It loads nothing from the network (no fonts, scripts or styles from elsewhere), so it opens the
// same offline. Every string from disk or from the report is escaped; values are always printed beside
// their bars, so a chart never hides a number. Texts come from the language catalogs (i18n/).
import { clean, questions, contributorName, glanceData, otherSuggestions, notCounted, sessionLabel, entrypointName, kindLabel } from './report.mjs';
import { locale, lookup } from './i18n/index.mjs';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);
// Escaped text where `code` spans become <code>.
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
// A path or id from disk placed inside a catalog text that goes through rich(): a backtick in it would
// pair with the text's own and move the <code> spans, so it shows as a look-alike.
const tick = (s) => String(s).replace(/`/g, 'ˋ');

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const entrypoint = (t, k) => cap(entrypointName(t, k));

// Horizontal bars: label, bar, value. `max` is the value of a full-width bar.
function barList(rows, max, tone = 'spend') {
  return `<div class="bars">${rows.map((x) => {
    const w = x.cost > 0 && max ? Math.max(0.8, (x.cost / max) * 100) : 0;
    return `<div class="bar-row" tabindex="0" data-tip="${esc(x.tip || `${x.label}: ${x.value}`)}"><span class="bar-label">${esc(x.label)}</span><span class="bar-track"><span class="bar-fill ${tone}" style="width:${w.toFixed(2)}%"></span></span><span class="bar-value">${esc(x.value)}</span></div>`;
  }).join('')}</div>`;
}

// Columns for spend by day, the busiest day and today labelled on the cap; every day has a tooltip and a table row.
function dayColumns(rows, { t, usd, num }) {
  const D = t.dashboard;
  const max = Math.max(...rows.map((x) => x.cost));
  const peak = rows.findIndex((x) => x.cost === max);
  const cols = rows.map((x, i) => {
    const h = max ? (x.cost / max) * 100 : 0;
    const tip = D.dayTip({ day: x.label, cost: usd(x.cost), requests: num(x.requests) });
    const value = (i === peak || i === rows.length - 1) && x.cost > 0 ? `<span class="col-value" style="bottom:calc(${h.toFixed(2)}% + 4px)">${esc(usd(x.cost))}</span>` : '';
    return `<div class="col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}">${value}<span class="col-fill" style="height:${h.toFixed(2)}%"></span></div>`;
  });
  const axis = rows.map((x) => {
    const [day, date] = x.label.split(' ');
    return `<span>${esc(day)}<br>${esc(date)}</span>`;
  });
  const table = rows.map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(usd(x.cost))}</td><td>${esc(num(x.requests))}</td></tr>`).join('');
  return `<div class="cols">${cols.join('')}</div><div class="col-axis">${axis.join('')}</div>
<details class="table-view"><summary>${esc(D.asTable)}</summary><table><thead><tr><th>${esc(D.day)}</th><th>${esc(D.spendColumn)}</th><th>${esc(D.requestsColumn)}</th></tr></thead><tbody>${table}</tbody></table></details>`;
}

const meter = (share) => `<span class="meter" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0, share * 100)).toFixed(2)}%"></span></span>`;

function tile(label, cost, total, foot, { pct }) {
  return `<div class="card tile"><p class="tile-label">${esc(label)}</p><p class="tile-value">${esc(pct(cost, total))}</p>${meter(total ? cost / total : 0)}<p class="tile-foot">${esc(foot)}</p></div>`;
}

const show = (v, { t }) => (v === undefined || v === null ? esc(t.dashboard.notSet) : `<code>${esc(JSON.stringify(v))}</code>`);
const source = (docs) => (/^https:\/\//.test(docs) ? `<a href="${esc(docs)}">${esc(docs.replace(/^https:\/\//, ''))}</a>` : rich(docs));

function option(f, maxSaving, withTitle, loc) {
  const { t, usd } = loc;
  const D = t.dashboard;
  const change = f.target === 'memory'
    ? rich(D.addTo({ file: tick(f.file), rule: f.rule }))
    : `<code>${esc(f.path.join('.'))}</code>: ${show(f.current, loc)} → ${show(f.value, loc)}`;
  const kinds = [...new Set((f.contributors || []).map((c) => c.kind))];
  const who = kinds.map((k) => `<dt>${esc(lookup(t.names.contributors, k))}</dt><dd>${f.contributors.filter((c) => c.kind === k)
    .map((c) => `${esc(contributorName(c))} <span class="muted">${esc(usd(c.cost))}${c.detail ? `, ${esc(c.detail)}` : ''}</span>`).join('<br>')}</dd>`).join('');
  const saving = f.savings?.weekly == null
    ? `<dd>${rich(f.savings?.basis || '')}</dd>`
    : `<dd>${barList([{ label: D.perWeek, cost: f.savings.weekly, value: D.about({ cost: usd(f.savings.weekly) }) }], maxSaving, 'saving')}<span class="muted">${rich(f.savings.basis)}</span></dd>`;
  const costOnly = f.kind === 'cost-only';
  return `<div class="option">
${withTitle ? `<h4><code>${esc(f.id)}</code> ${esc(f.title)}</h4>` : ''}
<p class="badge ${costOnly ? 'good' : 'warn'}"><span class="icon" aria-hidden="true">${costOnly ? '✓' : '!'}</span>${esc(kindLabel(f, t))}</p>
<p>${rich(f.effect)}</p>
<dl><dt>${esc(D.change)}</dt><dd>${change}</dd><dt>${esc(D.why)}</dt><dd>${rich(f.why)}</dd>${who}<dt>${esc(D.saving)}</dt>${saving}<dt>${esc(D.source)}</dt><dd>${source(f.docs)}</dd></dl>
</div>`;
}

export function renderDashboard({ report: r, found, fixes, habits = [], settingsFile, last = null, undo = null, active = [], warning = null, generatedAt = Date.now(), lang = 'en' }) {
  const loc = locale(lang);
  const { t, usd, pct, tokens, num } = loc;
  const D = t.dashboard;
  const total = r.totals.cost;
  const glance = Object.fromEntries(glanceData(r, { projects: 5, lang }).map((s) => [s.id, s]));
  const share = (x) => `${pct(x.cost, total)}  ${usd(x.cost)}`;
  const listCard = (s) => (s.rows.length ? `<section class="card"><h2>${esc(s.title)}</h2>${barList(s.rows.map((x) => ({ ...x, value: share(x) })), total)}</section>` : '');
  const opus = Object.entries(r.byModel).filter(([k]) => k.startsWith('opus')).reduce((s, [, b]) => s + b.cost, 0);
  const agents = r.agents.subagent.cost + r.agents.workflow.cost;
  const high = (r.byEffort.xhigh?.cost || 0) + (r.byEffort.max?.cost || 0);
  const entry = { id: 'entry', title: D.startedFrom, rows: Object.entries(r.byEntrypoint).filter(([, b]) => b.cost > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, 4).map(([k, b]) => ({ label: entrypoint(t, k), cost: b.cost })) };
  const qs = questions(fixes, { lang });
  const withSaving = fixes.filter((f) => f.savings?.weekly != null).sort((a, b) => b.savings.weekly - a.savings.weekly);
  const maxSaving = withSaving.length ? withSaving[0].savings.weekly : 0;
  const suggestions = otherSuggestions(found, fixes, habits, { lang });

  const findingCards = found.slice(0, 6).map((f, i) => `<article class="card finding">
<header><span class="rank">${i + 1}</span><h3>${esc(f.title)}</h3><span class="finding-value">${esc(pct(f.cost, total))} <span class="muted">${esc(usd(f.cost))}${f.outsideCost ? esc(D.outsideTotal({ cost: usd(f.outsideCost) })) : ''}</span></span></header>
${meter(total ? f.cost / total : 0)}
<ul>${f.evidence.map((e) => `<li>${rich(e)}</li>`).join('')}</ul>
</article>`).join('');

  const fixCards = qs.map((q, i) => `<article class="card fix">
<header><span class="q">${esc(D.question({ n: i + 1 }))}</span><h3>${esc(q.title)}</h3></header>
<p class="what"><strong>${esc(D.whatItIs)}</strong> ${rich(q.what)}</p>
${q.options.length > 1 ? `<p class="muted">${esc(D.alternatives)}</p>` : ''}
${q.options.map((f) => option(f, maxSaving, q.options.length > 1, loc)).join('')}
</article>`).join('');

  const sessions = r.topSessions.slice(0, 5).map((s, i) => `<tr><td>${esc(clean(s.project))}</td><td><code>${esc(sessionLabel(s.sessionId, i, false))}</code></td><td>${esc(entrypoint(t, s.entrypoint))}</td><td>${esc(usd(s.cost))}</td><td>${esc(num(s.requests))}</td><td>${esc(tokens(s.avgPromptTokens))}</td><td>${esc(pct(s.rereadCost, s.cost))}</td></tr>`).join('');

  const history = [];
  const { utc } = loc;
  const change = (c) => (c.kind === 'memory' ? rich(D.routingRule({ file: tick(c.file) })) : `<code>${esc(c.path.join('.'))}</code> = ${show(c.after, loc)}`);
  for (const e of active) history.push(`<div class="applied"><p><code>${esc(e.id)}</code> <span class="muted">${esc(D.appliedAt({ when: utc(e.appliedAt) }))}</span></p><ul>${e.changes.map((c) => `<li>${change(c)}</li>`).join('')}</ul></div>`);
  if (!active.length && last) history.push(`<p>${rich(D.lastChange({ id: tick(last.id), when: utc(last.appliedAt), fixes: last.changes.map((c) => `\`${tick(c.fixId)}\``).join(', '), reverted: Boolean(last.revertedAt) }))}</p>`);
  const inEffect = active.reduce((s, e) => s + e.changes.length, 0);
  if (undo) {
    history.push(`<div class="applied"><p>${rich(D.wouldUndo({ id: tick(undo.id) }))}</p><ul>${undo.changes.map((c) => (c.kind === 'memory'
      ? `<li>${rich(D.undoMemory({ file: tick(c.file) }))}</li>`
      : `<li><code>${esc(c.path.join('.'))}</code> → ${c.hadKey ? show(c.restore, loc) : esc(D.removed)}</li>`)).join('')}</ul></div>`);
  }
  if (warning) history.push(`<p class="badge warn"><span class="icon" aria-hidden="true">!</span>${esc(warning)}</p>`);

  return `<!doctype html>
<html lang="${esc(D.htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(D.title)}</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11, 11, 11, 0.1);
  --spend: #2a78d6; --spend-track: #cde2fb; --saving: #1baf7a; --good: #0ca30c; --warn: #fab219;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255, 255, 255, 0.1);
    --spend: #3987e5; --spend-track: #104281; --saving: #199e70;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255, 255, 255, 0.1);
  --spend: #3987e5; --spend-track: #104281; --saving: #199e70;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 56px; }
h1 { font-size: 28px; line-height: 1.2; font-weight: 650; margin: 2px 0 6px; }
h2 { font-size: 16px; font-weight: 600; margin: 0 0 14px; }
h3 { font-size: 16px; font-weight: 600; margin: 0; }
h4 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0 0 8px; }
code { font: 0.92em/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; background: var(--grid); border-radius: 4px; padding: 0 4px; overflow-wrap: anywhere; }
a { color: var(--ink-2); }
.brand { font-size: 13px; font-weight: 600; color: var(--muted); margin: 0; }
.sub, .muted { color: var(--muted); }
.sub { margin: 0 0 20px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
.section-title { font-size: 20px; font-weight: 600; margin: 36px 0 6px; }
.note { color: var(--ink-2); margin: 0 0 14px; }
.hero { display: grid; gap: 4px; }
.hero-label { color: var(--ink-2); font-weight: 600; margin: 0; }
.hero-value { font-size: 56px; line-height: 1.05; font-weight: 650; margin: 0; }
.next { margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--grid); color: var(--ink-2); }
.next code { white-space: nowrap; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 12px 0; }
.tile-label { color: var(--ink-2); font-size: 14px; margin: 0; }
.tile-value { font-size: 32px; font-weight: 600; line-height: 1.2; margin: 2px 0 10px; }
.tile-foot { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
.meter { display: block; height: 8px; border-radius: 4px; background: var(--spend-track); overflow: hidden; }
.meter > span { display: block; height: 100%; background: var(--spend); border-radius: 0 4px 4px 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; margin: 12px 0; }
.bars { display: grid; gap: 10px; }
.bar-row { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "label value" "track track"; gap: 4px 12px; align-items: baseline; border-radius: 6px; outline: none; }
.bar-row:hover .bar-fill, .bar-row:focus-visible .bar-fill { filter: brightness(1.15); }
.bar-row:focus-visible { box-shadow: 0 0 0 2px var(--spend); }
.bar-label { grid-area: label; color: var(--ink-2); font-size: 14px; overflow-wrap: anywhere; }
.bar-value { grid-area: value; }
.bar-track { grid-area: track; height: 10px; }
.bar-fill { display: block; height: 10px; border-radius: 0 4px 4px 0; }
.bar-fill.spend { background: var(--spend); }
.bar-fill.saving { background: var(--saving); }
.bar-value { font-size: 13px; font-variant-numeric: tabular-nums; white-space: pre; text-align: right; }
.cols { display: flex; align-items: flex-end; gap: 2px; height: 200px; padding-top: 24px; border-bottom: 1px solid var(--axis); }
.col { flex: 1; height: 100%; position: relative; display: flex; align-items: flex-end; justify-content: center; border-radius: 6px; outline: none; }
.col:hover .col-fill, .col:focus-visible .col-fill { filter: brightness(1.15); }
.col:focus-visible { box-shadow: 0 0 0 2px var(--spend); }
.col-fill { width: min(24px, 70%); background: var(--spend); border-radius: 4px 4px 0 0; }
.col-value { position: absolute; font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.col-axis { display: flex; gap: 2px; margin-top: 6px; }
.col-axis span { flex: 1; text-align: center; font-size: 12px; line-height: 1.3; color: var(--muted); }
.table-view { margin-top: 12px; color: var(--ink-2); font-size: 13px; }
.table-view summary { cursor: pointer; }
table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
th { color: var(--muted); font-weight: 600; }
.scroll { overflow-x: auto; }
.findings, .fixes, .suggestions { display: grid; gap: 12px; }
.finding header, .fix header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.finding-value { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
.rank, .q { font-size: 12.5px; font-weight: 600; color: var(--muted); }
.rank { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border); display: inline-grid; place-items: center; }
.finding ul, .suggestions ul { margin: 10px 0 0; padding-left: 20px; color: var(--ink-2); }
.finding li, .suggestions li { margin: 4px 0; }
.what { background: var(--page); border-radius: 8px; padding: 12px 14px; color: var(--ink); }
.option { border-top: 1px solid var(--grid); padding-top: 14px; margin-top: 14px; }
.option:first-of-type { border-top: 0; margin-top: 4px; padding-top: 0; }
.applied + .applied { border-top: 1px solid var(--grid); margin-top: 12px; padding-top: 12px; }
.applied ul { margin: 6px 0 0; padding-left: 20px; color: var(--ink-2); }
.badge { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--ink-2); border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px 2px 4px; margin-bottom: 10px; }
.badge .icon { width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 11px; color: #0b0b0b; }
.badge.good .icon { background: var(--good); color: #fff; }
.badge.warn .icon { background: var(--warn); }
dl { display: grid; grid-template-columns: minmax(110px, 160px) 1fr; gap: 8px 16px; margin: 6px 0 0; }
dt { color: var(--muted); font-size: 13px; font-weight: 600; }
dd { margin: 0; color: var(--ink-2); }
dd .bars { margin-bottom: 4px; }
footer { margin-top: 36px; color: var(--muted); font-size: 13px; }
footer ul { padding-left: 20px; }
.tip { position: absolute; z-index: 10; pointer-events: none; background: var(--ink); color: var(--surface); font-size: 12.5px; padding: 6px 9px; border-radius: 6px; max-width: 280px; }
@media (max-width: 640px) {
  .hero-value { font-size: 44px; }
  dl { grid-template-columns: 1fr; gap: 2px 0; }
  dd { margin-bottom: 8px; }
  .col-axis span { font-size: 10.5px; }
}
</style>
</head>
<body>
<main>
<header>
<p class="brand">limit-xray</p>
<h1>${esc(D.heading)}</h1>
<p class="sub">${esc(D.sub({ days: r.window.days, from: loc.monthDay(r.window.from), to: loc.monthDay(r.window.to), asOf: loc.date(r.pricesAsOf) }))}</p>
</header>

<section class="card hero">
<p class="hero-label">${esc(D.spend)}</p>
<p class="hero-value">${esc(usd(total))}</p>
<p class="muted">${esc(D.requests({ requests: num(r.totals.requests), sessions: num(r.totals.sessions), outside: r.outside.cost ? usd(r.outside.cost) : '' }))}</p>
<p class="next"><strong>${esc(D.next)}</strong> ${qs.length ? rich(D.nextAsk({ n: qs.length })) : rich(D.nextNone({ inEffect }))}</p>
</section>

<div class="tiles">
${tile(D.tileReread, r.components.cacheRead, total, D.tileRereadFoot({ cost: usd(r.components.cacheRead) }), loc)}
${tile(D.tileOpus, opus, total, D.tileOpusFoot({ cost: usd(opus) }), loc)}
${tile(D.tileAgents, agents, total, D.tileAgentsFoot({ cost: usd(agents) }), loc)}
${tile(D.tileEffort, high, total, D.tileEffortFoot({ cost: usd(high) }), loc)}
</div>
<p class="muted">${esc(D.overlap)}</p>

${glance.days.rows.length <= 45 ? `<section class="card"><h2>${esc(glance.days.title)}</h2>${dayColumns(glance.days.rows, loc)}</section>` : ''}

<div class="grid">
${listCard(glance.where)}
${listCard(glance.models)}
${listCard(glance.source)}
${listCard(glance.effort)}
${listCard(glance.projects)}
${listCard(entry)}
</div>

<h2 class="section-title">${esc(D.driving)}</h2>
<p class="note">${esc(D.drivingNote)}</p>
<div class="findings">${findingCards || `<p class="card">${esc(t.report.nothing)}</p>`}</div>

<h2 class="section-title">${esc(D.fixesTitle)}</h2>
<p class="note">${rich(D.fixesNote({ file: tick(settingsFile) }))}</p>
${withSaving.length ? `<section class="card"><h2>${esc(D.savingsTitle)}</h2>${barList(withSaving.map((f) => ({ label: f.title, cost: f.savings.weekly, value: D.about({ cost: usd(f.savings.weekly) }) })), maxSaving, 'saving')}<p class="muted" style="margin-top:10px">${esc(D.savingsNote)}</p></section>` : ''}
<div class="fixes">${fixCards || `<p class="card">${esc(t.report.noFix)}</p>`}</div>

${suggestions.length ? `<h2 class="section-title">${esc(D.otherTitle)}</h2>
<p class="note">${esc(D.otherNote)}</p>
<div class="suggestions">${suggestions.map(([title, xs]) => `<section class="card"><h3>${esc(title)}</h3><ul>${xs.map((x) => `<li>${rich(x)}</li>`).join('')}</ul></section>`).join('')}</div>` : ''}

${sessions ? `<h2 class="section-title">${esc(D.sessionsTitle)}</h2>
<section class="card scroll"><table><thead><tr>${D.sessionsColumns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${sessions}</tbody></table><p class="muted" style="margin-top:8px">${esc(D.sessionsNote)}</p></section>` : ''}

${history.length ? `<h2 class="section-title">${esc(D.historyTitle)}</h2><p class="note">${rich(D.historyNote)}</p><section class="card">${history.join('')}</section>` : ''}

<footer>
<p><strong>${esc(D.notCounted)}</strong></p>
<ul>${notCounted(r, { lang }).map((x) => `<li>${rich(x)}</li>`).join('')}</ul>
<p>${esc(D.generated({ when: loc.dateTime(generatedAt) }))}</p>
</footer>
</main>
<div class="tip" role="tooltip" hidden></div>
<script>
(() => {
  const tip = document.querySelector('.tip');
  const show = (el) => {
    tip.textContent = el.getAttribute('data-tip');
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    const left = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2));
    tip.style.left = left + window.scrollX + 'px';
    tip.style.top = box.top + window.scrollY - tip.offsetHeight - 8 + 'px';
  };
  const hide = () => { tip.hidden = true; };
  for (const el of document.querySelectorAll('[data-tip]')) {
    el.addEventListener('pointerenter', () => show(el));
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', () => show(el));
    el.addEventListener('blur', hide);
  }
})();
</script>
</body>
</html>
`;
}
