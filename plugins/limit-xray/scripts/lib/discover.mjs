// Find Claude Code transcripts modified inside the window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Default config folders: CLAUDE_CONFIG_DIR wins; otherwise ~/.claude and the XDG location.
export function defaultConfigDirs(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return [env.CLAUDE_CONFIG_DIR];
  const home = os.homedir();
  return [path.join(home, '.claude'), path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude')];
}

// The security-guidance plugin's log file, resolved the way the plugin resolves it.
export function securityGuidanceLogFile(configDir, env = process.env) {
  if (configDir) return path.join(configDir, 'security', 'log.txt');
  if (env.SECURITY_GUIDANCE_DEBUG_LOG) return env.SECURITY_GUIDANCE_DEBUG_LOG;
  const stateDir = env.SECURITY_WARNINGS_STATE_DIR
    || (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'security') : path.join(os.homedir(), '.claude', 'security'));
  return path.join(stateDir, 'log.txt');
}

// Each transcript: { file, project, sessionId, kind: 'main' | 'subagent' | 'workflow', metaFile }.
// Linked folders (symlinks, Windows junctions) are followed once each.
export function findTranscripts(projectsDirs, sinceMs) {
  const out = [];
  const visited = new Set();
  for (const dir of projectsDirs) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const projectPath = path.join(real, e.name);
      const target = resolveDir(projectPath, e, visited);
      if (target) walk(target, e.name, [], sinceMs, out, visited);
    }
  }
  return out;
}

// Return the real path of a directory entry (following links), or null if it is not a new directory.
function resolveDir(p, entry, visited) {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) return null;
  let real;
  try {
    real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  if (visited.has(real)) return null;
  visited.add(real);
  return real;
}

function walk(dir, project, rel, sinceMs, out, visited) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const sub = resolveDir(p, e, visited);
    if (sub) {
      walk(sub, project, [...rel, e.name], sinceMs, out, visited);
      continue;
    }
    if (!e.name.endsWith('.jsonl')) continue;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.mtimeMs < sinceMs) continue;
    out.push(describe(project, [...rel, e.name], p));
  }
}

// Names of the project folders under the given projects directories.
export function listProjects(projectsDirs) {
  const names = new Set();
  for (const dir of projectsDirs) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() || e.isSymbolicLink()) names.add(e.name);
    } catch {
      // missing folder: nothing to list
    }
  }
  return [...names];
}

function describe(project, parts, file) {
  // Older Claude Code versions wrote sidechain (subagent) transcripts at the project root as agent-*.jsonl;
  // their parent session is in each line's sessionId.
  if (parts.length === 1 && /^agent-[^\\/]+\.jsonl$/.test(parts[0])) {
    return { file, project, sessionId: null, kind: 'subagent', metaFile: file.replace(/\.jsonl$/, '.meta.json') };
  }
  const subIdx = parts.indexOf('subagents');
  if (subIdx > 0) {
    const sessionId = parts[subIdx - 1];
    const kind = parts[subIdx + 1] === 'workflows' ? 'workflow' : 'subagent';
    return { file, project, sessionId, kind, metaFile: file.replace(/\.jsonl$/, '.meta.json') };
  }
  return { file, project, sessionId: path.basename(file, '.jsonl'), kind: 'main', metaFile: null };
}
