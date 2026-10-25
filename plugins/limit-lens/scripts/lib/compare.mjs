// Compare usage before and after an experiment. Workload differs between periods, so the table leads
// with per-day and per-request cost and with shares, not with totals.
import { usd, pct, tokens, sumCost } from './format.mjs';

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

const change = (before, after) => (before ? `${after >= before ? '+' : ''}${Math.round(((after - before) / before) * 100)}%` : 'n/a');
const points = (before, after) => `${after >= before ? '+' : ''}${Math.round((after - before) * 100)} pts`;
const share = (x) => pct(x, 1);

export function renderCompare(experiment, after) {
  const before = experiment.baseline;
  const applied = experiment.appliedAt.slice(0, 16).replace('T', ' ');
  const fixes = experiment.changes.map((c) => `\`${c.fixId}\``).join(', ');
  const lines = ['# limit-lens: before and after', '', `Experiment \`${experiment.id}\`, applied ${applied} UTC: ${fixes}.`];
  if (experiment.revertedAt) lines.push(`It was reverted on ${experiment.revertedAt.slice(0, 16).replace('T', ' ')} UTC, so "after" mixes both settings.`);
  lines.push('');
  if (after.activeDays < MIN_ACTIVE_DAYS || after.requests < MIN_REQUESTS) {
    lines.push(
      `It is too early to compare: since the change there are ${after.activeDays} active day${after.activeDays === 1 ? '' : 's'} and ${after.requests.toLocaleString('en-US')} requests.`,
      `Come back after at least ${MIN_ACTIVE_DAYS} active days and ${MIN_REQUESTS} requests of normal use. New settings apply to new sessions, so restart running ones.`,
    );
    return lines.join('\n') + '\n';
  }
  lines.push(
    `Before: the 7 days up to the change (${before.activeDays} active days, ${before.requests.toLocaleString('en-US')} requests). After: since the change (${after.activeDays} active days, ${after.requests.toLocaleString('en-US')} requests).`,
    '',
    '| Measure | Before | After | Change |',
    '| :- | -: | -: | -: |',
    `| Spend per active day | ${usd(before.spendPerActiveDay)} | ${usd(after.spendPerActiveDay)} | ${change(before.spendPerActiveDay, after.spendPerActiveDay)} |`,
    `| Spend per request | ${usd(before.spendPerRequest)} | ${usd(after.spendPerRequest)} | ${change(before.spendPerRequest, after.spendPerRequest)} |`,
    `| Opus share of spend | ${share(before.shares.opus)} | ${share(after.shares.opus)} | ${points(before.shares.opus, after.shares.opus)} |`,
    `| xhigh and max effort share | ${share(before.shares.highEffort)} | ${share(after.shares.highEffort)} | ${points(before.shares.highEffort, after.shares.highEffort)} |`,
    `| Agents share | ${share(before.shares.agents)} | ${share(after.shares.agents)} | ${points(before.shares.agents, after.shares.agents)} |`,
    `| Re-reading share | ${share(before.shares.reread)} | ${share(after.shares.reread)} | ${points(before.shares.reread, after.shares.reread)} |`,
    `| Automated turns share | ${share(before.shares.automated)} | ${share(after.shares.automated)} | ${points(before.shares.automated, after.shares.automated)} |`,
    `| Average main-conversation context | ${tokens(before.avgMainContext)} | ${tokens(after.avgMainContext)} | ${change(before.avgMainContext, after.avgMainContext)} |`,
    '',
    'Workload differs between the two periods: trust per-request cost and shares more than totals. Spend is API-equivalent at list prices; on a subscription it shows how the usage limit was spent.',
  );
  return lines.join('\n') + '\n';
}
