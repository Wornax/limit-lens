// Stream transcripts once and aggregate API-equivalent cost into the report's lenses.
import fs from 'node:fs';
import readline from 'node:readline';
import { requestCost, PRICES_AS_OF } from './pricing.mjs';
import { findTranscripts } from './discover.mjs';

const DAY = 86_400_000;

const bucket = () => ({ cost: 0, requests: 0 });
function add(map, key, cost) {
  const b = (map[key] ??= bucket());
  b.cost += cost;
  b.requests += 1;
  return b;
}

export async function analyze({ projectsDirs, now = Date.now(), days = 7, project = null, securityLogDir = null } = {}) {
  const to = typeof now === 'number' ? now : now.getTime();
  const from = to - days * DAY;
  const report = {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days },
    pricesAsOf: PRICES_AS_OF,
    totals: { cost: 0, requests: 0, sessions: 0, estimatedCost: 0 },
    components: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0 },
    byModel: {},
    byEffort: {},
  };

  const seen = new Set();
  const sessions = new Set();
  let transcripts = findTranscripts(projectsDirs, from);
  if (project) transcripts = transcripts.filter((t) => t.project.toLowerCase().includes(project.toLowerCase()));

  for (const t of transcripts) {
    const rl = readline.createInterface({ input: fs.createReadStream(t.file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"type":"assistant"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'assistant') continue;
      const msg = o.message;
      const usage = msg?.usage;
      if (!usage || !msg.model || msg.model === '<synthetic>') continue;
      const ts = Date.parse(o.timestamp);
      if (!(ts >= from && ts <= to)) continue;
      const id = msg.id || o.requestId;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const c = requestCost(msg.model, usage);
      if (c.total === 0 && !(usage.output_tokens > 0)) continue;

      sessions.add(`${t.project}/${t.sessionId}`);
      report.totals.cost += c.total;
      report.totals.requests += 1;
      if (c.estimated) report.totals.estimatedCost += c.total;
      for (const k of Object.keys(report.components)) report.components[k] += c[k];
      add(report.byModel, c.priceKey, c.total);
      add(report.byEffort, o.effort || 'unknown', c.total);
    }
  }
  report.totals.sessions = sessions.size;
  return report;
}
