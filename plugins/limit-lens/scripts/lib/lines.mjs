// Fast JSONL reader. Transcripts are mostly tool results and request blobs we never need, so each
// line is classified from its first bytes and skipped without being assembled or decoded.
import fs from 'node:fs';

const HEAD = 8192;
const CHUNK = 1 << 20;
const TYPED_RECORD = Buffer.from('{"type":"');
const TYPED_ASSISTANT = Buffer.from('{"type":"assistant"');
const TYPED_USER = Buffer.from('{"type":"user"');
const ROLE_ASSISTANT = Buffer.from('"role":"assistant"');
const ROLE_USER = Buffer.from('"role":"user"');
const TOOL_RESULT = Buffer.from('"tool_result"');

// 'assistant' | 'prompt' | null, decided from the start of a line.
export function classifyHead(head, wantPrompts) {
  // Records that lead with their type (queue, api-request, snapshots, titles...) are never needed,
  // unless a future format leads with "assistant" or "user" too.
  if (head.indexOf(TYPED_RECORD) === 0 && head.indexOf(TYPED_ASSISTANT) !== 0 && head.indexOf(TYPED_USER) !== 0) return null;
  if (head.indexOf(ROLE_ASSISTANT) !== -1) return 'assistant';
  if (wantPrompts && head.indexOf(ROLE_USER) !== -1 && head.indexOf(TOOL_RESULT) === -1) return 'prompt';
  return null;
}

// Yields { kind, text } for kept lines only.
export async function* keptLines(file, { wantPrompts }) {
  let parts = [];
  let size = 0;
  let kind; // undefined = undecided, null = skip
  const decide = () => {
    const head = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    parts = [head];
    kind = classifyHead(head.subarray(0, HEAD), wantPrompts);
    if (kind === null) {
      parts = [];
      size = 0;
    }
  };
  const emit = () => {
    const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    return { kind, text: buf.toString('utf8') };
  };

  for await (const chunk of fs.createReadStream(file, { highWaterMark: CHUNK })) {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(10, start);
      const end = nl === -1 ? chunk.length : nl;
      if (kind !== null && end > start) {
        parts.push(chunk.subarray(start, end));
        size += end - start;
      }
      if (kind === undefined && (size >= HEAD || nl !== -1) && size > 0) decide();
      if (nl === -1) break;
      if (kind) yield emit();
      parts = [];
      size = 0;
      kind = undefined;
      start = nl + 1;
    }
  }
  if (kind === undefined && size > 0) decide();
  if (kind) yield emit();
}
