// Fixes that can be applied as user settings, offered only when the report's evidence supports them
// and the setting is not already at that value. Keys are the documented ones listed in docs/plan.md
// (v0.2 decision 2); add a fix only with a docs link that confirms its key and value. One more fix,
// the model-routing rule, goes in the user's CLAUDE.md instead (target: 'memory', see memory.mjs).
//
// Each fix carries what the user needs to decide:
// - contributors: the biggest projects, agent types, sessions or reviews behind it;
// - savings: an estimated weekly saving (API-equivalent, list prices) and how it was estimated,
//   or weekly: null when it cannot be estimated in advance;
// - kind: 'cost-only' (your own sessions work the same) or 'changes-work', with its effect;
// - group: fixes in the same group are alternatives, asked as one question and never applied together;
// - what: what the thing is, in plain words, for someone who has never heard of it.
import { getPath } from './settings.mjs';
import { pct } from './format.mjs';
import { resolveModel, sonnetSaving } from './pricing.mjs';

const MIN_MODEL_SHARE = 0.05;
const TOP = 3;
const NOT_ESTIMABLE = 'cannot be estimated in advance; `/limit-xray:analyze compare` measures it after a few days.';

// An environment variable set in the settings file's env block or in the shell running the plan.
// With `flag`, values such as "0" and "false" count as unset.
function envSet(settings, name, flag = false) {
  const v = getPath(settings, ['env', name]) ?? process.env[name];
  if (v === undefined || v === null || v === '') return false;
  return !flag || !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

const DOCS = 'https://code.claude.com/docs/en';
const SG_README = 'the security-guidance plugin README (Configuration section)';
const isOpus = (k) => k.startsWith('opus');
// Built-in agents that CLAUDE_CODE_SUBAGENT_MODEL alone does not move (sub-agents#choose-a-model).
const UNMOVED_AGENTS = new Set(['Explore', 'Plan']);
const sumOpus = (m) => Object.entries(m || {}).filter(([k]) => isOpus(k)).reduce((s, [, b]) => s + b.cost, 0);
// What the Opus spend in a { model key: { cost } } map would cost less on Sonnet 5.5, at list prices.
const opusSaving = (m) => Object.entries(m || {}).filter(([k]) => isOpus(k)).reduce((s, [k, b]) => s + b.cost * sonnetSaving(k), 0);

// The largest entries of a { name: number } list, as contributors of one kind.
function top(kind, entries) {
  return entries
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([name, cost, detail]) => ({ kind, name, cost, ...(detail ? { detail } : {}) }));
}
const projectsBy = (r, field) => top('project', Object.entries(r.byProject || {}).map(([p, b]) => [p, b[field] || 0]));

export function applicableFixes(r, settings) {
  const total = r.totals.cost;
  if (!total) return [];
  const share = (x) => x / total;
  const weekly = (x) => (x * 7) / (r.window.days || 7);
  const out = [];
  const offer = (fix) => {
    const current = getPath(settings, fix.path);
    if (current === fix.value) return;
    out.push({ ...fix, current });
  };

  // Agents on a smaller model. The variable alone does not move the built-in Explore and Plan agents,
  // which keep the main conversation's model, so their Opus spend is left out.
  const agentsCost = r.agents.subagent.cost + r.agents.workflow.cost;
  const types = Object.create(null); // the same type can run as a subagent and in a workflow
  for (const l of [r.agents.subagent, r.agents.workflow]) for (const [t, b] of Object.entries(l.byType || {})) types[t] = (types[t] || 0) + (b.opusCost || 0);
  const opusAll = sumOpus(r.agents.subagent.byModel) + sumOpus(r.agents.workflow.byModel);
  const opusAgents = Math.max(0, opusAll - [...UNMOVED_AGENTS].reduce((s, t) => s + (types[t] || 0), 0));
  if (share(agentsCost) >= 0.2 && opusAgents / agentsCost >= 0.3 && !envSet(settings, 'CLAUDE_CODE_SUBAGENT_MODEL')) {
    offer({
      id: 'subagent-model-sonnet',
      finding: 'agents',
      title: 'Run agents on Sonnet by default',
      what: 'Subagents and workflow agents are helpers Claude starts for side tasks, such as searching the code, reviewing a change or running steps in parallel. Each runs on its own model; this setting is the default for agents that do not choose one.',
      why: `Agents were ${pct(agentsCost, total)} of spend, ${pct(opusAgents, agentsCost)} of it on Opus outside the built-in Explore and Plan agents. Agents that do not choose a model themselves will run on Sonnet; agents with a model in their definition, and Explore and Plan, keep theirs.`,
      kind: 'changes-work',
      effect: 'Agents without their own model run on Sonnet: cheaper and faster, a little weaker on the hardest reasoning.',
      contributors: [...projectsBy(r, 'opusAgentCost'), ...top('agent type', Object.entries(types).filter(([t]) => !UNMOVED_AGENTS.has(t)))],
      savings: { weekly: weekly(((opusSaving(r.agents.subagent.byModel) + opusSaving(r.agents.workflow.byModel)) * opusAgents) / opusAll), basis: 'what your agents\' Opus spend outside Explore and Plan would cost less on Sonnet 5.5 at list prices (half for Opus 5.5, more for older Opus); agents with a model in their definition keep it, so the real saving can be lower.' },
      path: ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'],
      value: 'sonnet',
      docs: `${DOCS}/sub-agents#choose-a-model`,
    });
  }

  // Effort: only levels you saved per model can be changed here; an environment override wins over them.
  const highEffort = (r.byEffort.xhigh?.cost || 0) + (r.byEffort.max?.cost || 0);
  const capped = ['low', 'medium', 'high'].includes(getPath(settings, ['maxEffortLevel'])); // the cap applies over a saved level
  if (share(highEffort) >= 0.3 && !envSet(settings, 'CLAUDE_CODE_EFFORT_LEVEL') && !capped) {
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
        what: 'Effort is how hard Claude thinks before answering and how many tool calls it makes: low, medium, high, xhigh or max. Higher effort costs more per task; the level saved for a model is its default in new sessions.',
        why: `${pct(highEffort, total)} of spend ran at xhigh or max effort, and ${modelId} is saved at xhigh. High still reasons deeply. For a hard problem, use /effort max (this session only) or pick xhigh with s in the /effort slider (this session only); a level typed after /effort is saved as your default.`,
        kind: 'changes-work',
        effect: `${modelId} thinks less deeply by default, with fewer tool calls; raise it for one session when a problem needs it.`,
        contributors: top('project', Object.entries(r.byProject || {}).map(([p, b]) => [p, (b.highEffortByModel?.[key] || 0) + (b.highEffortByModel?.[`${key}~`] || 0)])),
        savings: { weekly: null, basis: `Lower effort means less thinking and fewer tool calls, which ${NOT_ESTIMABLE}` },
        path: ['modelSettings', modelId, 'effortLevel'],
        value: 'high',
        docs: `${DOCS}/model-config#adjust-effort-level`,
      });
    }
  }

  // Compact long conversations earlier. The env variable and a per-model window both override the
  // top-level key, CLAUDE_CODE_DISABLE_1M_CONTEXT already caps the window at 200K, and automatic compaction
  // can be off: skip in each case.
  const autoCompact = getPath(settings, ['autoCompactWindow']);
  const perModelWindow = Object.values(getPath(settings, ['modelSettings']) || {}).some((c) => c?.autoCompactWindow !== undefined);
  const overridden = envSet(settings, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW') || perModelWindow || envSet(settings, 'CLAUDE_CODE_DISABLE_1M_CONTEXT', true)
    || getPath(settings, ['autoCompactEnabled']) === false || envSet(settings, 'DISABLE_AUTO_COMPACT', true) || envSet(settings, 'DISABLE_COMPACT', true);
  if (share(r.components.cacheRead) >= 0.25 && r.context.requestsOver300k > 0 && !overridden && !(typeof autoCompact === 'number' && autoCompact <= 300_000)) {
    offer({
      id: 'autocompact-300k',
      finding: 'reread',
      title: 'Compact conversations at 300K tokens',
      what: 'Every message re-sends the whole conversation, so a long session costs more with each turn. Auto-compaction replaces the conversation with a summary when it reaches a size limit, and the session continues from the summary.',
      why: `Re-reading context is ${pct(r.components.cacheRead, total)} of spend and ${r.context.requestsOver300k.toLocaleString('en-US')} requests went past 300K tokens. Compacting earlier keeps long sessions smaller; each compaction costs one summary request.`,
      kind: 'changes-work',
      effect: 'Long sessions are summarized once they reach 300K tokens, so details from early in a session can be lost.',
      contributors: (r.contextSessions || []).map((s) => ({ kind: 'session', name: `${s.project}/${String(s.sessionId).slice(0, 8)}`, cost: s.cost, detail: `${s.requestsOver300k.toLocaleString('en-US')} requests over 300K, ${Math.round(s.avgPromptTokens / 1000)}K average` })),
      savings: { weekly: null, basis: `Smaller contexts are cheaper to re-read, but summaries cost a request each and sessions differ, so it ${NOT_ESTIMABLE}` },
      path: ['autoCompactWindow'],
      value: 300_000,
      docs: `${DOCS}/model-config#set-the-auto-compact-window`,
    });
  }

  // Messages from other sessions starting turns.
  const peer = r.turns.automated.byKind.peer?.cost || 0;
  if (share(peer) >= 0.01 && !['hold', 'refuse'].includes(getPath(settings, ['crossSessionInbound']))) {
    offer({
      id: 'cross-session-hold',
      finding: 'automation',
      title: 'Hold messages from other sessions',
      what: 'Your Claude Code sessions can send each other messages, for example when a session you started elsewhere reports back. Each message starts a turn in the session that receives it, which re-reads its whole conversation.',
      why: `Messages from other sessions started turns that cost ${pct(peer, total)} of spend, each re-reading the whole conversation. With hold, Claude Code shows a notice for each message and does not deliver it to Claude (up to 100 are kept, released only if you switch back to accept). Choose it only if you do not rely on your sessions messaging each other.`,
      kind: 'changes-work',
      effect: 'Your sessions stop receiving each other\'s messages.',
      contributors: [],
      savings: { weekly: weekly(peer), basis: 'up to what turns started by other sessions cost; those messages would no longer arrive.' },
      path: ['crossSessionInbound'],
      value: 'hold',
      docs: `${DOCS}/cross-session-messaging#control-inbound-messages`,
    });
  }

  // security-guidance reviews, each fix on its own evidence. Its model variables take the provider's own
  // model id (Bedrock, Vertex and Foundry differ), so the model fixes are offered on the first-party API only.
  const sgReviews = r.plugins.securityGuidance?.reviews || {};
  const stopCost = r.outside.cost || 0;
  const stopReviews = (sgReviews.stop?.count || 0) > 0 || stopCost > 0;
  const sgSessions = r.toolSessions['security-guidance review'];
  const agenticReviews = Boolean(sgSessions) || (sgReviews.commit?.count || 0) + (sgReviews.push?.count || 0) > 0;
  const agenticCost = sgSessions?.cost || 0;
  const thirdParty = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS']
    .some((k) => envSet(settings, k, true));
  // The plugin's own switches, read the way its hooks read them (hooks/_base.py, llm.py).
  const sgEnv = (name) => String(getPath(settings, ['env', name]) ?? process.env[name] ?? '').trim();
  const sgOff = ['1', 'true', 'yes', 'on'].includes(sgEnv('SECURITY_GUIDANCE_DISABLE').toLowerCase()) || sgEnv('ENABLE_SECURITY_REMINDER') === '0'
    || sgEnv('ENABLE_CODE_SECURITY_REVIEW') === '0'
    || Object.entries(getPath(settings, ['enabledPlugins']) || {}).some(([k, v]) => k.startsWith('security-guidance@') && v === false);
  const agenticOff = sgEnv('ENABLE_COMMIT_REVIEW') === '0' || ['0', 'off'].includes(sgEnv('SG_AGENTIC_COMMIT_REVIEW').toLowerCase());
  // The model a review runs on: its variable in the settings env or the shell, else the plugin's default, the newest Opus.
  const sgModel = (name) => (envSet(settings, name) ? String(getPath(settings, ['env', name]) ?? process.env[name]) : 'claude-opus-5-5');
  const onOpus = (name) => /opus/i.test(sgModel(name));
  const sgSaving = (name) => sonnetSaving(resolveModel(sgModel(name)).key);
  // The plugin turns its per-turn review off only for the exact value "0".
  const stopOff = sgOff || String(getPath(settings, ['env', 'ENABLE_STOP_REVIEW']) ?? process.env.ENABLE_STOP_REVIEW) === '0';
  const logAgenticCost = (sgReviews.commit?.cost || 0) + (sgReviews.push?.cost || 0);
  const stopContributors = sgReviews.stop?.count ? [{ kind: 'review', name: 'per-turn reviews', cost: sgReviews.stop.cost, detail: `${sgReviews.stop.count} reviews` }] : [];
  if (stopReviews && !stopOff && !thirdParty && onOpus('SECURITY_REVIEW_MODEL')) {
    offer({
      id: 'security-review-sonnet',
      finding: 'plugins',
      group: 'security-turn-review',
      title: 'security-guidance: per-turn diff review on Sonnet',
      what: 'security-guidance is a plugin that reviews the code Claude changes for security problems: after every turn that changed files, and at each commit and push. Each review is a separate call to the model.',
      why: 'The security-guidance plugin reviews on the newest Opus by default. Sonnet finds slightly less but costs half as much.',
      kind: 'cost-only',
      effect: 'Your sessions work the same; the plugin\'s per-turn review may catch slightly fewer issues.',
      contributors: stopContributors,
      savings: { weekly: weekly(stopCost * sgSaving('SECURITY_REVIEW_MODEL')), basis: 'what the per-turn reviews in the plugin\'s log would cost less on Sonnet 5.5 (half, from the default Opus 5.5); the log only keeps recent history.' },
      path: ['env', 'SECURITY_REVIEW_MODEL'],
      value: 'claude-sonnet-5-5',
      docs: SG_README,
    });
  }
  if (agenticReviews && !sgOff && !agenticOff && !thirdParty && onOpus('SG_AGENTIC_MODEL')) {
    offer({
      id: 'security-agentic-sonnet',
      finding: 'plugins',
      title: 'security-guidance: commit and push reviews on Sonnet',
      what: 'security-guidance is a plugin that reviews the code Claude changes for security problems: after every turn that changed files, and at each commit and push. Each review is a separate call to the model.',
      why: 'Its commit and push reviews run full agent sessions on Opus by default.',
      kind: 'cost-only',
      effect: 'Your sessions work the same; commit and push reviews may catch slightly fewer issues.',
      contributors: sgSessions ? [{ kind: 'review', name: 'commit and push review sessions', cost: agenticCost, detail: `${sgSessions.sessions} sessions` }] : [],
      savings: agenticCost
        ? { weekly: weekly(agenticCost * sgSaving('SG_AGENTIC_MODEL')), basis: 'what the review sessions in your transcripts would cost less on Sonnet 5.5 (half, from the default Opus 5.5).' }
        : { weekly: weekly(logAgenticCost * sgSaving('SG_AGENTIC_MODEL')), basis: 'what the commit and push reviews in the plugin\'s log would cost less on Sonnet 5.5 (half, from the default Opus 5.5); the log only keeps recent history.' },
      path: ['env', 'SG_AGENTIC_MODEL'],
      value: 'claude-sonnet-5-5',
      docs: SG_README,
    });
  }
  if (stopReviews && !stopOff) {
    offer({
      id: 'security-stop-review-off',
      finding: 'plugins',
      group: 'security-turn-review',
      title: 'security-guidance: drop the review after every turn',
      what: 'security-guidance is a plugin that reviews the code Claude changes for security problems: after every turn that changed files, and at each commit and push. Each review is a separate call to the model.',
      why: 'Keeps the commit and push reviews, which see everything that lands; drops the review that runs every time Claude finishes a turn with changes.',
      kind: 'cost-only',
      effect: 'Your sessions work the same; issues are caught at commit or push instead of after each turn.',
      contributors: stopContributors,
      savings: { weekly: weekly(stopCost), basis: 'what the per-turn reviews cost in the plugin\'s log (the log only keeps recent history).' },
      path: ['env', 'ENABLE_STOP_REVIEW'],
      value: '0',
      docs: SG_README,
    });
  }

  // Fast mode left on.
  // With fastModePerSessionOptIn or CLAUDE_CODE_DISABLE_FAST_MODE, new sessions start without fast mode anyway.
  const fastCarries = getPath(settings, ['fastModePerSessionOptIn']) !== true && !envSet(settings, 'CLAUDE_CODE_DISABLE_FAST_MODE', true);
  if (r.fastMode.cost > 0 && getPath(settings, ['fastMode']) === true && fastCarries) {
    offer({
      id: 'fast-mode-off',
      finding: 'fast',
      title: 'Turn fast mode off by default',
      what: 'Fast mode makes Opus answer faster for twice the price. With `"fastMode": true` in your settings, new sessions start with it on.',
      why: `Fast mode ran ${r.fastMode.requests.toLocaleString('en-US')} requests at twice the Opus price, paid from usage credits on a subscription. Turn it on with /fast when you need the speed.`,
      kind: 'changes-work',
      effect: 'Responses are slower unless you turn fast mode on with /fast.',
      contributors: [],
      savings: { weekly: weekly(r.fastMode.cost / 2), basis: 'half of fast-mode spend (fast mode bills twice the standard price), paid from usage credits.' },
      path: ['fastMode'],
      value: false,
      docs: `${DOCS}/fast-mode`,
    });
  }

  // Default model. opusplan already uses Opus only for planning, so it is left alone; ANTHROPIC_MODEL outranks the setting.
  const model = getPath(settings, ['model']);
  if (typeof model === 'string' && /opus/i.test(model) && !/^opusplan/i.test(model) && !envSet(settings, 'ANTHROPIC_MODEL') && share(sumOpus(r.byModel)) >= 0.6) {
    const opusMain = Object.values(r.byProject || {}).reduce((s, b) => s + (b.opusMainCost || 0), 0);
    const saving = opusSaving(r.byModel) / sumOpus(r.byModel); // the main conversations' split by Opus version is not tracked
    offer({
      id: 'default-model-sonnet',
      finding: 'models',
      title: 'Start new sessions on Sonnet',
      what: 'The default model is the one every new session starts on; `/model` switches it for the session you are in. Sonnet costs half as much as Opus and handles most everyday coding.',
      why: `Opus models were ${pct(sumOpus(r.byModel), total)} of spend. New sessions would start on Sonnet, which costs less than Opus (on the Anthropic API, Sonnet 5.5 lists at half the price of Opus 5.5); switch with /model opus at the start of a session that needs it.`,
      kind: 'changes-work',
      effect: 'New sessions start on Sonnet; you choose Opus with /model when a task needs it.',
      contributors: projectsBy(r, 'opusMainCost'),
      savings: { weekly: weekly(opusMain * saving), basis: 'what your main conversations\' Opus spend would cost less on Sonnet 5.5 at list prices (half for Opus 5.5, more for older Opus); sessions you switch back to Opus keep its price.' },
      path: ['model'],
      value: 'sonnet',
      docs: `${DOCS}/model-config`,
    });
  }
  return out;
}

// The model-routing rule: asked first, whenever agents spend, unless CLAUDE.md already routes
// (the caller checks that). The skill ships with this plugin; the rule makes Claude load it every time.
export function routingFix(r, { file, rule }) {
  const total = r.totals.cost;
  const agentsCost = r.agents.subagent.cost + r.agents.workflow.cost;
  if (!total || agentsCost / total < 0.01) return null;
  const opusAgents = sumOpus(r.agents.subagent.byModel) + sumOpus(r.agents.workflow.byModel);
  const types = Object.create(null);
  for (const l of [r.agents.subagent, r.agents.workflow]) for (const [t, b] of Object.entries(l.byType || {})) types[t] = (types[t] || 0) + (b.opusCost || 0);
  return {
    id: 'model-routing-rule',
    finding: 'agents',
    target: 'memory',
    title: 'Turn on model routing for agents',
    what: 'Model routing means choosing, for each task Claude hands to a subagent or workflow agent, the smallest model that gets it right the first time: Haiku for fixed recipes with a check (run a known command, rename), Sonnet for most coding, reviews and fixes, Opus for design, decisions and anything risky (money, user data, security, deploys), plus the effort for each. This plugin ships those rules as a guide, the `model-routing` skill; the line added to CLAUDE.md makes Claude follow it every time it starts an agent and say which model it picked.',
    why: `Agents were ${pct(agentsCost, total)} of spend, ${pct(opusAgents, agentsCost)} of it on Opus. Without the line, Claude reads the guide only when it decides to, and each agent runs on its default model, usually your session's.`,
    kind: 'changes-work',
    effect: 'Claude chooses a model and effort for each agent it starts and says which one; routine agent work moves off Opus, hard or risky work stays on it.',
    contributors: top('agent type', Object.entries(types)),
    savings: { weekly: null, basis: `It depends on which tasks move to a smaller model, so it ${NOT_ESTIMABLE}` },
    file,
    rule,
    docs: `${DOCS}/memory`,
    current: null,
  };
}

// Habits only the user can adopt (slash commands are typed by the user). Each names the finding whose
// suggestions already give the same advice, so a report that shows that finding need not repeat it.
export function habitsWithFindings(r) {
  const total = r.totals.cost;
  if (!total) return [];
  const out = [];
  const share = (x) => x / total;
  if (share(r.components.cacheRead) >= 0.25) out.push({ finding: 'reread', text: 'Run `/clear` between unrelated tasks, and `/compact` at natural breaks.' });
  const rb = r.cache.rebuilds;
  if (share(rb.afterIdle.cost) >= 0.02) out.push({ finding: 'rebuilds', text: 'Run `/compact` before stepping away from a large session; after a long break, start fresh with `/clear`.' });
  if (share(rb.modelSwitch.cost) >= 0.01) out.push({ finding: 'rebuilds', text: 'Pick the model with `/model` at the start of a session, not in the middle.' });
  if (share((r.byEffort.max?.cost || 0)) >= 0.1) out.push({ finding: 'effort', text: '`max` effort cannot be saved, so it comes from `/effort max`, `--effort max` or an environment variable: keep it for hard problems.' });
  if (share(r.turns.automated.cost) >= 0.05) out.push({ finding: 'automation', text: 'Run loops in a short, dedicated session, and check `/usage` (press `w`) for the heaviest ones.' });
  return out;
}

export const habits = (r) => habitsWithFindings(r).map((h) => h.text);
