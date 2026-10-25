import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { applicableFixes } from '../plugins/limit-lens/scripts/lib/fixes.mjs';
import { renderPlan } from '../plugins/limit-lens/scripts/lib/report.mjs';
import { NOW, tempRoot, assistant, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-lens', 'scripts', 'limit-lens.mjs');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

async function heavyAgents(days = 7) {
  const r = await analyze({ projectsDirs: [tempRoot().projects], now: NOW, days: 7, securityLog: null });
  r.window.days = days;
  r.totals.cost = 100;
  r.totals.requests = 1000;
  Object.assign(r.agents.subagent, { cost: 60, requests: 600, agents: 6 });
  r.agents.subagent.byModel['opus-5-5'] = { cost: 40, requests: 400 };
  r.agents.subagent.byType = { 'code-reviewer': { cost: 30, requests: 300, opusCost: 30 }, Explore: { cost: 30, requests: 300, opusCost: 10 } };
  r.byProject = {
    'proj-a': { cost: 50, mainCost: 10, agentCost: 40, opusMainCost: 10, opusAgentCost: 30, highEffortCost: 0, requestsOver200k: 0 },
    'proj-b': { cost: 50, mainCost: 40, agentCost: 10, opusMainCost: 0, opusAgentCost: 10, highEffortCost: 0, requestsOver200k: 0 },
  };
  return r;
}

test('a fix names its biggest contributors, estimates weekly savings and says what it changes', async () => {
  const r = await heavyAgents();
  const f = applicableFixes(r, {}).find((x) => x.id === 'subagent-model-sonnet');
  assert.deepEqual(f.contributors.filter((c) => c.kind === 'project').map((c) => c.name), ['proj-a', 'proj-b']);
  assert.equal(f.contributors.find((c) => c.kind === 'agent type').name, 'code-reviewer');
  close(f.savings.weekly, 20); // half of $40 of Opus agent spend
  assert.match(f.savings.basis, /half/i);
  assert.equal(f.kind, 'changes-work');
  assert.ok(f.effect.length > 0);
});

test('savings are scaled to a week', async () => {
  const r = await heavyAgents(14);
  close(applicableFixes(r, {}).find((x) => x.id === 'subagent-model-sonnet').savings.weekly, 10);
});

test('effort and auto-compaction say their savings cannot be estimated in advance', async () => {
  const r = await heavyAgents();
  r.byEffort = { xhigh: { cost: 60, requests: 600 } };
  r.byModel = { 'opus-5-5': { cost: 90, requests: 900 } };
  r.components.cacheRead = 60;
  r.context.requestsOver300k = 10;
  const fixes = applicableFixes(r, { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } });
  for (const id of ['effort-high-claude-opus-5-5', 'autocompact-300k']) {
    const f = fixes.find((x) => x.id === id);
    assert.equal(f.savings.weekly, null, id);
    assert.match(f.savings.basis, /compare/i, id);
  }
});

test('the per-turn review fixes are alternatives in one group, labelled cost-only', async () => {
  const r = await heavyAgents();
  r.plugins.securityGuidance = { reviews: { stop: { count: 10, cost: 4 }, commit: { count: 0, cost: 0 }, push: { count: 0, cost: 0 } }, outsideTranscriptsCost: 4 };
  r.outside.cost = 4;
  const fixes = applicableFixes(r, {});
  const sonnet = fixes.find((x) => x.id === 'security-review-sonnet');
  const off = fixes.find((x) => x.id === 'security-stop-review-off');
  assert.equal(sonnet.group, off.group);
  assert.equal(sonnet.kind, 'cost-only');
  close(sonnet.savings.weekly, 2);
  close(off.savings.weekly, 4);
});

test('apply refuses two alternatives of the same group', () => {
  const { root, projects } = tempRoot();
  const iso = (ms) => new Date(ms).toISOString();
  writeTranscript(projects, 'p/s.jsonl', [assistant({ ts: iso(NOW - 3_600_000), usage: { output_tokens: 1000 } })]);
  fs.mkdirSync(path.join(root, 'security'));
  const d = new Date(NOW - 7_200_000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`;
  fs.writeFileSync(path.join(root, 'security', 'log.txt'), `[${stamp}] Review usage: review=stop session=x model=claude-opus-5-5 calls=1 in=1 out=1 cache_read=0 cache_write=0 est_cost_usd=0.5000\n`);
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  const res = spawnSync(process.execPath, [CLI, 'apply', 'security-review-sonnet', 'security-stop-review-off', '--config-dir', root, '--now', iso(NOW)], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /alternatives/);
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{}');
});

test('the plan opens with the diagnosis and asks one question per group', async () => {
  const r = await heavyAgents();
  r.plugins.securityGuidance = { reviews: { stop: { count: 10, cost: 4 } }, outsideTranscriptsCost: 4 };
  r.outside.cost = 4;
  const fixes = applicableFixes(r, {});
  const md = renderPlan({ report: r, fixes, habits: [], settingsFile: 'settings.json', last: null, undo: null, warning: null });
  const diag = md.indexOf('## What is eating your limit');
  const firstQuestion = md.indexOf('### Question 1');
  assert.ok(diag > -1 && firstQuestion > diag, md);
  assert.match(md, /Biggest projects: proj-a/);
  assert.match(md, /Estimated savings: about \$20 per week/);
  assert.match(md, /Changes how Claude works for you/);
  const questions = md.match(/### Question \d+/g).length;
  assert.equal(questions, fixes.length - 1); // the two review alternatives share one question
  assert.match(md, /Options: `security-review-sonnet` or `security-stop-review-off`/);
});

test('names from disk are cleaned in the plan; limit-lens review names are left as written', async () => {
  const r = await heavyAgents();
  r.byProject['proj`[x](y)'] = { ...r.byProject['proj-a'], cost: 90, opusAgentCost: 35 };
  r.plugins.securityGuidance = { reviews: { stop: { count: 10, cost: 4 } }, outsideTranscriptsCost: 4 };
  r.outside.cost = 4;
  const md = renderPlan({ report: r, fixes: applicableFixes(r, {}), habits: [], settingsFile: 'settings.json', last: null, undo: null, warning: null });
  assert.doesNotMatch(md, /`\[x\]\(y\)/);
  assert.match(md, /proj__x__y_/);
  assert.match(md, /Reviews: per-turn reviews \(\$4\.00, 10 reviews\)/);
});

test('plan --json carries the diagnosis and the questions, with names from disk cleaned', () => {
  const { root, projects } = tempRoot();
  const iso = (ms) => new Date(ms).toISOString();
  writeTranscript(projects, 'my proj/s.jsonl', [assistant({ ts: iso(NOW - 3_600_000), model: 'claude-opus-5-5', usage: { output_tokens: 100_000 } })]);
  fs.writeFileSync(path.join(root, 'settings.json'), '{"model":"opus"}');
  const res = spawnSync(process.execPath, [CLI, 'plan', '--json', '--config-dir', root, '--now', iso(NOW)], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.diagnosis.projects[0].name, 'my_proj');
  assert.deepEqual(plan.questions.map((q) => q.options), [['default-model-sonnet']]);
  assert.equal(plan.fixes[0].contributors[0].name, 'my_proj');
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"model":"opus"}');
});
