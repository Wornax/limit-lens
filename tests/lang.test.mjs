// Reports in the user's language: English by default, Portuguese from --lang, LIMIT_XRAY_LANG or Claude
// Code's `language` setting. Synthetic data and temp folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { langOf, resolveLang, locale, CATALOGS } from '../plugins/limit-xray/scripts/lib/i18n/index.mjs';
import en from '../plugins/limit-xray/scripts/lib/i18n/en.mjs';
import { analyze } from '../plugins/limit-xray/scripts/lib/analyze.mjs';
import { findings } from '../plugins/limit-xray/scripts/lib/findings.mjs';
import { applicableFixes, routingFix, habitsWithFindings } from '../plugins/limit-xray/scripts/lib/fixes.mjs';
import { renderAnalyze, renderPlan, renderMarkdown } from '../plugins/limit-xray/scripts/lib/report.mjs';
import { renderDashboard } from '../plugins/limit-xray/scripts/lib/dashboard.mjs';
import { renderCompare } from '../plugins/limit-xray/scripts/lib/compare.mjs';
import { ROUTING_RULE } from '../plugins/limit-xray/scripts/lib/memory.mjs';
import { NOW, minutesAgo, tempRoot, assistant, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-xray', 'scripts', 'limit-xray.mjs');
const M = 1_000_000;
// The CLI also reads the language from the project settings under its working folder: run it from a
// neutral one unless a test says otherwise.
const run = (root, args, env = {}, cwd = os.tmpdir()) => spawnSync(process.execPath, [CLI, ...args, '--config-dir', root, '--now', new Date(NOW).toISOString()], { encoding: 'utf8', cwd, env: { ...process.env, LIMIT_XRAY_NO_OPEN: '1', ...env } });

// English words that never appear in Portuguese prose. Code spans, links and paths are left out first:
// they hold setting names, commands and URLs, which stay in English on purpose. So does the routing rule:
// it is the literal line written to CLAUDE.md, an instruction for Claude that revert finds by its text.
// The boundaries count accented letters as letters ("início" is not "in").
const ENGLISH = /(?<![\p{L}\p{N}_])(the|and|of|your|with|is|are|to|per|from|this|that|not|you|it|on|in|at|by|be|can|only|less|each|every|when|which|will|would|after|before|requests?|spend|sessions?|fix(es)?)(?![\p{L}\p{N}_])/iu;
const RULE = /Before you start a subagent[^"”]*/g;
const prose = (md) => md.replace(RULE, ' ').replace(/`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[A-Z]:[\\/]\S+|\/tmp\/\S+/g, ' ');
const visible = (html) => html
  .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<code>[\s\S]*?<\/code>|<a [^>]*>[\s\S]*?<\/a>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(quot|#39|amp|lt|gt);/g, ' ')
  .replace(RULE, ' ');
function assertNoEnglish(text, where) {
  const m = ENGLISH.exec(text);
  assert.ok(!m, m && `${where}: "${m[0]}" in ...${text.slice(Math.max(0, m.index - 70), m.index + 50).replace(/\s+/g, ' ')}...`);
}

test('a language name or code maps to a report language, or to none', () => {
  for (const v of ['pt', 'pt-BR', 'pt_br', 'Portuguese', 'português', 'Brazilian Portuguese']) assert.equal(langOf(v), 'pt', v);
  for (const v of ['en', 'en-US', 'English']) assert.equal(langOf(v), 'en', v);
  for (const v of ['japanese', 'es', '', undefined, null, 'ptolemy']) assert.equal(langOf(v), null, String(v));
});

test('--lang wins over LIMIT_XRAY_LANG, which wins over the language setting; English otherwise', () => {
  assert.equal(resolveLang({ flag: 'en', env: 'pt', setting: 'portuguese' }), 'en');
  assert.equal(resolveLang({ env: 'pt', setting: 'english' }), 'pt');
  assert.equal(resolveLang({ setting: 'portuguese' }), 'pt');
  assert.equal(resolveLang({ setting: 'japanese' }), 'en'); // no catalog for it yet
  assert.equal(resolveLang({}), 'en');
});

test('numbers read the Brazilian way in Portuguese and stay as they were in English', () => {
  const p = locale('pt');
  assert.equal(p.usd(12_345.6), 'US$ 12.346');
  assert.equal(p.usd(42.4), 'US$ 42');
  assert.equal(p.usd(1.5), 'US$ 1,50');
  assert.equal(p.usd(0.001), '<US$ 0,01');
  assert.equal(p.pct(1, 40), '2,5%');
  assert.equal(p.pct(1, 4), '25%');
  assert.equal(p.tokens(1_200_000), '1,2M');
  assert.equal(p.tokens(350_000), '350K');
  assert.equal(p.num(1_234_567), '1.234.567');
  const e = locale('en');
  assert.equal(e.usd(12_345.6), '$12,346');
  assert.equal(e.usd(1.5), '$1.50');
  assert.equal(e.pct(1, 40), '2.5%');
  assert.equal(e.tokens(1_200_000), '1.2M');
  assert.equal(e.num(1_234_567), '1,234,567');
});

test('days are labelled in the language: weekday, then day/month in Portuguese', () => {
  assert.equal(locale('pt').dayLabel('2026-10-24'), 'sáb 24/10');
  assert.equal(locale('en').dayLabel('2026-10-24'), 'Sat 10-24');
});

// The catalog, leaf by leaf: [path, value].
const leaves = (o, p = []) => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? leaves(v, [...p, k]) : [[[...p, k].join('.'), v]]));
// A text with every value replaced by "§", and the names of the values it uses.
function sample(v) {
  if (typeof v !== 'function') return { text: Array.isArray(v) ? v.join(' | ') : String(v), used: [] };
  const used = new Set();
  const p = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? (used.add(k), '§') : undefined) });
  return { text: v(p), used: [...used].sort() };
}
const codeSpans = (s) => (s.match(/`[^`]*`/g) || []).sort();

// Every registered language, so a new catalog is checked the moment it is added.
for (const [code, catalog] of Object.entries(CATALOGS)) {
  if (code === 'en') continue;
  test(`the ${code} catalog translates every English text, with the same values and the same code`, () => {
    const own = new Map(leaves(catalog));
    for (const [key, value] of leaves(en)) {
      assert.ok(own.has(key), `${code} is missing ${key}`);
      const a = sample(value);
      const b = sample(own.get(key));
      assert.equal(typeof own.get(key), typeof value, key);
      if (Array.isArray(value)) assert.equal(own.get(key).length, value.length, key);
      assert.deepEqual(b.used, a.used, `${key} uses other values`);
      assert.deepEqual(codeSpans(b.text), codeSpans(a.text), `${key} changed a command or setting`);
      assert.doesNotMatch(b.text, /undefined|NaN/, key);
      // The English words are a Portuguese check: some are words in other languages ("on" in French).
      if (code === 'pt' && !key.startsWith('format.') && key !== 'dashboard.htmlLang') assertNoEnglish(prose(b.text), `pt.${key}`);
    }
    for (const key of own.keys()) assert.ok(leaves(en).some(([k]) => k === key), `${code} has ${key}, which en does not`);
  });
}

// A week where every lens crosses its threshold and every fix applies.
async function everything(lang) {
  const r = await analyze({ projectsDirs: [tempRoot().projects], now: NOW, days: 7, securityLog: null });
  Object.assign(r.totals, { cost: 100, requests: 1000, sessions: 12, estimatedCost: 1 });
  r.activeDays = 5;
  Object.assign(r.components, { cacheRead: 60, cacheWrite5m: 10, cacheWrite1h: 2, output: 20, input: 1, thinking: 5 });
  Object.assign(r.mainConversation, { cost: 30, requests: 400 });
  Object.assign(r.context, { avgPromptTokens: 250_000, requestsOver200k: 50, requestsOver300k: 10 });
  Object.assign(r.agents.subagent, { cost: 60, requests: 600, agents: 6, avgPromptTokens: 150_000 });
  r.agents.subagent.byModel = { 'opus-5-5': { cost: 40, requests: 400 } };
  r.agents.subagent.byType = { 'general-purpose': { cost: 60, requests: 600, opusCost: 40 } };
  r.byModel = { 'opus-5-5': { cost: 90, requests: 900 }, 'sonnet-5-5': { cost: 10, requests: 100 } };
  r.byEffort = { xhigh: { cost: 60, requests: 600 }, high: { cost: 40, requests: 400 } };
  r.byEntrypoint = { cli: { cost: 70 }, 'claude-desktop': { cost: 30 } };
  r.byProject = { 'my-app': { cost: 100, opusMainCost: 50, opusAgentCost: 40, highEffortByModel: { 'opus-5-5': 60 } } };
  r.byDay = { '2026-10-24': { cost: 60, requests: 600 }, '2026-10-25': { cost: 40, requests: 400 } };
  Object.assign(r.turns.human, { cost: 70, requests: 800 });
  Object.assign(r.turns.automated, { cost: 12, requests: 20 });
  r.turns.automated.byKind = { peer: { cost: 10, requests: 10 }, loop: { cost: 2, requests: 10 } };
  Object.assign(r.loops, { cost: 2, requests: 10, runs: 5, sessions: 1 });
  Object.assign(r.cache.rebuilds, { afterIdle: { count: 3, cost: 3 }, modelSwitch: { count: 2, cost: 2 }, other: { count: 1, cost: 1 } });
  Object.assign(r.startup, { cost: 5, count: 8, avgTokens: 30_000 });
  Object.assign(r.startup.byKind, { main: { cost: 2, count: 2 }, subagent: { cost: 3, count: 6 } });
  r.plugins.securityGuidance = { reviews: { stop: { count: 10, cost: 4 }, commit: { count: 2, cost: 2 }, push: { count: 0, cost: 0 } }, outsideTranscriptsCost: 4 };
  r.outside.cost = 4;
  r.toolSessions = { 'security-guidance review': { cost: 6, requests: 60, sessions: 3 }, 'other SDK sessions': { cost: 2, requests: 20, sessions: 1 } };
  r.fastMode = { cost: 20, requests: 10 };
  r.topSessions = [{ project: 'my-app', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', entrypoint: 'cli', cost: 30, requests: 100, avgPromptTokens: 200_000, rereadCost: 20 }];
  r.contextSessions = [{ project: 'my-app', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', cost: 30, requestsOver300k: 10, avgPromptTokens: 320_000 }];
  r.notes = ['plugin-log-partial', 'history-shorter-than-window'];
  r.window.oldestData = '2026-10-20T08:00:00Z';
  const settings = { model: 'opus', fastMode: true, modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } };
  const found = findings(r, { lang });
  const fixes = [routingFix(r, { file: 'C:/u/.claude/CLAUDE.md', rule: ROUTING_RULE, lang }), ...applicableFixes(r, settings, { lang })];
  const habits = habitsWithFindings(r, { lang });
  const active = [{ id: 'exp-1', appliedAt: '2026-10-20T10:00:00Z', changes: [{ kind: 'memory', file: 'C:/u/.claude/CLAUDE.md', fixId: 'model-routing-rule' }, { path: ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'], after: 'sonnet', fixId: 'subagent-model-sonnet' }] }];
  const undo = { id: 'exp-1', changes: [{ kind: 'memory', file: 'C:/u/.claude/CLAUDE.md' }, { path: ['fastMode'], hadKey: true, restore: true }, { path: ['model'], hadKey: false }] };
  return { r, found, fixes, habits, active, undo, settingsFile: 'C:/u/.claude/settings.json' };
}

test('in Portuguese, analyze, the plan and the dashboard carry no English prose', async () => {
  const x = await everything('pt');
  assert.equal(x.fixes.length, 10);
  assert.equal(x.found.length, 9);
  const md = renderAnalyze({ report: x.r, found: x.found, fixes: x.fixes, habits: x.habits, settingsFile: x.settingsFile, active: x.active, undo: x.undo, dashboard: { file: 'C:/u/.claude/limit-xray/dashboard.html', opened: true }, lang: 'pt' });
  for (const s of ['## Resumo', '## Visão geral', 'Gasto por dia', '## Perguntas', '### Pergunta 1: Ligar o roteamento de modelos nos agentes', '## Outras sugestões', 'US$', 'sáb 24/10']) assert.ok(md.includes(s), s);
  assertNoEnglish(prose(md), 'analyze');
  const plan = renderPlan({ report: x.r, found: x.found, fixes: x.fixes, habits: x.habits.map((h) => h.text), settingsFile: x.settingsFile, last: { id: 'exp-0', appliedAt: '2026-10-18T10:00:00Z', revertedAt: '2026-10-19T10:00:00Z', changes: [{ fixId: 'fast-mode-off' }] }, undo: x.undo, lang: 'pt' });
  assertNoEnglish(prose(plan), 'plan');
  const report = renderMarkdown(x.r, x.found, { lang: 'pt' });
  assertNoEnglish(prose(report), 'report');
  const html = renderDashboard({ report: x.r, found: x.found, fixes: x.fixes, habits: x.habits, settingsFile: x.settingsFile, active: x.active, undo: x.undo, generatedAt: NOW, lang: 'pt' });
  assert.match(html, /<html lang="pt-BR">/);
  assertNoEnglish(visible(html), 'dashboard');
});

test('in Portuguese, the other suggestions leave out what a question already asks', async () => {
  const x = await everything('pt');
  const md = renderAnalyze({ report: x.r, found: x.found, fixes: x.fixes, habits: x.habits, settingsFile: x.settingsFile, lang: 'pt' });
  const other = md.slice(md.indexOf('## Outras sugestões'));
  const F = locale('pt').t.findings;
  assert.ok(!other.includes(F.models.sonnet));
  assert.ok(!other.includes(F.agents.sonnet));
  assert.ok(other.includes(F.reread.clear)); // no setting covers it
});

test('in Portuguese, compare reads in Portuguese, too early or not', () => {
  const metrics = { activeDays: 5, requests: 900, spendPerActiveDay: 120, spendPerRequest: 0.4, avgMainContext: 180_000, shares: { opus: 0.8, highEffort: 0.5, agents: 0.4, reread: 0.6, automated: 0.1 } };
  const exp = { id: 'exp-1', appliedAt: '2026-10-20T10:00:00Z', revertedAt: '2026-10-24T10:00:00Z', changes: [{ fixId: 'subagent-model-sonnet' }], baseline: metrics };
  const later = renderCompare(exp, { ...metrics, spendPerActiveDay: 90 }, { lang: 'pt' });
  assert.match(later, /\| Gasto por dia de uso \| US\$ 120 \| US\$ 90 \| -25% \|/);
  assertNoEnglish(prose(later), 'compare');
  assertNoEnglish(prose(renderCompare(exp, { ...metrics, activeDays: 1, requests: 10 }, { lang: 'pt' })), 'compare, too early');
});

// Opus agents at xhigh, a long re-read main conversation, and a default model of Opus.
function heavyWeek(settings = { model: 'opus' }) {
  const { root, projects } = tempRoot();
  const big = { cache_read_input_tokens: 400_000, output_tokens: 1000 };
  writeTranscript(projects, 'my-app/s1.jsonl', [1, 2, 3, 4].map((i) => assistant({ ts: minutesAgo(60 - i), model: 'claude-opus-5-5', effort: 'xhigh', usage: big })));
  writeTranscript(projects, 'my-app/s1/subagents/agent-1.jsonl', [assistant({ ts: minutesAgo(40), model: 'claude-opus-5-5', effort: 'xhigh', usage: { output_tokens: M / 50 } })]);
  writeJson(projects, 'my-app/s1/subagents/agent-1.meta.json', { agentType: 'general-purpose' });
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
  return root;
}

test('analyze --lang pt prints Portuguese and writes the dashboard in Portuguese', () => {
  const root = heavyWeek();
  const res = run(root, ['analyze', '--lang', 'pt']);
  assert.equal(res.status, 0, res.stderr);
  for (const s of ['## Resumo', 'Gasto por dia', '## Perguntas']) assert.ok(res.stdout.includes(s), s);
  assertNoEnglish(prose(res.stdout), 'analyze --lang pt');
  assert.match(fs.readFileSync(path.join(root, 'limit-xray', 'dashboard.html'), 'utf8'), /<html lang="pt-BR">/);
});

test('the language setting picks Portuguese; --lang and LIMIT_XRAY_LANG override it', () => {
  const root = heavyWeek({ model: 'opus', language: 'portuguese' });
  assert.match(run(root, ['plan']).stdout, /^# limit-xray: ajustes que você pode aplicar/);
  assert.match(run(root, ['plan', '--lang', 'en']).stdout, /^# limit-xray: fixes you can apply/);
  assert.match(run(root, ['plan'], { LIMIT_XRAY_LANG: 'en' }).stdout, /^# limit-xray: fixes you can apply/);
  const plain = heavyWeek();
  assert.match(run(plain, ['plan']).stdout, /^# limit-xray: fixes you can apply/);
  assert.match(run(plain, ['plan'], { LIMIT_XRAY_LANG: 'pt-BR' }).stdout, /^# limit-xray: ajustes/);
});

test('a language in the project settings counts too, the local file before the shared one', () => {
  const root = heavyWeek();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-xray-project-'));
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ language: 'portuguese' }));
  assert.match(run(root, ['plan'], {}, project).stdout, /^# limit-xray: ajustes/);
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ language: 'english' }));
  assert.match(run(root, ['plan'], {}, project).stdout, /^# limit-xray: fixes you can apply/);
});

test('one request in one session reads in the singular, in both languages', () => {
  const { root, projects } = tempRoot();
  writeTranscript(projects, 'my-app/s.jsonl', [assistant({ ts: minutesAgo(30), model: 'claude-opus-5-5', usage: { output_tokens: 1000 } })]);
  assert.match(run(root, ['--lang', 'en']).stdout, / over 1 request in 1 session \(/);
  assert.match(run(root, ['--lang', 'pt']).stdout, / em 1 requisição e 1 sessão \(/);
});

test('in Portuguese, dates read day/month/year', async () => {
  const x = await everything('pt');
  const md = renderAnalyze({ report: x.r, found: x.found, fixes: x.fixes, habits: x.habits, settingsFile: x.settingsFile, active: x.active, lang: 'pt' });
  assert.match(md, /preços de tabela de \d{2}\/\d{2}\/\d{4}\)/);
  assert.match(md, /aplicado em 20\/10\/2026 10:00 UTC/);
  assert.match(md, /começam em 20\/10\/2026\./);
});

test('--lang takes only a language with a catalog', () => {
  const res = run(heavyWeek(), ['plan', '--lang', 'klingon']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--lang must be en or pt/);
});

test('apply and revert speak Portuguese too', () => {
  const root = heavyWeek();
  const applied = run(root, ['apply', 'default-model-sonnet', '--lang', 'pt']);
  assert.equal(applied.status, 0, applied.stderr);
  assertNoEnglish(prose(applied.stdout), 'apply');
  const reverted = run(root, ['revert', '--lang', 'pt']);
  assert.equal(reverted.status, 0, reverted.stderr);
  assertNoEnglish(prose(reverted.stdout), 'revert');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).model, 'opus');
});
