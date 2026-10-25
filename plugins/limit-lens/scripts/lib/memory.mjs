// The model-routing rule limit-lens can add to the user's CLAUDE.md (<config dir>/CLAUDE.md, the
// instructions Claude Code loads in every session). It goes in as a marked block, so revert can find it
// and remove exactly what was added, and leaves alone a block the user has edited since.
import fs from 'node:fs';
import path from 'node:path';

export const ROUTING_START = '<!-- limit-lens:model-routing -->';
export const ROUTING_END = '<!-- /limit-lens:model-routing -->';
export const ROUTING_RULE = 'Before you start a subagent or a workflow agent, use the `limit-lens:model-routing` skill to choose its model and effort.';

export const memoryPath = (configDir) => path.join(configDir, 'CLAUDE.md');

export function readMemory(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { exists: true, text, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, text: '', eol: '\n' };
    throw e;
  }
}

// Already routed: our block, or any mention of the skill the user wrote themselves.
export const hasRouting = (text) => text.includes(ROUTING_START) || text.includes('limit-lens:model-routing');

export const routingBlock = (eol) => [ROUTING_START, ROUTING_RULE, ROUTING_END].join(eol);

// Append the block after a blank line, in the file's own line endings. Returns the new text and the
// separator added before the block, which revert needs to remove exactly what was added.
export function addRouting(text, eol) {
  const sep = !text ? '' : text.endsWith(eol) ? eol : eol + eol;
  return { text: `${text}${sep}${routingBlock(eol)}${eol}`, sep };
}

// Remove what addRouting added; if the user moved the block or its blank line, remove the block alone.
// Null when the block is no longer there unchanged.
export function removeRouting(text, eol, sep = '') {
  const block = routingBlock(eol);
  for (const piece of [sep + block + eol, block + eol, block]) {
    const at = text.indexOf(piece);
    if (at !== -1) return text.slice(0, at) + text.slice(at + piece.length);
  }
  return null;
}
