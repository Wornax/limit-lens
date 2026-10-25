// Adapter for the security-guidance plugin's debug log. The plugin writes to
// SECURITY_GUIDANCE_DEBUG_LOG or <state dir>/log.txt and rotates the full file to "<file>.1" at 1 MiB.
// Each review writes: "[YYYY-MM-DD HH:MM:SS.mmm] Review usage: review=<stop|commit|push> ... est_cost_usd=<n>[~]"
// in local time. Stop reviews call the API directly, so they never appear in transcripts. Commit and
// push reviews run through Claude Code and already show up as SDK sessions, so only stop reviews
// count as spend outside transcripts.
import fs from 'node:fs';

const STAMP = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\] (.*)$/;
const USAGE = /^Review usage: (.*)$/;
// One review costs cents to a few dollars; anything outside [0, 1000] is a corrupt or forged line.
const MAX_REVIEW_COST = 1000;

export function readSecurityGuidanceLog(logFile, fromMs, toMs) {
  const files = [`${logFile}.1`, logFile].filter((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
  if (files.length === 0) return null;
  const result = { reviews: Object.create(null), outsideTranscriptsCost: 0, estimated: false, coversFrom: null };
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(STAMP);
      if (!m) continue;
      const [, y, mo, d, h, mi, s, ms = '0', rest] = m;
      const ts = new Date(+y, +mo - 1, +d, +h, +mi, +s, +ms.padEnd(3, '0')).getTime();
      if (Number.isNaN(ts)) continue;
      if (result.coversFrom === null || ts < result.coversFrom) result.coversFrom = ts;
      const u = rest.match(USAGE);
      if (!u || ts < fromMs || ts > toMs) continue;
      const fields = Object.create(null);
      for (const kv of u[1].split(/\s+/)) {
        const i = kv.indexOf('=');
        if (i > 0) fields[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const raw = fields.est_cost_usd || '0';
      if (raw.endsWith('~')) result.estimated = true;
      const cost = Number.parseFloat(raw);
      if (!Number.isFinite(cost) || cost < 0 || cost > MAX_REVIEW_COST) continue;
      const kind = ['stop', 'commit', 'push'].includes(fields.review) ? fields.review : 'other';
      const r = (result.reviews[kind] ??= { count: 0, cost: 0 });
      r.count += 1;
      r.cost += cost;
      if (kind === 'stop') result.outsideTranscriptsCost += cost;
    }
  }
  for (const k of ['stop', 'commit', 'push']) result.reviews[k] ??= { count: 0, cost: 0 };
  return result;
}
