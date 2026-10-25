// Bar charts drawn with text, for the terminal: Unicode block characters in eighths, so a bar's length
// reads at a glance and its exact value sits beside it.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

// A bar `fraction` (0 to 1) of `width` characters long. Anything above zero shows as at least a sliver.
export function bar(fraction, width) {
  if (!(fraction > 0)) return '';
  const units = Math.round(Math.min(1, fraction) * width * 8);
  const text = '█'.repeat(Math.floor(units / 8)) + EIGHTHS[units % 8];
  return text || '▏';
}

// Rows of { label, fraction, value }: labels padded to one column, bars to one width, values after them.
// `pad` sets the label column, so several blocks can share it.
export function barBlock(rows, { width = 24, labelWidth = 28, pad = 0 } = {}) {
  const fit = (s) => (s.length > labelWidth ? `${s.slice(0, labelWidth - 1)}…` : s);
  const labels = rows.map((r) => fit(String(r.label)));
  pad = Math.max(pad, ...labels.map((l) => l.length));
  const valuePad = Math.max(...rows.map((r) => String(r.value).length));
  return rows.map((r, i) => `${labels[i].padEnd(pad)}  ${bar(r.fraction, width).padEnd(width)}  ${String(r.value).padStart(valuePad)}`);
}
