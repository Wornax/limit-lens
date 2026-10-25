// Stream transcripts once and aggregate API-equivalent cost into the report's lenses.
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import { requestCost, PRICES_AS_OF } from './pricing.mjs';
import { findTranscripts } from './discover.mjs';
import { labelForPrompt } from './signatures.mjs';

const DAY = 86_400_000;
const LOOP_MIN_RUNS = 3;

const bucket = () => ({ cost: 0, requests: 0 });
function add(map, key, cost) {
  const b = (map[key] ??= bucket());
  b.cost += cost;
  b.requests += 1;
  return b;
}

// Who started a turn: 'human', or the kind of automation ('task-notification', 'peer', 'system', 'sdk', ...).
function turnKind(turn, entrypoint) {
  if (turn.originKind) return turn.originKind;
  const ps = turn.promptSource;
  if (!ps || ps === 'typed' || ps === 'queued' || ps === 'suggestion_accepted') return 'human';
  if (ps === 'sdk') return entrypoint === 'claude-desktop' ? 'human' : 'sdk';
  return ps;
}

function promptText(o) {
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary) return null;
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b?.type === 'tool_result')) return null;
  return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

const hashOf = (text) => crypto.createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function newReport(from, to, days) {
  return {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days },
    pricesAsOf: PRICES_AS_OF,
    totals: { cost: 0, requests: 0, sessions: 0, estimatedCost: 0 },
    components: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0 },
    byModel: {},
    byEffort: {},
    byEntrypoint: {},
    mainConversation: bucket(),
    turns: { human: bucket(), automated: { ...bucket(), byKind: {} } },
    loops: { cost: 0, requests: 0, runs: 0, sessions: 0 },
    agents: {
      subagent: { ...bucket(), byType: {}, byModel: {} },
      workflow: { ...bucket(), byType: {}, byModel: {} },
    },
    toolSessions: {},
  };
}

export async function analyze({ projectsDirs, now = Date.now(), days = 7, project = null, securityLogDir = null } = {}) {
  const to = typeof now === 'number' ? now : now.getTime();
  const from = to - days * DAY;
  const report = newReport(from, to, days);
  const seen = new Set();
  const sessions = new Set();
  const entrypointSessions = {};

  let transcripts = findTranscripts(projectsDirs, from);
  if (project) transcripts = transcripts.filter((t) => t.project.toLowerCase().includes(project.toLowerCase()));

  for (const t of transcripts) {
    const meta = t.metaFile ? readMeta(t.metaFile) : null;
    const f = { cost: 0, requests: 0, entrypoint: null, firstLabel: undefined, turn: { hash: null }, hashes: new Map() };

    const rl = readline.createInterface({ input: fs.createReadStream(t.file), crlfDelay: Infinity });
    for await (const line of rl) {
      const isAssistant = line.includes('"type":"assistant"');
      const maybePrompt = t.kind === 'main' && !isAssistant && line.includes('"type":"user"') && !line.includes('"tool_use_id"');
      if (!isAssistant && !maybePrompt) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }

      if (o.type === 'user') {
        const text = promptText(o);
        if (text === null) continue;
        const hash = hashOf(text);
        f.turn = { originKind: o.origin?.kind || null, promptSource: o.promptSource || null, hash };
        if (f.firstLabel === undefined) f.firstLabel = labelForPrompt(text);
        const h = f.hashes.get(hash) ?? { runs: 0, cost: 0, requests: 0 };
        h.runs += 1;
        f.hashes.set(hash, h);
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
      if (c.total === 0) continue;

      f.entrypoint ??= o.entrypoint || null;
      f.cost += c.total;
      f.requests += 1;
      sessions.add(`${t.project}/${t.sessionId}`);
      report.totals.cost += c.total;
      report.totals.requests += 1;
      if (c.estimated) report.totals.estimatedCost += c.total;
      for (const k of Object.keys(report.components)) report.components[k] += c[k];
      add(report.byModel, c.priceKey, c.total);
      add(report.byEffort, o.effort || 'unknown', c.total);
      const ep = o.entrypoint || 'unknown';
      add(report.byEntrypoint, ep, c.total);
      (entrypointSessions[ep] ??= new Set()).add(`${t.project}/${t.sessionId}`);

      if (t.kind === 'main') {
        report.mainConversation.cost += c.total;
        report.mainConversation.requests += 1;
        const kind = turnKind(f.turn, f.entrypoint);
        if (kind === 'human') {
          report.turns.human.cost += c.total;
          report.turns.human.requests += 1;
        } else {
          report.turns.automated.cost += c.total;
          report.turns.automated.requests += 1;
          add(report.turns.automated.byKind, kind, c.total);
        }
        const h = f.turn.hash && f.hashes.get(f.turn.hash);
        if (h) {
          h.cost += c.total;
          h.requests += 1;
        }
      } else {
        const lens = report.agents[t.kind];
        lens.cost += c.total;
        lens.requests += 1;
        add(lens.byType, meta?.agentType || 'unknown', c.total);
        add(lens.byModel, c.priceKey, c.total);
      }
    }

    if (t.kind === 'main') {
      let looped = false;
      for (const h of f.hashes.values()) {
        if (h.runs < LOOP_MIN_RUNS || h.requests === 0) continue;
        looped = true;
        report.loops.cost += h.cost;
        report.loops.requests += h.requests;
        report.loops.runs += h.runs;
      }
      if (looped) report.loops.sessions += 1;
      if (f.requests > 0 && f.entrypoint?.startsWith('sdk')) {
        const s = (report.toolSessions[f.firstLabel || 'other SDK sessions'] ??= { cost: 0, requests: 0, sessions: 0 });
        s.cost += f.cost;
        s.requests += f.requests;
        s.sessions += 1;
      }
    }
  }

  report.totals.sessions = sessions.size;
  for (const [ep, set] of Object.entries(entrypointSessions)) report.byEntrypoint[ep].sessions = set.size;
  return report;
}
