import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { NOW, minutesAgo, daysAgo, tempRoot, assistant, prompt, writeTranscript } from './helpers.mjs';

const M = 1_000_000;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const run = (projects, extra = {}) => analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLogDir: null, ...extra });

test('a response written as one line per content block is counted once', async () => {
  const { projects } = tempRoot();
  const usage = { output_tokens: M };
  writeTranscript(projects, 'proj-a/s1.jsonl', [
    prompt({ ts: minutesAgo(10) }),
    assistant({ id: 'msg-1', ts: minutesAgo(9), usage, block: 'thinking' }),
    assistant({ id: 'msg-1', ts: minutesAgo(9), usage, block: 'text' }),
    assistant({ id: 'msg-1', ts: minutesAgo(9), usage, block: 'tool_use' }),
  ]);
  const r = await run(projects);
  assert.equal(r.totals.requests, 1);
  close(r.totals.cost, 10); // 1M Sonnet 5.5 output tokens
});

test('responses outside the window are ignored, even inside a recent file', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'proj-a/s1.jsonl', [
    assistant({ ts: daysAgo(8), usage: { output_tokens: M } }),
    assistant({ ts: daysAgo(1), usage: { output_tokens: M } }),
  ]);
  writeTranscript(projects, 'proj-b/old.jsonl', [assistant({ ts: daysAgo(30), usage: { output_tokens: M } })], { mtime: daysAgo(30) });
  const r = await run(projects);
  assert.equal(r.totals.requests, 1);
  assert.equal(r.totals.sessions, 1);
});

test('cost is broken down by model and by effort level', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'proj-a/s1.jsonl', [
    assistant({ ts: minutesAgo(5), model: 'claude-opus-5-5', effort: 'xhigh', usage: { output_tokens: M } }),
    assistant({ ts: minutesAgo(4), model: 'claude-sonnet-5-5', effort: 'medium', usage: { output_tokens: M } }),
  ]);
  const r = await run(projects);
  close(r.byModel['opus-5-5'].cost, 20);
  close(r.byModel['sonnet-5-5'].cost, 10);
  close(r.byEffort.xhigh.cost, 20);
  close(r.byEffort.medium.cost, 10);
});

test('synthetic messages without real usage are skipped', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'proj-a/s1.jsonl', [
    assistant({ ts: minutesAgo(5), model: '<synthetic>' }),
    assistant({ ts: minutesAgo(4), usage: { output_tokens: 10 } }),
  ]);
  const r = await run(projects);
  assert.equal(r.totals.requests, 1);
});
