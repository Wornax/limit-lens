// Builders for synthetic Claude Code transcripts. Never put real transcript content in tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NOW = Date.parse('2026-10-25T12:00:00Z');
export const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString();
export const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

export function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-lens-'));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  return { root, projects };
}

let seq = 0;
export function assistant({ id, ts, model = 'claude-sonnet-5-5', usage = {}, effort = 'high', entrypoint = 'cli', block = 'text' } = {}) {
  seq += 1;
  return {
    type: 'assistant',
    uuid: `u-${seq}`,
    requestId: `req-${id ?? seq}`,
    timestamp: ts,
    effort,
    entrypoint,
    // Same key order as real transcripts: model, id, type, role, content, ..., usage.
    message: {
      model,
      id: id ?? `msg-${seq}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: block }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    },
  };
}

export function prompt({ ts, text = 'do the thing', origin = 'human', promptSource, isMeta } = {}) {
  seq += 1;
  const line = { type: 'user', uuid: `u-${seq}`, timestamp: ts, message: { role: 'user', content: text } };
  if (origin) line.origin = { kind: origin };
  if (promptSource) line.promptSource = promptSource;
  if (isMeta) line.isMeta = true;
  return line;
}

export function toolResult({ ts }) {
  seq += 1;
  return { type: 'user', uuid: `u-${seq}`, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'SECRET TOOL OUTPUT' }] } };
}

// Write a transcript and return its path. `rel` is relative to the projects folder.
export function writeTranscript(projects, rel, lines, { mtime } = {}) {
  const file = path.join(projects, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(mtime ?? NOW);
  fs.utimesSync(file, t, t);
  return file;
}

export function writeJson(projects, rel, obj) {
  const file = path.join(projects, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}
