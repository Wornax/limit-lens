// Regressions from the v0.3 review (2026-10-25). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { applicableFixes } from '../plugins/limit-lens/scripts/lib/fixes.mjs';
import { findings } from '../plugins/limit-lens/scripts/lib/findings.mjs';
import { renderPlan } from '../plugins/limit-lens/scripts/lib/report.mjs';
import { NOW, minutesAgo, tempRoot, assistant, writeTranscript } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-lens', 'scripts', 'limit-lens.mjs');
const M = 1_000_000;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const ids = (fixes) => fixes.map((f) => f.id);
const plan = (r, fixes) => renderPlan({ report: r, found: findings(r), fixes, habits: [], settingsFile: 'settings.json', last: null, undo: null, warning: null });

async function base() {
  const r = await analyze({ projectsDirs: [tempRoot().projects], now: NOW, days: 7, securityLog: null });
  r.totals.cost = 100;
  r.totals.requests = 1000;
  return r;
}

async function heavyAgents() {
  const r = await base();
  Object.assign(r.agents.subagent, { cost: 60, requests: 600, agents: 6 });
  r.agents.subagent.byModel['opus-5-5'] = { cost: 40, requests: 400 };
  r.byProject = { 'proj-a': { cost: 100, mainCost: 40, agentCost: 60, opusMainCost: 0, opusAgentCost: 40, highEffortCost: 0, highEffortByModel: {}, requestsOver200k: 0 } };
  return r;
}

function withStopReviews(r, cost = 4) {
  r.plugins.securityGuidance = { reviews: { stop: { count: 10, cost }, commit: { count: 0, cost: 0 }, push: { count: 0, cost: 0 } }, outsideTranscriptsCost: cost };
  r.outside.cost = cost;
  return r;
}

test('report --json adds up projects whose cleaned names collide instead of dropping one', () => {
  const { root, projects } = tempRoot();
  const stem = 'a'.repeat(80);
  writeTranscript(projects, `${stem}X/s1.jsonl`, [assistant({ ts: minutesAgo(10), usage: { output_tokens: M } })]);
  writeTranscript(projects, `${stem}Y/s2.jsonl`, [assistant({ ts: minutesAgo(9), usage: { output_tokens: M } })]);
  const res = spawnSync(process.execPath, [CLI, '--json', '--config-dir', root, '--now', new Date(NOW).toISOString()], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const { report } = JSON.parse(res.stdout);
  const sum = Object.values(report.byProject).reduce((s, b) => s + b.cost, 0);
  close(sum, report.totals.cost);
});

test('the diagnosis shows plugin spend outside the transcripts', async () => {
  const r = withStopReviews(await heavyAgents(), 50);
  const md = plan(r, applicableFixes(r, {}));
  const diag = md.slice(md.indexOf('## What is eating your limit'), md.indexOf('### Question 1'));
  assert.match(diag, /plus \$50 of plugin calls outside transcripts/);
});

test('the Sonnet saving follows the price of each Opus version', async () => {
  const r = await heavyAgents();
  r.agents.subagent.byModel = { 'opus-4-8': { cost: 40, requests: 400 } };
  const f = applicableFixes(r, {}).find((x) => x.id === 'subagent-model-sonnet');
  close(f.savings.weekly, 24); // Sonnet 5.5 is at most 40% of the Opus 4.8 price for every token kind
});

test('the security Sonnet fixes are offered only while the review runs on Opus, and saved at that model\'s price', async () => {
  const r = withStopReviews(await heavyAgents());
  r.toolSessions = { 'security-guidance review': { cost: 6, requests: 60, sessions: 3 } };
  for (const model of ['claude-haiku-5-5', 'claude-sonnet-4-5']) {
    const got = ids(applicableFixes(r, { env: { SECURITY_REVIEW_MODEL: model, SG_AGENTIC_MODEL: model } }));
    assert.ok(!got.includes('security-review-sonnet'), model);
    assert.ok(!got.includes('security-agentic-sonnet'), model);
  }
  const old = applicableFixes(r, { env: { SECURITY_REVIEW_MODEL: 'claude-opus-4-1' } }).find((x) => x.id === 'security-review-sonnet');
  close(old.savings.weekly, 4 * (1 - 2 / 15));
});

test('the per-turn review fixes are not offered once that review is off (the plugin turns it off only for "0")', async (t) => {
  const r = withStopReviews(await heavyAgents());
  const off = ids(applicableFixes(r, { env: { ENABLE_STOP_REVIEW: '0' } }));
  assert.ok(!off.includes('security-review-sonnet'));
  assert.ok(!off.includes('security-stop-review-off'));
  const saved = process.env.ENABLE_STOP_REVIEW;
  t.after(() => (saved === undefined ? delete process.env.ENABLE_STOP_REVIEW : (process.env.ENABLE_STOP_REVIEW = saved)));
  process.env.ENABLE_STOP_REVIEW = '0';
  assert.ok(!ids(applicableFixes(r, {})).includes('security-review-sonnet'));
  delete process.env.ENABLE_STOP_REVIEW;
  const notOff = ids(applicableFixes(r, { env: { ENABLE_STOP_REVIEW: 'false' } }));
  assert.ok(notOff.includes('security-review-sonnet'));
  assert.ok(notOff.includes('security-stop-review-off'));
});

test('the commit and push review fix falls back to the plugin log cost when no review session is in the transcripts', async () => {
  const r = await heavyAgents();
  r.plugins.securityGuidance = { reviews: { stop: { count: 0, cost: 0 }, commit: { count: 2, cost: 3 }, push: { count: 1, cost: 1 } }, outsideTranscriptsCost: 0 };
  const f = applicableFixes(r, {}).find((x) => x.id === 'security-agentic-sonnet');
  close(f.savings.weekly, 2);
});

test('an agent type found in both agent lenses is one contributor', async () => {
  const r = await heavyAgents();
  r.agents.subagent.byType = { 'general-purpose': { cost: 10, requests: 100, opusCost: 10 } };
  r.agents.workflow.byType = { 'general-purpose': { cost: 15, requests: 150, opusCost: 15 } };
  const f = applicableFixes(r, {}).find((x) => x.id === 'subagent-model-sonnet');
  const types = f.contributors.filter((c) => c.kind === 'agent type');
  assert.deepEqual(types.map((c) => [c.name, c.cost]), [['general-purpose', 25]]);
});

test('high-effort spend is attributed per model, and the effort fix names projects by that model', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: minutesAgo(10), model: 'claude-opus-5-5', effort: 'xhigh', usage: { output_tokens: M } }), // $20
    assistant({ ts: minutesAgo(9), model: 'claude-sonnet-5-5', effort: 'xhigh', usage: { output_tokens: M } }), // $10
  ]);
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  close(r.byProject.p.highEffortByModel['opus-5-5'], 20);
  close(r.byProject.p.highEffortByModel['sonnet-5-5'], 10);
  const f = applicableFixes(r, { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }).find((x) => x.id === 'effort-high-claude-opus-5-5');
  assert.deepEqual(f.contributors.map((c) => [c.name, c.cost]), [['p', 20]]);
});

test('auto-compaction at 300K is offered only when requests went past 300K, and names those sessions', async () => {
  const { projects } = tempRoot();
  const mid = { cache_read_input_tokens: 250_000, output_tokens: 100 };
  const big = { cache_read_input_tokens: 400_000, output_tokens: 100 };
  writeTranscript(projects, 'p/mid.jsonl', [1, 2, 3].map((i) => assistant({ ts: minutesAgo(20 - i), usage: mid })));
  writeTranscript(projects, 'p/big.jsonl', [assistant({ ts: minutesAgo(10), usage: big })]);
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  assert.equal(r.context.requestsOver200k, 4);
  assert.equal(r.context.requestsOver300k, 1);
  assert.deepEqual(r.contextSessions.map((s) => s.sessionId), ['big']);
  assert.ok(ids(applicableFixes(r, {})).includes('autocompact-300k'));
  r.context.requestsOver300k = 0;
  assert.ok(!ids(applicableFixes(r, {})).includes('autocompact-300k'));
  assert.ok(!JSON.stringify(findings(r).find((x) => x.id === 'reread')).includes('autoCompactWindow'));
});

test('the plan says the savings estimates do not add up', async () => {
  const r = withStopReviews(await heavyAgents());
  const md = plan(r, applicableFixes(r, {}));
  assert.match(md, /Estimated savings: about \$20 per week/);
  assert.match(md, /do not add up/);
});

test('the agents fix is not offered when the subagent model is already set in the shell', async (t) => {
  const r = await heavyAgents();
  t.after(() => delete process.env.CLAUDE_CODE_SUBAGENT_MODEL);
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'sonnet';
  assert.ok(!ids(applicableFixes(r, {})).includes('subagent-model-sonnet'));
});

test('the default-model fix is not offered when ANTHROPIC_MODEL overrides the settings model', async (t) => {
  const r = await heavyAgents();
  r.byModel = { 'opus-5-5': { cost: 80, requests: 800 } };
  assert.ok(ids(applicableFixes(r, { model: 'opus' })).includes('default-model-sonnet'));
  t.after(() => delete process.env.ANTHROPIC_MODEL);
  process.env.ANTHROPIC_MODEL = 'opus';
  assert.ok(!ids(applicableFixes(r, { model: 'opus' })).includes('default-model-sonnet'));
});

test('auto-compaction at 300K is not offered when CLAUDE_CODE_DISABLE_1M_CONTEXT already caps the window at 200K', async () => {
  const r = await heavyAgents();
  r.components.cacheRead = 60;
  r.context.requestsOver300k = 10;
  assert.ok(ids(applicableFixes(r, {})).includes('autocompact-300k'));
  assert.ok(!ids(applicableFixes(r, { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } })).includes('autocompact-300k'));
});

// Second review: fixes that would change nothing must not be offered.

test('a family alias such as "opus" in the security-guidance variables is priced as the newest Opus', async () => {
  const r = withStopReviews(await heavyAgents());
  r.toolSessions = { 'security-guidance review': { cost: 8, requests: 80, sessions: 4 } };
  for (const model of ['opus', 'opus[1m]']) {
    const fixes = applicableFixes(r, { env: { SECURITY_REVIEW_MODEL: model, SG_AGENTIC_MODEL: model } });
    close(fixes.find((x) => x.id === 'security-review-sonnet').savings.weekly, 2);
    close(fixes.find((x) => x.id === 'security-agentic-sonnet').savings.weekly, 4);
  }
});

test('the agents fix leaves out the built-in Explore and Plan agents, which the variable does not move', async () => {
  const r = await heavyAgents();
  r.agents.subagent.byType = { Explore: { cost: 25, requests: 250, opusCost: 25 }, Plan: { cost: 15, requests: 150, opusCost: 15 } };
  assert.ok(!ids(applicableFixes(r, {})).includes('subagent-model-sonnet'));
  r.agents.subagent.byType = { Explore: { cost: 20, requests: 200, opusCost: 20 }, 'general-purpose': { cost: 20, requests: 200, opusCost: 20 } };
  const f = applicableFixes(r, {}).find((x) => x.id === 'subagent-model-sonnet');
  close(f.savings.weekly, 10); // half of the $20 that can move
  assert.deepEqual(f.contributors.filter((c) => c.kind === 'agent type').map((c) => c.name), ['general-purpose']);
});

test('the hold fix is not offered when cross-session messages are already refused', async () => {
  const r = await heavyAgents();
  r.turns.automated.byKind.peer = { cost: 10, requests: 10 };
  assert.ok(ids(applicableFixes(r, {})).includes('cross-session-hold'));
  assert.ok(!ids(applicableFixes(r, { crossSessionInbound: 'refuse' })).includes('cross-session-hold'));
});

test('the security-guidance model fixes are skipped on every third-party provider', async () => {
  const r = withStopReviews(await heavyAgents());
  r.toolSessions = { 'security-guidance review': { cost: 6, requests: 60, sessions: 3 } };
  for (const flag of ['CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS']) {
    const got = ids(applicableFixes(r, { env: { [flag]: '1' } }));
    assert.ok(!got.includes('security-review-sonnet') && !got.includes('security-agentic-sonnet'), flag);
  }
});

test('the fast-mode fix is not offered when fast mode cannot carry over to new sessions', async () => {
  const r = await heavyAgents();
  r.fastMode = { cost: 20, requests: 10 };
  assert.ok(ids(applicableFixes(r, { fastMode: true })).includes('fast-mode-off'));
  assert.ok(!ids(applicableFixes(r, { fastMode: true, fastModePerSessionOptIn: true })).includes('fast-mode-off'));
  assert.ok(!ids(applicableFixes(r, { fastMode: true, env: { CLAUDE_CODE_DISABLE_FAST_MODE: '1' } })).includes('fast-mode-off'));
});

test('auto-compaction at 300K is not offered when automatic compaction is off', async () => {
  const r = await heavyAgents();
  r.components.cacheRead = 60;
  r.context.requestsOver300k = 10;
  for (const settings of [{ autoCompactEnabled: false }, { env: { DISABLE_AUTO_COMPACT: '1' } }, { env: { DISABLE_COMPACT: '1' } }]) {
    assert.ok(!ids(applicableFixes(r, settings)).includes('autocompact-300k'), JSON.stringify(settings));
  }
});

test('the security-guidance fixes follow the plugin\'s own off switches', async () => {
  const r = withStopReviews(await heavyAgents());
  r.toolSessions = { 'security-guidance review': { cost: 6, requests: 60, sessions: 3 } };
  const sg = (settings) => ids(applicableFixes(r, settings)).filter((id) => id.startsWith('security-'));
  assert.equal(sg({}).length, 3);
  for (const env of [{ SECURITY_GUIDANCE_DISABLE: 'true' }, { ENABLE_SECURITY_REMINDER: '0' }, { ENABLE_CODE_SECURITY_REVIEW: '0' }]) {
    assert.deepEqual(sg({ env }), [], JSON.stringify(env));
  }
  assert.deepEqual(sg({ enabledPlugins: { 'security-guidance@claude-plugins-official': false } }), []);
  for (const env of [{ SG_AGENTIC_COMMIT_REVIEW: 'off' }, { ENABLE_COMMIT_REVIEW: '0' }]) {
    assert.deepEqual(sg({ env }), ['security-review-sonnet', 'security-stop-review-off'], JSON.stringify(env));
  }
});

test('the effort fix is not offered when maxEffortLevel already caps the model below xhigh', async () => {
  const r = await heavyAgents();
  r.byEffort = { xhigh: { cost: 60, requests: 600 } };
  r.byModel = { 'opus-5-5': { cost: 90, requests: 900 } };
  const saved = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } };
  assert.ok(ids(applicableFixes(r, saved)).includes('effort-high-claude-opus-5-5'));
  assert.ok(!ids(applicableFixes(r, { ...saved, maxEffortLevel: 'high' })).includes('effort-high-claude-opus-5-5'));
});
