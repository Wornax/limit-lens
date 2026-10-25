// Compare usage before and after an experiment. Workload differs between periods, so the table leads
// with per-day and per-request cost and with shares, not with totals. Texts come from the language catalogs.
import { sumCost } from './format.mjs';
import { locale } from './i18n/index.mjs';

const MIN_ACTIVE_DAYS = 2;
const MIN_REQUESTS = 200;
const isOpus = (k) => k.startsWith('opus');

export function metrics(r) {
  const total = r.totals.cost;
  const share = (x) => (total ? x / total : 0);
  const opus = sumCost(Object.fromEntries(Object.entries(r.byModel).filter(([k]) => isOpus(k))));
  return {
    from: r.window.from,
    to: r.window.to,
    activeDays: r.activeDays,
    requests: r.totals.requests,
    spend: total,
    spendPerActiveDay: r.activeDays ? total / r.activeDays : 0,
    spendPerRequest: r.totals.requests ? total / r.totals.requests : 0,
    shares: {
      opus: share(opus),
      highEffort: share((r.byEffort.xhigh?.cost || 0) + (r.byEffort.max?.cost || 0)),
      agents: share(r.agents.subagent.cost + r.agents.workflow.cost),
      reread: share(r.components.cacheRead),
      automated: share(r.turns.automated.cost),
      startup: share(r.startup.cost),
    },
    avgMainContext: r.context.avgPromptTokens,
  };
}

const sign = (before, after) => (after >= before ? '+' : '');

export function renderCompare(experiment, after, { lang = 'en' } = {}) {
  const { t, usd, pct, tokens, num, utc } = locale(lang);
  const C = t.compare;
  const change = (b, a) => (b ? `${sign(b, a)}${Math.round(((a - b) / b) * 100)}%` : C.na);
  const points = (b, a) => C.points({ n: `${sign(b, a)}${Math.round((a - b) * 100)}` });
  const share = (x) => pct(x, 1);
  const before = experiment.baseline;
  const fixes = experiment.changes.map((c) => `\`${c.fixId}\``).join(', ');
  const lines = [C.title, '', C.experiment({ id: experiment.id, when: utc(experiment.appliedAt), fixes })];
  if (experiment.revertedAt) lines.push(C.reverted({ when: utc(experiment.revertedAt) }));
  lines.push('');
  if (after.activeDays < MIN_ACTIVE_DAYS || after.requests < MIN_REQUESTS) {
    lines.push(
      C.tooEarly({ days: after.activeDays, requests: num(after.requests) }),
      C.comeBack({ days: MIN_ACTIVE_DAYS, requests: MIN_REQUESTS }),
    );
    return lines.join('\n') + '\n';
  }
  const row = (label, b, a, cell, delta) => `| ${label} | ${cell(b)} | ${cell(a)} | ${delta(b, a)} |`;
  lines.push(
    C.periods({ beforeDays: before.activeDays, beforeRequests: num(before.requests), afterDays: after.activeDays, afterRequests: num(after.requests) }),
    '',
    C.header,
    '| :- | -: | -: | -: |',
    row(C.perDay, before.spendPerActiveDay, after.spendPerActiveDay, usd, change),
    row(C.perRequest, before.spendPerRequest, after.spendPerRequest, usd, change),
    row(C.opus, before.shares.opus, after.shares.opus, share, points),
    row(C.highEffort, before.shares.highEffort, after.shares.highEffort, share, points),
    row(C.agents, before.shares.agents, after.shares.agents, share, points),
    row(C.reread, before.shares.reread, after.shares.reread, share, points),
    row(C.automated, before.shares.automated, after.shares.automated, share, points),
    row(C.context, before.avgMainContext, after.avgMainContext, tokens, change),
    '',
    C.caveat,
  );
  return lines.join('\n') + '\n';
}
