// The analyze dashboard: one self-contained HTML page with the report's numbers drawn as cards and bar
// charts. It loads nothing from the network (no fonts, scripts or styles from elsewhere), so it opens the
// same offline. Every string from disk or from the report is escaped; values are always printed beside
// their bars, so a chart never hides a number.
import { usd, pct, tokens, topEntries } from './format.mjs';
import { clean, questions, contributorName, glanceData, otherSuggestions, notCounted, sessionLabel } from './report.mjs';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);
// Escaped text where `code` spans become <code>.
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const ENTRYPOINTS = { cli: 'Terminal', 'claude-desktop': 'Desktop app', 'sdk-py': 'Python SDK', 'sdk-ts': 'TypeScript SDK' };
const CONTRIBUTORS = { project: 'Biggest projects', 'agent type': 'Biggest agent types', session: 'Largest sessions', review: 'Reviews' };

// Horizontal bars: label, bar, value. `max` is the value of a full-width bar.
function barList(rows, max, tone = 'spend') {
  return `<div class="bars">${rows.map((x) => {
    const w = x.cost > 0 && max ? Math.max(0.8, (x.cost / max) * 100) : 0;
    return `<div class="bar-row" tabindex="0" data-tip="${esc(x.tip || `${x.label}: ${x.value}`)}"><span class="bar-label">${esc(x.label)}</span><span class="bar-track"><span class="bar-fill ${tone}" style="width:${w.toFixed(2)}%"></span></span><span class="bar-value">${esc(x.value)}</span></div>`;
  }).join('')}</div>`;
}

// Columns for spend by day, the busiest day and today labelled on the cap; every day has a tooltip and a table row.
function dayColumns(rows) {
  const max = Math.max(...rows.map((x) => x.cost));
  const peak = rows.findIndex((x) => x.cost === max);
  const cols = rows.map((x, i) => {
    const h = max ? (x.cost / max) * 100 : 0;
    const tip = `${x.label}: ${usd(x.cost)}, ${x.requests.toLocaleString('en-US')} requests`;
    const value = (i === peak || i === rows.length - 1) && x.cost > 0 ? `<span class="col-value" style="bottom:calc(${h.toFixed(2)}% + 4px)">${esc(usd(x.cost))}</span>` : '';
    return `<div class="col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}">${value}<span class="col-fill" style="height:${h.toFixed(2)}%"></span></div>`;
  });
  const axis = rows.map((x) => {
    const [day, date] = x.label.split(' ');
    return `<span>${esc(day)}<br>${esc(date)}</span>`;
  });
  const table = rows.map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(usd(x.cost))}</td><td>${x.requests.toLocaleString('en-US')}</td></tr>`).join('');
  return `<div class="cols">${cols.join('')}</div><div class="col-axis">${axis.join('')}</div>
<details class="table-view"><summary>Show as a table</summary><table><thead><tr><th>Day</th><th>Spend</th><th>Requests</th></tr></thead><tbody>${table}</tbody></table></details>`;
}

const meter = (share) => `<span class="meter" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0, share * 100)).toFixed(2)}%"></span></span>`;

function tile(label, cost, total, foot) {
  return `<div class="card tile"><p class="tile-label">${esc(label)}</p><p class="tile-value">${esc(pct(cost, total))}</p>${meter(total ? cost / total : 0)}<p class="tile-foot">${esc(foot)}</p></div>`;
}

const show = (v) => (v === undefined || v === null ? 'not set' : `<code>${esc(JSON.stringify(v))}</code>`);
const source = (docs) => (/^https:\/\//.test(docs) ? `<a href="${esc(docs)}">${esc(docs.replace(/^https:\/\//, ''))}</a>` : rich(docs));

function option(f, maxSaving, withTitle) {
  const change = f.target === 'memory'
    ? `Add to <code>${esc(f.file)}</code>: “${rich(f.rule)}”`
    : `<code>${esc(f.path.join('.'))}</code>: ${show(f.current)} → ${show(f.value)}`;
  const kinds = [...new Set((f.contributors || []).map((c) => c.kind))];
  const who = kinds.map((k) => `<dt>${esc(CONTRIBUTORS[k] || k)}</dt><dd>${f.contributors.filter((c) => c.kind === k)
    .map((c) => `${esc(contributorName(c))} <span class="muted">${esc(usd(c.cost))}${c.detail ? `, ${esc(c.detail)}` : ''}</span>`).join('<br>')}</dd>`).join('');
  const saving = f.savings?.weekly == null
    ? `<dd><span class="muted">Measured after a few days with <code>/limit-lens:analyze compare</code>.</span> ${rich(f.savings?.basis || '')}</dd>`
    : `<dd>${barList([{ label: 'per week', cost: f.savings.weekly, value: `about ${usd(f.savings.weekly)}` }], maxSaving, 'saving')}<span class="muted">${rich(f.savings.basis)}</span></dd>`;
  const costOnly = f.kind === 'cost-only';
  return `<div class="option">
${withTitle ? `<h4><code>${esc(f.id)}</code> ${esc(f.title)}</h4>` : ''}
<p class="badge ${costOnly ? 'good' : 'warn'}"><span class="icon" aria-hidden="true">${costOnly ? '✓' : '!'}</span>${costOnly ? 'Cost only' : 'Changes how Claude works for you'}</p>
<p>${rich(f.effect)}</p>
<dl><dt>Change</dt><dd>${change}</dd><dt>Why</dt><dd>${rich(f.why)}</dd>${who}<dt>Estimated saving</dt>${saving}<dt>Source</dt><dd>${source(f.docs)}</dd></dl>
</div>`;
}

export function renderDashboard({ report: r, found, fixes, habits = [], settingsFile, last = null, undo = null, active = [], warning = null, generatedAt = Date.now() }) {
  const total = r.totals.cost;
  const glance = Object.fromEntries(glanceData(r, { projects: 5 }).map((s) => [s.id, s]));
  const share = (x) => `${pct(x.cost, total)}  ${usd(x.cost)}`;
  const listCard = (s) => (s.rows.length ? `<section class="card"><h2>${esc(s.title)}</h2>${barList(s.rows.map((x) => ({ ...x, value: share(x) })), total)}</section>` : '');
  const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const opus = Object.entries(r.byModel).filter(([k]) => k.startsWith('opus')).reduce((s, [, b]) => s + b.cost, 0);
  const agents = r.agents.subagent.cost + r.agents.workflow.cost;
  const high = (r.byEffort.xhigh?.cost || 0) + (r.byEffort.max?.cost || 0);
  const entry = { id: 'entry', title: 'Started from', rows: Object.entries(r.byEntrypoint).filter(([, b]) => b.cost > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, 4).map(([k, b]) => ({ label: ENTRYPOINTS[k] || clean(k), cost: b.cost })) };
  const qs = questions(fixes);
  const withSaving = fixes.filter((f) => f.savings?.weekly != null).sort((a, b) => b.savings.weekly - a.savings.weekly);
  const maxSaving = withSaving.length ? withSaving[0].savings.weekly : 0;
  const suggestions = otherSuggestions(found, fixes, habits);

  const findingCards = found.slice(0, 6).map((f, i) => `<article class="card finding">
<header><span class="rank">${i + 1}</span><h3>${esc(f.title)}</h3><span class="finding-value">${esc(pct(f.cost, total))} <span class="muted">${esc(usd(f.cost))}${f.outsideCost ? `, plus ${esc(usd(f.outsideCost))} outside the total` : ''}</span></span></header>
${meter(total ? f.cost / total : 0)}
<ul>${f.evidence.map((e) => `<li>${rich(e)}</li>`).join('')}</ul>
</article>`).join('');

  const fixCards = qs.map((q, i) => `<article class="card fix">
<header><span class="q">Question ${i + 1}</span><h3>${esc(q.title)}</h3></header>
<p class="what"><strong>What it is.</strong> ${rich(q.what)}</p>
${q.options.length > 1 ? '<p class="muted">Alternatives: choose one or neither.</p>' : ''}
${q.options.map((f) => option(f, maxSaving, q.options.length > 1)).join('')}
</article>`).join('');

  const sessions = r.topSessions.slice(0, 5).map((s, i) => `<tr><td>${esc(clean(s.project))}</td><td><code>${esc(sessionLabel(s.sessionId, i, false))}</code></td><td>${esc(ENTRYPOINTS[s.entrypoint] || clean(s.entrypoint))}</td><td>${esc(usd(s.cost))}</td><td>${s.requests.toLocaleString('en-US')}</td><td>${esc(tokens(s.avgPromptTokens))}</td><td>${esc(pct(s.rereadCost, s.cost))}</td></tr>`).join('');

  const history = [];
  const when = (iso) => esc(iso.slice(0, 16).replace('T', ' '));
  const change = (c) => (c.kind === 'memory' ? `the model-routing rule in <code>${esc(c.file)}</code>` : `<code>${esc(c.path.join('.'))}</code> = ${show(c.after)}`);
  for (const e of active) history.push(`<div class="applied"><p><code>${esc(e.id)}</code> <span class="muted">applied ${when(e.appliedAt)} UTC</span></p><ul>${e.changes.map((c) => `<li>${change(c)}</li>`).join('')}</ul></div>`);
  if (!active.length && last) history.push(`<p>Last change: <code>${esc(last.id)}</code>, applied ${when(last.appliedAt)} UTC: ${last.changes.map((c) => `<code>${esc(c.fixId)}</code>`).join(', ')}${last.revertedAt ? ' (reverted)' : ''}.</p>`);
  const inEffect = active.reduce((s, e) => s + e.changes.length, 0);
  if (undo) {
    history.push(`<div class="applied"><p><code>/limit-lens:analyze revert</code> would undo <code>${esc(undo.id)}</code>:</p><ul>${undo.changes.map((c) => (c.kind === 'memory'
      ? `<li><code>${esc(c.file)}</code>: the model-routing rule is removed</li>`
      : `<li><code>${esc(c.path.join('.'))}</code> → ${c.hadKey ? show(c.restore) : 'removed'}</li>`)).join('')}</ul></div>`);
  }
  if (warning) history.push(`<p class="badge warn"><span class="icon" aria-hidden="true">!</span>${esc(warning)}</p>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>limit-lens dashboard</title>
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
<p class="brand">limit-lens</p>
<h1>Where your Claude Code limit goes</h1>
<p class="sub">Last ${r.window.days} days, ${esc(day(r.window.from))} to ${esc(day(r.window.to))} · this computer · API list prices as of ${esc(r.pricesAsOf)}</p>
</header>

<section class="card hero">
<p class="hero-label">API-equivalent spend</p>
<p class="hero-value">${esc(usd(total))}</p>
<p class="muted">${r.totals.requests.toLocaleString('en-US')} requests in ${r.totals.sessions.toLocaleString('en-US')} sessions${r.outside.cost ? `, plus ${esc(usd(r.outside.cost))} of plugin calls outside transcripts` : ''}. On a subscription this is not a bill: it shows how your usage limit was spent.</p>
<p class="next">${qs.length ? `<strong>Next:</strong> Claude asks you about ${qs.length} fix${qs.length === 1 ? '' : 'es'} in the conversation, shown below. Nothing changes until you choose; every change is backed up, and <code>/limit-lens:analyze revert</code> undoes it.` : `<strong>Next:</strong> no fix applies right now${inEffect ? `: ${inEffect} change${inEffect === 1 ? '' : 's'} from earlier runs ${inEffect === 1 ? 'is' : 'are'} already in effect, listed at the end` : ''}. The suggestions below are yours to try.`}</p>
</section>

<div class="tiles">
${tile('Re-reading context', r.components.cacheRead, total, `${usd(r.components.cacheRead)}: every request re-sends the conversation`)}
${tile('On Opus', opus, total, `${usd(opus)} of spend on Opus models`)}
${tile('In agents', agents, total, `${usd(agents)} in subagents and workflow agents`)}
${tile('At xhigh or max effort', high, total, `${usd(high)} at the two highest effort levels`)}
</div>
<p class="muted">These overlap: one request can count in several.</p>

${glance.days.rows.length <= 45 ? `<section class="card"><h2>Spend by day</h2>${dayColumns(glance.days.rows)}</section>` : ''}

<div class="grid">
${listCard(glance.where)}
${listCard(glance.models)}
${listCard(glance.source)}
${listCard(glance.effort)}
${listCard(glance.projects)}
${listCard(entry)}
</div>

<h2 class="section-title">What is driving it</h2>
<p class="note">Each finding is a share of the total; they overlap.</p>
<div class="findings">${findingCards || '<p class="card">Nothing stands out: no lens crossed its threshold.</p>'}</div>

<h2 class="section-title">Fixes you can apply</h2>
<p class="note">Claude asks about each one in the conversation, Skip first. The settings file is <code>${esc(settingsFile)}</code>; changes apply to new sessions.</p>
${withSaving.length ? `<section class="card"><h2>Estimated weekly savings</h2>${barList(withSaving.map((f) => ({ label: f.title, cost: f.savings.weekly, value: `about ${usd(f.savings.weekly)}` })), maxSaving, 'saving')}<p class="muted" style="margin-top:10px">Each estimate assumes that fix alone, at list prices; they do not add up. Effort, auto-compaction and model routing are measured after a few days instead.</p></section>` : ''}
<div class="fixes">${fixCards || '<p class="card">No fix applies right now: either nothing crossed its threshold, or your settings already have these values.</p>'}</div>

${suggestions.length ? `<h2 class="section-title">Other suggestions</h2>
<p class="note">Things only you can do: slash commands to type, habits, and changes to your own agents and skills.</p>
<div class="suggestions">${suggestions.map(([title, xs]) => `<section class="card"><h3>${esc(title)}</h3><ul>${xs.map((x) => `<li>${rich(x)}</li>`).join('')}</ul></section>`).join('')}</div>` : ''}

${sessions ? `<h2 class="section-title">Costliest sessions</h2>
<section class="card scroll"><table><thead><tr><th>Project</th><th>Session</th><th>From</th><th>Spend</th><th>Requests</th><th>Avg context</th><th>Re-read</th></tr></thead><tbody>${sessions}</tbody></table><p class="muted" style="margin-top:8px">Main conversation only, not its subagents.</p></section>` : ''}

${history.length ? `<h2 class="section-title">Changes in effect</h2><p class="note">What limit-lens changed earlier and is still in place, newest first. <code>/limit-lens:analyze compare</code> measures it; <code>/limit-lens:analyze revert</code> undoes the newest.</p><section class="card">${history.join('')}</section>` : ''}

<footer>
<p><strong>Not counted</strong></p>
<ul>${notCounted(r).map((x) => `<li>${rich(x)}</li>`).join('')}</ul>
<p>Generated by limit-lens on ${esc(new Date(generatedAt).toLocaleString('en-US'))}. Everything stayed on this computer.</p>
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
