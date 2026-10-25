// `limit-lens analyze`: the report, then the questions (routing first), then the other suggestions, in
// one pass over the transcripts. Synthetic data and temp folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOW, minutesAgo, tempRoot, assistant, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-lens', 'scripts', 'limit-lens.mjs');
const M = 1_000_000;
const run = (root, ...args) => spawnSync(process.execPath, [CLI, ...args, '--config-dir', root, '--now', new Date(NOW).toISOString()], { encoding: 'utf8' });

// Opus agents at xhigh, a long re-read main conversation, and a default model of Opus.
function heavyWeek() {
  const { root, projects } = tempRoot();
  const big = { cache_read_input_tokens: 400_000, output_tokens: 1000 };
  writeTranscript(projects, 'my-app/s1.jsonl', [1, 2, 3, 4].map((i) => assistant({ ts: minutesAgo(60 - i), model: 'claude-opus-5-5', effort: 'xhigh', usage: big })));
  writeTranscript(projects, 'my-app/s1/subagents/agent-1.jsonl', [assistant({ ts: minutesAgo(40), model: 'claude-opus-5-5', effort: 'xhigh', usage: { output_tokens: M / 50 } })]);
  writeJson(projects, 'my-app/s1/subagents/agent-1.meta.json', { agentType: 'general-purpose' });
  fs.writeFileSync(path.join(root, 'settings.json'), '{"model":"opus"}\n');
  return root;
}

test('analyze shows the report, then the questions with routing first, then the other suggestions', () => {
  const root = heavyWeek();
  const res = run(root, 'analyze');
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout;
  const at = (s) => out.indexOf(s);
  for (const s of ['## Where it goes', '## Findings', '## Questions', '### Question 1: Route delegated work with the model-routing skill', '## Other suggestions']) assert.ok(at(s) > -1, `missing ${s}`);
  assert.ok(at('## Where it goes') < at('## Findings') && at('## Findings') < at('## Questions') && at('## Questions') < at('## Other suggestions'));
  assert.match(out, /Biggest projects:\*\* my-app 100%/);
  assert.doesNotMatch(out, /^Fixes:/m); // the findings' suggestions move to the end
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"model":"opus"}\n');
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')));
});

test('other suggestions leave out what a question already asks', () => {
  const root = heavyWeek();
  const out = run(root, 'analyze').stdout;
  const asked = out.slice(out.indexOf('## Questions'), out.indexOf('## Other suggestions'));
  const other = out.slice(out.indexOf('## Other suggestions'));
  assert.match(asked, /default-model-sonnet/);
  assert.doesNotMatch(other, /Start routine sessions with `\/model sonnet`/);
  assert.match(asked, /model-routing-rule/);
  assert.doesNotMatch(other, /Let Claude pick a model per task/);
  assert.match(other, /Run `\/clear` between unrelated tasks/); // a habit no setting covers stays
});

test('analyze with no usage says so and asks nothing', () => {
  const { root } = tempRoot();
  const res = run(root, 'analyze');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /No Claude Code usage found/);
  assert.doesNotMatch(res.stdout, /## Questions/);
});

test('analyze --json carries the report, the diagnosis and the questions, with names from disk cleaned', () => {
  const { root, projects } = tempRoot();
  writeTranscript(projects, 'my proj/s.jsonl', [assistant({ ts: minutesAgo(60), model: 'claude-opus-5-5', usage: { output_tokens: 100_000 } })]);
  fs.writeFileSync(path.join(root, 'settings.json'), '{"model":"opus"}');
  const res = run(root, 'analyze', '--json');
  assert.equal(res.status, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.ok(j.report && j.findings && j.diagnosis && j.questions && j.fixes);
  assert.deepEqual(Object.keys(j.report.byProject), ['my_proj']);
  assert.equal(j.diagnosis.projects[0].name, 'my_proj');
  assert.deepEqual(j.questions.map((q) => q.options), [['default-model-sonnet']]);
});

test('the report lists the biggest projects, hidden by --anonymize', () => {
  const root = heavyWeek();
  assert.match(run(root).stdout, /Biggest projects:\*\* my-app 100%/);
  const anon = run(root, '--anonymize').stdout;
  assert.match(anon, /Biggest projects:\*\* project-1 100%/);
  assert.doesNotMatch(anon, /my-app/);
});
