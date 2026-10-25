import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { keptLines, classifyHead } from '../plugins/limit-xray/scripts/lib/lines.mjs';
import { tempRoot } from './helpers.mjs';

const assistantLine = (n, pad) => JSON.stringify({ parentUuid: 'p', message: { model: 'm', id: `id-${n}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'é✓'.repeat(pad) }] }, type: 'assistant' });
const promptLine = (n) => JSON.stringify({ parentUuid: 'p', type: 'user', message: { role: 'user', content: `prompt ${n} ✓` } });
const toolLine = (pad) => JSON.stringify({ parentUuid: 'p', type: 'user', message: { role: 'user', content: [{ tool_use_id: 't', type: 'tool_result', content: 'x'.repeat(pad) }] } });
const blobLine = (pad) => JSON.stringify({ type: 'api-request-blob', body: 'y'.repeat(pad) });

async function collect(file, opts) {
  const got = [];
  for await (const l of keptLines(file, opts)) got.push(l);
  return got;
}

test('kept lines match a naive split for every chunk and head size, line ending and trailing newline', async () => {
  const { root } = tempRoot();
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const r = i % 4;
    lines.push(r === 0 ? assistantLine(i, (i * 37) % 300) : r === 1 ? promptLine(i) : r === 2 ? toolLine((i * 53) % 900) : blobLine((i * 71) % 700));
  }
  const expected = lines
    .map((l) => ({ l, kind: classifyHead(Buffer.from(l).subarray(0, 64), true) }))
    .filter((x) => x.kind)
    .map((x) => ({ kind: x.kind, text: x.l }));
  for (const eol of ['\n', '\r\n']) {
    for (const trailing of [true, false]) {
      const file = path.join(root, `f-${eol.length}-${trailing}.jsonl`);
      fs.writeFileSync(file, lines.join(eol) + (trailing ? eol : ''));
      for (const chunkSize of [7, 64, 1000, 1 << 20]) {
        const got = await collect(file, { wantPrompts: true, chunkSize, headSize: 64 });
        assert.deepEqual(got.map((g) => ({ kind: g.kind, text: g.text.replace(/\r$/, '') })), expected, `eol=${JSON.stringify(eol)} trailing=${trailing} chunk=${chunkSize}`);
      }
    }
  }
});

test('prompts are skipped when not wanted', async () => {
  const { root } = tempRoot();
  const file = path.join(root, 'f.jsonl');
  fs.writeFileSync(file, [promptLine(1), assistantLine(2, 3)].join('\n'));
  const got = await collect(file, { wantPrompts: false });
  assert.deepEqual(got.map((g) => g.kind), ['assistant']);
});
