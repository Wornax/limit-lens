import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSettings, writeSettings, getPath, setPath } from '../plugins/limit-xray/scripts/lib/settings.mjs';
import { tempRoot } from './helpers.mjs';

test('setting a nested key keeps every other key and backs up the original first', () => {
  const { root } = tempRoot();
  const file = path.join(root, 'settings.json');
  const original = '{\n  "model": "opus",\n  "env": { "FOO": "1" },\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n';
  fs.writeFileSync(file, original);
  const { data } = readSettings(file);
  setPath(data, ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'], 'sonnet');
  setPath(data, ['modelSettings', 'claude-opus-5-5', 'effortLevel'], 'high');
  const backup = writeSettings(file, data, { backupDir: path.join(root, 'backups') });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.equal(after.env.FOO, '1');
  assert.equal(after.env.CLAUDE_CODE_SUBAGENT_MODEL, 'sonnet');
  assert.equal(after.modelSettings['claude-opus-5-5'].effortLevel, 'high');
  assert.deepEqual(after.permissions, { allow: ['Bash(ls)'] });
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
});

test('a missing settings file is created without a backup', () => {
  const { root } = tempRoot();
  const file = path.join(root, 'settings.json');
  const { exists, data } = readSettings(file);
  assert.equal(exists, false);
  setPath(data, ['fastMode'], false);
  assert.equal(writeSettings(file, data, { backupDir: path.join(root, 'backups') }), null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fastMode, false);
});

test('a settings file that is not valid JSON is refused and left untouched', () => {
  const { root } = tempRoot();
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, '{ "model": "opus", // comment\n}');
  assert.throws(() => readSettings(file), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model": "opus", // comment\n}');
});

test('setPath refuses to overwrite a non-object on the way and refuses prototype keys', () => {
  const data = { env: 'oops' };
  assert.throws(() => setPath(data, ['env', 'X'], '1'), /not an object/);
  assert.throws(() => setPath({}, ['__proto__', 'polluted'], true), /not allowed/);
  assert.equal({}.polluted, undefined);
});

test('getPath reads nested values and returns undefined when absent', () => {
  const data = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } };
  assert.equal(getPath(data, ['modelSettings', 'claude-opus-5-5', 'effortLevel']), 'xhigh');
  assert.equal(getPath(data, ['env', 'X']), undefined);
});
