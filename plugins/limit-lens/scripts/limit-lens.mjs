#!/usr/bin/env node
// limit-lens: show where your Claude Code usage limit goes. Reads local files only; no network.
import path from 'node:path';
import { analyze } from './lib/analyze.mjs';
import { defaultConfigDirs } from './lib/discover.mjs';
import { findings } from './lib/findings.mjs';
import { renderMarkdown, anonymizer } from './lib/report.mjs';

const USAGE = `Usage: limit-lens [--days N] [--project NAME] [--anonymize] [--json] [--config-dir PATH]

  --days N           window to analyze, 1 to 90 (default 7)
  --project NAME     only projects whose folder name contains NAME
  --anonymize        replace project folder names with project-1, project-2, ...
  --json             print the raw report and findings as JSON
  --config-dir PATH  Claude config folder (default: CLAUDE_CONFIG_DIR, ~/.claude and ~/.config/claude)
`;

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { days: 7, project: null, anonymize: false, json: false, configDir: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--days') opts.days = Number(value());
    else if (a === '--project') opts.project = value();
    else if (a === '--anonymize') opts.anonymize = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--config-dir') opts.configDir = value();
    else if (a === '--now') opts.now = Date.parse(value()); // for tests
    else if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a.trim() === '') continue;
    else fail(`Unknown option: ${a}`);
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) fail('--days must be a whole number from 1 to 90');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const configDirs = opts.configDir ? [opts.configDir] : defaultConfigDirs();
const projectsDirs = configDirs.map((d) => path.join(d, 'projects'));
const securityLogDir = process.env.SECURITY_GUIDANCE_DEBUG_LOG
  ? path.dirname(process.env.SECURITY_GUIDANCE_DEBUG_LOG)
  : path.join(configDirs[0], 'security');

const report = await analyze({ projectsDirs, now: opts.now ?? Date.now(), days: opts.days, project: opts.project, securityLogDir });
const found = findings(report);

if (opts.json) {
  const name = anonymizer(opts.anonymize);
  for (const s of report.topSessions) s.project = name(s.project);
  process.stdout.write(JSON.stringify({ report, findings: found }, null, 2) + '\n');
} else {
  process.stdout.write(renderMarkdown(report, found, { anonymize: opts.anonymize, searched: projectsDirs }));
}
