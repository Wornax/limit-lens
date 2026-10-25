import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { NOW, minutesAgo, tempRoot, assistant, prompt, writeTranscript, writeJson } from './helpers.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('agent lenses split their spend into reads, writes and output, with average prompt size', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s1.jsonl', [prompt({ ts: minutesAgo(30) }), assistant({ ts: minutesAgo(29), usage: { output_tokens: 10 } })]);
  writeTranscript(projects, 'p/s1/subagents/agent-a.jsonl', [
    assistant({ ts: minutesAgo(28), usage: { cache_creation_input_tokens: 100_000, output_tokens: 1_000_000 } }),
    assistant({ ts: minutesAgo(27), usage: { cache_read_input_tokens: 100_000 } }),
  ]);
  writeJson(projects, 'p/s1/subagents/agent-a.meta.json', { agentType: 'general-purpose' });
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  const s = r.agents.subagent;
  close(s.components.cacheWrite, 0.25); // 100K Sonnet 5.5 5m writes
  close(s.components.cacheRead, 0.01);
  close(s.components.output, 10);
  assert.equal(s.avgPromptTokens, 100_000);
});

test('fast mode spend is tracked', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: minutesAgo(5), model: 'claude-opus-5-5', usage: { output_tokens: 1_000_000, speed: 'fast' } }),
    assistant({ ts: minutesAgo(4), model: 'claude-opus-5-5', usage: { output_tokens: 1_000_000 } }),
  ]);
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  close(r.fastMode.cost, 40);
  assert.equal(r.fastMode.requests, 1);
});
