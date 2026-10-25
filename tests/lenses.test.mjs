import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { NOW, minutesAgo, tempRoot, assistant, prompt, toolResult, writeTranscript, writeJson } from './helpers.mjs';

const M = 1_000_000;
const out = { output_tokens: M }; // $10 on Sonnet 5.5
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const run = (projects) => analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLogDir: null });

test('each response is attributed to the prompt that started its turn', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s1.jsonl', [
    prompt({ ts: minutesAgo(30), origin: 'human' }),
    assistant({ ts: minutesAgo(29), usage: out }),
    toolResult({ ts: minutesAgo(28) }),
    assistant({ ts: minutesAgo(28), usage: out }),
    prompt({ ts: minutesAgo(20), origin: 'task-notification' }),
    assistant({ ts: minutesAgo(19), usage: out }),
  ]);
  const r = await run(projects);
  close(r.turns.human.cost, 20);
  close(r.turns.automated.cost, 10);
  close(r.turns.automated.byKind['task-notification'].cost, 10);
});

test('desktop prompts arrive through the SDK but count as human', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s1.jsonl', [
    prompt({ ts: minutesAgo(10), origin: 'human', promptSource: 'sdk' }),
    assistant({ ts: minutesAgo(9), usage: out, entrypoint: 'claude-desktop' }),
  ]);
  const r = await run(projects);
  close(r.turns.human.cost, 10);
  close(r.turns.automated.cost, 0);
});

test('a prompt repeated three or more times in a session is a loop', async () => {
  const { projects } = tempRoot();
  const firing = (m) => [prompt({ ts: minutesAgo(m), origin: null, promptSource: 'system', text: 'check  CI\n' }), assistant({ ts: minutesAgo(m - 1), usage: out })];
  writeTranscript(projects, 'p/loop.jsonl', [...firing(60), ...firing(40), ...firing(20)]);
  writeTranscript(projects, 'p/twice.jsonl', [
    prompt({ ts: minutesAgo(50), text: 'same' }), assistant({ ts: minutesAgo(49), usage: out }),
    prompt({ ts: minutesAgo(30), text: 'same' }), assistant({ ts: minutesAgo(29), usage: out }),
  ]);
  const r = await run(projects);
  close(r.loops.cost, 30);
  assert.equal(r.loops.sessions, 1);
  assert.equal(r.loops.runs, 3);
});

test('subagents and workflow agents are their own lens, by agent type and model', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s1.jsonl', [prompt({ ts: minutesAgo(30) }), assistant({ ts: minutesAgo(29), usage: out })]);
  writeTranscript(projects, 'p/s1/subagents/agent-a1.jsonl', [assistant({ ts: minutesAgo(28), model: 'claude-opus-5-5', usage: out })]);
  writeJson(projects, 'p/s1/subagents/agent-a1.meta.json', { agentType: 'Explore' });
  writeTranscript(projects, 'p/s1/subagents/workflows/wf_1/agent-b1.jsonl', [assistant({ ts: minutesAgo(27), usage: out })]);
  writeJson(projects, 'p/s1/subagents/workflows/wf_1/agent-b1.meta.json', { agentType: 'workflow-subagent', workflowPhase: 'Verify' });
  const r = await run(projects);
  close(r.mainConversation.cost, 10);
  close(r.agents.subagent.cost, 20);
  close(r.agents.subagent.byType.Explore.cost, 20);
  close(r.agents.subagent.byModel['opus-5-5'].cost, 20);
  close(r.agents.workflow.cost, 10);
  assert.equal(r.totals.sessions, 1);
});

test('sessions started through the SDK are grouped, and known plugin reviewers are labelled', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/review.jsonl', [
    prompt({ ts: minutesAgo(10), origin: 'human', promptSource: 'sdk', text: 'Review this change for security vulnerabilities.\n\nChanged files: secret.ts' }),
    assistant({ ts: minutesAgo(9), usage: out, entrypoint: 'sdk-py' }),
  ]);
  writeTranscript(projects, 'p/script.jsonl', [
    prompt({ ts: minutesAgo(8), origin: 'human', promptSource: 'sdk', text: 'my private script prompt' }),
    assistant({ ts: minutesAgo(7), usage: out, entrypoint: 'sdk-ts' }),
  ]);
  const r = await run(projects);
  close(r.byEntrypoint['sdk-py'].cost, 10);
  close(r.toolSessions['security-guidance review'].cost, 10);
  close(r.toolSessions['other SDK sessions'].cost, 10);
  assert.ok(!JSON.stringify(r).includes('private script'));
  assert.ok(!JSON.stringify(r).includes('secret.ts'));
});
