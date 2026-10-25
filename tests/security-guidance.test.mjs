import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSecurityGuidanceLog } from '../plugins/limit-lens/scripts/lib/plugins/security-guidance.mjs';
import { analyze } from '../plugins/limit-lens/scripts/lib/analyze.mjs';
import { NOW, tempRoot } from './helpers.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

// The plugin writes local wall-clock time without a zone.
function stamp(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
const usageLine = (ms, review, cost) =>
  `[${stamp(ms)}] Review usage: review=${review} session=abc model=claude-opus-5-5 calls=1 in=1000 out=200 cache_read=0 cache_write=0 est_cost_usd=${cost}`;

function writeLogs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const hour = 3_600_000;
  fs.writeFileSync(path.join(dir, 'log.txt.1'), [
    usageLine(NOW - 10 * 86_400_000, 'stop', '9.0000'), // outside a 7-day window
    usageLine(NOW - 5 * hour, 'stop', '0.2000'),
    `[${stamp(NOW - 5 * hour)}] Processing: hook_event=Stop, tool=`,
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'log.txt'), [
    usageLine(NOW - 2 * hour, 'commit', '0.5000'),
    usageLine(NOW - 1 * hour, 'push', '0.1000~'),
    usageLine(NOW - 1 * hour, 'stop', '0.3000'),
  ].join('\n'));
}

test('review usage lines inside the window are summed by review kind', () => {
  const { root } = tempRoot();
  const dir = path.join(root, 'security');
  writeLogs(dir);
  const r = readSecurityGuidanceLog(dir, NOW - 7 * 86_400_000, NOW);
  assert.equal(r.reviews.stop.count, 2);
  close(r.reviews.stop.cost, 0.5);
  close(r.reviews.commit.cost, 0.5);
  close(r.reviews.push.cost, 0.1);
  close(r.outsideTranscriptsCost, 0.5); // only stop reviews call the API outside transcripts
});

test('a missing log folder yields nothing', () => {
  const r = readSecurityGuidanceLog(path.join(tempRoot().root, 'nope'), 0, NOW);
  assert.equal(r, null);
});

test('analyze reports plugin calls that never reach the transcripts', async () => {
  const { root, projects } = tempRoot();
  writeLogs(path.join(root, 'security'));
  const r = await analyze({ projectsDirs: [projects], now: NOW, days: 7, securityLogDir: path.join(root, 'security') });
  close(r.outside.cost, 0.5);
  close(r.plugins.securityGuidance.reviews.commit.cost, 0.5);
});
