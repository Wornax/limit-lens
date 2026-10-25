#!/usr/bin/env node
// limit-xray: show where your Claude Code usage limit goes, apply chosen fixes to your settings,
// and compare before and after. Reads local files only; no network.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { analyze } from './lib/analyze.mjs';
import { defaultConfigDirs, securityGuidanceLogFile } from './lib/discover.mjs';
import { findings } from './lib/findings.mjs';
import { habitsWithFindings } from './lib/fixes.mjs';
import { metrics, renderCompare } from './lib/compare.mjs';
import { currentPlan, applyFixes, revertExperiment, findExperiment, planHistory, settingsPath, stateDir } from './lib/experiments.mjs';
import { renderDashboard } from './lib/dashboard.mjs';
import { userConfigDir, readSettings } from './lib/settings.mjs';
import { renderMarkdown, renderPlan, renderAnalyze, diagnosis, questions, contributorName, anonymizer, clean, UUID } from './lib/report.mjs';
import { langOf, resolveLang, locale } from './lib/i18n/index.mjs';

const USAGE = `Usage: limit-xray [command] [options]

  limit-xray [--days N] [--project NAME] [--anonymize] [--json]   report where your limit goes
  limit-xray analyze [--open] [--json]                             the report, the fixes to ask about and other suggestions, and a dashboard page
  limit-xray plan [--json]                                         list the fixes you can apply
  limit-xray apply FIX_ID [FIX_ID ...]                             apply the chosen fixes (backs up settings first)
  limit-xray compare [--experiment ID]                             compare usage before and after the last change
  limit-xray revert [--experiment ID]                              undo the last change

Options:
  --days N           window to analyze, 1 to 90 (default 7)
  --project NAME     only projects whose folder name contains NAME
  --anonymize        replace project folder names with project-1, project-2, ...
  --json             print raw JSON
  --open             analyze only: open the dashboard page in your browser
  --lang en|pt       language of the output (default: LIMIT_XRAY_LANG, then Claude Code's language setting, then en)
  --config-dir PATH  Claude config folder (default: CLAUDE_CONFIG_DIR, ~/.claude and ~/.config/claude)
`;

const SUBCOMMANDS = new Set(['analyze', 'plan', 'apply', 'compare', 'revert']);
const FIX_ID = /^[a-z0-9][a-z0-9.-]{0,80}$/;

// Agent types Claude Code ships with; any other name is the user's own and is hidden by --anonymize.
const BUILT_IN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'workflow-subagent', 'fork', 'unknown', 'other']);

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(rawArgv) {
  const opts = { command: 'report', ids: [], days: 7, project: null, anonymize: false, json: false, configDir: null, now: null, experiment: null };
  // Accept --flag=value as well as --flag value.
  const argv = rawArgv.flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
  let i = 0;
  if (SUBCOMMANDS.has(argv[0])) {
    opts.command = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      // A value never starts with "--": that is the next flag, not this one's value.
      if (v === undefined || v.trim() === '' || v.startsWith('--')) fail(`Missing value for ${a}`);
      return v;
    };
    if (a === '--days') {
      opts.days = Number(value());
      opts.daysGiven = true;
    }
    else if (a === '--project') opts.project = value();
    else if (a === '--anonymize') opts.anonymize = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--lang') {
      opts.lang = value();
      if (!langOf(opts.lang)) fail('--lang must be en or pt');
    } else if (a === '--config-dir') opts.configDir = value();
    else if (a === '--experiment') opts.experiment = value();
    else if (a === '--now') {
      // Undocumented: pins the window's end, for tests.
      opts.now = Date.parse(value());
      if (Number.isNaN(opts.now)) fail('--now must be an ISO date');
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a.trim() === '') continue;
    else if (opts.command === 'apply' && FIX_ID.test(a)) opts.ids.push(a);
    else fail(`Unknown option: ${a}`);
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) fail('--days must be a whole number from 1 to 90');
  // The other commands always look at the last 7 days of every project, the window compare measures against.
  if (opts.open && opts.command !== 'analyze') fail('--open applies only to analyze.');
  if (opts.command !== 'report' && (opts.daysGiven || opts.project !== null || opts.anonymize)) {
    fail('--days, --project and --anonymize apply only to the report (limit-xray [--days N] [--project NAME] [--anonymize]).');
  }
  if (opts.command === 'apply' && !opts.ids.length) fail('Name at least one fix id to apply (see `limit-xray plan`).');
  return opts;
}

// Every name in the JSON comes from disk. Real session ids (UUIDs) are kept; other file names become a
// cleaned stub; project names are cleaned. --anonymize replaces project, file and custom agent names.
function sanitizeJson(report, anonymize) {
  const projectName = anonymize ? anonymizer(true) : (p) => clean(p).slice(0, 80);
  const sessionName = (id, i) => (UUID.test(id) ? id : anonymize ? `session-${i + 1}` : clean(id).slice(0, 8));
  for (const rows of [report.topSessions, report.contextSessions]) {
    rows.forEach((s, i) => {
      s.sessionId = sessionName(s.sessionId, i);
      s.project = projectName(s.project);
    });
  }
  // Two folders can clean to the same name: add their numbers up instead of dropping one.
  const merge = (into, from) => {
    for (const [k, v] of Object.entries(from)) {
      if (typeof v === 'number') into[k] = (into[k] || 0) + v;
      else if (v && typeof v === 'object') merge((into[k] ??= Object.create(null)), v);
    }
    return into;
  };
  const byProject = Object.create(null);
  for (const [p, b] of Object.entries(report.byProject)) merge((byProject[projectName(p)] ??= Object.create(null)), b);
  report.byProject = byProject;
  if (report.filter) report.filter.project = anonymize ? 'hidden' : clean(report.filter.project);
  if (!anonymize) return;
  const agentName = new Map();
  for (const lens of Object.values(report.agents)) {
    const renamed = Object.create(null);
    for (const [type, b] of Object.entries(lens.byType)) {
      if (!BUILT_IN_AGENTS.has(type) && !agentName.has(type)) agentName.set(type, `custom-agent-${agentName.size + 1}`);
      renamed[BUILT_IN_AGENTS.has(type) ? type : agentName.get(type)] = b;
    }
    lens.byType = renamed;
  }
}

// Open a local file with the system's default app (the browser, for HTML). The path is limit-xray's own;
// LIMIT_XRAY_NO_OPEN=1 turns this off, for tests and headless runs.
function openInBrowser(file) {
  if (process.env.LIMIT_XRAY_NO_OPEN) return false;
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Claude Code's `language` setting, from the most specific settings file that sets it: the project's local
// file, the project's shared file (both under the working folder), then the user's. A broken file counts as unset.
function languageSetting(dir) {
  for (const file of [path.resolve('.claude', 'settings.local.json'), path.resolve('.claude', 'settings.json'), settingsPath(dir)]) {
    try {
      const value = readSettings(file).data.language;
      if (value) return value;
    } catch {
      // unreadable or not JSON: try the next file
    }
  }
  return undefined;
}

const opts = parseArgs(process.argv.slice(2));
const now = opts.now ?? Date.now();
const configDirs = opts.configDir ? [opts.configDir] : defaultConfigDirs();
const projectsDirs = configDirs.map((d) => path.join(d, 'projects'));
const securityLog = securityGuidanceLogFile(opts.configDir);
const settingsDir = userConfigDir(opts.configDir);
const lang = resolveLang({ flag: opts.lang, env: process.env.LIMIT_XRAY_LANG, setting: languageSetting(settingsDir) });
const { cli: T, names } = locale(lang).t;
const code = (v) => `\`${JSON.stringify(v)}\``;
const out = (text) => process.stdout.write(text);

try {
  if (opts.command === 'report') {
    const report = await analyze({ projectsDirs, now, days: opts.days, project: opts.project, securityLog });
    const found = findings(report, { lang });
    if (opts.json) {
      sanitizeJson(report, opts.anonymize);
      out(JSON.stringify({ report, findings: found }, null, 2) + '\n');
    } else {
      out(renderMarkdown(report, found, { anonymize: opts.anonymize, searched: projectsDirs, lang }));
    }
  } else if (opts.command === 'analyze' || opts.command === 'plan' || opts.command === 'apply') {
    // Fixes are judged on the last 7 days, the same window compare measures against.
    const report = await analyze({ projectsDirs, now, days: 7, securityLog });
    if (opts.command !== 'apply') {
      const fixes = currentPlan(settingsDir, report, { lang });
      const found = findings(report, { lang });
      const habitList = habitsWithFindings(report, { lang });
      const plan = { settingsFile: settingsPath(settingsDir), fixes, habits: habitList.map((h) => h.text), ...planHistory(settingsDir) };
      if (opts.json) {
        // Names from disk are cleaned, as in the Markdown; plan leaves the full report out.
        for (const f of fixes) for (const c of f.contributors) c.name = contributorName(c);
        const extra = { diagnosis: diagnosis(report, found), questions: questions(fixes, { lang }).map((q) => ({ title: q.title, what: q.what, group: q.group, options: q.options.map((f) => f.id) })) };
        if (opts.command === 'analyze') sanitizeJson(report, false);
        out(JSON.stringify(opts.command === 'analyze' ? { report, findings: found, ...extra, ...plan } : { ...extra, ...plan }, null, 2) + '\n');
      } else {
        let dashboard = null;
        if (opts.command === 'analyze' && report.totals.requests) {
          const file = path.join(stateDir(settingsDir), 'dashboard.html');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          // plan.habits holds only the texts; the dashboard needs each habit's finding too, so habitList goes last.
          fs.writeFileSync(file, renderDashboard({ report, found, fixes, ...plan, habits: habitList, generatedAt: now, lang }));
          dashboard = { file, opened: Boolean(opts.open) && openInBrowser(file) };
        }
        out(opts.command === 'analyze' ? renderAnalyze({ report, found, searched: projectsDirs, ...plan, habits: habitList, dashboard, lang }) : renderPlan({ report, found, ...plan, lang }));
      }
    } else {
      const exp = applyFixes({ configDir: settingsDir, fixIds: opts.ids, report, now });
      const lines = [T.applied({ n: exp.changes.length, id: exp.id }), ''];
      for (const c of exp.changes) {
        lines.push(c.kind === 'memory'
          ? T.appliedMemory({ fixId: c.fixId, file: c.file })
          : T.appliedSetting({ fixId: c.fixId, path: c.path.join('.'), file: exp.settingsFile, from: c.hadKey ? code(c.before) : names.notSet, to: code(c.after) }));
      }
      lines.push('');
      if (exp.changes.some((c) => c.kind !== 'memory')) lines.push(exp.backup ? T.backup({ file: exp.backup }) : T.created);
      if (exp.memoryBackup) lines.push(T.memoryBackup({ file: exp.memoryBackup }));
      lines.push(T.applyNext);
      out(lines.join('\n') + '\n');
    }
  } else if (opts.command === 'compare') {
    const exp = findExperiment(settingsDir, opts.experiment);
    if (!exp) out(`${T.noExperiment}\n`);
    else {
      const from = Date.parse(exp.appliedAt);
      const after = metrics(await analyze({ projectsDirs, from, to: Math.max(now, from + 1), securityLog }));
      out(renderCompare(exp, after, { lang }));
    }
  } else if (opts.command === 'revert') {
    const { experiment, restored, skipped, backup, memoryBackup, notes } = revertExperiment({ configDir: settingsDir, now, id: opts.experiment, lang });
    const lines = [T.reverted({ id: experiment.id }), ''];
    for (const c of restored) {
      lines.push(c.kind === 'memory'
        ? T.restoredMemory({ file: c.file })
        : T.restoredSetting({ path: c.path.join('.'), to: c.hadKey ? code(c.before) : names.notSet, file: experiment.settingsFile }));
    }
    for (const c of skipped) lines.push(c.kind === 'memory' ? T.skippedMemory({ file: c.file }) : T.skippedSetting({ path: c.path.join('.') }));
    if (backup || memoryBackup) lines.push('');
    if (backup) lines.push(T.revertBackup({ file: backup }));
    if (memoryBackup) lines.push(T.revertMemoryBackup({ file: memoryBackup }));
    if (notes.length) lines.push('', ...notes.map((n) => T.note({ note: n })));
    out(lines.join('\n') + '\n');
  }
} catch (e) {
  process.stderr.write(`limit-xray: ${e.message}\n`);
  process.exit(2);
}
