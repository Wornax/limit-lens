// The model-routing rule: offered as the first question, added to the user's CLAUDE.md as a marked
// block, and removed exactly by revert. Synthetic data and temp folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { currentPlan, applyFixes, revertExperiment, planHistory } from '../plugins/limit-lens/scripts/lib/experiments.mjs';
import { renderPlan } from '../plugins/limit-lens/scripts/lib/report.mjs';
import { NOW, minutesAgo, tempRoot, assistant, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-lens', 'scripts', 'limit-lens.mjs');
const M = 1_000_000;
const RULE = /Before you start a subagent or a workflow agent, use the `limit-lens:model-routing` skill/;

// A config folder whose last week has main-conversation and agent spend on Opus.
async function withAgents() {
  const { root, projects } = tempRoot();
  writeTranscript(projects, 'p/s1.jsonl', [assistant({ ts: minutesAgo(20), model: 'claude-opus-5-5', usage: { output_tokens: M } })]);
  writeTranscript(projects, 'p/s1/subagents/agent-1.jsonl', [assistant({ ts: minutesAgo(19), model: 'claude-opus-5-5', usage: { output_tokens: M } })]);
  writeJson(projects, 'p/s1/subagents/agent-1.meta.json', { agentType: 'general-purpose' });
  const report = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  return { root, report, memory: path.join(root, 'CLAUDE.md'), settings: path.join(root, 'settings.json') };
}

test('the routing rule is the first question when agents spend and CLAUDE.md does not have it', async () => {
  const { root, report, memory } = await withAgents();
  const fixes = currentPlan(root, report);
  assert.equal(fixes[0].id, 'model-routing-rule');
  assert.equal(fixes[0].target, 'memory');
  assert.equal(fixes[0].kind, 'changes-work');
  assert.equal(fixes[0].savings.weekly, null);
  fs.writeFileSync(memory, '# Mine\n\nUse limit-lens:model-routing before delegating.\n');
  assert.ok(!currentPlan(root, report).some((f) => f.id === 'model-routing-rule'));
});

test('the routing rule is not offered without agent spend', async () => {
  const { root, projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [assistant({ ts: minutesAgo(5), usage: { output_tokens: M } })]);
  const report = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  assert.ok(!currentPlan(root, report).some((f) => f.id === 'model-routing-rule'));
});

test('apply adds the marked block to CLAUDE.md, keeping its content and line endings, and leaves settings alone', async () => {
  const { root, report, memory, settings } = await withAgents();
  fs.writeFileSync(memory, '# My rules\r\n\r\nBe brief.');
  const exp = applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  const text = fs.readFileSync(memory, 'utf8');
  assert.ok(text.startsWith('# My rules\r\n\r\nBe brief.\r\n\r\n<!-- limit-lens:model-routing -->\r\n'), JSON.stringify(text));
  assert.match(text, RULE);
  assert.ok(text.endsWith('<!-- /limit-lens:model-routing -->\r\n'));
  assert.ok(!fs.existsSync(settings));
  assert.equal(fs.readFileSync(exp.memoryBackup, 'utf8'), '# My rules\r\n\r\nBe brief.');
  assert.equal(exp.changes[0].kind, 'memory');
});

test('apply creates CLAUDE.md when there is none, and revert removes exactly the block', async () => {
  const { root, report, memory } = await withAgents();
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  assert.match(fs.readFileSync(memory, 'utf8'), RULE);
  fs.appendFileSync(memory, '\nA rule I added later.\n');
  const { restored, skipped } = revertExperiment({ configDir: root, now: NOW + 1000 });
  assert.equal(restored.length, 1);
  assert.equal(skipped.length, 0);
  assert.equal(fs.readFileSync(memory, 'utf8'), '\nA rule I added later.\n');
});

test('revert leaves an edited block alone', async () => {
  const { root, report, memory } = await withAgents();
  fs.writeFileSync(memory, '# Mine\n');
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  fs.writeFileSync(memory, fs.readFileSync(memory, 'utf8').replace('choose its model', 'pick its model'));
  const before = fs.readFileSync(memory, 'utf8');
  const { restored, skipped } = revertExperiment({ configDir: root, now: NOW + 1000 });
  assert.equal(restored.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(fs.readFileSync(memory, 'utf8'), before);
});

test('routing and a settings fix apply together and revert together', async () => {
  const { root, report, memory, settings } = await withAgents();
  fs.writeFileSync(settings, '{"model":"opus"}\n');
  fs.writeFileSync(memory, '# Mine\n');
  const ids = currentPlan(root, report).map((f) => f.id);
  assert.ok(ids.includes('default-model-sonnet'), ids.join());
  applyFixes({ configDir: root, fixIds: ['model-routing-rule', 'default-model-sonnet'], report, now: NOW });
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).model, 'sonnet');
  assert.match(fs.readFileSync(memory, 'utf8'), RULE);
  const undo = planHistory(root).undo;
  assert.deepEqual(undo.changes.map((c) => c.kind || 'settings').sort(), ['memory', 'settings']);
  revertExperiment({ configDir: root, now: NOW + 1000 });
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).model, 'opus');
  assert.equal(fs.readFileSync(memory, 'utf8'), '# Mine\n');
});

test('a settings file that is not valid JSON stops apply before CLAUDE.md is touched', async () => {
  const { root, report, memory, settings } = await withAgents();
  fs.writeFileSync(settings, '{ broken');
  fs.writeFileSync(memory, '# Mine\n');
  assert.throws(() => applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW }), /not valid JSON/);
  assert.equal(fs.readFileSync(memory, 'utf8'), '# Mine\n');
});

test('the plan shows the rule and where it goes, and what revert would remove', async () => {
  const { root, report } = await withAgents();
  const fixes = currentPlan(root, report);
  let md = renderPlan({ report, fixes, habits: [], settingsFile: 'settings.json', ...planHistory(root) });
  assert.match(md, /### Question 1: Route delegated work with the model-routing skill/);
  assert.match(md, /Change: add to `[^`]*CLAUDE\.md`/);
  assert.match(md, RULE);
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  md = renderPlan({ report, fixes: currentPlan(root, report), habits: [], settingsFile: 'settings.json', ...planHistory(root) });
  assert.match(md, /CLAUDE\.md`: the model-routing rule is removed/);
});

test('the CLI reports routing changes on apply and revert', async () => {
  const { root } = await withAgents();
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--config-dir', root, '--now', new Date(NOW).toISOString()], { encoding: 'utf8' });
  let res = run('apply', 'model-routing-rule');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /model-routing-rule`: added the model-routing rule to `[^`]*CLAUDE\.md`/);
  assert.doesNotMatch(res.stdout, /settings file before/);
  res = run('revert');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /CLAUDE\.md`: removed the model-routing rule/);
});
