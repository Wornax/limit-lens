import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { NOW, minutesAgo, tempRoot, assistant, prompt, writeTranscript } from './helpers.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('huge lines spanning several read chunks do not break attribution', async () => {
  const { projects } = tempRoot();
  const bigToolResult = {
    parentUuid: 'x',
    type: 'user',
    timestamp: minutesAgo(8),
    message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'x'.repeat(3_500_000) }] },
  };
  const bigApiRequest = { type: 'api-request', blob: 'y'.repeat(2_500_000) };
  const bigAnswer = assistant({ ts: minutesAgo(7), usage: { output_tokens: 1_000_000 } });
  bigAnswer.message.content = [{ type: 'text', text: 'z'.repeat(2_000_000) }];
  writeTranscript(projects, 'p/s.jsonl', [
    prompt({ ts: minutesAgo(10), origin: 'task-notification' }),
    bigApiRequest,
    bigToolResult,
    bigAnswer,
    assistant({ ts: minutesAgo(6), usage: { output_tokens: 1_000_000 } }),
  ]);
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  assert.equal(r.totals.requests, 2);
  close(r.turns.automated.cost, 20);
});

test('Windows line endings are handled', async () => {
  const { projects } = tempRoot();
  const file = writeTranscript(projects, 'p/crlf.jsonl', [
    prompt({ ts: minutesAgo(10) }),
    assistant({ ts: minutesAgo(9), usage: { output_tokens: 1_000_000 } }),
  ]);
  const fs = await import('node:fs');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  assert.equal(r.totals.requests, 1);
  close(r.turns.human.cost, 10);
});
