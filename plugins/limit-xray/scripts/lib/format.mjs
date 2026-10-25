export const usd = (x) => {
  if (x >= 1000) return `$${Math.round(x).toLocaleString('en-US')}`;
  if (x >= 10) return `$${x.toFixed(0)}`;
  if (x >= 0.01 || x === 0) return `$${x.toFixed(2)}`;
  return '<$0.01';
};

export const pct = (part, whole) => {
  if (!whole) return '0%';
  const p = (100 * part) / whole;
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
};

export const tokens = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export const sumCost = (map) => Object.values(map || {}).reduce((s, b) => s + (b.cost || 0), 0);

// "a=$1 (10%), b=..." for the largest entries of a { key: { cost } } map.
export function topEntries(map, whole, n = 3, label = (k) => k) {
  return Object.entries(map || {})
    .filter(([, b]) => b.cost > 0 && (!whole || b.cost / whole >= 0.001))
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, n)
    .map(([k, b]) => `${label(k)} ${pct(b.cost, whole)}`)
    .join(', ');
}

const MODEL_NAMES = {
  'opus-5-5': 'Opus 5.5', 'opus-5': 'Opus 5', 'opus-4-8': 'Opus 4.8', 'opus-4-7': 'Opus 4.7', 'opus-4-6': 'Opus 4.6',
  'opus-4-5': 'Opus 4.5', 'opus-4-1': 'Opus 4.1', 'opus-4': 'Opus 4', 'opus-3': 'Opus 3',
  'sonnet-5-5': 'Sonnet 5.5', 'sonnet-5': 'Sonnet 5', 'sonnet-4-6': 'Sonnet 4.6', 'sonnet-4-5': 'Sonnet 4.5',
  'sonnet-4': 'Sonnet 4', 'sonnet-3-7': 'Sonnet 3.7', 'haiku-5-5': 'Haiku 5.5', 'haiku-4-5': 'Haiku 4.5',
  'haiku-3-5': 'Haiku 3.5', 'haiku-3': 'Haiku 3', 'fable-5-1': 'Fable 5.1', 'fable-5': 'Fable 5',
  'mythos-5-1': 'Mythos 5.1', 'mythos-5': 'Mythos 5',
};
// "sonnet-5-5~" (estimated price) reads as "Sonnet 5.5~".
export const modelName = (key) => {
  const estimated = key.endsWith('~');
  const base = estimated ? key.slice(0, -1) : key;
  return (MODEL_NAMES[base] || base) + (estimated ? '~' : '');
};
