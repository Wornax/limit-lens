// Stream transcripts once and aggregate API-equivalent cost into the report's lenses.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { requestCost, PRICES_AS_OF } from './pricing.mjs';
import { keptLines } from './lines.mjs';
import { findTranscripts } from './discover.mjs';
import { labelForPrompt } from './signatures.mjs';
import { readSecurityGuidanceLog } from './plugins/security-guidance.mjs';

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
    context: { avgPromptTokens: 0, requestsOver200k: 0, costOver200k: 0 },
    cache: { rebuilds: { afterIdle: { cost: 0, count: 0 }, modelSwitch: { cost: 0, count: 0 }, other: { cost: 0, count: 0 } } },
    topSessions: [],
    outside: { cost: 0 },
    plugins: {},
  };
}

// A request "rebuilds" the cache when it writes most of its prompt again (not just the new turn).
const REBUILD_MIN_TOKENS = 10_000;
const REBUILD_MIN_SHARE = 0.5;
const HOUR = 3_600_000;
const FIVE_MIN = 300_000;
const TOP_SESSIONS = 5;

export async function analyze({ projectsDirs, now = Date.now(), days = 7, project = null, securityLogDir = null } = {}) {
  const to = typeof now === 'number' ? now : now.getTime();
  const from = to - days * DAY;
  const report = newReport(from, to, days);
  const seen = new Set();
  const sessions = new Set();
  const entrypointSessions = {};
  const sessionRows = [];
  let mainPromptTokens = 0;

  let transcripts = findTranscripts(projectsDirs, from);
  if (project) transcripts = transcripts.filter((t) => t.project.toLowerCase().includes(project.toLowerCase()));

  for (const t of transcripts) {
    const meta = t.metaFile ? readMeta(t.metaFile) : null;
    const f = {
      cost: 0, requests: 0, entrypoint: null, firstLabel: undefined, turn: { hash: null }, hashes: new Map(),
      prevTs: null, prevModel: null, ttlMs: HOUR, promptTokens: 0, rereadCost: 0,
    };

    for await (const { text: line } of keptLines(t.file, { wantPrompts: t.kind === 'main' })) {
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
      f.rereadCost += c.cacheRead;

      const created = usage.cache_creation_input_tokens || 0;
      const promptTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + created;
      if (f.prevTs !== null && created >= REBUILD_MIN_TOKENS && created >= REBUILD_MIN_SHARE * promptTokens) {
        const writeCost = c.cacheWrite5m + c.cacheWrite1h;
        const r = msg.model !== f.prevModel ? 'modelSwitch' : ts - f.prevTs > f.ttlMs ? 'afterIdle' : 'other';
        report.cache.rebuilds[r].cost += writeCost;
        report.cache.rebuilds[r].count += 1;
      }
      if (usage.cache_creation?.ephemeral_1h_input_tokens > 0) f.ttlMs = HOUR;
      else if (created > 0) f.ttlMs = FIVE_MIN;
      f.prevTs = ts;
      f.prevModel = msg.model;
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
        f.promptTokens += promptTokens;
        if (promptTokens > 200_000) {
          report.context.requestsOver200k += 1;
          report.context.costOver200k += c.total;
        }
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

    if (t.kind === 'main' && f.requests > 0) {
      sessionRows.push({
        project: t.project,
        sessionId: t.sessionId,
        entrypoint: f.entrypoint || 'unknown',
        cost: f.cost,
        requests: f.requests,
        avgPromptTokens: Math.round(f.promptTokens / f.requests),
        rereadCost: f.rereadCost,
      });
      mainPromptTokens += f.promptTokens;
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
  const mainRequests = report.mainConversation.requests;
  report.context.avgPromptTokens = mainRequests ? Math.round(mainPromptTokens / mainRequests) : 0;
  report.topSessions = sessionRows.sort((a, b) => b.cost - a.cost).slice(0, TOP_SESSIONS);
  if (securityLogDir) {
    const sg = readSecurityGuidanceLog(securityLogDir, from, to);
    if (sg) {
      report.plugins.securityGuidance = sg;
      report.outside.cost += sg.outsideTranscriptsCost;
    }
  }
  for (const [ep, set] of Object.entries(entrypointSessions)) report.byEntrypoint[ep].sessions = set.size;
  return report;
}
