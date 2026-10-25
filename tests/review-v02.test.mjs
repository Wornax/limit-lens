// Regression tests for defects confirmed by the v0.2 review (2026-10-25).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { applicableFixes } from '../plugins/limit-lens/scripts/lib/fixes.mjs';
import { readSettings, writeSettings, setPath } from '../plugins/limit-lens/scripts/lib/settings.mjs';
import { NOW, daysAgo, tempRoot, assistant, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-lens', 'scripts', 'limit-lens.mjs');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const cli = (root, args, now = NOW) => spawnSync(process.execPath, [CLI, ...args, '--config-dir', root, '--now', iso(now)], { encoding: 'utf8' });

function fixture(settingsText = JSON.stringify({ model: 'opus', env: { KEEP: '1' } }, null, 2)) {
  const { root, projects } = tempRoot();
  const lines = [];
  for (let d = 7; d >= 1; d--) for (let i = 0; i < 40; i++) lines.push(assistant({ ts: iso(NOW - d * DAY + i * 60_000), model: 'claude-opus-5-5', usage: { cache_read_input_tokens: 300_000, output_tokens: 2_000 } }));
  writeTranscript(projects, 'p/s/subagents/agent-a.jsonl', lines);
  writeJson(projects, 'p/s/subagents/agent-a.meta.json', { agentType: 'general-purpose' });
  writeTranscript(projects, 'p/s.jsonl', [assistant({ ts: daysAgo(7), usage: { output_tokens: 10 } })]);
  fs.writeFileSync(path.join(root, 'settings.json'), settingsText);
  return { root, projects };
}
async function report() {
  const r = await analyze({ projectsDirs: [tempRoot().projects], now: NOW, days: 7, securityLog: null });
  r.totals.cost = 100;
  r.totals.requests = 1000;
  return r;
}
const ids = (fixes) => fixes.map((f) => f.id);

// Experiments state

test('a damaged experiments.json stops apply and revert instead of being overwritten', () => {
  const { root } = fixture();
  assert.equal(cli(root, ['apply', 'default-model-sonnet']).status, 0);
  const state = path.join(root, 'limit-lens', 'experiments.json');
  const damaged = fs.readFileSync(state, 'utf8').slice(0, -5);
  fs.writeFileSync(state, damaged);
  const apply = cli(root, ['apply', 'subagent-model-sonnet']);
  assert.equal(apply.status, 2);
  assert.match(apply.stderr, /damaged/);
  assert.equal(cli(root, ['revert']).status, 2);
  assert.equal(fs.readFileSync(state, 'utf8'), damaged);
  assert.equal(cli(root, ['plan']).status, 0); // the plan still works, with a warning
});

test('plan shows the experiment revert would undo, with the values it would restore, and revert can be pinned to it', () => {
  const { root } = fixture();
  assert.equal(cli(root, ['apply', 'default-model-sonnet'], NOW).status, 0);
  assert.equal(cli(root, ['apply', 'subagent-model-sonnet'], NOW + 5_000).status, 0);
  assert.equal(cli(root, ['revert'], NOW + 10_000).status, 0); // undoes the second
  const plan = JSON.parse(cli(root, ['plan', '--json'], NOW + 20_000).stdout);
  assert.deepEqual(plan.undo.changes.map((c) => c.path.join('.')), ['model']);
  assert.equal(plan.undo.changes[0].restore, 'opus');
  const md = cli(root, ['plan'], NOW + 20_000).stdout;
  assert.match(md, /Revert would restore/);
  assert.match(md, /`model` -> `"opus"`/);
  const pinned = cli(root, ['revert', '--experiment', plan.undo.id], NOW + 30_000);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).model, 'opus');
});

// Settings writes

test('apply keeps the file\'s indentation, line endings and byte order mark', () => {
  const text = '﻿{\r\n\t"model": "opus",\r\n\t"env": {\r\n\t\t"KEEP": "1"\r\n\t}\r\n}\r\n';
  const { root } = fixture(text);
  assert.equal(cli(root, ['apply', 'subagent-model-sonnet']).status, 0);
  const after = fs.readFileSync(path.join(root, 'settings.json'), 'utf8');
  assert.equal(after.charCodeAt(0), 0xfeff);
  assert.ok(after.includes('\r\n\t"model": "opus"'));
  assert.ok(!/[^\r]\n/.test(after));
});

test('a read-only settings file fails cleanly: no temp file, no stray backup, nothing changed', () => {
  const { root } = tempRoot();
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  fs.chmodSync(file, 0o444);
  const { data, format } = readSettings(file);
  setPath(data, ['a'], 2);
  assert.throws(() => writeSettings(file, data, { backupDir: path.join(root, 'backups'), format }), /read-only|in use/);
  fs.chmodSync(file, 0o644);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp')), []);
  assert.ok(!fs.existsSync(path.join(root, 'backups')) || fs.readdirSync(path.join(root, 'backups')).length === 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
});

test('a symlinked settings file stays a symlink and its target is updated', (t) => {
  const { root } = tempRoot();
  const real = path.join(root, 'real-settings.json');
  const link = path.join(root, 'settings.json');
  fs.writeFileSync(real, '{"a":1}');
  try {
    fs.symlinkSync(real, link, 'file');
  } catch {
    t.skip('this system does not allow creating file symlinks');
    return;
  }
  const { data, format } = readSettings(link);
  setPath(data, ['a'], 2);
  writeSettings(link, data, { backupDir: path.join(root, 'backups'), format });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).a, 2);
});

// Fix conditions and wording

test('security-guidance model fixes are skipped on third-party providers, which need their own model ids', async () => {
  const r = await report();
  r.toolSessions = { 'security-guidance review': { cost: 3, requests: 30, sessions: 3 } };
  r.plugins.securityGuidance = { reviews: { stop: { count: 4, cost: 1 }, commit: { count: 2, cost: 1 } }, outsideTranscriptsCost: 1 };
  r.outside.cost = 1;
  const got = ids(applicableFixes(r, { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
  assert.ok(!got.includes('security-review-sonnet'));
  assert.ok(!got.includes('security-agentic-sonnet'));
  assert.ok(got.includes('security-stop-review-off'));
});

test('each security-guidance fix needs its own evidence', async () => {
  const onlyStop = await report();
  onlyStop.plugins.securityGuidance = { reviews: { stop: { count: 4, cost: 1 }, commit: { count: 0, cost: 0 }, push: { count: 0, cost: 0 } }, outsideTranscriptsCost: 1 };
  onlyStop.outside.cost = 1;
  let got = ids(applicableFixes(onlyStop, {}));
  assert.ok(got.includes('security-review-sonnet') && got.includes('security-stop-review-off'));
  assert.ok(!got.includes('security-agentic-sonnet'));
  const onlyAgentic = await report();
  onlyAgentic.toolSessions = { 'security-guidance review': { cost: 3, requests: 30, sessions: 3 } };
  got = ids(applicableFixes(onlyAgentic, {}));
  assert.deepEqual(got.filter((id) => id.startsWith('security')), ['security-agentic-sonnet']);
});

test('the effort fix is skipped under an effort environment override and never suggests saving xhigh again', async () => {
  const r = await report();
  r.byEffort = { xhigh: { cost: 60, requests: 600 } };
  r.byModel = { 'opus-5-5': { cost: 90, requests: 900 } };
  const saved = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } };
  const fix = applicableFixes(r, saved).find((f) => f.id.startsWith('effort-high'));
  assert.ok(fix);
  assert.ok(!fix.why.includes('/effort xhigh'));
  assert.ok(!ids(applicableFixes(r, { ...saved, env: { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' } })).some((id) => id.startsWith('effort-high')));
});

test('auto-compaction is skipped when an env window or a per-model window would override it', async () => {
  const r = await report();
  r.components.cacheRead = 60;
  r.context.requestsOver200k = 10;
  assert.ok(!ids(applicableFixes(r, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' } })).includes('autocompact-300k'));
  assert.ok(!ids(applicableFixes(r, { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 500000 } } })).includes('autocompact-300k'));
});

test('opusplan is left alone by the default-model fix', async () => {
  const r = await report();
  r.byModel = { 'opus-5-5': { cost: 80, requests: 800 } };
  assert.ok(!ids(applicableFixes(r, { model: 'opusplan' })).includes('default-model-sonnet'));
});

test('the hold fix says held messages are not delivered', async () => {
  const r = await report();
  r.turns.automated.byKind.peer = { cost: 5, requests: 50 };
  const fix = applicableFixes(r, {}).find((f) => f.id === 'cross-session-hold');
  assert.match(fix.why, /not deliver/);
});
