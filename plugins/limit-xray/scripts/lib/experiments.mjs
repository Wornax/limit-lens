// Apply chosen fixes to the user settings file (and the model-routing rule to the user's CLAUDE.md) and
// keep a record of each change, so it can be measured (compare) and undone (revert).
// State: <config dir>/limit-xray/experiments.json.
// A damaged state file is never overwritten: apply and revert refuse to run until it is fixed.
import fs from 'node:fs';
import path from 'node:path';
import { applicableFixes, routingFix } from './fixes.mjs';
import { metrics } from './compare.mjs';
import { readSettings, writeSettings, writeFileSafely, getPath, setPath, deletePath } from './settings.mjs';
import { memoryPath, readMemory, hasRouting, addRouting, removeRouting, ROUTING_RULE } from './memory.mjs';
import { locale } from './i18n/index.mjs';

export const stateDir = (configDir) => path.join(configDir, 'limit-xray');
const stateFile = (configDir) => path.join(stateDir(configDir), 'experiments.json');
const backupDir = (configDir) => path.join(stateDir(configDir), 'backups');
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

// What `plan` shows about past changes: every experiment still in effect (newest first), the latest one,
// and what a revert would restore.
// A damaged state file is reported here as a warning instead of stopping the plan.
export function planHistory(configDir) {
  try {
    const { experiments } = loadState(configDir);
    const target = revertTarget(experiments);
    const undo = target && {
      id: target.id,
      appliedAt: target.appliedAt,
      changes: target.changes.map((c) => (c.kind === 'memory'
        ? { fixId: c.fixId, kind: 'memory', file: c.file }
        : { fixId: c.fixId, path: c.path, restore: c.hadKey ? c.before : null, hadKey: c.hadKey })),
    };
    const active = [...experiments].reverse().filter((e) => !e.revertedAt).map((e) => ({
      id: e.id,
      appliedAt: e.appliedAt,
      changes: e.changes.map((c) => (c.kind === 'memory' ? { fixId: c.fixId, kind: 'memory', file: c.file } : { fixId: c.fixId, path: c.path, after: c.after })),
    }));
    return { last: experiments[experiments.length - 1] || null, undo: undo || null, active, warning: null };
  } catch (e) {
    return { last: null, undo: null, active: [], warning: e.message };
  }
}

// The fixes that apply now, given the report, the current settings file and CLAUDE.md: the routing rule
// first, unless CLAUDE.md already routes or cannot be read.
export function currentPlan(configDir, report, { lang = 'en' } = {}) {
  const { data } = readSettings(settingsPath(configDir));
  return [routingOffer(configDir, report, lang), ...applicableFixes(report, data, { lang })].filter(Boolean);
}

function routingOffer(configDir, report, lang) {
  const file = memoryPath(configDir);
  let memory;
  try {
    memory = readMemory(file);
  } catch {
    return null;
  }
  return hasRouting(memory.text) ? null : routingFix(report, { file, rule: ROUTING_RULE, lang });
}

export function applyFixes({ configDir, fixIds, report, now }) {
  if (!fixIds.length) throw new Error('Name at least one fix id to apply.');
  const state = loadState(configDir); // refuse early if the history is damaged
  const file = settingsPath(configDir);
  const { data, format } = readSettings(file);
  const available = new Map(currentPlan(configDir, report).map((f) => [f.id, f]));
  const chosen = [...new Set(fixIds)].map((id) => {
    const fix = available.get(id);
    if (!fix) throw new Error(`"${id}" is not an applicable fix right now; run the plan again to see the current list.`);
    return fix;
  });
  const byGroup = new Map();
  for (const fix of chosen) {
    if (!fix.group) continue;
    if (byGroup.has(fix.group)) throw new Error(`"${byGroup.get(fix.group)}" and "${fix.id}" are alternatives; choose one.`);
    byGroup.set(fix.group, fix.id);
  }
  const settingsFixes = chosen.filter((fix) => fix.target !== 'memory');
  const memoryFix = chosen.find((fix) => fix.target === 'memory');
  const changes = settingsFixes.map((fix) => {
    const before = getPath(data, fix.path);
    setPath(data, fix.path, fix.value);
    return { fixId: fix.id, path: fix.path, before: before === undefined ? null : before, hadKey: before !== undefined, after: fix.value };
  });
  // CLAUDE.md first; if the settings write then fails, CLAUDE.md is put back as it was.
  let memoryBackup = null;
  let memory = null;
  if (memoryFix) {
    memory = readMemory(memoryFix.file);
    const { text, sep } = addRouting(memory.text, memory.eol);
    memoryBackup = writeFileSafely(memoryFix.file, text, { backupDir: backupDir(configDir), backupName: 'CLAUDE', backupExt: '.md' });
    changes.unshift({ fixId: memoryFix.id, kind: 'memory', file: memoryFix.file, eol: memory.eol, sep, hadFile: memory.exists });
  }
  let backup = null;
  if (settingsFixes.length) {
    try {
      backup = writeSettings(file, data, { backupDir: backupDir(configDir), format });
    } catch (e) {
      if (memory) {
        if (memory.exists) writeFileSafely(memoryFix.file, memory.text, { backupDir: backupDir(configDir), backupName: 'CLAUDE', backupExt: '.md' });
        else fs.unlinkSync(memoryFix.file);
      }
      throw e;
    }
  }
  const at = new Date(now);
  const experiment = {
    id: `exp-${at.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`,
    appliedAt: at.toISOString(),
    settingsFile: file,
    backup,
    memoryBackup,
    changes,
    baseline: metrics(report),
  };
  state.experiments.push(experiment);
  saveState(configDir, state);
  return experiment;
}

// Restore only the keys the experiment changed, and only where the value is still the one it set.
export function revertExperiment({ configDir, now, id = null, lang = 'en' }) {
  const state = loadState(configDir);
  const exp = id ? state.experiments.find((e) => e.id === id) : revertTarget(state.experiments);
  if (!exp) throw new Error(id ? `No experiment "${id}".` : 'There is no applied experiment to revert.');
  if (exp.revertedAt) throw new Error(`Experiment "${exp.id}" was already reverted.`);
  const file = settingsPath(configDir);
  // An experiment that only added the routing rule never touched settings, so it does not need them.
  const { data, format } = exp.changes.some((c) => c.kind !== 'memory') ? readSettings(file) : { data: {}, format: undefined };
  const restored = [];
  const skipped = [];
  const notes = [];
  let memoryUndo = null; // written after settings, so a failed settings write leaves both files as they were
  for (const c of exp.changes) {
    if (c.kind === 'memory') {
      const text = removeRouting(readMemory(c.file).text, c.eol, c.sep);
      if (text === null) {
        skipped.push(c);
        continue;
      }
      if (hasRouting(text)) notes.push(locale(lang).t.cli.routingLeft({ file: c.file }));
      memoryUndo = { c, text };
      restored.push(c);
      continue;
    }
    const current = getPath(data, c.path);
    if (current !== c.after) {
      skipped.push(c);
      continue;
    }
    if (c.hadKey) setPath(data, c.path, c.before);
    else deletePath(data, c.path);
    restored.push(c);
  }
  const backup = restored.some((c) => c.kind !== 'memory') ? writeSettings(file, data, { backupDir: backupDir(configDir), format }) : null;
  let memoryBackup = null;
  if (memoryUndo) {
    const { c, text } = memoryUndo;
    try {
      // A CLAUDE.md that apply created and nobody wrote in since goes away again.
      if (c.hadFile === false && text === '') fs.unlinkSync(c.file);
      else memoryBackup = writeFileSafely(c.file, text, { backupDir: backupDir(configDir), backupName: 'CLAUDE', backupExt: '.md' });
    } catch (e) {
      if (backup) writeFileSafely(file, fs.readFileSync(backup), { backupDir: backupDir(configDir), backupName: 'settings', backupExt: '.json' });
      throw e;
    }
  }
  exp.revertedAt = new Date(now).toISOString();
  saveState(configDir, state);
  return { experiment: exp, restored, skipped, backup, memoryBackup, notes };
}
