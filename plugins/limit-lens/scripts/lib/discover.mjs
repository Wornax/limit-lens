// Find Claude Code transcripts modified inside the window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Default transcript folders: CLAUDE_CONFIG_DIR wins; otherwise ~/.claude and the XDG location.
export function defaultConfigDirs(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return [env.CLAUDE_CONFIG_DIR];
  const home = os.homedir();
  return [path.join(home, '.claude'), path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude')];
}

// Each transcript: { file, project, sessionId, kind: 'main' | 'subagent' | 'workflow', metaFile }.
export function findTranscripts(projectsDirs, sinceMs) {
  const out = [];
  const seenReal = new Set();
  for (const dir of projectsDirs) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    walk(real, real, sinceMs, out);
  }
  return out;
}

function walk(root, dir, sinceMs, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(root, p, sinceMs, out);
      continue;
    }
    if (!e.name.endsWith('.jsonl')) continue;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs < sinceMs) continue;
    out.push(describe(root, p));
  }
}

function describe(root, file) {
  const parts = path.relative(root, file).split(path.sep);
  const project = parts[0];
  const subIdx = parts.indexOf('subagents');
  if (subIdx > 0) {
    const sessionId = parts[subIdx - 1];
    const kind = parts[subIdx + 1] === 'workflows' ? 'workflow' : 'subagent';
    const metaFile = file.replace(/\.jsonl$/, '.meta.json');
    return { file, project, sessionId, kind, metaFile };
  }
  return { file, project, sessionId: path.basename(file, '.jsonl'), kind: 'main', metaFile: null };
}
