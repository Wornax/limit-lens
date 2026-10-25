// Read and write Claude Code's user settings file safely: never touch a file that is not valid JSON,
// keep every key we do not change and the file's own formatting (indentation, line endings, BOM),
// back up the original before writing, write atomically, follow a symlinked file to its target,
// and leave nothing behind when a write fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_FORMAT = { bom: false, eol: '\n', indent: 2 };

// The config folder whose settings.json Claude Code reads for this user.
export function userConfigDir(configDir, env = process.env) {
  return configDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, data: {}, format: DEFAULT_FORMAT };
    throw e;
  }
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${file} is not valid JSON; fix it before applying fixes.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object; fix it before applying fixes.`);
  const indentMatch = body.match(/^[ \t]+(?=")/m);
  const indent = indentMatch ? (indentMatch[0][0] === '\t' ? '\t' : indentMatch[0].length) : 2;
  return { exists: true, data, format: { bom, eol: body.includes('\r\n') ? '\r\n' : '\n', indent } };
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

const serialize = (data, f) => {
  const json = JSON.stringify(data, null, f.indent) + '\n';
  return (f.bom ? '﻿' : '') + (f.eol === '\r\n' ? json.replace(/\n/g, '\r\n') : json);
};

// Write settings; returns the backup path of the previous file, or null when there was none.
export function writeSettings(file, data, { backupDir, format = DEFAULT_FORMAT }) {
  return writeFileSafely(file, serialize(data, format), { backupDir, backupName: 'settings', backupExt: '.json' });
}

// Write any user file the same way: back up the previous file, write atomically, follow a symlinked file
// to its target, keep its mode, and leave nothing behind on failure. Returns the backup path, or null.
export function writeFileSafely(file, content, { backupDir, backupName, backupExt }) {
  // A symlinked file stays a symlink: write to its target.
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let backup = null;
  let mode = null;
  if (fs.existsSync(target)) {
    mode = fs.statSync(target).mode & 0o777;
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(backupDir, `${backupName}-${new Date().toISOString().replace(/[:.]/g, '-')}${backupExt}`);
    fs.copyFileSync(target, backup);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.limit-xray-${process.pid}.tmp`;
  try {
    if (mode !== null) fs.accessSync(target, fs.constants.W_OK);
    fs.writeFileSync(tmp, content, mode === null ? undefined : { mode });
    fs.renameSync(tmp, target);
  } catch (e) {
    for (const f of [tmp, backup]) {
      try {
        if (f) fs.unlinkSync(f);
      } catch {
        // already gone
      }
    }
    if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw new Error(`${file} is read-only or in use by another program; nothing was changed.`);
    throw e;
  }
  return backup;
}
