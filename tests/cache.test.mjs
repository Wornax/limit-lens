import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-xray/scripts/lib/analyze.mjs';
import { NOW, minutesAgo, tempRoot, assistant, prompt, writeTranscript } from './helpers.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const run = (projects) => analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
const write1h = (n) => ({ cache_creation_input_tokens: n, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: n } });
const write5m = (n) => ({ cache_creation_input_tokens: n, cache_creation: { ephemeral_5m_input_tokens: n, ephemeral_1h_input_tokens: 0 } });

test('re-reading the conversation is measured overall and per session', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/big.jsonl', [
    prompt({ ts: minutesAgo(10) }),
    assistant({ ts: minutesAgo(9), model: 'claude-opus-5-5', usage: { cache_read_input_tokens: 300_000, output_tokens: 1000 } }),
    assistant({ ts: minutesAgo(8), model: 'claude-opus-5-5', usage: { cache_read_input_tokens: 300_000, output_tokens: 1000 } }),
  ]);
  const r = await run(projects);
  close(r.components.cacheRead, 0.12); // 600K reads at $0.20/MTok
  assert.equal(r.context.avgPromptTokens, 300_000);
  assert.equal(r.context.requestsOver200k, 2);
  assert.equal(r.topSessions[0].requests, 2);
  close(r.topSessions[0].rereadCost, 0.12);
});

test('a cache rewritten after a pause longer than its lifetime counts as a rebuild', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    prompt({ ts: minutesAgo(200) }),
    assistant({ ts: minutesAgo(199), model: 'claude-opus-5-5', usage: write1h(200_000) }),
    prompt({ ts: minutesAgo(100) }),
    assistant({ ts: minutesAgo(99), model: 'claude-opus-5-5', usage: write1h(200_000) }), // 100 min gap > 1h
    prompt({ ts: minutesAgo(95) }),
    assistant({ ts: minutesAgo(94), model: 'claude-opus-5-5', usage: { ...write1h(1_000), cache_read_input_tokens: 200_000 } }),
  ]);
  writeTranscript(projects, 'p/short-ttl.jsonl', [
    assistant({ ts: minutesAgo(60), usage: write5m(100_000) }),
    assistant({ ts: minutesAgo(50), usage: write5m(100_000) }), // 10 min gap > 5 min
  ]);
  const r = await run(projects);
  assert.equal(r.cache.rebuilds.afterIdle.count, 2);
  close(r.cache.rebuilds.afterIdle.cost, 1.6 + 0.25); // 200K Opus 5.5 1h writes + 100K Sonnet 5.5 5m writes
});

test('switching models mid-session rebuilds the cache', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: minutesAgo(10), model: 'claude-opus-5-5', usage: write5m(150_000) }),
    assistant({ ts: minutesAgo(9), model: 'claude-sonnet-5-5', usage: write5m(150_000) }),
  ]);
  const r = await run(projects);
  assert.equal(r.cache.rebuilds.modelSwitch.count, 1);
  close(r.cache.rebuilds.modelSwitch.cost, 0.375);
  assert.equal(r.cache.rebuilds.afterIdle.count, 0);
});
