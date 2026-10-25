// Apply chosen fixes to the user settings file and keep a record of each change, so it can be
// measured (compare) and undone (revert). State: <config dir>/limit-lens/experiments.json.
import fs from 'node:fs';
import path from 'node:path';
import { applicableFixes } from './fixes.mjs';
import { metrics } from './compare.mjs';
import { readSettings, writeSettings, getPath, setPath, deletePath } from './settings.mjs';

export const stateDir = (configDir) => path.join(configDir, 'limit-lens');
const stateFile = (configDir) => path.join(stateDir(configDir), 'experiments.json');
export const settingsPath = (configDir) => path.join(configDir, 'settings.json');

export function loadState(configDir) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(configDir), 'utf8'));
    return Array.isArray(s?.experiments) ? s : { experiments: [] };
  } catch {
    return { experiments: [] };
  }
}

function saveState(configDir, state) {
  fs.mkdirSync(stateDir(configDir), { recursive: true });
  const file = stateFile(configDir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

export function latestExperiment(configDir, id = null) {
  const { experiments } = loadState(configDir);
  return id ? experiments.find((e) => e.id === id) || null : experiments[experiments.length - 1] || null;
}

// The fixes that apply now, given the report and the current settings file.
export function currentPlan(configDir, report) {
  const { data } = readSettings(settingsPath(configDir));
  return applicableFixes(report, data);
}

export function applyFixes({ configDir, fixIds, report, now }) {
  if (!fixIds.length) throw new Error('Name at least one fix id to apply.');
  const file = settingsPath(configDir);
  const { data } = readSettings(file);
  const available = new Map(applicableFixes(report, data).map((f) => [f.id, f]));
  const chosen = fixIds.map((id) => {
    const fix = available.get(id);
    if (!fix) throw new Error(`"${id}" is not an applicable fix right now; run the plan again to see the current list.`);
    return fix;
  });
  const changes = chosen.map((fix) => {
    const before = getPath(data, fix.path);
    setPath(data, fix.path, fix.value);
    return { fixId: fix.id, path: fix.path, before: before === undefined ? null : before, hadKey: before !== undefined, after: fix.value };
  });
  const backup = writeSettings(file, data, { backupDir: path.join(stateDir(configDir), 'backups') });
  const at = new Date(now);
  const experiment = {
    id: `exp-${at.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`,
    appliedAt: at.toISOString(),
    settingsFile: file,
    backup,
    changes,
    baseline: metrics(report),
  };
  const state = loadState(configDir);
  state.experiments.push(experiment);
  saveState(configDir, state);
  return experiment;
}

// Restore only the keys the experiment changed, and only where the value is still the one it set.
export function revertExperiment({ configDir, now, id = null }) {
  const state = loadState(configDir);
  const exp = id ? state.experiments.find((e) => e.id === id) : [...state.experiments].reverse().find((e) => !e.revertedAt);
  if (!exp) throw new Error(id ? `No experiment "${id}".` : 'There is no applied experiment to revert.');
  const file = settingsPath(configDir);
  const { data } = readSettings(file);
  const restored = [];
  const skipped = [];
  for (const c of exp.changes) {
    const current = getPath(data, c.path);
    if (current !== c.after) {
      skipped.push(c);
      continue;
    }
    if (c.hadKey) setPath(data, c.path, c.before);
    else deletePath(data, c.path);
    restored.push(c);
  }
  const backup = restored.length ? writeSettings(file, data, { backupDir: path.join(stateDir(configDir), 'backups') }) : null;
  exp.revertedAt = new Date(now).toISOString();
  saveState(configDir, state);
  return { experiment: exp, restored, skipped, backup };
}
