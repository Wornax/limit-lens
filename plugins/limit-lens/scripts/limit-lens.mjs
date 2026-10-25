#!/usr/bin/env node
// limit-lens: show where your Claude Code usage limit goes. Reads local files only; no network.
import path from 'node:path';
import { analyze } from './lib/analyze.mjs';
import { defaultConfigDirs, securityGuidanceLogFile } from './lib/discover.mjs';
import { findings } from './lib/findings.mjs';
import { renderMarkdown, anonymizer, clean, UUID } from './lib/report.mjs';

const USAGE = `Usage: limit-lens [--days N] [--project NAME] [--anonymize] [--json] [--config-dir PATH]

  --days N           window to analyze, 1 to 90 (default 7)
  --project NAME     only projects whose folder name contains NAME
  --anonymize        replace project folder names with project-1, project-2, ...
  --json             print the raw report and findings as JSON
  --config-dir PATH  Claude config folder (default: CLAUDE_CONFIG_DIR, ~/.claude and ~/.config/claude)
`;

// Agent types Claude Code ships with; any other name is the user's own and is hidden by --anonymize.
const BUILT_IN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'workflow-subagent', 'fork', 'unknown', 'other']);

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(rawArgv) {
  const opts = { days: 7, project: null, anonymize: false, json: false, configDir: null, now: null };
  // Accept --flag=value as well as --flag value.
  const argv = rawArgv.flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      // A value never starts with "--": that is the next flag, not this one's value.
      if (v === undefined || v.trim() === '' || v.startsWith('--')) fail(`Missing value for ${a}`);
      return v;
    };
    if (a === '--days') opts.days = Number(value());
    else if (a === '--project') opts.project = value();
    else if (a === '--anonymize') opts.anonymize = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--config-dir') opts.configDir = value();
    else if (a === '--now') {
      // Undocumented: pins the window's end, for tests.
      opts.now = Date.parse(value());
      if (Number.isNaN(opts.now)) fail('--now must be an ISO date');
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a.trim() === '') continue;
    else fail(`Unknown option: ${a}`);
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) fail('--days must be a whole number from 1 to 90');
  return opts;
}

function anonymizeJson(report) {
  const name = anonymizer(true);
  for (const s of report.topSessions) s.project = name(s.project);
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

const opts = parseArgs(process.argv.slice(2));
const configDirs = opts.configDir ? [opts.configDir] : defaultConfigDirs();
const projectsDirs = configDirs.map((d) => path.join(d, 'projects'));
const securityLog = securityGuidanceLogFile(opts.configDir);

const report = await analyze({ projectsDirs, now: opts.now ?? Date.now(), days: opts.days, project: opts.project, securityLog });
const found = findings(report);

if (opts.json) {
  if (opts.anonymize) anonymizeJson(report);
  // Names come from disk: keep real session ids (UUIDs); anything else becomes a cleaned stub,
  // or a placeholder under --anonymize.
  report.topSessions.forEach((s, i) => {
    s.sessionId = UUID.test(s.sessionId) ? s.sessionId : opts.anonymize ? `session-${i + 1}` : clean(s.sessionId).slice(0, 8);
    s.project = clean(s.project).slice(0, 80);
  });
  if (report.filter) report.filter.project = opts.anonymize ? 'hidden' : clean(report.filter.project);
  process.stdout.write(JSON.stringify({ report, findings: found }, null, 2) + '\n');
} else {
  process.stdout.write(renderMarkdown(report, found, { anonymize: opts.anonymize, searched: projectsDirs }));
}
