// Regressions from the review of /limit-xray:analyze and the CLAUDE.md routing fix (2026-10-25).
// Synthetic data and temp folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../plugins/limit-xray/scripts/lib/analyze.mjs';
import { currentPlan, applyFixes, revertExperiment, planHistory } from '../plugins/limit-xray/scripts/lib/experiments.mjs';
import { NOW, minutesAgo, tempRoot, assistant, prompt, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-xray', 'scripts', 'limit-xray.mjs');
const M = 1_000_000;
const run = (root, ...args) => spawnSync(process.execPath, [CLI, ...args, '--config-dir', root, '--now', new Date(NOW).toISOString()], { encoding: 'utf8' });

async function withAgents() {
  const { root, projects } = tempRoot();
  writeTranscript(projects, 'p/s1.jsonl', [assistant({ ts: minutesAgo(20), model: 'claude-opus-5-5', usage: { output_tokens: M } })]);
  writeTranscript(projects, 'p/s1/subagents/agent-1.jsonl', [assistant({ ts: minutesAgo(19), model: 'claude-opus-5-5', usage: { output_tokens: M } })]);
  writeJson(projects, 'p/s1/subagents/agent-1.meta.json', { agentType: 'general-purpose' });
  const report = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  return { root, report, memory: path.join(root, 'CLAUDE.md'), settings: path.join(root, 'settings.json') };
}

test('revert keeps the user\'s lines apart when the file had no final newline and text was added after the block', async () => {
  const { root, report, memory } = await withAgents();
  fs.writeFileSync(memory, '# Mine\nBe brief.');
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  fs.appendFileSync(memory, '## Later\nNew rule.\n');
  revertExperiment({ configDir: root, now: NOW + 1000 });
  assert.equal(fs.readFileSync(memory, 'utf8'), '# Mine\nBe brief.\n## Later\nNew rule.\n');
});

test('a CLAUDE.md that is not UTF-8 is never rewritten', async () => {
  const { root, report, memory } = await withAgents();
  const latin1 = Buffer.from([0x52, 0x65, 0x67, 0x72, 0x61, 0x3a, 0x20, 0xe7, 0xe3, 0x0a]); // "Regra: çã" in Windows-1252
  fs.writeFileSync(memory, latin1);
  assert.ok(!currentPlan(root, report).some((f) => f.id === 'model-routing-rule'));
  assert.throws(() => applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW }));
  assert.ok(fs.readFileSync(memory).equals(latin1));
  // Applied while UTF-8, re-saved in another encoding later: revert refuses instead of rewriting.
  fs.writeFileSync(memory, '# Mine\n');
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fs.readFileSync(memory, 'utf8'), 'utf16le')]);
  fs.writeFileSync(memory, utf16);
  assert.throws(() => revertExperiment({ configDir: root, now: NOW + 1000 }), /not UTF-8/);
  assert.ok(fs.readFileSync(memory).equals(utf16));
});

test('a UTF-8 CLAUDE.md with a byte-order mark keeps it', async () => {
  const { root, report, memory } = await withAgents();
  fs.writeFileSync(memory, '﻿# Mine\n');
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  revertExperiment({ configDir: root, now: NOW + 1000 });
  assert.equal(fs.readFileSync(memory, 'utf8'), '﻿# Mine\n');
});

test('undoing the routing rule alone does not need a valid settings file', async () => {
  const { root, report, memory, settings } = await withAgents();
  fs.writeFileSync(memory, '# Mine\n');
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  fs.writeFileSync(settings, '{ nope');
  revertExperiment({ configDir: root, now: NOW + 1000 });
  assert.equal(fs.readFileSync(memory, 'utf8'), '# Mine\n');
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ nope');
});

test('a revert that cannot write settings changes nothing, CLAUDE.md included, and can be retried', async (t) => {
  const { root, report, memory, settings } = await withAgents();
  fs.writeFileSync(settings, '{"model":"opus"}\n');
  fs.writeFileSync(memory, '# Mine\n');
  applyFixes({ configDir: root, fixIds: ['model-routing-rule', 'default-model-sonnet'], report, now: NOW });
  const applied = fs.readFileSync(memory, 'utf8');
  fs.chmodSync(settings, 0o444);
  t.after(() => fs.chmodSync(settings, 0o644));
  assert.throws(() => revertExperiment({ configDir: root, now: NOW + 1000 }), /read-only|in use/);
  assert.equal(fs.readFileSync(memory, 'utf8'), applied);
  assert.ok(planHistory(root).undo, 'the experiment is still pending');
  fs.chmodSync(settings, 0o644);
  const { restored, skipped } = revertExperiment({ configDir: root, now: NOW + 2000 });
  assert.equal(restored.length, 2);
  assert.equal(skipped.length, 0);
  assert.equal(fs.readFileSync(memory, 'utf8'), '# Mine\n');
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).model, 'opus');
});

test('revert removes a CLAUDE.md that apply created and nobody wrote in since', async () => {
  const { root, report, memory } = await withAgents();
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  revertExperiment({ configDir: root, now: NOW + 1000 });
  assert.ok(!fs.existsSync(memory));
});

test('revert says so when CLAUDE.md still mentions the routing skill after the block is gone', async () => {
  const { root, report, memory } = await withAgents();
  fs.writeFileSync(memory, '# Mine\n');
  applyFixes({ configDir: root, fixIds: ['model-routing-rule'], report, now: NOW });
  fs.appendFileSync(memory, '\nCopied: use the `limit-xray:model-routing` skill.\n');
  const { restored, notes } = revertExperiment({ configDir: root, now: NOW + 1000 });
  assert.equal(restored.length, 1);
  assert.match(notes.join(' '), /still mentions/);
});

test('analyze asks about holding cross-session messages once, and keeps the goal check-in tip', () => {
  const { root, projects } = tempRoot();
  const big = { cache_read_input_tokens: 400_000, output_tokens: 1000 };
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(prompt({ ts: minutesAgo(60 - 2 * i), origin: i % 2 ? 'peer' : 'human', text: `turn ${i}` }));
    lines.push(assistant({ ts: minutesAgo(59 - 2 * i), model: 'claude-opus-5-5', usage: big }));
  }
  writeTranscript(projects, 'p/s.jsonl', lines);
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  const out = run(root, 'analyze').stdout;
  assert.match(out, /cross-session-hold/);
  const other = out.slice(out.indexOf('## Other suggestions'));
  assert.doesNotMatch(other, /crossSessionInbound/);
  assert.match(other, /CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0/);
});

test('analyze keeps the /compact advice when the auto-compaction question is asked', () => {
  const { root, projects } = tempRoot();
  const big = { cache_read_input_tokens: 400_000, output_tokens: 100 };
  writeTranscript(projects, 'p/s.jsonl', [1, 2, 3, 4, 5, 6].map((i) => assistant({ ts: minutesAgo(30 - i), usage: big })));
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  const out = run(root, 'analyze').stdout;
  assert.match(out, /autocompact-300k/);
  const other = out.slice(out.indexOf('## Other suggestions'));
  assert.match(other, /`\/compact`/);
  assert.doesNotMatch(other, /"autoCompactWindow": 300000/);
});

test('analyze lists the habits no finding already gives, even when no finding has suggestions', () => {
  const { root, projects } = tempRoot();
  // max effort at 1/6 of spend: a habit (10% or more) but not the effort finding (30%).
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: minutesAgo(20), effort: 'max', usage: { output_tokens: M / 5 } }),
    assistant({ ts: minutesAgo(19), effort: 'medium', usage: { output_tokens: M } }),
  ]);
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  assert.match(run(root, 'plan').stdout, /`max` effort cannot be saved/);
  const out = run(root, 'analyze').stdout;
  assert.doesNotMatch(out, /High effort by default/);
  assert.match(out.slice(out.indexOf('## Other suggestions')), /`max` effort cannot be saved/);
});

test('report-only flags are refused by the other commands instead of being ignored', () => {
  const { root } = tempRoot();
  for (const args of [['analyze', '--anonymize'], ['analyze', '--days', '30'], ['plan', '--project', 'api'], ['apply', 'model-routing-rule', '--days', '3']]) {
    const res = run(root, ...args);
    assert.equal(res.status, 2, args.join(' '));
    assert.match(res.stderr, /only to the report/, args.join(' '));
  }
});
