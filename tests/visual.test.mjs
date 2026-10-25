// Charts: text bars in the terminal, spend by day, and the HTML dashboard analyze writes.
// Synthetic data and temp folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { findings } from '../plugins/limit-lens/scripts/lib/findings.mjs';
import { applicableFixes, routingFix, habitsWithFindings } from '../plugins/limit-lens/scripts/lib/fixes.mjs';
import { bar, barBlock } from '../plugins/limit-lens/scripts/lib/charts.mjs';
import { renderMarkdown } from '../plugins/limit-lens/scripts/lib/report.mjs';
import { renderDashboard } from '../plugins/limit-lens/scripts/lib/dashboard.mjs';
import { NOW, minutesAgo, daysAgo, tempRoot, assistant, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-lens', 'scripts', 'limit-lens.mjs');
const M = 1_000_000;
const run = (root, args, env = {}) => spawnSync(process.execPath, [CLI, ...args, '--config-dir', root, '--now', new Date(NOW).toISOString()], { encoding: 'utf8', env: { ...process.env, LIMIT_LENS_NO_OPEN: '1', ...env } });

test('a bar is drawn in eighths of a character, and anything above zero shows', () => {
  assert.equal(bar(1, 10), '██████████');
  assert.equal(bar(0.5, 10), '█████');
  assert.equal(bar(0.55, 10), '█████▌');
  assert.equal(bar(0, 10), '');
  assert.equal(bar(0.0001, 10), '▏');
  assert.equal(bar(2, 4), '████'); // never past its width
});

test('a bar block lines up labels, bars and values', () => {
  const lines = barBlock([
    { label: 'Re-reading context', fraction: 0.62, value: '62%  $5,224' },
    { label: 'Output', fraction: 0.1, value: '10%    $832' },
  ], { width: 20 });
  assert.equal(lines.length, 2);
  const barStart = (l) => l.search(/[█-▏]/);
  assert.equal(barStart(lines[0]), barStart(lines[1]));
  assert.equal(lines[0].length, lines[1].length);
});

test('spend is counted per local calendar day', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'p/s.jsonl', [
    assistant({ ts: daysAgo(3), usage: { output_tokens: M } }), // $10
    assistant({ ts: minutesAgo(30), usage: { output_tokens: M / 2 } }), // $5
  ]);
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  const days = Object.entries(r.byDay);
  assert.equal(days.length, 2);
  assert.deepEqual(days.map(([, b]) => b.cost).sort((a, b) => a - b), [5, 10]);
  assert.match(days[0][0], /^\d{4}-\d{2}-\d{2}$/);
});

test('the report draws its numbers as bars in a text block', async () => {
  const { projects } = tempRoot();
  writeTranscript(projects, 'my-app/s.jsonl', [
    assistant({ ts: daysAgo(2), model: 'claude-opus-5-5', effort: 'xhigh', usage: { output_tokens: M } }),
    assistant({ ts: minutesAgo(30), usage: { cache_read_input_tokens: 400_000, output_tokens: 1000 } }),
  ]);
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
  const md = renderMarkdown(r, findings(r));
  const block = md.slice(md.indexOf('```text'), md.indexOf('```', md.indexOf('```text') + 7));
  for (const title of ['Spend by day', 'Where it goes', 'By model', 'By source', 'By effort', 'Biggest projects']) assert.match(block, new RegExp(title), title);
  assert.match(block, /█/);
  assert.match(block, /Opus 5\.5 +█+.* \d+%/);
  assert.match(block, /my-app/);
});

async function richReport() {
  const { projects } = tempRoot();
  writeTranscript(projects, "x' onmouseover='alert(1)/s1.jsonl", [
    assistant({ ts: daysAgo(2), model: 'claude-opus-5-5', effort: 'xhigh', usage: { output_tokens: M } }),
    assistant({ ts: minutesAgo(30), model: 'claude-opus-5-5', usage: { cache_read_input_tokens: 400_000, output_tokens: 1000 } }),
  ]);
  writeTranscript(projects, "x' onmouseover='alert(1)/s1/subagents/agent-1.jsonl", [assistant({ ts: minutesAgo(20), model: 'claude-opus-5-5', usage: { output_tokens: M / 2 } })]);
  writeJson(projects, "x' onmouseover='alert(1)/s1/subagents/agent-1.meta.json", { agentType: '<b>evil</b>' });
  return analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLog: null });
}

test('the dashboard shows the spend, the charts, the findings and every fix, with names from disk escaped', async () => {
  const r = await richReport();
  const found = findings(r);
  const fixes = [routingFix(r, { file: 'C:/x/CLAUDE.md', rule: 'the `rule`' }), ...applicableFixes(r, { model: 'opus' })].filter(Boolean);
  const html = renderDashboard({ report: r, found, fixes, habits: habitsWithFindings(r), settingsFile: 'C:/x/settings.json', last: null, undo: null, generatedAt: NOW });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /prefers-color-scheme: dark/);
  for (const s of ['Spend by day', 'Where it goes', 'By model', 'What is driving it', 'Fixes you can apply', 'What it is']) assert.match(html, new RegExp(s), s);
  for (const f of fixes) assert.ok(html.includes(f.title.replace(/"/g, '&quot;')), f.id);
  assert.ok(!html.includes("onmouseover='"), 'a folder name became markup');
  assert.ok(!html.includes('<b>evil'), 'an agent name became markup');
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+stylesheet|@import|url\(\s*['"]?https?:/i); // nothing loads from the network
});

test('analyze writes the dashboard next to its records and says where', () => {
  const { root, projects } = tempRoot();
  writeTranscript(projects, 'my-app/s.jsonl', [assistant({ ts: minutesAgo(30), model: 'claude-opus-5-5', usage: { output_tokens: M } })]);
  const res = run(root, ['analyze', '--open']);
  assert.equal(res.status, 0, res.stderr);
  const file = path.join(root, 'limit-lens', 'dashboard.html');
  assert.ok(fs.existsSync(file));
  assert.ok(res.stdout.includes(file), 'the output names the dashboard file');
  assert.match(res.stdout, /## Summary/);
});

test('--open belongs to analyze only', () => {
  const { root } = tempRoot();
  const res = run(root, ['plan', '--open']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--open/);
});
