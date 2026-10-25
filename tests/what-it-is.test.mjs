// Every question says what the thing is, in plain words, before asking about it. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-xray/scripts/lib/analyze.mjs';
import { applicableFixes, routingFix } from '../plugins/limit-xray/scripts/lib/fixes.mjs';
import { renderPlan } from '../plugins/limit-xray/scripts/lib/report.mjs';
import { NOW, tempRoot } from './helpers.mjs';

// A week where every fix applies.
async function everything() {
  const r = await analyze({ projectsDirs: [tempRoot().projects], now: NOW, days: 7, securityLog: null });
  r.totals.cost = 100;
  r.totals.requests = 1000;
  Object.assign(r.agents.subagent, { cost: 60, requests: 600, agents: 6 });
  r.agents.subagent.byModel['opus-5-5'] = { cost: 40, requests: 400 };
  r.agents.subagent.byType = { 'general-purpose': { cost: 60, requests: 600, opusCost: 40 } };
  r.byModel = { 'opus-5-5': { cost: 90, requests: 900 } };
  r.byEffort = { xhigh: { cost: 60, requests: 600 } };
  r.components.cacheRead = 60;
  r.context.requestsOver300k = 10;
  r.turns.automated.byKind.peer = { cost: 10, requests: 10 };
  r.plugins.securityGuidance = { reviews: { stop: { count: 10, cost: 4 }, commit: { count: 2, cost: 2 }, push: { count: 0, cost: 0 } }, outsideTranscriptsCost: 4 };
  r.outside.cost = 4;
  r.toolSessions = { 'security-guidance review': { cost: 6, requests: 60, sessions: 3 } };
  r.fastMode = { cost: 20, requests: 10 };
  const settings = { model: 'opus', fastMode: true, modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } };
  const fixes = [routingFix(r, { file: 'CLAUDE.md', rule: 'the rule' }), ...applicableFixes(r, settings)];
  return { r, fixes };
}

test('every fix says what it is', async () => {
  const { fixes } = await everything();
  assert.equal(fixes.length, 10, fixes.map((f) => f.id).join());
  for (const f of fixes) assert.ok(typeof f.what === 'string' && f.what.length > 40, f.id);
});

test('the routing fix explains model routing: a model per task, from Haiku to Opus', async () => {
  const { fixes } = await everything();
  const what = fixes.find((f) => f.id === 'model-routing-rule').what;
  for (const word of ['Haiku', 'Sonnet', 'Opus', 'subagent']) assert.match(what, new RegExp(word));
});

test('each question opens with what it is, said once even for alternatives', async () => {
  const { r, fixes } = await everything();
  const md = renderPlan({ report: r, fixes, habits: [], settingsFile: 'settings.json', last: null, undo: null, warning: null });
  const blocks = md.split(/^### /m).slice(1);
  assert.equal(blocks.length, 9); // ten fixes, two of them alternatives in one question
  for (const b of blocks) {
    const firstItem = b.split('\n').find((l) => l.startsWith('- '));
    assert.match(firstItem, /^- What it is: /, b.split('\n')[0]);
    assert.equal(b.match(/What it is: /g).length, 1, b.split('\n')[0]);
  }
});
