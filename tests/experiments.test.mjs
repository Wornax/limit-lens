import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOW, daysAgo, tempRoot, assistant, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-xray', 'scripts', 'limit-xray.mjs');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const cli = (root, args, now) => spawnSync(process.execPath, [CLI, ...args, '--config-dir', root, '--now', iso(now)], { encoding: 'utf8' });

// A week of heavy Opus agents before the change; Sonnet agents after it.
function fixture() {
  const { root, projects } = tempRoot();
  const opus = { cache_read_input_tokens: 300_000, output_tokens: 2_000 };
  const before = [];
  for (let d = 7; d >= 1; d--) for (let i = 0; i < 40; i++) before.push(assistant({ ts: iso(NOW - d * DAY + i * 60_000), model: 'claude-opus-5-5', usage: opus }));
  writeTranscript(projects, 'p/s/subagents/agent-before.jsonl', before);
  writeJson(projects, 'p/s/subagents/agent-before.meta.json', { agentType: 'general-purpose' });
  writeTranscript(projects, 'p/s.jsonl', [assistant({ ts: daysAgo(7), usage: { output_tokens: 10 } })]);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ model: 'opus', env: { KEEP: '1' } }, null, 2));
  return { root, projects };
}

function addAfter(projects, days) {
  const sonnet = { cache_read_input_tokens: 300_000, output_tokens: 2_000 };
  const lines = [];
  for (let d = 1; d <= days; d++) for (let i = 0; i < 120; i++) lines.push(assistant({ ts: iso(NOW + d * DAY - 12 * 3_600_000 + i * 60_000), model: 'claude-sonnet-5-5', usage: sonnet }));
  writeTranscript(projects, 'p/s/subagents/agent-after.jsonl', lines, { mtime: iso(NOW + days * DAY) });
  writeJson(projects, 'p/s/subagents/agent-after.meta.json', { agentType: 'general-purpose' });
}

test('plan lists the applicable fixes with ids, and apply writes only the chosen ones', () => {
  const { root } = fixture();
  const plan = cli(root, ['plan', '--json'], NOW);
  assert.equal(plan.status, 0, plan.stderr);
  const fixes = JSON.parse(plan.stdout).fixes.map((f) => f.id);
  assert.ok(fixes.includes('subagent-model-sonnet'));
  assert.ok(fixes.includes('default-model-sonnet'));

  const applied = cli(root, ['apply', 'subagent-model-sonnet'], NOW);
  assert.equal(applied.status, 0, applied.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'sonnet');
  assert.equal(settings.env.KEEP, '1');
  assert.equal(settings.model, 'opus'); // not chosen, not changed
  const state = JSON.parse(fs.readFileSync(path.join(root, 'limit-xray', 'experiments.json'), 'utf8'));
  assert.equal(state.experiments.length, 1);
  assert.deepEqual(state.experiments[0].changes.map((c) => c.fixId), ['subagent-model-sonnet']);
  assert.ok(state.experiments[0].baseline.spend > 0);
  assert.ok(fs.existsSync(state.experiments[0].backup));
});

test('apply refuses ids that are not in the current plan', () => {
  const { root } = fixture();
  const bad = cli(root, ['apply', 'made-up-fix'], NOW);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not an applicable fix/);
  const none = cli(root, ['apply'], NOW);
  assert.equal(none.status, 2);
});

test('compare says it is too early, then shows before and after', () => {
  const { root, projects } = fixture();
  assert.equal(cli(root, ['apply', 'subagent-model-sonnet'], NOW).status, 0);
  const early = cli(root, ['compare'], NOW + 3_600_000);
  assert.equal(early.status, 0, early.stderr);
  assert.match(early.stdout, /too early/i);

  addAfter(projects, 3);
  const later = cli(root, ['compare'], NOW + 3 * DAY);
  assert.equal(later.status, 0, later.stderr);
  assert.match(later.stdout, /Before/);
  assert.match(later.stdout, /Opus share of spend \| 100% \| 0%/);
});

test('revert restores the previous values but keeps a key the user changed since', () => {
  const { root } = fixture();
  assert.equal(cli(root, ['apply', 'subagent-model-sonnet', 'default-model-sonnet'], NOW).status, 0);
  const file = path.join(root, 'settings.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.model = 'haiku'; // the user changed it after applying
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  const res = cli(root, ['revert'], NOW + DAY);
  assert.equal(res.status, 0, res.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  assert.equal(after.env.KEEP, '1');
  assert.equal(after.model, 'haiku');
  assert.match(res.stdout, /changed since/);
});
