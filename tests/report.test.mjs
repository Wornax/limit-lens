import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { findings } from '../plugins/limit-lens/scripts/lib/findings.mjs';
import { renderMarkdown } from '../plugins/limit-lens/scripts/lib/report.mjs';
import { NOW, minutesAgo, tempRoot, assistant, prompt, toolResult, writeTranscript, writeJson } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'limit-lens', 'scripts', 'limit-lens.mjs');

function heavyFixture() {
  const { root, projects } = tempRoot();
  // Realistic proportions: a large context re-read on every request, modest output.
  const big = { cache_read_input_tokens: 400_000, output_tokens: 2_000, output_tokens_details: { thinking_tokens: 1_500 } };
  for (let s = 0; s < 8; s++) {
    const lines = [prompt({ ts: minutesAgo(300), text: 'PRIVATE PROMPT about acme payroll' })];
    for (let i = 0; i < 20; i++) {
      lines.push(assistant({ ts: minutesAgo(299 - i), model: 'claude-opus-5-5', effort: 'xhigh', usage: big }));
      lines.push(toolResult({ ts: minutesAgo(299 - i) }));
    }
    writeTranscript(projects, `C--Users-alice-acme-secret-${s}/sess-${s}.jsonl`, lines);
    writeTranscript(projects, `C--Users-alice-acme-secret-${s}/sess-${s}/subagents/agent-${s}.jsonl`, [
      assistant({ ts: minutesAgo(200), model: 'claude-opus-5-5', usage: big }),
    ]);
    writeJson(projects, `C--Users-alice-acme-secret-${s}/sess-${s}/subagents/agent-${s}.meta.json`, { agentType: 'general-purpose' });
  }
  return { root, projects };
}

test('the report never contains prompt or tool output text', async () => {
  const { projects } = heavyFixture();
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLogDir: null });
  const md = renderMarkdown(r, findings(r));
  assert.ok(!md.includes('PRIVATE PROMPT'));
  assert.ok(!md.includes('acme payroll'));
  assert.ok(!md.includes('SECRET TOOL OUTPUT'));
});

test('--anonymize replaces folder names', async () => {
  const { projects } = heavyFixture();
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLogDir: null });
  const md = renderMarkdown(r, findings(r), { anonymize: true });
  assert.ok(!md.includes('alice'));
  assert.ok(!md.includes('acme'));
  assert.match(md, /project-1/);
});

test('a heavy report stays short enough to paste into a conversation', async () => {
  const { projects } = heavyFixture();
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLogDir: null });
  const md = renderMarkdown(r, findings(r));
  const words = md.split(/\s+/).length;
  assert.ok(words < 1600, `report has ${words} words`);
  assert.match(md, /## Findings/);
  assert.match(md, /Re-reading long conversations/);
});

test('an empty window says so and where it looked', async () => {
  const { projects } = tempRoot();
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLogDir: null });
  const md = renderMarkdown(r, findings(r), { searched: [projects] });
  assert.match(md, /No Claude Code usage found/);
  assert.ok(md.includes(projects));
});

test('the CLI prints markdown by default and JSON with --json', () => {
  const { root } = heavyFixture();
  const md = execFileSync(process.execPath, [CLI, '--config-dir', root, '--now', new Date(NOW).toISOString()], { encoding: 'utf8' });
  assert.match(md, /^# limit-lens/m);
  const json = JSON.parse(execFileSync(process.execPath, [CLI, '--config-dir', root, '--now', new Date(NOW).toISOString(), '--json'], { encoding: 'utf8' }));
  assert.ok(json.report.totals.requests > 0);
  assert.ok(Array.isArray(json.findings));
});

test('the CLI rejects unknown flags with usage help', () => {
  assert.throws(() => execFileSync(process.execPath, [CLI, '--bogus'], { encoding: 'utf8', stdio: 'pipe' }), /Usage: limit-lens/);
});
