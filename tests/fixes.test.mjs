import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { applicableFixes, habits } from '../plugins/limit-lens/scripts/lib/fixes.mjs';
import { NOW, tempRoot } from './helpers.mjs';

async function report() {
  const r = await analyze({ projectsDirs: [tempRoot().projects], now: NOW, days: 7, securityLog: null });
  r.totals.cost = 100;
  r.totals.requests = 1000;
  return r;
}
const ids = (fixes) => fixes.map((f) => f.id);

test('heavy Opus agents get the subagent model fix, unless it is already set', async () => {
  const r = await report();
  Object.assign(r.agents.subagent, { cost: 50, requests: 500, agents: 5 });
  r.agents.subagent.byModel['opus-5-5'] = { cost: 40, requests: 400 };
  const f = applicableFixes(r, {}).find((x) => x.id === 'subagent-model-sonnet');
  assert.deepEqual(f.path, ['env', 'CLAUDE_CODE_SUBAGENT_MODEL']);
  assert.equal(f.value, 'sonnet');
  assert.equal(f.current, undefined);
  assert.ok(!ids(applicableFixes(r, { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } })).includes('subagent-model-sonnet'));
});

test('effort is lowered only for models saved at xhigh', async () => {
  const r = await report();
  r.byEffort = { xhigh: { cost: 60, requests: 600 } };
  r.byModel = { 'opus-5-5': { cost: 70, requests: 700 }, 'sonnet-5-5': { cost: 30, requests: 300 } };
  const saved = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-sonnet-5-5': { effortLevel: 'medium' } } };
  const f = applicableFixes(r, saved).filter((x) => x.id.startsWith('effort-high'));
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].path, ['modelSettings', 'claude-opus-5-5', 'effortLevel']);
  assert.equal(f[0].value, 'high');
  assert.equal(f[0].current, 'xhigh');
  assert.ok(!ids(applicableFixes(r, {})).some((id) => id.startsWith('effort-high')));
});

test('effort is not offered for a saved model with a negligible share of spend', async () => {
  const r = await report();
  r.byEffort = { xhigh: { cost: 60, requests: 600 } };
  r.byModel = { 'opus-5-5': { cost: 95, requests: 950 }, 'fable-5-1': { cost: 1, requests: 10 } };
  const saved = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-fable-5-1': { effortLevel: 'xhigh' } } };
  assert.deepEqual(ids(applicableFixes(r, saved)).filter((id) => id.startsWith('effort-high')), ['effort-high-claude-opus-5-5']);
});

test('auto-compaction is offered only when contexts get huge and it is not already lower', async () => {
  const r = await report();
  r.components.cacheRead = 60;
  r.context.requestsOver200k = 0;
  assert.ok(!ids(applicableFixes(r, {})).includes('autocompact-300k'));
  r.context.requestsOver200k = 50;
  assert.ok(ids(applicableFixes(r, {})).includes('autocompact-300k'));
  assert.ok(!ids(applicableFixes(r, { autoCompactWindow: 200000 })).includes('autocompact-300k'));
});

test('security-guidance fixes appear when the plugin shows up, and the stop review only when it spent', async () => {
  const r = await report();
  r.toolSessions = { 'security-guidance review': { cost: 3, requests: 30, sessions: 3 } };
  let got = ids(applicableFixes(r, {}));
  assert.ok(got.includes('security-review-sonnet'));
  assert.ok(got.includes('security-agentic-sonnet'));
  assert.ok(!got.includes('security-stop-review-off'));
  r.outside.cost = 2;
  r.plugins.securityGuidance = { reviews: {}, outsideTranscriptsCost: 2 };
  got = ids(applicableFixes(r, {}));
  assert.ok(got.includes('security-stop-review-off'));
});

test('fast mode and the default model are offered only when they apply', async () => {
  const r = await report();
  r.fastMode = { cost: 5, requests: 10 };
  assert.ok(ids(applicableFixes(r, { fastMode: true })).includes('fast-mode-off'));
  assert.ok(!ids(applicableFixes(r, { fastMode: false })).includes('fast-mode-off'));
  r.byModel = { 'opus-5-5': { cost: 80, requests: 800 } };
  assert.ok(ids(applicableFixes(r, { model: 'opus' })).includes('default-model-sonnet'));
  assert.ok(!ids(applicableFixes(r, { model: 'sonnet' })).includes('default-model-sonnet'));
});

test('every fix value is a plain JSON value and env values are strings', async () => {
  const r = await report();
  Object.assign(r.agents.subagent, { cost: 50, requests: 500, agents: 5 });
  r.agents.subagent.byModel['opus-5-5'] = { cost: 40, requests: 400 };
  r.toolSessions = { 'security-guidance review': { cost: 3, requests: 30, sessions: 3 } };
  r.outside.cost = 2;
  for (const f of applicableFixes(r, {})) {
    if (f.path[0] === 'env') assert.equal(typeof f.value, 'string', f.id);
    assert.ok(['string', 'number', 'boolean'].includes(typeof f.value), f.id);
  }
});

test('habits follow the findings', async () => {
  const r = await report();
  r.components.cacheRead = 60;
  assert.ok(habits(r).some((h) => h.includes('/clear')));
});
