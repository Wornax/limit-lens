// Stream transcripts once and aggregate API-equivalent cost into the report's lenses.
// Transcript contents are untrusted: every field is type-checked before it is used, values that
// reach the report go through `label()`, and every keyed map has a null prototype.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requestCost, num, PRICES_AS_OF } from './pricing.mjs';
import { findTranscripts, listProjects } from './discover.mjs';
import { keptLines } from './lines.mjs';
import { labelForPrompt } from './signatures.mjs';
import { readSecurityGuidanceLog } from './plugins/security-guidance.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FIVE_MIN = 300_000;
const LOOP_MIN_RUNS = 3;
const TOP_SESSIONS = 5;
// Claude Code deletes transcripts older than cleanupPeriodDays, 30 by default.
const DEFAULT_RETENTION_DAYS = 30;
// A request "rebuilds" the cache when it writes most of its prompt again instead of reading it:
// the write is large, most of the prompt, and the previous prompt was mostly not read back.
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
  if (typeof value !== 'string' && typeof value !== 'number') return 'other';
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
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

const timeOf = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);
const str = (v) => (typeof v === 'string' && v ? v : null);
// Estimated prices keep their own bucket, marked with "~".
const modelKey = (c) => (c.estimated ? `${c.priceKey}~` : c.priceKey);

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
    activeDays: 0,
    components: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0 },
    byModel: map(),
    byEffort: map(),
    byEntrypoint: map(),
    mainConversation: bucket(),
    turns: { human: bucket(), automated: { ...bucket(), byKind: map() } },
    loops: { cost: 0, requests: 0, runs: 0, sessions: 0 },
    agents: { subagent: agentLens(), workflow: agentLens() },
    fastMode: bucket(),
    startup: { cost: 0, count: 0, tokens: 0, avgTokens: 0, byKind: { main: { cost: 0, count: 0 }, subagent: { cost: 0, count: 0 }, workflow: { cost: 0, count: 0 } } },
    toolSessions: map(),
    context: { avgPromptTokens: 0, requestsOver200k: 0, costOver200k: 0, requestsOver300k: 0 },
    cache: { rebuilds: { afterIdle: { cost: 0, count: 0 }, modelSwitch: { cost: 0, count: 0 }, other: { cost: 0, count: 0 } } },
    topSessions: [],
    // Who is behind each lens, so fixes can name their biggest contributors.
    byProject: map(),
    contextSessions: [],
    outside: { cost: 0 },
    plugins: {},
    filter: null,
    notes: [],
  };
}

// The window is either the `days` before `now`, or an explicit [from, to] (used for before/after comparisons).
export async function analyze({ projectsDirs, now = Date.now(), days = 7, from: fromArg, to: toArg, project = null, securityLog = null } = {}) {
  const to = toArg ?? (typeof now === 'number' ? now : now.getTime());
  const from = fromArg ?? to - days * DAY;
  days = Math.round(((to - from) / DAY) * 10) / 10;
  const report = newReport(from, to, days);
  const state = { from, to, report, seen: new Set(), sessions: new Set(), entrypointSessions: map(), oldest: Infinity, dates: new Set() };
  const sessionRows = [];
  let mainPromptTokens = 0;

  let transcripts = findTranscripts(projectsDirs, from);
  if (project) {
    const needle = project.toLowerCase();
    transcripts = transcripts.filter((t) => t.project.toLowerCase().includes(needle));
    report.filter = { project, matchingFolders: listProjects(projectsDirs).filter((p) => p.toLowerCase().includes(needle)).length };
  }

  for (const t of transcripts) {
    const f = {
      cost: 0, requests: 0, entrypoint: null, firstLabel: undefined, turn: { hash: null }, hashes: new Map(),
      prevTs: null, prevModel: null, prevPromptTokens: 0, ttlMs: HOUR, promptTokens: 0, rereadCost: 0, sawResponse: false,
    };
    try {
      await readTranscript(t, f, state);
    } catch {
      report.notes.push('unreadable-transcript');
      continue;
    }
    finishTranscript(t, f, report, sessionRows);
    if (t.kind === 'main') mainPromptTokens += f.promptTokens;
  }

  report.totals.sessions = state.sessions.size;
  report.activeDays = state.dates.size;
  const mainRequests = report.mainConversation.requests;
  report.context.avgPromptTokens = mainRequests ? Math.round(mainPromptTokens / mainRequests) : 0;
  for (const lens of Object.values(report.agents)) {
    lens.avgPromptTokens = lens.requests ? Math.round(lens.promptTokens / lens.requests) : 0;
    delete lens.promptTokens;
  }
  for (const [ep, set] of Object.entries(state.entrypointSessions)) report.byEntrypoint[ep].sessions = set.size;
  report.startup.avgTokens = report.startup.count ? Math.round(report.startup.tokens / report.startup.count) : 0;
  delete report.startup.tokens;

  // Only blame retention when it can be the cause: the window is longer than the default retention
  // and the oldest data sits at the retention edge.
  if (Number.isFinite(state.oldest)) {
    report.window.oldestData = new Date(state.oldest).toISOString();
    if (days > DEFAULT_RETENTION_DAYS && state.oldest > from + DAY && state.oldest <= to - (DEFAULT_RETENTION_DAYS - 1) * DAY) {
      report.notes.push('history-shorter-than-window');
    }
  }
  report.contextSessions = sessionRows
    .filter((s) => s.requestsOver300k > 0)
    .sort((a, b) => b.requestsOver300k - a.requestsOver300k || b.avgPromptTokens - a.avgPromptTokens)
    .slice(0, 3)
    .map((s) => ({ ...s }));
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

async function readTranscript(t, f, state) {
  const meta = t.metaFile ? readMeta(t.metaFile) : null;
  for await (const { text } of keptLines(t.file, { wantPrompts: t.kind === 'main' })) {
    let o;
    try {
      o = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    try {
      if (o.type === 'user') readPrompt(o, f, state);
      else if (o.type === 'assistant') readResponse(o, t, f, meta, state);
    } catch {
      state.report.notes.push('malformed-line');
    }
  }
}

function readPrompt(o, f, { from, to }) {
  const raw = promptText(o);
  if (raw === null) return;
  const body = raw.trim();
  if (NOT_A_TURN.test(body)) return;
  const ts = timeOf(o.timestamp);
  const originKind = str(o.origin?.kind);
  const promptSource = str(o.promptSource);
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
}

function readResponse(o, t, f, meta, state) {
  const { from, to, report, seen, sessions, entrypointSessions } = state;
  const msg = o.message;
  const usage = msg?.usage;
  const model = str(msg?.model);
  if (!usage || typeof usage !== 'object' || !model || model === '<synthetic>') return;
  const ts = timeOf(o.timestamp);
  if (Number.isNaN(ts)) return;
  // The transcript's first response writes the setup (system prompt, tools, CLAUDE.md, memory, skill list).
  const isFirst = !f.sawResponse;
  f.sawResponse = true;
  if (ts < state.oldest) state.oldest = ts;
  if (!(ts >= from && ts <= to)) return;
  const id = str(msg.id) || str(o.requestId);
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  const c = requestCost(model, usage);
  if (!(c.total > 0) || !Number.isFinite(c.total)) return;
  const entrypoint = label(o.entrypoint);
  const effort = label(o.effort);
  const created = num(usage.cache_creation_input_tokens);
  const read = num(usage.cache_read_input_tokens);
  const promptTokens = num(usage.input_tokens) + read + created;
  const sessionKey = `${t.project}/${t.sessionId ?? label(o.sessionId, 64)}`;

  // Everything below only adds numbers that were validated above.
  f.entrypoint ??= entrypoint;
  f.cost += c.total;
  f.requests += 1;
  f.rereadCost += c.cacheRead;
  sessions.add(sessionKey);
  state.dates.add(new Date(ts).toLocaleDateString('en-CA')); // local calendar day
  report.totals.cost += c.total;
  report.totals.requests += 1;
  if (c.estimated) report.totals.estimatedCost += c.total;
  for (const k of Object.keys(report.components)) report.components[k] += c[k];
  add(report.byModel, modelKey(c), c.total);
  add(report.byEffort, effort, c.total);
  add(report.byEntrypoint, entrypoint, c.total);
  (entrypointSessions[entrypoint] ??= new Set()).add(sessionKey);
  if (usage.speed === 'fast') add(report, 'fastMode', c.total);
  const opus = c.priceKey.startsWith('opus');
  const proj = (report.byProject[t.project] ??= { cost: 0, mainCost: 0, agentCost: 0, opusMainCost: 0, opusAgentCost: 0, highEffortCost: 0, highEffortByModel: map(), requestsOver200k: 0, requestsOver300k: 0 });
  proj.cost += c.total;
  if (t.kind === 'main') {
    proj.mainCost += c.total;
    if (opus) proj.opusMainCost += c.total;
  } else {
    proj.agentCost += c.total;
    if (opus) proj.opusAgentCost += c.total;
  }
  if (effort === 'xhigh' || effort === 'max') {
    proj.highEffortCost += c.total;
    proj.highEffortByModel[modelKey(c)] = (proj.highEffortByModel[modelKey(c)] || 0) + c.total;
  }

  if (isFirst) {
    const setup = c.input + c.cacheWrite5m + c.cacheWrite1h;
    report.startup.cost += setup;
    report.startup.count += 1;
    report.startup.tokens += num(usage.input_tokens) + created;
    report.startup.byKind[t.kind].cost += setup;
    report.startup.byKind[t.kind].count += 1;
  }
  const lostCache = read < REBUILD_MIN_SHARE * f.prevPromptTokens;
  if (f.prevTs !== null && created >= REBUILD_MIN_TOKENS && created >= REBUILD_MIN_SHARE * promptTokens && lostCache) {
    const kind = model !== f.prevModel ? 'modelSwitch' : ts - f.prevTs > f.ttlMs ? 'afterIdle' : 'other';
    report.cache.rebuilds[kind].cost += c.cacheWrite5m + c.cacheWrite1h;
    report.cache.rebuilds[kind].count += 1;
  }
  if (num(usage.cache_creation?.ephemeral_1h_input_tokens) > 0) f.ttlMs = HOUR;
  else if (created > 0) f.ttlMs = FIVE_MIN;
  f.prevTs = ts;
  f.prevModel = model;
  f.prevPromptTokens = promptTokens;

  if (t.kind === 'main') {
    report.mainConversation.cost += c.total;
    report.mainConversation.requests += 1;
    f.promptTokens += promptTokens;
    if (promptTokens > 200_000) {
      report.context.requestsOver200k += 1;
      report.context.costOver200k += c.total;
      proj.requestsOver200k += 1;
      f.over200k = (f.over200k || 0) + 1;
    }
    // The auto-compact fix compacts at 300K, so it only reaches requests past that.
    if (promptTokens > 300_000) {
      report.context.requestsOver300k += 1;
      proj.requestsOver300k += 1;
      f.over300k = (f.over300k || 0) + 1;
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
    const typeBucket = add(lens.byType, label(meta?.agentType, 48), c.total);
    typeBucket.opusCost = (typeBucket.opusCost || 0) + (opus ? c.total : 0);
    add(lens.byModel, modelKey(c), c.total);
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
    sessionId: t.sessionId ?? path.basename(t.file, '.jsonl'),
    entrypoint: f.entrypoint || 'unknown',
    cost: f.cost,
    requests: f.requests,
    avgPromptTokens: Math.round(f.promptTokens / f.requests),
    rereadCost: f.rereadCost,
    requestsOver200k: f.over200k || 0,
    requestsOver300k: f.over300k || 0,
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
