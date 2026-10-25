#!/usr/bin/env node
// limit-lens: show where your Claude Code usage limit goes, apply chosen fixes to your settings,
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
import { userConfigDir } from './lib/settings.mjs';
import { renderMarkdown, renderPlan, renderAnalyze, diagnosis, questions, contributorName, anonymizer, clean, UUID } from './lib/report.mjs';

const USAGE = `Usage: limit-lens [command] [options]

  limit-lens [--days N] [--project NAME] [--anonymize] [--json]   report where your limit goes
  limit-lens analyze [--open] [--json]                             the report, the fixes to ask about and other suggestions, and a dashboard page
  limit-lens plan [--json]                                         list the fixes you can apply
  limit-lens apply FIX_ID [FIX_ID ...]                             apply the chosen fixes (backs up settings first)
  limit-lens compare [--experiment ID]                             compare usage before and after the last change
  limit-lens revert [--experiment ID]                              undo the last change

Options:
  --days N           window to analyze, 1 to 90 (default 7)
  --project NAME     only projects whose folder name contains NAME
  --anonymize        replace project folder names with project-1, project-2, ...
  --json             print raw JSON
  --open             analyze only: open the dashboard page in your browser
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
    else if (a === '--config-dir') opts.configDir = value();
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
    fail('--days, --project and --anonymize apply only to the report (limit-lens [--days N] [--project NAME] [--anonymize]).');
  }
  if (opts.command === 'apply' && !opts.ids.length) fail('Name at least one fix id to apply (see `limit-lens plan`).');
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

// Open a local file with the system's default app (the browser, for HTML). The path is limit-lens's own;
// LIMIT_LENS_NO_OPEN=1 turns this off, for tests and headless runs.
function openInBrowser(file) {
  if (process.env.LIMIT_LENS_NO_OPEN) return false;
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

const opts = parseArgs(process.argv.slice(2));
const now = opts.now ?? Date.now();
const configDirs = opts.configDir ? [opts.configDir] : defaultConfigDirs();
const projectsDirs = configDirs.map((d) => path.join(d, 'projects'));
const securityLog = securityGuidanceLogFile(opts.configDir);
const settingsDir = userConfigDir(opts.configDir);
const out = (text) => process.stdout.write(text);

try {
  if (opts.command === 'report') {
    const report = await analyze({ projectsDirs, now, days: opts.days, project: opts.project, securityLog });
    const found = findings(report);
    if (opts.json) {
      sanitizeJson(report, opts.anonymize);
      out(JSON.stringify({ report, findings: found }, null, 2) + '\n');
    } else {
      out(renderMarkdown(report, found, { anonymize: opts.anonymize, searched: projectsDirs }));
    }
  } else if (opts.command === 'analyze' || opts.command === 'plan' || opts.command === 'apply') {
    // Fixes are judged on the last 7 days, the same window compare measures against.
    const report = await analyze({ projectsDirs, now, days: 7, securityLog });
    if (opts.command !== 'apply') {
      const fixes = currentPlan(settingsDir, report);
      const found = findings(report);
      const habitList = habitsWithFindings(report);
      const plan = { settingsFile: settingsPath(settingsDir), fixes, habits: habitList.map((h) => h.text), ...planHistory(settingsDir) };
      if (opts.json) {
        // Names from disk are cleaned, as in the Markdown; plan leaves the full report out.
        for (const f of fixes) for (const c of f.contributors) c.name = contributorName(c);
        const extra = { diagnosis: diagnosis(report, found), questions: questions(fixes).map((q) => ({ title: q.title, what: q.what, group: q.group, options: q.options.map((f) => f.id) })) };
        if (opts.command === 'analyze') sanitizeJson(report, false);
        out(JSON.stringify(opts.command === 'analyze' ? { report, findings: found, ...extra, ...plan } : { ...extra, ...plan }, null, 2) + '\n');
      } else {
        let dashboard = null;
        if (opts.command === 'analyze' && report.totals.requests) {
          const file = path.join(stateDir(settingsDir), 'dashboard.html');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, renderDashboard({ report, found, fixes, habits: habitList, ...plan, generatedAt: now }));
          dashboard = { file, opened: Boolean(opts.open) && openInBrowser(file) };
        }
        out(opts.command === 'analyze' ? renderAnalyze({ report, found, searched: projectsDirs, ...plan, habits: habitList, dashboard }) : renderPlan({ report, found, ...plan }));
      }
    } else {
      const exp = applyFixes({ configDir: settingsDir, fixIds: opts.ids, report, now });
      const lines = [`Applied ${exp.changes.length} fix${exp.changes.length === 1 ? '' : 'es'} (experiment \`${exp.id}\`):`, ''];
      for (const c of exp.changes) {
        lines.push(c.kind === 'memory'
          ? `- \`${c.fixId}\`: added the model-routing rule to \`${c.file}\``
          : `- \`${c.fixId}\`: \`${c.path.join('.')}\` in \`${exp.settingsFile}\`: ${c.hadKey ? `\`${JSON.stringify(c.before)}\`` : '(not set)'} -> \`${JSON.stringify(c.after)}\``);
      }
      lines.push('');
      if (exp.changes.some((c) => c.kind !== 'memory')) lines.push(exp.backup ? `Backup of the previous settings file: \`${exp.backup}\`.` : 'There was no settings file before; it was created.');
      if (exp.memoryBackup) lines.push(`Backup of the previous CLAUDE.md: \`${exp.memoryBackup}\`.`);
      lines.push('New settings and rules apply to new sessions. Compare after a few days of normal use; revert at any time.');
      out(lines.join('\n') + '\n');
    }
  } else if (opts.command === 'compare') {
    const exp = findExperiment(settingsDir, opts.experiment);
    if (!exp) out('No experiment yet: apply a fix first (`limit-lens plan`, then `limit-lens apply FIX_ID`).\n');
    else {
      const from = Date.parse(exp.appliedAt);
      const after = metrics(await analyze({ projectsDirs, from, to: Math.max(now, from + 1), securityLog }));
      out(renderCompare(exp, after));
    }
  } else if (opts.command === 'revert') {
    const { experiment, restored, skipped, backup, memoryBackup, notes } = revertExperiment({ configDir: settingsDir, now, id: opts.experiment });
    const lines = [`Reverted experiment \`${experiment.id}\`:`, ''];
    for (const c of restored) {
      lines.push(c.kind === 'memory' ? `- \`${c.file}\`: removed the model-routing rule` : `- \`${c.path.join('.')}\` restored to ${c.hadKey ? `\`${JSON.stringify(c.before)}\`` : '(not set)'} in \`${experiment.settingsFile}\``);
    }
    for (const c of skipped) {
      lines.push(c.kind === 'memory' ? `- \`${c.file}\`: the model-routing rule was left as is: it was edited since it was added` : `- \`${c.path.join('.')}\` left as is: it was changed since the fix was applied`);
    }
    if (backup || memoryBackup) lines.push('');
    if (backup) lines.push(`Backup of the settings file before reverting: \`${backup}\`.`);
    if (memoryBackup) lines.push(`Backup of CLAUDE.md before reverting: \`${memoryBackup}\`.`);
    if (notes.length) lines.push('', ...notes.map((n) => `Note: ${n}`));
    out(lines.join('\n') + '\n');
  }
} catch (e) {
  process.stderr.write(`limit-lens: ${e.message}\n`);
  process.exit(2);
}
