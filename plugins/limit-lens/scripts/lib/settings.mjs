// Read and write Claude Code's user settings file safely: never touch a file that is not valid JSON,
// keep every key we do not change, back up the original before writing, and write atomically.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

// The config folder whose settings.json Claude Code reads for this user.
export function userConfigDir(configDir, env = process.env) {
  return configDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, data: {} };
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix it before applying fixes.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not valid JSON object; fix it before applying fixes.`);
  return { exists: true, data };
}

function checkKey(key) {
  if (FORBIDDEN.has(key)) throw new Error(`Setting key "${key}" is not allowed.`);
}

export function getPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function setPath(obj, keys, value) {
  keys.forEach(checkKey);
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!Object.prototype.hasOwnProperty.call(cur, k)) cur[k] = {};
    else if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) throw new Error(`Setting "${keys.join('.')}" cannot be written: "${k}" is not an object.`);
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

export function deletePath(obj, keys) {
  keys.forEach(checkKey);
  const parent = getPath(obj, keys.slice(0, -1));
  if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]];
}

// Write settings; returns the backup path of the previous file, or null when there was none.
export function writeSettings(file, data, { backupDir }) {
  let backup = null;
  if (fs.existsSync(file)) {
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(backupDir, `settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.limit-lens-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return backup;
}
