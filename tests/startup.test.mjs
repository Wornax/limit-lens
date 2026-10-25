import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-xray/scripts/lib/analyze.mjs';
import { findings } from '../plugins/limit-xray/scripts/lib/findings.mjs';
import { NOW, minutesAgo, daysAgo, tempRoot, assistant, prompt, writeTranscript, writeJson } from './helpers.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const run = (projects) => analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
const w5m = (n) => ({ cache_creation_input_tokens: n, cache_creation: { ephemeral_5m_input_tokens: n, ephemeral_1h_input_tokens: 0 } });

test('the first request of each session and agent is its startup cost', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    prompt({ ts: minutesAgo(30) }),
    assistant({ ts: minutesAgo(29), usage: w5m(40_000) }), // startup: 40K Sonnet 5.5 5m writes = $0.10
    assistant({ ts: minutesAgo(28), usage: { cache_read_input_tokens: 40_000, ...w5m(2_000) } }),
  ]);
  for (const a of ['a1', 'a2']) {
    writeTranscript(projects, `p/s/subagents/agent-${a}.jsonl`, [
      assistant({ ts: minutesAgo(27), usage: w5m(20_000) }), // $0.05 each
      assistant({ ts: minutesAgo(26), usage: { cache_read_input_tokens: 20_000 } }),
    ]);
    writeJson(projects, `p/s/subagents/agent-${a}.meta.json`, { agentType: 'general-purpose' });
  }
  const r = await run(projects);
  assert.equal(r.startup.count, 3);
  close(r.startup.cost, 0.2);
  assert.equal(r.startup.avgTokens, Math.round(80_000 / 3));
  assert.equal(r.startup.byKind.subagent.count, 2);
});

test('a session that started before the window has no startup in it', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/old.jsonl', [
    assistant({ ts: daysAgo(9), usage: w5m(40_000) }),
    assistant({ ts: minutesAgo(5), usage: w5m(40_000) }),
  ]);
  const r = await run(projects);
  assert.equal(r.startup.count, 0);
});

test('heavy startup spend points at /context, CLAUDE.md size and unused MCP servers', async () => {
  const r = await analyze({ projectsDirs: [tempRoot().projects], now: NOW, days: 7, securityLog: null });
  r.totals.cost = 100;
  r.startup = { cost: 20, count: 400, avgTokens: 45_000, byKind: { main: { count: 10, cost: 1 }, subagent: { count: 90, cost: 5 }, workflow: { count: 300, cost: 14 } } };
  const f = findings(r).find((x) => x.id === 'startup');
  assert.ok(f);
  const text = JSON.stringify(f);
  assert.match(text, /\/context/);
  assert.match(text, /CLAUDE\.md/);
  assert.match(text, /\/mcp/);
});
