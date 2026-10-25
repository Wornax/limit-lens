// Apply chosen fixes to the user settings file and keep a record of each change, so it can be
// measured (compare) and undone (revert). State: <config dir>/limit-lens/experiments.json.
// A damaged state file is never overwritten: apply and revert refuse to run until it is fixed.
import fs from 'node:fs';
import path from 'node:path';
import { applicableFixes } from './fixes.mjs';
import { metrics } from './compare.mjs';
import { readSettings, writeSettings, getPath, setPath, deletePath } from './settings.mjs';

export const stateDir = (configDir) => path.join(configDir, 'limit-lens');
const stateFile = (configDir) => path.join(stateDir(configDir), 'experiments.json');
export const settingsPath = (configDir) => path.join(configDir, 'settings.json');

export function loadState(configDir) {
  const file = stateFile(configDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { experiments: [] };
    throw new Error(`Cannot read ${file}: ${e.message}. Fix or move it before applying or reverting.`);
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is damaged (${e.message}). Fix or move it before applying or reverting; previous settings files are in ${path.join(stateDir(configDir), 'backups')}.`);
  }
  if (!Array.isArray(state?.experiments)) throw new Error(`${file} is damaged (no "experiments" list). Fix or move it before applying or reverting.`);
  return state;
}

function saveState(configDir, state) {
  fs.mkdirSync(stateDir(configDir), { recursive: true });
  const file = stateFile(configDir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

// The experiment a plain `revert` undoes: the newest one not reverted yet.
export const revertTarget = (experiments) => [...experiments].reverse().find((e) => !e.revertedAt) || null;

export function findExperiment(configDir, id = null) {
  const { experiments } = loadState(configDir);
  return id ? experiments.find((e) => e.id === id) || null : experiments[experiments.length - 1] || null;
}

// What `plan` shows about past changes: the latest experiment, and what a revert would restore.
// A damaged state file is reported here as a warning instead of stopping the plan.
export function planHistory(configDir) {
  try {
    const { experiments } = loadState(configDir);
    const target = revertTarget(experiments);
    const undo = target && {
      id: target.id,
      appliedAt: target.appliedAt,
      changes: target.changes.map((c) => ({ fixId: c.fixId, path: c.path, restore: c.hadKey ? c.before : null, hadKey: c.hadKey })),
    };
    return { last: experiments[experiments.length - 1] || null, undo: undo || null, warning: null };
  } catch (e) {
    return { last: null, undo: null, warning: e.message };
  }
}

// The fixes that apply now, given the report and the current settings file.
export function currentPlan(configDir, report) {
  const { data } = readSettings(settingsPath(configDir));
  return applicableFixes(report, data);
}

export function applyFixes({ configDir, fixIds, report, now }) {
  if (!fixIds.length) throw new Error('Name at least one fix id to apply.');
  const state = loadState(configDir); // refuse early if the history is damaged
  const file = settingsPath(configDir);
  const { data, format } = readSettings(file);
  const available = new Map(applicableFixes(report, data).map((f) => [f.id, f]));
  const chosen = [...new Set(fixIds)].map((id) => {
    const fix = available.get(id);
    if (!fix) throw new Error(`"${id}" is not an applicable fix right now; run the plan again to see the current list.`);
    return fix;
  });
  const changes = chosen.map((fix) => {
    const before = getPath(data, fix.path);
    setPath(data, fix.path, fix.value);
    return { fixId: fix.id, path: fix.path, before: before === undefined ? null : before, hadKey: before !== undefined, after: fix.value };
  });
  const backup = writeSettings(file, data, { backupDir: path.join(stateDir(configDir), 'backups'), format });
  const at = new Date(now);
  const experiment = {
    id: `exp-${at.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`,
    appliedAt: at.toISOString(),
    settingsFile: file,
    backup,
    changes,
    baseline: metrics(report),
  };
  state.experiments.push(experiment);
  saveState(configDir, state);
  return experiment;
}

// Restore only the keys the experiment changed, and only where the value is still the one it set.
export function revertExperiment({ configDir, now, id = null }) {
  const state = loadState(configDir);
  const exp = id ? state.experiments.find((e) => e.id === id) : revertTarget(state.experiments);
  if (!exp) throw new Error(id ? `No experiment "${id}".` : 'There is no applied experiment to revert.');
  if (exp.revertedAt) throw new Error(`Experiment "${exp.id}" was already reverted.`);
  const file = settingsPath(configDir);
  const { data, format } = readSettings(file);
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
  const backup = restored.length ? writeSettings(file, data, { backupDir: path.join(stateDir(configDir), 'backups'), format }) : null;
  exp.revertedAt = new Date(now).toISOString();
  saveState(configDir, state);
  return { experiment: exp, restored, skipped, backup };
}
