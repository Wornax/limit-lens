// Regression tests for defects confirmed by the adversarial review (2026-10-25, third round).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { findings } from '../plugins/limit-lens/scripts/lib/findings.mjs';
import { renderMarkdown } from '../plugins/limit-lens/scripts/lib/report.mjs';
import { resolveModel } from '../plugins/limit-lens/scripts/lib/pricing.mjs';
import { NOW, minutesAgo, daysAgo, tempRoot, assistant, prompt, writeTranscript } from './helpers.mjs';

const M = 1_000_000;
const out = { output_tokens: M };
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-lens', 'scripts', 'limit-lens.mjs');
const run = (projects, extra = {}) => analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null, ...extra });
const empty = () => run(tempRoot().projects);

test('plugin spend outside transcripts is never divided by the transcript total', async () => {
  const r = await empty();
  r.totals = { ...r.totals, cost: 1, requests: 1 };
  r.outside.cost = 10;
  const f = findings(r).find((x) => x.id === 'plugins');
  assert.ok(f);
  const md = renderMarkdown(r, [f]);
  const heading = md.split('\n').find((l) => l.startsWith('### ') && l.includes('Plugins'));
  assert.ok(!heading.includes('%'), heading);
  assert.match(heading, /\$10 outside the total/);
  assert.ok(!md.includes(': ,'));
});

test('a request that reads its cache and adds a lot of new content is not a rebuild', async () => {
  const { projects } = tempRoot();
  const w1h = (n) => ({ cache_creation_input_tokens: n, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: n } });
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: minutesAgo(10), usage: w1h(30_000) }),
    assistant({ ts: minutesAgo(9), usage: { ...w1h(40_000), cache_read_input_tokens: 30_000 } }),
  ]);
  const r = await run(projects);
  const rb = r.cache.rebuilds;
  assert.equal(rb.afterIdle.count + rb.modelSwitch.count + rb.other.count, 0);
});

test('the history note only appears when the window is longer than the default retention and history ends there', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/new-user.jsonl', [assistant({ ts: daysAgo(5), usage: out })]);
  assert.ok(!(await run(projects, { days: 30 })).notes.includes('history-shorter-than-window'));
  const { projects: p2 } = tempRoot();
  writeTranscript(p2, 'p/retained.jsonl', [assistant({ ts: daysAgo(29.5), usage: out })]);
  assert.ok((await run(p2, { days: 60 })).notes.includes('history-shorter-than-window'));
});

test('older root-level agent transcripts count as subagents of their session', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/11111111-2222-3333-4444-555555555555.jsonl', [prompt({ ts: minutesAgo(10) }), assistant({ ts: minutesAgo(9), usage: out })]);
  const side = assistant({ ts: minutesAgo(8), usage: out });
  side.isSidechain = true;
  side.sessionId = '11111111-2222-3333-4444-555555555555';
  writeTranscript(projects, 'p/agent-abc123.jsonl', [side]);
  const r = await run(projects);
  assert.ok(Math.abs(r.agents.subagent.cost - 10) < 1e-9);
  assert.ok(Math.abs(r.mainConversation.cost - 10) < 1e-9);
  assert.equal(r.totals.sessions, 1);
});

test('estimated prices keep their own bucket and a ~ marker', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: minutesAgo(6), model: 'claude-sonnet-5-5', usage: out }),
    assistant({ ts: minutesAgo(5), model: 'claude-nimbus-9', usage: out }),
  ]);
  const r = await run(projects);
  assert.ok(r.byModel['sonnet-5-5~']);
  assert.match(renderMarkdown(r, findings(r)), /Sonnet 5\.5~/);
});

test('a huge bracketed model id resolves quickly', () => {
  const t0 = Date.now();
  resolveModel('['.repeat(60_000) + 'claude-opus-5-5');
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test('--anonymize replaces session ids that are not UUIDs', async () => {
  const { root, projects } = tempRoot();
  writeTranscript(projects, 'p/my-secret-notes.jsonl', [assistant({ ts: minutesAgo(5), usage: out })]);
  const r = await run(projects);
  const md = renderMarkdown(r, findings(r), { anonymize: true });
  assert.ok(!md.includes('my-secre'));
  assert.match(md, /session-1/);
  const json = execFileSync(process.execPath, [CLI, '--config-dir', root, '--now', new Date(NOW).toISOString(), '--json', '--anonymize'], { encoding: 'utf8' });
  assert.ok(!json.includes('my-secre'));
});

test('a malformed field skips its line, not the whole transcript', async () => {
  const { projects } = tempRoot();
  const bad = assistant({ ts: minutesAgo(7), usage: out });
  bad.timestamp = { toString: 1 };
  bad.effort = { toString: 1 };
  const bad2 = assistant({ ts: minutesAgo(6), usage: out });
  bad2.message.model = { toString: 1 };
  writeTranscript(projects, 'p/s.jsonl', [bad, bad2, assistant({ ts: minutesAgo(5), usage: out })]);
  const r = await run(projects);
  assert.equal(r.totals.requests, 1);
  assert.equal(r.topSessions.length, 1);
});

test('a flag never swallows the next flag, and --name=value works', () => {
  const swallowed = spawnSync(process.execPath, [CLI, '--project', '--anonymize'], { encoding: 'utf8' });
  assert.equal(swallowed.status, 2);
  assert.match(swallowed.stderr, /Missing value for --project/);
  const { root } = tempRoot();
  const ok = spawnSync(process.execPath, [CLI, '--days=3', `--config-dir=${root}`], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /last 3 days/);
});

test('long project names are shortened with a visible ASCII marker', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, `C--Users-someone-${'x'.repeat(60)}-end/s.jsonl`, [assistant({ ts: minutesAgo(5), usage: out })]);
  const r = await run(projects);
  assert.match(renderMarkdown(r, findings(r)), /\| \.\.\.x+-end \|/);
});

test('a --project filter is shown, and a filter with no match says so', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'C--repos-api/s.jsonl', [assistant({ ts: minutesAgo(5), usage: out })]);
  const hit = await run(projects, { project: 'api' });
  assert.match(renderMarkdown(hit, findings(hit)), /folder name contains `api`/);
  const miss = await run(projects, { project: 'nomatch' });
  const md = renderMarkdown(miss, findings(miss));
  assert.match(md, /nomatch/);
  assert.ok(!md.includes('--days 30'));
});

test('fixes follow the evidence: no auto-compact advice without huge contexts, no bounded-task advice without long agents', async () => {
  const r = await empty();
  r.totals.cost = 100;
  r.components.cacheRead = 50;
  r.mainConversation.requests = 10;
  r.context.avgPromptTokens = 90_000;
  r.context.requestsOver200k = 0;
  Object.assign(r.agents.subagent, { cost: 60, requests: 3000, agents: 300, avgPromptTokens: 40_000 });
  const f = findings(r);
  assert.ok(!JSON.stringify(f.find((x) => x.id === 'reread')).includes('autoCompactWindow'));
  const agents = JSON.stringify(f.find((x) => x.id === 'agents'));
  assert.ok(!agents.includes('autoCompactWindow: 200000'));
  assert.ok(!agents.includes('hundreds of tool calls'));
});
