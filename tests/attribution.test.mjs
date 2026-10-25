import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { NOW, minutesAgo, tempRoot, assistant, prompt, writeTranscript, writeJson } from './helpers.mjs';

const M = 1_000_000;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const run = (projects) => analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });

test('spend is attributed to projects, split by main conversation, agents, Opus and effort', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'proj-a/s1.jsonl', [
    prompt({ ts: minutesAgo(20) }),
    assistant({ ts: minutesAgo(19), model: 'claude-opus-5-5', effort: 'xhigh', usage: { output_tokens: M } }), // $20
  ]);
  writeTranscript(projects, 'proj-a/s1/subagents/agent-1.jsonl', [assistant({ ts: minutesAgo(18), model: 'claude-opus-5-5', usage: { output_tokens: M } })]); // $20
  writeJson(projects, 'proj-a/s1/subagents/agent-1.meta.json', { agentType: 'code-reviewer' });
  writeTranscript(projects, 'proj-b/s2.jsonl', [assistant({ ts: minutesAgo(17), model: 'claude-sonnet-5-5', usage: { output_tokens: M } })]); // $10
  const r = await run(projects);
  const a = r.byProject['proj-a'];
  close(a.cost, 40);
  close(a.mainCost, 20);
  close(a.agentCost, 20);
  close(a.opusMainCost, 20);
  close(a.opusAgentCost, 20);
  close(a.highEffortCost, 20);
  close(r.byProject['proj-b'].cost, 10);
  close(r.agents.subagent.byType['code-reviewer'].opusCost, 20);
});

test('sessions with the largest contexts are listed with their requests over 200K', async () => {
  const { projects } = tempRoot();
  const big = { cache_read_input_tokens: 400_000, output_tokens: 100 };
  writeTranscript(projects, 'p/huge.jsonl', [assistant({ ts: minutesAgo(10), usage: big }), assistant({ ts: minutesAgo(9), usage: big })]);
  writeTranscript(projects, 'p/small.jsonl', [assistant({ ts: minutesAgo(8), usage: { cache_read_input_tokens: 50_000, output_tokens: 100 } })]);
  const r = await run(projects);
  assert.equal(r.contextSessions[0].sessionId, 'huge');
  assert.equal(r.contextSessions[0].requestsOver200k, 2);
  assert.ok(!r.contextSessions.some((s) => s.sessionId === 'small'));
});
