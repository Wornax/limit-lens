import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-xray/scripts/lib/analyze.mjs';
import { findings } from '../plugins/limit-xray/scripts/lib/findings.mjs';
import { NOW, tempRoot } from './helpers.mjs';

// Start from the real report shape (all zeros), then set the numbers a scenario needs.
async function emptyReport() {
  return analyze({ projectsDirs: [tempRoot().projects], now: NOW, days: 7, securityLog: null });
}

test('a quiet report produces no findings', async () => {
  const r = await emptyReport();
  assert.deepEqual(findings(r), []);
});

test('heavy subagent spend recommends the subagent model setting', async () => {
  const r = await emptyReport();
  r.totals.cost = 100;
  r.agents.subagent.cost = 60;
  r.agents.subagent.requests = 600;
  r.agents.subagent.agents = 2;
  r.agents.subagent.avgPromptTokens = 380_000;
  r.agents.subagent.byModel = { 'opus-5-5': { cost: 50, requests: 500 } };
  const f = findings(r);
  assert.equal(f[0].id, 'agents');
  const text = JSON.stringify(f[0]);
  assert.match(text, /CLAUDE_CODE_SUBAGENT_MODEL/);
  assert.match(text, /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
});

test('findings are ordered by the spend they cover', async () => {
  const r = await emptyReport();
  r.totals.cost = 100;
  r.components.cacheRead = 40;
  r.mainConversation.requests = 10;
  r.context.avgPromptTokens = 300_000;
  r.byEffort = { xhigh: { cost: 70, requests: 5 } };
  const ids = findings(r).map((x) => x.id);
  assert.deepEqual(ids, ['effort', 'reread']);
});

test('the re-read finding points at /clear, /compact and the auto-compact window', async () => {
  const r = await emptyReport();
  r.totals.cost = 100;
  r.components.cacheRead = 60;
  r.mainConversation.requests = 10;
  r.context.requestsOver300k = 5; // huge contexts: auto-compaction advice applies
  const text = JSON.stringify(findings(r).find((x) => x.id === 'reread'));
  assert.match(text, /\/clear/);
  assert.match(text, /\/compact/);
  assert.match(text, /autoCompactWindow/);
});

test('security-guidance spend points at its own model switches', async () => {
  const r = await emptyReport();
  r.totals.cost = 100;
  r.toolSessions = { 'security-guidance review': { cost: 3, requests: 30, sessions: 5 } };
  r.outside.cost = 2;
  const f = findings(r).find((x) => x.id === 'plugins');
  assert.ok(f);
  assert.match(JSON.stringify(f), /SECURITY_REVIEW_MODEL/);
  assert.match(JSON.stringify(f), /ENABLE_STOP_REVIEW=0/);
});

test('any fast mode spend is reported', async () => {
  const r = await emptyReport();
  r.totals.cost = 100;
  r.fastMode = { cost: 1, requests: 1 };
  assert.ok(findings(r).some((x) => x.id === 'fast'));
});
