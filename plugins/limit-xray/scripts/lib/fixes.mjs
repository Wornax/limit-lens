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
import { locale } from './i18n/index.mjs';
import { resolveModel, sonnetSaving } from './pricing.mjs';

const MIN_MODEL_SHARE = 0.05;
const TOP = 3;

// An environment variable set in the settings file's env block or in the shell running the plan.
// With `flag`, values such as "0" and "false" count as unset.
function envSet(settings, name, flag = false) {
  const v = getPath(settings, ['env', name]) ?? process.env[name];
  if (v === undefined || v === null || v === '') return false;
  return !flag || !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

const DOCS = 'https://code.claude.com/docs/en';
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

export function applicableFixes(r, settings, { lang = 'en' } = {}) {
  const total = r.totals.cost;
  if (!total) return [];
  const loc = locale(lang);
  const { pct, num } = loc;
  const T = loc.t.fixes;
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
      title: T.subagentSonnet.title,
      what: T.subagentSonnet.what,
      why: T.subagentSonnet.why({ agents: pct(agentsCost, total), opus: pct(opusAgents, agentsCost) }),
      kind: 'changes-work',
      effect: T.subagentSonnet.effect,
      contributors: [...projectsBy(r, 'opusAgentCost'), ...top('agent type', Object.entries(types).filter(([t]) => !UNMOVED_AGENTS.has(t)))],
      savings: { weekly: weekly(((opusSaving(r.agents.subagent.byModel) + opusSaving(r.agents.workflow.byModel)) * opusAgents) / opusAll), basis: T.subagentSonnet.basis },
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
        title: T.effortHigh.title({ model: modelId }),
        what: T.effortHigh.what,
        why: T.effortHigh.why({ share: pct(highEffort, total), model: modelId }),
        kind: 'changes-work',
        effect: T.effortHigh.effect({ model: modelId }),
        contributors: top('project', Object.entries(r.byProject || {}).map(([p, b]) => [p, (b.highEffortByModel?.[key] || 0) + (b.highEffortByModel?.[`${key}~`] || 0)])),
        savings: { weekly: null, basis: T.effortHigh.basis },
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
      title: T.autocompact.title,
      what: T.autocompact.what,
      why: T.autocompact.why({ share: pct(r.components.cacheRead, total), count: num(r.context.requestsOver300k) }),
      kind: 'changes-work',
      effect: T.autocompact.effect,
      contributors: (r.contextSessions || []).map((s) => ({ kind: 'session', name: `${s.project}/${String(s.sessionId).slice(0, 8)}`, cost: s.cost, detail: T.autocompact.detail({ count: num(s.requestsOver300k), avg: Math.round(s.avgPromptTokens / 1000) }) })),
      savings: { weekly: null, basis: T.autocompact.basis },
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
      title: T.crossSession.title,
      what: T.crossSession.what,
      why: T.crossSession.why({ share: pct(peer, total) }),
      kind: 'changes-work',
      effect: T.crossSession.effect,
      contributors: [],
      savings: { weekly: weekly(peer), basis: T.crossSession.basis },
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
  const stopContributors = sgReviews.stop?.count ? [{ kind: 'review', name: T.securityReview.contributor, cost: sgReviews.stop.cost, detail: T.securityReview.detail({ count: num(sgReviews.stop.count) }) }] : [];
  if (stopReviews && !stopOff && !thirdParty && onOpus('SECURITY_REVIEW_MODEL')) {
    offer({
      id: 'security-review-sonnet',
      finding: 'plugins',
      group: 'security-turn-review',
      title: T.securityReview.title,
      what: T.securityReview.what,
      why: T.securityReview.why,
      kind: 'cost-only',
      effect: T.securityReview.effect,
      contributors: stopContributors,
      savings: { weekly: weekly(stopCost * sgSaving('SECURITY_REVIEW_MODEL')), basis: T.securityReview.basis },
      path: ['env', 'SECURITY_REVIEW_MODEL'],
      value: 'claude-sonnet-5-5',
      docs: T.sgDocs,
    });
  }
  if (agenticReviews && !sgOff && !agenticOff && !thirdParty && onOpus('SG_AGENTIC_MODEL')) {
    offer({
      id: 'security-agentic-sonnet',
      finding: 'plugins',
      title: T.securityAgentic.title,
      what: T.securityAgentic.what,
      why: T.securityAgentic.why,
      kind: 'cost-only',
      effect: T.securityAgentic.effect,
      contributors: sgSessions ? [{ kind: 'review', name: T.securityAgentic.contributor, cost: agenticCost, detail: T.securityAgentic.detail({ count: num(sgSessions.sessions) }) }] : [],
      savings: agenticCost
        ? { weekly: weekly(agenticCost * sgSaving('SG_AGENTIC_MODEL')), basis: T.securityAgentic.basisSessions }
        : { weekly: weekly(logAgenticCost * sgSaving('SG_AGENTIC_MODEL')), basis: T.securityAgentic.basisLog },
      path: ['env', 'SG_AGENTIC_MODEL'],
      value: 'claude-sonnet-5-5',
      docs: T.sgDocs,
    });
  }
  if (stopReviews && !stopOff) {
    offer({
      id: 'security-stop-review-off',
      finding: 'plugins',
      group: 'security-turn-review',
      title: T.securityStop.title,
      what: T.securityStop.what,
      why: T.securityStop.why,
      kind: 'cost-only',
      effect: T.securityStop.effect,
      contributors: stopContributors,
      savings: { weekly: weekly(stopCost), basis: T.securityStop.basis },
      path: ['env', 'ENABLE_STOP_REVIEW'],
      value: '0',
      docs: T.sgDocs,
    });
  }

  // Fast mode left on.
  // With fastModePerSessionOptIn or CLAUDE_CODE_DISABLE_FAST_MODE, new sessions start without fast mode anyway.
  const fastCarries = getPath(settings, ['fastModePerSessionOptIn']) !== true && !envSet(settings, 'CLAUDE_CODE_DISABLE_FAST_MODE', true);
  if (r.fastMode.cost > 0 && getPath(settings, ['fastMode']) === true && fastCarries) {
    offer({
      id: 'fast-mode-off',
      finding: 'fast',
      title: T.fastOff.title,
      what: T.fastOff.what,
      why: T.fastOff.why({ requests: num(r.fastMode.requests) }),
      kind: 'changes-work',
      effect: T.fastOff.effect,
      contributors: [],
      savings: { weekly: weekly(r.fastMode.cost / 2), basis: T.fastOff.basis },
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
      title: T.defaultSonnet.title,
      what: T.defaultSonnet.what,
      why: T.defaultSonnet.why({ share: pct(sumOpus(r.byModel), total) }),
      kind: 'changes-work',
      effect: T.defaultSonnet.effect,
      contributors: projectsBy(r, 'opusMainCost'),
      savings: { weekly: weekly(opusMain * saving), basis: T.defaultSonnet.basis },
      path: ['model'],
      value: 'sonnet',
      docs: `${DOCS}/model-config`,
    });
  }
  return out;
}

// The model-routing rule: asked first, whenever agents spend, unless CLAUDE.md already routes
// (the caller checks that). The skill ships with this plugin; the rule makes Claude load it every time.
export function routingFix(r, { file, rule, lang = 'en' }) {
  const total = r.totals.cost;
  const loc = locale(lang);
  const { pct } = loc;
  const T = loc.t.fixes.routing;
  const agentsCost = r.agents.subagent.cost + r.agents.workflow.cost;
  if (!total || agentsCost / total < 0.01) return null;
  const opusAgents = sumOpus(r.agents.subagent.byModel) + sumOpus(r.agents.workflow.byModel);
  const types = Object.create(null);
  for (const l of [r.agents.subagent, r.agents.workflow]) for (const [t, b] of Object.entries(l.byType || {})) types[t] = (types[t] || 0) + (b.opusCost || 0);
  return {
    id: 'model-routing-rule',
    finding: 'agents',
    target: 'memory',
    title: T.title,
    what: T.what,
    why: T.why({ agents: pct(agentsCost, total), opus: pct(opusAgents, agentsCost) }),
    kind: 'changes-work',
    effect: T.effect,
    contributors: top('agent type', Object.entries(types)),
    savings: { weekly: null, basis: T.basis },
    file,
    rule,
    docs: `${DOCS}/memory`,
    current: null,
  };
}

// Habits only the user can adopt (slash commands are typed by the user). Each names the finding whose
// suggestions already give the same advice, so a report that shows that finding need not repeat it.
export function habitsWithFindings(r, { lang = 'en' } = {}) {
  const total = r.totals.cost;
  if (!total) return [];
  const H = locale(lang).t.habits;
  const out = [];
  const share = (x) => x / total;
  if (share(r.components.cacheRead) >= 0.25) out.push({ finding: 'reread', text: H.clear });
  const rb = r.cache.rebuilds;
  if (share(rb.afterIdle.cost) >= 0.02) out.push({ finding: 'rebuilds', text: H.compactBeforeBreak });
  if (share(rb.modelSwitch.cost) >= 0.01) out.push({ finding: 'rebuilds', text: H.modelAtStart });
  if (share((r.byEffort.max?.cost || 0)) >= 0.1) out.push({ finding: 'effort', text: H.maxEffort });
  if (share(r.turns.automated.cost) >= 0.05) out.push({ finding: 'automation', text: H.loops });
  return out;
}

export const habits = (r, opts) => habitsWithFindings(r, opts).map((h) => h.text);
