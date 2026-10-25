import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestCost, PRICES_AS_OF } from '../plugins/limit-xray/scripts/lib/pricing.mjs';

const M = 1_000_000;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

// Expected values come from https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-25).

test('Opus 5.5 prices each token kind at list price', () => {
  const c = requestCost('claude-opus-5-5', {
    input_tokens: M,
    cache_read_input_tokens: M,
    cache_creation_input_tokens: 2 * M,
    cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
    output_tokens: M,
  });
  close(c.input, 4);
  close(c.cacheRead, 0.2);
  close(c.cacheWrite5m, 5);
  close(c.cacheWrite1h, 8);
  close(c.output, 20);
  close(c.total, 37.2);
  assert.equal(c.estimated, false);
});

test('thinking tokens are part of output and reported separately', () => {
  const c = requestCost('claude-sonnet-5-5', {
    output_tokens: M,
    output_tokens_details: { thinking_tokens: 600_000 },
  });
  close(c.output, 10);
  close(c.thinking, 6);
  close(c.total, 10);
});

test('cache writes without a TTL breakdown are priced as 5-minute writes', () => {
  const c = requestCost('claude-sonnet-5-5', { cache_creation_input_tokens: M });
  close(c.cacheWrite5m, 2.5);
  close(c.cacheWrite1h, 0);
});

test('model ids with dates and old naming resolve to their family', () => {
  close(requestCost('claude-opus-4-1-20250805', { output_tokens: M }).total, 75);
  close(requestCost('claude-sonnet-4-20250514', { output_tokens: M }).total, 15);
  close(requestCost('claude-haiku-4-5-20251001', { output_tokens: M }).total, 5);
  close(requestCost('claude-3-5-haiku-20241022', { output_tokens: M }).total, 4);
  close(requestCost('claude-opus-4-8', { output_tokens: M }).total, 25);
  close(requestCost('claude-fable-5-1', { output_tokens: M }).total, 50);
});

test('Haiku 5.5 pays the higher tier when the prompt is over 100K tokens', () => {
  close(requestCost('claude-haiku-5-5', { input_tokens: 50_000 }).total, 0.005);
  // 150K prompt: 50K uncached input + 100K cache read, all at the >100K tier.
  const c = requestCost('claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 100_000 });
  close(c.input, 0.025);
  close(c.cacheRead, 0.005);
});

test('fast mode doubles Opus 5.5 and US-only inference adds 10%', () => {
  close(requestCost('claude-opus-5-5', { output_tokens: M, speed: 'fast' }).total, 40);
  close(requestCost('claude-opus-5-5', { output_tokens: M, inference_geo: 'us' }).total, 22);
});

test('unknown models fall back to a default price and are flagged as estimated', () => {
  const c = requestCost('claude-nimbus-9', { output_tokens: M });
  assert.equal(c.estimated, true);
  assert.ok(c.total > 0);
});

test('the price table carries its date', () => {
  assert.match(PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
});
