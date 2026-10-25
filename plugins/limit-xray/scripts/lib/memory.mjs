// The model-routing rule limit-xray can add to the user's CLAUDE.md (<config dir>/CLAUDE.md, the
// instructions Claude Code loads in every session). It goes in as a marked block, so revert can find it
// and remove exactly what was added, and leaves alone a block the user has edited since.
import fs from 'node:fs';
import path from 'node:path';

export const ROUTING_START = '<!-- limit-xray:model-routing -->';
export const ROUTING_END = '<!-- /limit-xray:model-routing -->';
export const ROUTING_RULE = 'Before you start a subagent or a workflow agent, use the `limit-xray:model-routing` skill to choose its model and effort.';

export const memoryPath = (configDir) => path.join(configDir, 'CLAUDE.md');

// A file that is not UTF-8 (an ANSI or UTF-16 file, for example) would be damaged by a rewrite, so it is refused.
export function readMemory(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, text: '', eol: '\n' };
    throw e;
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${file} is not UTF-8 text; save it as UTF-8 before adding or removing the model-routing rule.`);
  return { exists: true, text, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

// Already routed: our block, or any mention of the skill the user wrote themselves.
export const hasRouting = (text) => text.includes(ROUTING_START) || text.includes('limit-xray:model-routing');

export const routingBlock = (eol) => [ROUTING_START, ROUTING_RULE, ROUTING_END].join(eol);

// Append the block after a blank line, in the file's own line endings. Returns the new text and the
// separator added before the block, which revert needs to remove exactly what was added.
export function addRouting(text, eol) {
  const sep = !text ? '' : text.endsWith(eol) ? eol : eol + eol;
  return { text: `${text}${sep}${routingBlock(eol)}${eol}`, sep };
}

// Remove what addRouting added; if the user moved the block or its blank line, remove the block alone.
// When text was written right after the block, a line ending keeps it off the line before.
// Null when the block is no longer there unchanged.
export function removeRouting(text, eol, sep = '') {
  const block = routingBlock(eol);
  for (const piece of [sep + block + eol, block + eol, block]) {
    const at = text.indexOf(piece);
    if (at === -1) continue;
    const head = text.slice(0, at);
    const tail = text.slice(at + piece.length);
    return head + (head && tail && !head.endsWith(eol) && !tail.startsWith(eol) ? eol : '') + tail;
  }
  return null;
}
