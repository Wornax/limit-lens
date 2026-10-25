import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { NOW, daysAgo, tempRoot, assistant, writeTranscript } from './helpers.mjs';

const out = { output_tokens: 1_000_000 };

test('an explicit from/to window replaces the days window', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: daysAgo(10), usage: out }),
    assistant({ ts: daysAgo(5), usage: out }),
    assistant({ ts: daysAgo(1), usage: out }),
  ]);
  const r = await analyze({ projectsDirs: [projects], from: NOW - 6 * 86_400_000, to: NOW - 2 * 86_400_000, securityLog: null });
  assert.equal(r.totals.requests, 1);
  assert.equal(r.window.days, 4);
});

test('active days count the distinct days with usage', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: daysAgo(3), usage: out }),
    assistant({ ts: daysAgo(3), usage: out }),
    assistant({ ts: daysAgo(1), usage: out }),
  ]);
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  assert.equal(r.activeDays, 2);
});
