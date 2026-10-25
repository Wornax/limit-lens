// Fixes that can be applied as user settings, offered only when the report's evidence supports them
// and the setting is not already at that value. Keys are the documented ones listed in docs/plan.md
// (v0.2 decision 2); add a fix only with a docs link that confirms its key and value.
import { getPath } from './settings.mjs';
import { pct } from './format.mjs';
import { resolveModel } from './pricing.mjs';

const MIN_MODEL_SHARE = 0.05;

const DOCS = 'https://code.claude.com/docs/en';
const SG_README = 'the security-guidance plugin README (Configuration section)';
const isOpus = (k) => k.startsWith('opus');
const sumOpus = (m) => Object.entries(m || {}).filter(([k]) => isOpus(k)).reduce((s, [, b]) => s + b.cost, 0);

export function applicableFixes(r, settings) {
  const total = r.totals.cost;
  if (!total) return [];
  const share = (x) => x / total;
  const out = [];
  const offer = (fix) => {
    const current = getPath(settings, fix.path);
    if (current === fix.value) return;
    out.push({ ...fix, current });
  };

  // Agents on a smaller model.
  const agentsCost = r.agents.subagent.cost + r.agents.workflow.cost;
  const opusAgents = sumOpus(r.agents.subagent.byModel) + sumOpus(r.agents.workflow.byModel);
  if (share(agentsCost) >= 0.2 && opusAgents / agentsCost >= 0.3 && getPath(settings, ['env', 'CLAUDE_CODE_SUBAGENT_MODEL']) === undefined) {
    offer({
      id: 'subagent-model-sonnet',
      finding: 'agents',
      title: 'Run agents on Sonnet by default',
      why: `Agents were ${pct(agentsCost, total)} of spend, ${pct(opusAgents, agentsCost)} of it on Opus. Agents that do not choose a model themselves will run on Sonnet; agents with a model in their definition keep it.`,
      path: ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'],
      value: 'sonnet',
      docs: `${DOCS}/sub-agents#choose-a-model`,
    });
  }

  // Effort: only levels you saved per model can be changed here.
  const highEffort = (r.byEffort.xhigh?.cost || 0) + (r.byEffort.max?.cost || 0);
  if (share(highEffort) >= 0.3) {
    const saved = getPath(settings, ['modelSettings']) || {};
    for (const [modelId, conf] of Object.entries(saved)) {
      if (conf?.effortLevel !== 'xhigh') continue;
      const key = resolveModel(modelId).key;
      const modelSpend = (r.byModel[key]?.cost || 0) + (r.byModel[`${key}~`]?.cost || 0);
      if (share(modelSpend) < MIN_MODEL_SHARE) continue; // not worth a question
      offer({
        id: `effort-high-${modelId}`,
        finding: 'effort',
        title: `Save effort "high" for ${modelId}`,
        why: `${pct(highEffort, total)} of spend ran at xhigh or max effort, and ${modelId} is saved at xhigh. High still reasons deeply; use /effort xhigh or max for a hard problem when you need it.`,
        path: ['modelSettings', modelId, 'effortLevel'],
        value: 'high',
        docs: `${DOCS}/model-config#adjust-effort-level`,
      });
    }
  }

  // Compact long conversations earlier.
  const autoCompact = getPath(settings, ['autoCompactWindow']);
  if (share(r.components.cacheRead) >= 0.25 && r.context.requestsOver200k > 0 && !(typeof autoCompact === 'number' && autoCompact <= 300_000)) {
    offer({
      id: 'autocompact-300k',
      finding: 'reread',
      title: 'Compact conversations at 300K tokens',
      why: `Re-reading context is ${pct(r.components.cacheRead, total)} of spend and ${r.context.requestsOver200k.toLocaleString('en-US')} requests were over 200K tokens. Compacting earlier keeps long sessions smaller; each compaction costs one summary request. A level you saved with /autocompact for a model may take precedence.`,
      path: ['autoCompactWindow'],
      value: 300_000,
      docs: `${DOCS}/model-config#set-the-auto-compact-window`,
    });
  }

  // Messages from other sessions waking an idle conversation.
  const peer = r.turns.automated.byKind.peer?.cost || 0;
  if (share(peer) >= 0.01) {
    offer({
      id: 'cross-session-hold',
      finding: 'automation',
      title: 'Hold messages from other sessions while idle',
      why: `Messages from other sessions started turns that cost ${pct(peer, total)} of spend, each re-reading the whole conversation. With hold, they wait instead of starting a turn on their own.`,
      path: ['crossSessionInbound'],
      value: 'hold',
      docs: `${DOCS}/costs#why-usage-climbs-in-a-long-session`,
    });
  }

  // security-guidance reviews.
  const sgSessions = r.toolSessions['security-guidance review'];
  if (sgSessions || r.plugins.securityGuidance) {
    offer({
      id: 'security-review-sonnet',
      finding: 'plugins',
      title: 'security-guidance: per-turn diff review on Sonnet',
      why: 'The security-guidance plugin reviews on the newest Opus by default. Sonnet finds slightly less but costs half as much.',
      path: ['env', 'SECURITY_REVIEW_MODEL'],
      value: 'claude-sonnet-5-5',
      docs: SG_README,
    });
    offer({
      id: 'security-agentic-sonnet',
      finding: 'plugins',
      title: 'security-guidance: commit and push reviews on Sonnet',
      why: 'Its commit and push reviews run full agent sessions on Opus by default.',
      path: ['env', 'SG_AGENTIC_MODEL'],
      value: 'claude-sonnet-5-5',
      docs: SG_README,
    });
    if (r.outside.cost > 0) {
      offer({
        id: 'security-stop-review-off',
        finding: 'plugins',
        title: 'security-guidance: drop the review after every turn',
        why: 'Keeps the commit and push reviews, which see everything that lands; drops the review that runs every time Claude finishes a turn with changes.',
        path: ['env', 'ENABLE_STOP_REVIEW'],
        value: '0',
        docs: SG_README,
      });
    }
  }

  // Fast mode left on.
  if (r.fastMode.cost > 0 && getPath(settings, ['fastMode']) === true) {
    offer({
      id: 'fast-mode-off',
      finding: 'fast',
      title: 'Turn fast mode off by default',
      why: `Fast mode ran ${r.fastMode.requests.toLocaleString('en-US')} requests at twice the Opus price, paid from usage credits on a subscription. Turn it on with /fast when you need the speed.`,
      path: ['fastMode'],
      value: false,
      docs: `${DOCS}/fast-mode`,
    });
  }

  // Default model.
  const model = getPath(settings, ['model']);
  if (typeof model === 'string' && /opus/i.test(model) && share(sumOpus(r.byModel)) >= 0.6) {
    offer({
      id: 'default-model-sonnet',
      finding: 'models',
      title: 'Start new sessions on Sonnet',
      why: `Opus models were ${pct(sumOpus(r.byModel), total)} of spend. New sessions would start on Sonnet 5.5 (half the list price); switch with /model opus at the start of a session that needs it.`,
      path: ['model'],
      value: 'sonnet',
      docs: `${DOCS}/model-config`,
    });
  }
  return out;
}

// Habits only the user can adopt (slash commands are typed by the user).
export function habits(r) {
  const total = r.totals.cost;
  if (!total) return [];
  const out = [];
  const share = (x) => x / total;
  if (share(r.components.cacheRead) >= 0.25) out.push('Run `/clear` between unrelated tasks, and `/compact` at natural breaks.');
  const rb = r.cache.rebuilds;
  if (share(rb.afterIdle.cost) >= 0.02) out.push('Run `/compact` before stepping away from a large session; after a long break, start fresh with `/clear`.');
  if (share(rb.modelSwitch.cost) >= 0.01) out.push('Pick the model with `/model` at the start of a session, not in the middle.');
  if (share((r.byEffort.max?.cost || 0)) >= 0.1) out.push('`max` effort cannot be saved, so it comes from `/effort max`, `--effort max` or an environment variable: keep it for hard problems.');
  if (share(r.turns.automated.cost) >= 0.05) out.push('Run loops in a short, dedicated session, and check `/usage` (press `w`) for the heaviest ones.');
  return out;
}
