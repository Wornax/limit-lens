// Adapter for the security-guidance plugin's debug log (<config>/security/log.txt, rotated to log.txt.1).
// Each review writes: "[YYYY-MM-DD HH:MM:SS.mmm] Review usage: review=<stop|commit|push> ... est_cost_usd=<n>[~]".
// Stop reviews call the API directly, so they never appear in transcripts. Commit and push reviews run
// through Claude Code and already show up as SDK sessions, so only stop reviews count as outside spend.
import fs from 'node:fs';
import path from 'node:path';

const LINE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\] Review usage: (.*)$/;

export function readSecurityGuidanceLog(dir, fromMs, toMs) {
  const files = ['log.txt.1', 'log.txt'].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  if (files.length === 0) return null;
  const result = { reviews: {}, outsideTranscriptsCost: 0, estimated: false };
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(LINE);
      if (!m) continue;
      const [, y, mo, d, h, mi, s, ms = '0', rest] = m;
      const ts = new Date(+y, +mo - 1, +d, +h, +mi, +s, +ms.padEnd(3, '0')).getTime();
      if (ts < fromMs || ts > toMs) continue;
      const fields = Object.fromEntries(rest.split(/\s+/).map((kv) => kv.split('=')));
      const raw = fields.est_cost_usd || '0';
      if (raw.endsWith('~')) result.estimated = true;
      const cost = Number.parseFloat(raw) || 0;
      const kind = fields.review || 'unknown';
      const r = (result.reviews[kind] ??= { count: 0, cost: 0 });
      r.count += 1;
      r.cost += cost;
      if (kind === 'stop') result.outsideTranscriptsCost += cost;
    }
  }
  for (const k of ['stop', 'commit', 'push']) result.reviews[k] ??= { count: 0, cost: 0 };
  return result;
}
