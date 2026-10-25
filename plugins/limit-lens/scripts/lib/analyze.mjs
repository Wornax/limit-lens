// Stream transcripts once and aggregate API-equivalent cost into the report's lenses.
// Transcript contents are untrusted: values that reach the report go through `label()`,
// and every keyed map has a null prototype.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { requestCost, PRICES_AS_OF } from './pricing.mjs';
import { findTranscripts } from './discover.mjs';
import { keptLines } from './lines.mjs';
import { labelForPrompt } from './signatures.mjs';
import { readSecurityGuidanceLog } from './plugins/security-guidance.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FIVE_MIN = 300_000;
const LOOP_MIN_RUNS = 3;
const TOP_SESSIONS = 5;
// A request "rebuilds" the cache when it writes most of its prompt again (not just the new turn).
const REBUILD_MIN_TOKENS = 10_000;
const REBUILD_MIN_SHARE = 0.5;

// User lines that echo a local command (no model turn starts from them).
const NOT_A_TURN = /^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
// A slash command fired by the scheduler: origin human, no prompt source, wrapped in <command-message>.
const SCHEDULED_COMMAND = /^<command-message>/;
const TYPED_SOURCES = new Set(['typed', 'queued', 'suggestion_accepted']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const map = () => Object.create(null);
const bucket = () => ({ cost: 0, requests: 0 });

// Only short, plain identifiers from transcripts reach the report.
export function label(value, max = 24) {
  if (value === undefined || value === null || value === '') return 'unknown';
  const s = String(value);
  if (RESERVED_KEYS.has(s) || !new RegExp(`^[A-Za-z0-9_.:-]{1,${max}}$`).test(s)) return 'other';
  return s;
}

function add(target, key, cost) {
  const b = (target[key] ??= bucket());
  b.cost += cost;
  b.requests += 1;
  return b;
}

// Who started a turn: 'human', or the kind of automation ('task-notification', 'peer', 'system', 'sdk', ...).
function turnKind(turn, entrypoint) {
  if (turn.originKind) return turn.originKind === 'human' ? 'human' : label(turn.originKind);
  const ps = turn.promptSource;
  if (!ps || TYPED_SOURCES.has(ps)) return 'human';
  if (ps === 'sdk') return entrypoint === 'claude-desktop' ? 'human' : 'sdk';
  return label(ps);
}

function promptText(o) {
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary) return null;
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b?.type === 'tool_result')) return null;
  return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const agentLens = () => ({
  ...bucket(),
  byType: map(),
  byModel: map(),
  components: { cacheRead: 0, cacheWrite: 0, output: 0, input: 0 },
  promptTokens: 0,
  avgPromptTokens: 0,
  agents: 0,
});

function newReport(from, to, days) {
  return {
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days },
    pricesAsOf: PRICES_AS_OF,
    totals: { cost: 0, requests: 0, sessions: 0, estimatedCost: 0 },
    components: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0 },
    byModel: map(),
    byEffort: map(),
    byEntrypoint: map(),
    mainConversation: bucket(),
    turns: { human: bucket(), automated: { ...bucket(), byKind: map() } },
    loops: { cost: 0, requests: 0, runs: 0, sessions: 0 },
    agents: { subagent: agentLens(), workflow: agentLens() },
    fastMode: bucket(),
    toolSessions: map(),
    context: { avgPromptTokens: 0, requestsOver200k: 0, costOver200k: 0 },
    cache: { rebuilds: { afterIdle: { cost: 0, count: 0 }, modelSwitch: { cost: 0, count: 0 }, other: { cost: 0, count: 0 } } },
    topSessions: [],
    outside: { cost: 0 },
    plugins: {},
    notes: [],
  };
}

export async function analyze({ projectsDirs, now = Date.now(), days = 7, project = null, securityLog = null } = {}) {
  const to = typeof now === 'number' ? now : now.getTime();
  const from = to - days * DAY;
  const report = newReport(from, to, days);
  const seen = new Set();
  const sessions = new Set();
  const entrypointSessions = map();
  const sessionRows = [];
  let mainPromptTokens = 0;

  let transcripts = findTranscripts(projectsDirs, from);
  if (project) transcripts = transcripts.filter((t) => t.project.toLowerCase().includes(project.toLowerCase()));

  for (const t of transcripts) {
    const f = {
      cost: 0, requests: 0, entrypoint: null, firstLabel: undefined, turn: { hash: null }, hashes: new Map(),
      prevTs: null, prevModel: null, ttlMs: HOUR, promptTokens: 0, rereadCost: 0,
    };
    try {
      await readTranscript(t, f, { from, to, report, seen, sessions, entrypointSessions });
    } catch {
      report.notes.push('unreadable-transcript');
      continue;
    }
    finishTranscript(t, f, report, sessionRows);
    if (t.kind === 'main') mainPromptTokens += f.promptTokens;
  }

  report.totals.sessions = sessions.size;
  const mainRequests = report.mainConversation.requests;
  report.context.avgPromptTokens = mainRequests ? Math.round(mainPromptTokens / mainRequests) : 0;
  for (const lens of Object.values(report.agents)) {
    lens.avgPromptTokens = lens.requests ? Math.round(lens.promptTokens / lens.requests) : 0;
    delete lens.promptTokens;
  }
  for (const [ep, set] of Object.entries(entrypointSessions)) report.byEntrypoint[ep].sessions = set.size;
  report.topSessions = sessionRows.sort((a, b) => b.cost - a.cost).slice(0, TOP_SESSIONS);

  if (securityLog && project) {
    report.notes.push('plugin-log-unscoped');
  } else if (securityLog) {
    const sg = readSecurityGuidanceLog(securityLog, from, to);
    if (sg) {
      report.plugins.securityGuidance = sg;
      report.outside.cost += sg.outsideTranscriptsCost;
      if (sg.coversFrom !== null && sg.coversFrom > from) report.notes.push('plugin-log-partial');
    }
  }
  report.notes = [...new Set(report.notes)];
  return report;
}

async function readTranscript(t, f, { from, to, report, seen, sessions, entrypointSessions }) {
  const meta = t.metaFile ? readMeta(t.metaFile) : null;
  for await (const { text } of keptLines(t.file, { wantPrompts: t.kind === 'main' })) {
    let o;
    try {
      o = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      continue;
    }

    if (o.type === 'user') {
      const raw = promptText(o);
      if (raw === null) continue;
      const body = raw.trim();
      if (NOT_A_TURN.test(body)) continue;
      const ts = Date.parse(o.timestamp);
      const originKind = o.origin?.kind || null;
      const promptSource = o.promptSource || null;
      const normalized = body.replace(/\s+/g, ' ');
      const hash = normalized ? crypto.createHash('sha1').update(normalized).digest('hex') : null;
      const scheduled = originKind === 'human' && !promptSource && SCHEDULED_COMMAND.test(body);
      f.turn = { originKind, promptSource, hash, scheduled };
      if (f.firstLabel === undefined) f.firstLabel = labelForPrompt(body);
      if (hash && ts >= from && ts <= to) {
        const h = f.hashes.get(hash) ?? { runs: 0, cost: 0, requests: 0, humanCost: 0, humanRequests: 0, machine: false };
        h.runs += 1;
        f.hashes.set(hash, h);
      }
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

    const entrypoint = label(o.entrypoint);
    f.entrypoint ??= entrypoint;
    f.cost += c.total;
    f.requests += 1;
    f.rereadCost += c.cacheRead;
    const sessionKey = `${t.project}/${t.sessionId}`;
    sessions.add(sessionKey);

    report.totals.cost += c.total;
    report.totals.requests += 1;
    if (c.estimated) report.totals.estimatedCost += c.total;
    for (const k of Object.keys(report.components)) report.components[k] += c[k];
    add(report.byModel, c.priceKey, c.total);
    add(report.byEffort, label(o.effort), c.total);
    add(report.byEntrypoint, entrypoint, c.total);
    (entrypointSessions[entrypoint] ??= new Set()).add(sessionKey);
    if (usage.speed === 'fast') add(report, 'fastMode', c.total);

    const created = usage.cache_creation_input_tokens || 0;
    const promptTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + created;
    if (f.prevTs !== null && created >= REBUILD_MIN_TOKENS && created >= REBUILD_MIN_SHARE * promptTokens) {
      const kind = msg.model !== f.prevModel ? 'modelSwitch' : ts - f.prevTs > f.ttlMs ? 'afterIdle' : 'other';
      report.cache.rebuilds[kind].cost += c.cacheWrite5m + c.cacheWrite1h;
      report.cache.rebuilds[kind].count += 1;
    }
    if (usage.cache_creation?.ephemeral_1h_input_tokens > 0) f.ttlMs = HOUR;
    else if (created > 0) f.ttlMs = FIVE_MIN;
    f.prevTs = ts;
    f.prevModel = msg.model;

    if (t.kind === 'main') {
      report.mainConversation.cost += c.total;
      report.mainConversation.requests += 1;
      f.promptTokens += promptTokens;
      if (promptTokens > 200_000) {
        report.context.requestsOver200k += 1;
        report.context.costOver200k += c.total;
      }
      const kind = turnKind(f.turn, f.entrypoint);
      const h = f.turn.hash ? f.hashes.get(f.turn.hash) : null;
      if (kind === 'human') add(report.turns, 'human', c.total);
      else {
        report.turns.automated.cost += c.total;
        report.turns.automated.requests += 1;
        add(report.turns.automated.byKind, kind, c.total);
      }
      if (h) {
        h.cost += c.total;
        h.requests += 1;
        if (kind === 'human') {
          h.humanCost += c.total;
          h.humanRequests += 1;
        }
        if (kind !== 'human' || f.turn.scheduled) h.machine = true;
      }
    } else {
      const lens = report.agents[t.kind];
      lens.cost += c.total;
      lens.requests += 1;
      lens.components.cacheRead += c.cacheRead;
      lens.components.cacheWrite += c.cacheWrite5m + c.cacheWrite1h;
      lens.components.output += c.output;
      lens.components.input += c.input;
      lens.promptTokens += promptTokens;
      add(lens.byType, label(meta?.agentType, 48), c.total);
      add(lens.byModel, c.priceKey, c.total);
    }
  }
}

function finishTranscript(t, f, report, sessionRows) {
  if (f.requests === 0) return;
  if (t.kind !== 'main') {
    report.agents[t.kind].agents += 1;
    return;
  }
  sessionRows.push({
    project: t.project,
    sessionId: t.sessionId,
    entrypoint: f.entrypoint || 'unknown',
    cost: f.cost,
    requests: f.requests,
    avgPromptTokens: Math.round(f.promptTokens / f.requests),
    rereadCost: f.rereadCost,
  });

  // Loops: a machine-started prompt repeated in the window. Hand-typed repeats ("continue") are not loops.
  let looped = false;
  for (const h of f.hashes.values()) {
    if (h.runs < LOOP_MIN_RUNS || h.requests === 0 || !h.machine) continue;
    looped = true;
    report.loops.cost += h.cost;
    report.loops.requests += h.requests;
    report.loops.runs += h.runs;
    if (h.humanCost > 0) {
      // Scheduled firings look human in the transcript; count them as automation.
      report.turns.human.cost -= h.humanCost;
      report.turns.human.requests -= h.humanRequests;
      report.turns.automated.cost += h.humanCost;
      report.turns.automated.requests += h.humanRequests;
      const b = (report.turns.automated.byKind.loop ??= bucket());
      b.cost += h.humanCost;
      b.requests += h.humanRequests;
    }
  }
  if (looped) report.loops.sessions += 1;

  if (f.entrypoint?.startsWith('sdk')) {
    const s = (report.toolSessions[f.firstLabel || 'other SDK sessions'] ??= { cost: 0, requests: 0, sessions: 0 });
    s.cost += f.cost;
    s.requests += f.requests;
    s.sessions += 1;
  }
}
