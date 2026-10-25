// Every change still in effect is shown, newest first, in the plan, in analyze and in the dashboard.
// Synthetic data and temp folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../plugins/limit-xray/scripts/lib/analyze.mjs';
import { findings } from '../plugins/limit-xray/scripts/lib/findings.mjs';
import { currentPlan, applyFixes, revertExperiment, planHistory } from '../plugins/limit-xray/scripts/lib/experiments.mjs';
import { renderPlan, renderAnalyze } from '../plugins/limit-xray/scripts/lib/report.mjs';
import { renderDashboard } from '../plugins/limit-xray/scripts/lib/dashboard.mjs';
import { NOW, minutesAgo, tempRoot, assistant, writeTranscript, writeJson } from './helpers.mjs';

const M = 1_000_000;

// Two experiments: the routing rule, then the default model.
async function twoExperiments() {
  const { root, projects } = tempRoot();
  writeTranscript(projects, 'p/s1.jsonl', [assistant({ ts: minutesAgo(20), model: 'claude-opus-5-5', usage: { output_tokens: M } })]);
  writeTranscript(projects, 'p/s1/subagents/agent-1.jsonl', [assistant({ ts: minutesAgo(19), model: 'claude-opus-5-5', usage: { output_tokens: M } })]);
  writeJson(projects, 'p/s1/subagents/agent-1.meta.json', { agentType: 'general-purpose' });
  fs.writeFileSync(path.join(root, 'settings.json'), '{"model":"opus"}\n');
  const report = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  const first = applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  const second = applyFixes({ configDir: root, fixIds: ['default-model-sonnet'], report, now: NOW + 60_000 });
  return { root, report, first, second };
}

test('the history lists every experiment still in effect, newest first', async () => {
  const { root, first, second } = await twoExperiments();
  assert.deepEqual(planHistory(root).active.map((e) => e.id), [second.id, first.id]);
  revertExperiment({ configDir: root, now: NOW + 120_000 });
  assert.deepEqual(planHistory(root).active.map((e) => e.id), [first.id]);
});

test('the plan and analyze say what is in effect, change by change', async () => {
  const { root, report, first, second } = await twoExperiments();
  const fixes = currentPlan(root, report);
  const history = planHistory(root);
  const plan = renderPlan({ report, fixes, habits: [], settingsFile: 'settings.json', ...history });
  const md = renderAnalyze({ report, found: findings(report), fixes, habits: [], settingsFile: 'settings.json', ...history });
  for (const out of [plan, md]) {
    const section = out.slice(out.indexOf('## Changes in effect'));
    assert.ok(out.includes('## Changes in effect'), out);
    assert.ok(section.indexOf(second.id) < section.indexOf(first.id));
    assert.match(section, /`model` = `"sonnet"`/);
    assert.match(section, /model-routing rule in `CLAUDE\.md`/);
  }
  assert.match(md.slice(md.indexOf('## Summary'), md.indexOf('## At a glance')), /2 changes from earlier runs are in effect/);
});

test('the dashboard shows the changes in effect', async () => {
  const { root, report, first, second } = await twoExperiments();
  const html = renderDashboard({ report, found: findings(report), fixes: currentPlan(root, report), habits: [], settingsFile: 'settings.json', ...planHistory(root), generatedAt: NOW });
  const section = html.slice(html.indexOf('Changes in effect'));
  assert.ok(html.includes('Changes in effect'));
  assert.ok(section.indexOf(second.id) < section.indexOf(first.id));
  assert.match(section, /<code>model<\/code>/);
  assert.match(section, /model-routing rule/);
});
