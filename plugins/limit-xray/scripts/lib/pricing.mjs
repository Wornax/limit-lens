// List prices in USD per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing
// Update PRICES_AS_OF whenever this table changes.
export const PRICES_AS_OF = '2026-10-25';

const M = 1_000_000;

// in: base input, w5m / w1h: cache writes, read: cache hits, out: output (thinking included).
const PRICES = {
  'fable-5-1': { in: 10, w5m: 12.5, w1h: 20, read: 0.25, out: 50 },
  'mythos-5-1': { in: 10, w5m: 12.5, w1h: 20, read: 0.25, out: 50 },
  'fable-5': { in: 10, w5m: 12.5, w1h: 20, read: 1, out: 50 },
  'mythos-5': { in: 10, w5m: 12.5, w1h: 20, read: 1, out: 50 },
  'opus-5-5': { in: 4, w5m: 5, w1h: 8, read: 0.2, out: 20 },
  'opus-5': { in: 5, w5m: 6.25, w1h: 10, read: 0.5, out: 25 },
  'opus-4-8': { in: 5, w5m: 6.25, w1h: 10, read: 0.5, out: 25 },
  'opus-4-7': { in: 5, w5m: 6.25, w1h: 10, read: 0.5, out: 25 },
  'opus-4-6': { in: 5, w5m: 6.25, w1h: 10, read: 0.5, out: 25 },
  'opus-4-5': { in: 5, w5m: 6.25, w1h: 10, read: 0.5, out: 25 },
  'opus-4-1': { in: 15, w5m: 18.75, w1h: 30, read: 1.5, out: 75 },
  'opus-4': { in: 15, w5m: 18.75, w1h: 30, read: 1.5, out: 75 },
  'opus-3': { in: 15, w5m: 18.75, w1h: 30, read: 1.5, out: 75 },
  'sonnet-5-5': { in: 2, w5m: 2.5, w1h: 4, read: 0.1, out: 10 },
  'sonnet-5': { in: 2, w5m: 2.5, w1h: 4, read: 0.2, out: 10 },
  'sonnet-4-6': { in: 3, w5m: 3.75, w1h: 6, read: 0.3, out: 15 },
  'sonnet-4-5': { in: 3, w5m: 3.75, w1h: 6, read: 0.3, out: 15 },
  'sonnet-4': { in: 3, w5m: 3.75, w1h: 6, read: 0.3, out: 15 },
  'sonnet-3-7': { in: 3, w5m: 3.75, w1h: 6, read: 0.3, out: 15 },
  'haiku-5-5': { in: 0.1, w5m: 0.125, w1h: 0.2, read: 0.01, out: 0.5 },
  'haiku-4-5': { in: 1, w5m: 1.25, w1h: 2, read: 0.1, out: 5 },
  'haiku-3-5': { in: 0.8, w5m: 1, w1h: 1.6, read: 0.08, out: 4 },
  'haiku-3': { in: 0.25, w5m: 0.3, w1h: 0.5, read: 0.03, out: 1.25 },
};

// Haiku 5.5 charges more when a request's prompt (input + cache reads + cache writes) is over 100K tokens.
const HAIKU_5_5_LONG = { in: 0.5, w5m: 0.625, w1h: 1, read: 0.05, out: 2.5 };
const HAIKU_5_5_THRESHOLD = 100_000;

// Fast mode is priced at 2x on these models; cache multipliers apply on top.
const FAST_MODE_MODELS = new Set(['opus-5-5', 'opus-5', 'opus-4-8']);
// US-only inference (inference_geo "us") costs 1.1x on Claude 4.6 and later.
const GEO_US_MODELS = new Set([
  'fable-5-1', 'mythos-5-1', 'fable-5', 'mythos-5', 'opus-5-5', 'opus-5', 'opus-4-8', 'opus-4-7',
  'opus-4-6', 'sonnet-5-5', 'sonnet-5', 'sonnet-4-6', 'haiku-5-5',
]);

const NEWEST_IN_FAMILY = { fable: 'fable-5-1', mythos: 'mythos-5-1', opus: 'opus-5-5', sonnet: 'sonnet-5-5', haiku: 'haiku-5-5' };
const FALLBACK = 'sonnet-5-5';

// Map a model id such as "claude-opus-4-1-20250805", "claude-3-5-haiku-20241022"
// or "us.anthropic.claude-opus-5-5-v1:0" to a key of PRICES. A version missing from the
// table takes the closest earlier version of its family and is flagged as estimated.
export function resolveModel(modelId) {
  const id = String(modelId || '')
    .slice(0, 200) // ids are short; a long one is junk and must not slow the scan
    .toLowerCase()
    .replace(/\[[^[\]]*\]/g, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '');
  let m = id.match(/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/);
  if (m) return lookup(m[1], +m[2], m[3] === undefined ? 0 : +m[3]);
  m = id.match(/claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/);
  if (m) return lookup(m[3], +m[1], m[2] === undefined ? 0 : +m[2]);
  // A bare alias such as "opus" (settings and plugin variables accept them) means the newest of its family.
  m = id.match(/^(opus|sonnet|haiku|fable|mythos)$/);
  if (m) return { key: NEWEST_IN_FAMILY[m[1]], known: true };
  return { key: FALLBACK, known: false };
}

const versionOf = (key) => {
  const [, major, minor = '0'] = key.split('-');
  return +major * 100 + +minor;
};

function lookup(family, major, minor) {
  const exact = minor ? `${family}-${major}-${minor}` : `${family}-${major}`;
  if (PRICES[exact]) return { key: exact, known: true };
  const wanted = major * 100 + minor;
  const earlier = Object.keys(PRICES)
    .filter((k) => k.startsWith(`${family}-`) && versionOf(k) <= wanted)
    .sort((a, b) => versionOf(b) - versionOf(a))[0];
  return { key: earlier || NEWEST_IN_FAMILY[family], known: false };
}

// Token counts come from files on disk: accept only finite, non-negative numbers below a sane ceiling.
const MAX_TOKENS = 1e9;
// The share of a request's cost saved by running it on Sonnet 5.5 instead of the model priced at `key`,
// taken from the token kind where Sonnet saves least, so it does not overstate (0.5 for Opus 5.5).
// Fast mode and US-only inference would save more and are not counted.
export function sonnetSaving(key) {
  const from = PRICES[String(key).replace(/~$/, '')];
  if (!from) return 0;
  const to = PRICES['sonnet-5-5'];
  return Math.max(0, 1 - Math.max(...Object.keys(to).map((k) => to[k] / from[k])));
}

export const num = (v) =>(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TOKENS ? v : 0);

// Split one API response's usage into list-price cost components (USD).
export function requestCost(modelId, usage = {}) {
  const { key, known } = resolveModel(modelId);
  const input = num(usage.input_tokens);
  const read = num(usage.cache_read_input_tokens);
  const w1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  // The TTL breakdown can be partial; whatever it does not attribute to 1h is priced as a 5-minute write.
  const created = num(usage.cache_creation_input_tokens) || w1h + num(usage.cache_creation?.ephemeral_5m_input_tokens);
  const w5m = Math.max(0, created - w1h);
  const output = num(usage.output_tokens);
  const thinking = Math.min(num(usage.output_tokens_details?.thinking_tokens), output);

  let p = PRICES[key];
  if (key === 'haiku-5-5' && input + read + created > HAIKU_5_5_THRESHOLD) p = HAIKU_5_5_LONG;
  let mult = 1;
  if (usage.speed === 'fast' && FAST_MODE_MODELS.has(key)) mult *= 2;
  if (usage.inference_geo === 'us' && GEO_US_MODELS.has(key)) mult *= 1.1;

  const c = {
    input: (input * p.in * mult) / M,
    cacheWrite5m: (w5m * p.w5m * mult) / M,
    cacheWrite1h: (w1h * p.w1h * mult) / M,
    cacheRead: (read * p.read * mult) / M,
    output: (output * p.out * mult) / M,
    thinking: (thinking * p.out * mult) / M,
    priceKey: key,
    estimated: !known,
  };
  c.total = c.input + c.cacheWrite5m + c.cacheWrite1h + c.cacheRead + c.output;
  return c;
}
