'use strict';

/**
 * dsh-agy-swarm — Host Cordis Plugin for DeepSeek Harness
 *
 * Implements a native `/swarm` multi-agent collaboration cluster:
 * - Four model tools: `swarm`, `post_message`, `read_board`, `swarm_wait`
 * - `/swarm` slash command (`ctx.commands`) + `swarm` / `swarm-monitor` skills (`ctx.skills`)
 * - Guardrail 1: Workers created with `meta: { origin: "subagent", parentSession: coordinatorId }`
 *   + `subagent/descriptor` (v3 continuable) & `subagent/catalog` (v3 named) so the native
 *   Subagent panel lists workers under their real swarm names
 * - Guardrail 2: `swarm_wait` declared exclusive (`isConcurrencySafe: () => false`) + `exec.concludeTurn()`
 *   with race-free `since` unread gate and cold `ctx.agents.resume` wakeup
 * - Guardrail 3: Typert `"dsh-swarm"` service (`getSwarmSnapshot`, `watchSwarm` stream,
 *   `getSwarmModels` for the model-dispatch permission panel) fed by board state +
 *   Host `agent/status`, `session/event`, and `agent/request-error` events
 * - Guardrail 4: model dispatch permission gate (`allowedModels` / `blockedModels`) is
 *   enforced on every entry (explicit model, inherited coordinator route, hot switch)
 */

const path = require('node:path');
const crypto = require('node:crypto');

const {
  PLUGIN_ID,
  SWARM_SERVICE_NAME,
  SWARM_TYPERT_PACKAGE,
  SWARM_METHODS,
  SWARM_REMOTE,
  WORKSPACE_MODES,
  buildSwarmResourceUri,
  parseSwarmRequest,
  parseSwarmModelsRequest,
  parseSwarmModelsResult,
} = require('./src/protocol.js');

const {
  expandAddSpecs,
  isMonitorRoleOrName,
  SwarmStoreManager,
} = require('./src/board-store.js');

const {
  COORDINATOR_SKILL_CONTENT,
  MONITOR_SKILL_CONTENT,
  buildWorkerSystemPrompt,
  buildCoordinatorSkillInjection,
} = require('./src/prompts.js');

const runtime = require('./runtime.js');
const { redactSensitiveText } = require('./src/redaction.js');
/** Maximum Swarm delegation depth (host root = 0, first child = 1). */
const MAX_SWARM_DELEGATION_DEPTH = 4;
/** Hard bounds for scheduled monitor delays (setTimeout/setInterval range). */
const MIN_TIMER_DELAY_MS = 1000;
const MAX_TIMER_DELAY_MS = 2147483647;

function shortSha256(value, length = 8) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, length);
}

function clampTimerDelay(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return MIN_TIMER_DELAY_MS;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_TIMER_DELAY_MS, Math.round(value)));
}

/**
 * Normalize the `workspace` argument of `swarm{action:"add"}`.
 *
 * Only the two host-native modes remain: `inherit` (share the caller's cwd) and
 * `share` (`ctx.worktrees.create`). The old `branch` git-clone mode is gone and
 * says so instead of silently degrading to something the caller never asked for.
 */
function normalizeWorkspaceMode(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value || value === 'inherit') return 'inherit';
  if (value === 'branch') {
    throw new Error(
      "已移除 branch (git clone) 工作区模式，请改用 workspace: 'share' (原生 git worktree) 或 'inherit'"
    );
  }
  if (!WORKSPACE_MODES.includes(value)) {
    throw new Error(
      `不支持的 workspace 模式 "${String(raw)}"：仅支持 ${WORKSPACE_MODES.join(' | ')}（默认 inherit）`
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Config（Standard Schema + .volatile() 热更新）                        */
/* ------------------------------------------------------------------ */

/** 运行时配置默认值：只剩「模型派发权限」三项，其余字段已随外部后端一并移除。 */
const SWARM_CONFIG_DEFAULTS = Object.freeze({
  /**
   * 模型派发权限：开源默认完全放行。
   * - `strictAllowlist`：严格白名单开关。`true` 时白名单恒为激活态，
   *   即使 `allowedModels` 为空也**拒绝所有模型**（空名单 = 全禁，绝不放行）。
   * - `allowedModels`：`[]` 且 `strictAllowlist === false` = 不启用白名单；
   *   非空 = 仅允许列表内模型。
   * - `blockedModels`：黑名单优先，命中即一律禁止派发。
   * 本插件绝不硬编码任何具体模型名，规则完全由用户在自己的设置里决定。
   */
  strictAllowlist: false,
  allowedModels: Object.freeze([]),
  blockedModels: Object.freeze([]),
});

/** 手写 Standard Schema：宿主 schemastery 不可用时的零依赖兜底。 */
function makeFallbackConfigSchema() {
  const fields = [
    { key: 'strictAllowlist', kind: 'boolean', fallback: SWARM_CONFIG_DEFAULTS.strictAllowlist },
    { key: 'allowedModels', kind: 'modelRules', fallback: SWARM_CONFIG_DEFAULTS.allowedModels },
    { key: 'blockedModels', kind: 'modelRules', fallback: SWARM_CONFIG_DEFAULTS.blockedModels },
  ];
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-swarm',
      validate(value) {
        const input = value && typeof value === 'object' ? value : {};
        const out = {};
        const issues = [];
        for (const field of fields) {
          const raw = input[field.key];
          if (raw === undefined) {
            out[field.key] = field.fallback;
            continue;
          }
          if (field.kind === 'boolean') {
            if (typeof raw !== 'boolean') {
              issues.push({ message: `${field.key} 必须是布尔值`, path: [field.key] });
              continue;
            }
            out[field.key] = raw;
            continue;
          }
          if (field.kind === 'modelRules') {
            if (!Array.isArray(raw)) {
              issues.push({ message: `${field.key} 必须是字符串数组`, path: [field.key] });
              continue;
            }
            const badIndex = raw.findIndex((item) => typeof item !== 'string');
            if (badIndex >= 0) {
              issues.push({
                message: `${field.key}[${badIndex}] 必须是字符串`,
                path: [field.key, badIndex],
              });
              continue;
            }
            out[field.key] = normalizeModelRuleList(raw);
            continue;
          }
        }
        return issues.length > 0 ? { issues } : { value: out };
      },
    },
  };
}

/**
 * 构造 Config：优先宿主 @deepseek-ai/schemastery（字段全部 `.volatile()`，
 * 设置页保存后无需重载插件）；解析不到宿主依赖时退回手写 Standard Schema，
 * 保证纯 Node 离线单测也能正常挂载与校验。
 */
function buildConfigSchema() {
  const z = runtime.loadSchemastery();
  if (z && typeof z.object === 'function' && typeof z.string === 'function' && typeof z.number === 'function') {
    /**
     * 模型派发权限字段：schemastery 的数组 + `.volatile()` 组合在不同版本间存在
     * 差异。这里单独兜底——某个字段构造失败时只丢该字段，绝不让整套 volatile
     * 配置因此退回零依赖 Schema（那会让所有字段热更新失效）。
     */
    const modelRuleField = (fallback) => {
      if (typeof z.array !== 'function') return null;
      try {
        const schema = z.array(z.string()).default(fallback);
        return typeof schema?.volatile === 'function' ? schema.volatile() : schema;
      } catch {
        return null;
      }
    };
    try {
      const allowedModelsField = modelRuleField([...SWARM_CONFIG_DEFAULTS.allowedModels]);
      const blockedModelsField = modelRuleField([...SWARM_CONFIG_DEFAULTS.blockedModels]);
      return z.object({
        // 模型派发权限：开源默认完全放行（strictAllowlist=false 且两个列表为空）。
        strictAllowlist: z.boolean().default(SWARM_CONFIG_DEFAULTS.strictAllowlist).volatile(),
        ...(allowedModelsField ? { allowedModels: allowedModelsField } : {}),
        ...(blockedModelsField ? { blockedModels: blockedModelsField } : {}),
      });
    } catch {
      // schemastery 版本差异 → 退回零依赖兜底
    }
  }
  return makeFallbackConfigSchema();
}

const Config = buildConfigSchema();

/**
 * 解包宿主 Config 值。
 *
 * schemastery 的 `.volatile()` 字段在 Standard Schema 校验后会变成
 * `{ get(), [write] }` 访问器（热更新时值会变）；若不解包，任何设置都会被
 * 当成「缺省」而回落到默认值。这里同时兼容裸值、访问器与 `{ value }` 包装。
 */
function readConfigValue(raw) {
  let current = raw;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return current;
    if (typeof current.get === 'function') {
      try {
        current = current.get();
      } catch {
        return undefined;
      }
      continue;
    }
    if ('value' in current && Object.keys(current).length === 1) {
      current = current.value;
      continue;
    }
    return current;
  }
  return current;
}

/** 只取 Swarm 运行期真正消费的字段（避免把无关键灌进 controller）。 */
function normalizeSwarmConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    strictAllowlist: readConfigValue(input.strictAllowlist) === true,
    allowedModels: normalizeModelRuleList(input.allowedModels),
    blockedModels: normalizeModelRuleList(input.blockedModels),
  };
}

/* ------------------------------------------------------------------ */
/* 模型派发权限（allowedModels 白名单 / blockedModels 黑名单）            */
/* ------------------------------------------------------------------ */

/**
 * 归一化模型规则列表：只保留非空字符串，`trim()` 后按大小写不敏感去重，
 * 并保留首次出现的原始写法（设置页可原样回显）。`[]` = 不启用该条规则。
 */
function normalizeModelRuleList(list) {
  const raw = readConfigValue(list);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const clean = item.trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(clean);
  }
  return out;
}

/**
 * 候选模型的规则键集合（全部小写）。
 *
 * 同时纳入完整 `provider/model` 键、裸 `model` 名与调用方原始 spec，
 * 因此白名单 / 黑名单规则既能按路由写法命中，也能按裸模型名命中。
 */
function modelRuleKeys(candidate) {
  const keys = new Set();
  const push = (value) => {
    if (typeof value !== 'string') return;
    const clean = value.trim().toLowerCase();
    if (clean) keys.add(clean);
  };
  if (typeof candidate === 'string') {
    push(candidate);
    const slash = candidate.indexOf('/');
    if (slash > 0 && slash < candidate.length - 1) push(candidate.slice(slash + 1));
    return [...keys];
  }
  if (candidate && typeof candidate === 'object') {
    const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : '';
    const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
    push(candidate.key);
    push(candidate.modelDisplay);
    push(candidate.requested);
    if (provider && model) push(`${provider}/${model}`);
    push(model);
    if (provider && !model) push(provider);
  }
  return [...keys];
}

/**
 * 规则判定结果：黑名单优先；白名单激活时未命中即视为不在白名单。
 *
 * 白名单激活条件 = `strictAllowlist === true` **或** `allowedModels` 非空。
 * 前者保证「严格模式下取消最后一个勾选 → `allowedModels: []`」不会反转成
 * 「全部放行」：开关仍在，空名单即全禁。
 */
function describeModelRuleState(config, candidate) {
  const blocked = normalizeModelRuleList(config?.blockedModels);
  const allowed = normalizeModelRuleList(config?.allowedModels);
  const strict = readConfigValue(config?.strictAllowlist) === true;
  const keys = modelRuleKeys(candidate);
  const blockedBy = blocked.find((rule) => keys.includes(rule.toLowerCase())) || '';
  const allowedBy = allowed.find((rule) => keys.includes(rule.toLowerCase())) || '';
  const whitelistActive = strict || allowed.length > 0;
  return {
    keys,
    blocked: blockedBy !== '',
    blockedBy,
    strict,
    whitelistActive,
    allowedRuleCount: allowed.length,
    allowed: allowedBy !== '',
    permitted: blockedBy === '' && (!whitelistActive || allowedBy !== ''),
  };
}

/** 候选模型是否允许被 Swarm 派发（纯函数，供 Host 入口与单测共用）。 */
function isSwarmModelAllowed(config, candidate) {
  return describeModelRuleState(config, candidate).permitted;
}

/** 人话标签：优先 `modelDisplay`，其次 `provider/model`，最后裸 `model`。 */
function describeModelCandidateLabel(candidate) {
  if (typeof candidate === 'string') return candidate.trim() || '(未命名模型)';
  if (candidate && typeof candidate === 'object') {
    for (const value of [candidate.modelDisplay, candidate.key]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : '';
    const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
    if (provider && model) return `${provider}/${model}`;
    if (model) return model;
    if (provider) return provider;
  }
  return '(未命名模型)';
}

/**
 * 硬拦截：被禁或不在白名单时抛出清晰错误，绝不静默降级或绕过。
 *
 * `options.inherited === true` 用于「省略 model、继承协调员当前路由」这条路径，
 * 错误文案会明确要求显式指定允许的模型或调整 Swarm 模型设置。
 */
function assertSwarmModelAllowed(config, candidate, options = {}) {
  const state = describeModelRuleState(config, candidate);
  if (state.permitted) return true;
  const label = describeModelCandidateLabel(candidate);
  const emptyAllowlist = state.whitelistActive && state.allowedRuleCount === 0;
  const reason = state.blocked
    ? `命中禁用规则 "${state.blockedBy}"`
    : emptyAllowlist
      ? '已启用严格白名单模式但允许列表为空，当前禁止所有模型'
      : '不在白名单（allowedModels）内';
  const remedy = emptyAllowlist
    ? '请先在 Swarm 设置页「模型派发权限控制」勾选（或手动添加）至少一个允许的模型，' +
      '或关闭严格白名单模式后再派发。'
    : '请显式指定允许的模型（可用 swarm{action:"models"} 查询当前清单），' +
      '或到 Swarm 设置页「模型派发权限控制」调整白名单 / 黑名单规则。';
  if (options.inherited === true) {
    throw new Error(
      `Swarm 拒绝派发"继承的默认模型" ${label}：${reason}。` +
        `默认路由被禁用时不会静默降级；${remedy}`
    );
  }
  throw new Error(`Swarm 拒绝派发模型 ${label}：${reason}。${remedy}`);
}

/**
 * Host dependency loader with a zero-dependency fallback.
 *
 * Desktop DSH bundles every `@deepseek-ai/*` runtime package inside its
 * Electron archive, so a plain `require` from the plugin directory raises
 * MODULE_NOT_FOUND and the plugin silently degraded to its hand-written
 * fallbacks. `runtime.requireHostModule` first tries the plain `require`
 * (profile-hoisted layouts), then resolves the specifier against host entry
 * anchors (the desktop runtime's own node_modules, CLI layouts, ...) and
 * requires that entry by path. The archive layout knowledge lives only in
 * `runtime.js`; nothing here spawns a process or reads the archive directly.
 *
 * Missing / ESM-only / unreadable modules still return `null`, so every
 * caller keeps its fallback and the pure-Node offline suite stays
 * dependency-free — no host package is ever required for the plugin to boot.
 */
function tryRequire(specifier) {
  return runtime.requireHostModule(specifier);
}

/**
 * Lazy `@deepseek-ai/dsh-scope` access.
 *
 * Host `agent/status` is dispatched with `scopeTarget(base, agent)` as the
 * listener `this` and a payload of only `{ status }`; the carrier agent can
 * ONLY be recovered through `carrierKeyOf(this)`. The module is resolved
 * lazily so a unit-test sandbox (and the browser bundle split) never pays for
 * a hard dependency, and `setDshScopeForTests` gives the regression suite a
 * seam to exercise the carrier path without the shipped package.
 */
let dshScopeResolved = false;
let dshScopeModule = null;

function resolveDshScope() {
  if (!dshScopeResolved) {
    dshScopeResolved = true;
    dshScopeModule = tryRequire('@deepseek-ai/dsh-scope');
  }
  return dshScopeModule;
}

/** Test seam: inject a fake `@deepseek-ai/dsh-scope` carrier reader. */
function setDshScopeForTests(scope) {
  dshScopeResolved = true;
  dshScopeModule = scope || null;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

function createUserMessageCompat(input) {
  const dshLlm = tryRequire('@deepseek-ai/dsh-llm');
  if (dshLlm && typeof dshLlm.createUserMessage === 'function') {
    return dshLlm.createUserMessage(input);
  }
  return deepFreeze(
    structuredClone({
      ...input,
      role: 'user',
      id: crypto.randomUUID(),
    })
  );
}

/**
 * Build a first-party DSH tool definition via `@deepseek-ai/dsh-tools` when
 * available in Host, or a 1:1 compatible JSON-Schema tool object in unit tests.
 */
function buildToolCompat(options) {
  const { executionMode: explicitMode, ...dshOptions } = options;
  const normalizedOutput = {
    ...dshOptions.output,
    schema: dshOptions.output?.schema || { type: 'object', additionalProperties: true },
  };
  const dshInput = {
    ...dshOptions,
    output: normalizedOutput,
  };

  const dshTools = tryRequire('@deepseek-ai/dsh-tools');
  let tool = null;
  if (dshTools && typeof dshTools.defineTool === 'function') {
    tool = dshTools.defineTool(dshInput);
  } else {
    const properties = {};
    const required = [];
    for (const [key, spec] of Object.entries(dshInput.parameters || {})) {
      const { required: isReq, ...rest } = spec;
      properties[key] = rest;
      if (isReq === true) required.push(key);
    }
    tool = {
      name: dshInput.name,
      description: dshInput.description,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
      output: {
        schema: normalizedOutput.schema,
        render(args, value) {
          return normalizedOutput.render(args, value);
        },
        ...(normalizedOutput.presentationMeta
          ? {
              presentationMeta(args, value) {
                return normalizedOutput.presentationMeta(args, value);
              },
            }
          : {}),
      },
      async execute(args, exec) {
        return dshInput.execute(args || {}, exec || {});
      },
    };
    if (dshInput.presentCall) tool.presentCall = dshInput.presentCall;
    if (dshInput.presentResult) tool.presentResult = dshInput.presentResult;
    if (dshInput.isConcurrencySafe) tool.isConcurrencySafe = dshInput.isConcurrencySafe;
  }

  const mode =
    typeof dshInput.isConcurrencySafe === 'function' && dshInput.isConcurrencySafe({}) === true
      ? 'parallel'
      : 'exclusive';
  if (!Object.hasOwn(tool, 'executionMode')) {
    Object.defineProperty(tool, 'executionMode', {
      value: explicitMode || mode,
      enumerable: true,
      configurable: true,
    });
  }
  return tool;
}

/**
 * Build a balanced fork seed from `events` up through `boundary` (inclusive).
 *
 * Host `@deepseek-ai/dsh-session#buildForkSeed` is authoritative when present.
 * The offline fallback stays tiny, but it must still close an OPEN
 * turn/step/tool-call: a swarm fork is usually taken from a coordinator that is
 * mid-turn, and an unclosed seed makes the child's replayed history invalid.
 */
function buildBalancedForkSeed(events, boundary) {
  if (!Array.isArray(events) || events.length === 0) return { seed: [], inheritedEventCount: 0 };
  const resolvedBoundary =
    boundary !== undefined && boundary !== null
      ? boundary
      : events[events.length - 1]?.seq ?? events.length - 1;
  if (
    !Number.isSafeInteger(resolvedBoundary) ||
    resolvedBoundary < 0 ||
    resolvedBoundary >= events.length
  ) {
    throw new Error(
      `无效的 fork 边界 seq=${String(resolvedBoundary)}（源会话共 ${events.length} 条事件）`
    );
  }

  const dshSession = tryRequire('@deepseek-ai/dsh-session');
  if (dshSession && typeof dshSession.buildForkSeed === 'function') {
    return {
      seed: dshSession.buildForkSeed(events, resolvedBoundary),
      inheritedEventCount: resolvedBoundary + 1,
    };
  }

  const seed = structuredClone(events.slice(0, resolvedBoundary + 1));
  const time = seed[seed.length - 1]?.time ?? Date.now();
  let seq = resolvedBoundary + 1;
  const push = (type, data) => seed.push({ type, seq: seq++, time, data });
  push('session/end-seed', { inherited: true });

  let turn = null;
  let step = null;
  const calls = new Map();
  for (const ev of seed) {
    if (ev.type === 'turn/start') {
      turn = ev.data?.turn ?? 1;
      step = null;
      calls.clear();
    } else if (ev.type === 'turn/end') {
      turn = null;
      step = null;
      calls.clear();
    } else if (ev.type === 'step/start') {
      step = ev.data?.step ?? 1;
    } else if (ev.type === 'step/end') {
      step = null;
    } else if (ev.type === 'tool/call' && ev.data?.callId) {
      calls.set(ev.data.callId, ev.data);
    } else if (ev.type === 'tool/result' && ev.data?.callId) {
      calls.delete(ev.data.callId);
    }
  }

  for (const [callId, call] of calls) {
    push('tool/result', {
      callId,
      name: call.name || 'unknown',
      isError: true,
      error: { code: 'TOOL_OUTCOME_UNKNOWN', message: 'Forked before tool completed' },
      content: [
        { type: 'text', text: 'Tool execution was still in flight when this session forked.' },
      ],
    });
  }
  if (step !== null) push('step/end', { step, reason: { kind: 'forked' } });
  if (turn !== null) push('turn/end', { turn, reason: { kind: 'forked' } });
  return { seed, inheritedEventCount: resolvedBoundary + 1 };
}

/**
 * Parse the strictly supported monitor cron shape: exactly 'x * * * *' or
 * '*\/N * * * *' with 1 <= N <= 10080 minutes. Any concrete hour/day/month/
 * weekday field is rejected instead of being silently approximated.
 */
function parseCronIntervalMs(cronExpr) {
  const raw = String(cronExpr || '').trim();
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron 表达式必须包含 5 个字段，收到："' + raw + '"');
  }
  const [minField, hourField, dayField, monthField, weekdayField] = fields;
  const trailing = [hourField, dayField, monthField, weekdayField];
  if (!trailing.every((field) => field === '*')) {
    throw new Error(
      '暂不支持复杂日历字段（时/日/月/星期必须全为 *），仅支持 "*/N * * * *" 形式，收到："' + raw + '"'
    );
  }
  if (minField === '*') return 60000;
  const stepMatch = /^\*\/(\d+)$/.exec(minField);
  if (!stepMatch) {
    throw new Error(
      '不支持的分钟字段 "' + minField + '"：仅支持 "*" 或 "*/N"（N 为 1..10080 的整数分钟）'
    );
  }
  const mins = Number(stepMatch[1]);
  if (!Number.isSafeInteger(mins) || mins < 1 || mins > 10080) {
    throw new Error('Cron 分钟步长必须在 1..10080 之间，收到：' + stepMatch[1]);
  }
  return clampTimerDelay(mins * 60000);
}

function extractErrorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const code = err.code || err.status || err.statusCode;
  const msg = err.message || err.reason || String(err);
  return code ? `[${code}] ${msg}` : String(msg);
}

/**
 * 写入成员 `lastError` 并推流到面板的错误文本统一脱敏并限长。
 * 桥接报错里可能带 `--auth-file <路径>`、Token 或用户主目录，绝不能原样外泄。
 */
function redactErrorText(value, maxChars = 400) {
  return redactSensitiveText(value, { maxChars });
}

/** 活动摘要（工具名 / 思考片段 / 回复片段）统一脱敏并限长。 */
function redactActivityText(value, maxChars = 160) {
  return redactSensitiveText(value, { maxChars });
}

function parseToolArgumentsObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function formatToolActivity(eventData) {
  const toolName = eventData?.name || eventData?.toolName || '';
  if (!toolName) return '执行工具中';
  const args = parseToolArgumentsObject(
    eventData?.arguments ?? eventData?.input ?? eventData?.args
  );
  if (args) {
    if (typeof args.description === 'string' && args.description.trim()) {
      return `${toolName}: ${args.description.trim()}`;
    }
    if (typeof args.toolSummary === 'string' && args.toolSummary.trim()) {
      return `${toolName}: ${args.toolSummary.trim()}`;
    }
    const rawFilePath = args.file_path ?? args.Path ?? args.path;
    if (typeof rawFilePath === 'string' && rawFilePath.trim()) {
      const p = path.basename(rawFilePath.trim());
      return `${toolName} (${p})`;
    }
    if (typeof args.action === 'string' && args.action.trim()) {
      const targetSuffix =
        typeof args.name === 'string' && args.name.trim() ? ` (${args.name.trim()})` : '';
      return `${toolName}:${args.action.trim()}${targetSuffix}`;
    }
  }
  return `调用 ${toolName}`;
}

function syncHostSessionTitle(ctx, agent, title) {
  if (!agent?.session || typeof title !== 'string' || !title.trim()) return false;
  try {
    const titleSvc = ctx?.get?.('sessionTitle') || ctx?.sessionTitle;
    if (titleSvc && typeof titleSvc.rename === 'function') {
      titleSvc.rename(agent.session, title.trim());
      return true;
    }
  } catch {
    // Non-fatal: mock or headless environments without live sessionTitle ignore this.
  }
  return false;
}

function readAgentModelRoute(agent) {
  if (!agent) return { provider: '', model: '', reasoningEffort: '' };
  try {
    const current =
      typeof agent.model?.current === 'function'
        ? agent.model.current()
        : agent.model?.current;
    if (current && (current.provider || current.model)) {
      return {
        provider: String(current.provider || ''),
        model: String(current.model || ''),
        reasoningEffort: current.reasoningEffort ? String(current.reasoningEffort) : '',
      };
    }
  } catch {
    // fall through
  }
  try {
    const hdr = agent.session?.requestHeader?.()?.config;
    if (hdr && (hdr.provider || hdr.model)) {
      return {
        provider: String(hdr.provider || ''),
        model: String(hdr.model || ''),
        reasoningEffort: hdr.reasoningEffort ? String(hdr.reasoningEffort) : '',
      };
    }
  } catch {
    // fall through
  }
  return { provider: '', model: '', reasoningEffort: '' };
}

/**
 * Read an agent's effective working directory.
 *
 * Host contract: workingDirectory.get(session) takes the Session, NOT the Agent.
 * Test doubles that expose a bare field are only consulted when no session is
 * available, so a strict host-like mock that throws on a wrong argument is
 * respected instead of silently swallowed.
 */
function readAgentCwd(ctx, agent) {
  if (!agent) return process.cwd();
  const wd = ctx?.get?.('workingDirectory') || ctx?.workingDirectory;
  if (agent.session && wd && typeof wd.get === 'function') {
    return wd.get(agent.session);
  }
  if (!agent.session && wd && typeof wd.get === 'function') {
    const val = wd.get(agent);
    if (typeof val === 'string' && val) return val;
  }
  return agent.session?.header?.cwd || agent.cwd || process.cwd();
}

/**
 * Extract a human-readable failure message from a host failure object without
 * ever producing "[object Object]".
 */
function extractFailureMessage(failure) {
  if (failure === undefined || failure === null) return '';
  if (typeof failure === 'string') return failure.trim();
  if (typeof failure !== 'object') return String(failure);
  const candidates = [failure.message, failure.reason, failure.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const nested = extractFailureMessage(candidate);
      if (nested) return nested;
    }
  }
  try {
    const serialized = JSON.stringify(failure);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // ignore non-serializable failures
  }
  return '';
}

/** Build a legal DSH UserMessage for an inter-agent relay. */
function makeUserMessage(text, senderSessionId) {
  const content = [{ type: 'text', text: String(text ?? '') }];
  const source = {
    kind: 'agent-message',
    form: 'relay',
    ...(senderSessionId ? { senderSessionId } : {}),
  };
  const dshLlm = tryRequire('@deepseek-ai/dsh-llm');
  if (dshLlm && typeof dshLlm.createUserMessage === 'function') {
    return dshLlm.createUserMessage({ content, source });
  }
  return deepFreeze(
    structuredClone({
      role: 'user',
      content,
      source,
      id: crypto.randomUUID(),
    })
  );
}

/**
 * Does this agent still have work queued or in flight?
 *
 * Host truth: the real `ReactLoopInbox` exposes `nextTurn` (array),
 * `nextStep` (array) and `hasPending`; `agent/status === 'running'` means a
 * turn is executing right now. A `session/event` `turn/end` therefore NEVER
 * implies "idle": parking a member that still has a queued next turn would
 * strand the wakeup and lose the doorbell. Test doubles keep using `size` /
 * `length`, which are accepted as a conservative fallback.
 */
function hasPendingAgentWork(agent) {
  if (!agent) return false;
  if (agent.status === 'running') return true;
  const inbox = agent.inbox;
  if (!inbox) return false;
  if (typeof inbox.hasPending === 'function') {
    try {
      if (inbox.hasPending()) return true;
    } catch {
      // A throwing probe cannot prove the inbox is empty: stay conservative.
      return true;
    }
  } else if (inbox.hasPending === true) {
    return true;
  }
  if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0) return true;
  if (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return true;
  if (typeof inbox.size === 'number' && inbox.size > 0) return true;
  if (typeof inbox.length === 'number' && inbox.length > 0) return true;
  return false;
}

/**
 * Real delegation depth, exactly as host `@deepseek-ai/dsh-subagent` computes
 * it: `max(header.delegationDepth, agent.options.subagentDepth)`.
 *
 * Reading the session header alone under-counts a resumed agent whose runtime
 * `subagentDepth` is already 4: the child would be created at depth 1 and
 * escape MAX_SWARM_DELEGATION_DEPTH entirely.
 */
function readAgentDelegationDepth(agent) {
  const runtime = agent?.options?.subagentDepth;
  if (
    runtime !== undefined &&
    (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))
  ) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer');
  }
  const header = agent?.session?.header?.delegationDepth ?? 0;
  if (!Number.isSafeInteger(header) || header < 0) {
    throw new TypeError('session header delegationDepth must be a non-negative safe integer');
  }
  return Math.max(header, runtime ?? 0);
}

/**
 * Capture the caller's EFFECTIVE security policy to seed into one delegation.
 * MUST run synchronously before the first await: a later parent switch belongs
 * to the parent's future, not to this child.
 *
 * `sandboxMode` is the resolved mode (explicit override, then the service
 * resolution, then the deployment default). Without it a fork from a member
 * whose history carries `sandbox/mode: danger-full-access` would silently
 * inherit that wide grant.
 */
function captureDelegatedPolicyOverrides(parentAgent) {
  const parentCtx = parentAgent?.ctx;
  const parentSession = parentAgent?.session;
  const sbSvc = parentCtx?.get?.('sandboxPolicy') ?? parentCtx?.sandboxPolicy;
  const explicitSandbox = sbSvc?.overrideOf?.(parentSession);
  const resolvedSandbox =
    explicitSandbox ??
    (parentSession && typeof sbSvc?.resolve === 'function'
      ? sbSvc.resolve({ session: parentSession })?.mode
      : undefined) ??
    sbSvc?.defaultMode;
  const permSvc = parentCtx?.get?.('permissionPresets') ?? parentCtx?.permissionPresets;
  const preset = permSvc?.current?.(parentSession);
  const permissionPreset = preset && preset !== 'custom' ? preset : undefined;
  const hasApproval = (parentCtx?.get?.('approval') ?? parentCtx?.approval) !== undefined;
  const parentAgentPreset = parentSession?.header?.agentPreset;
  return {
    sandboxMode: resolvedSandbox,
    explicitSandbox,
    permissionPreset,
    approvalPolicy: hasApproval ? 'never' : undefined,
    hasSecurityServices: Boolean(sbSvc || permSvc || hasApproval),
    ...(typeof parentAgentPreset === 'string' && parentAgentPreset
      ? { agentPreset: parentAgentPreset }
      : {}),
  };
}

function readAgentTurnNumber(ctx, agent) {
  try {
    const tb = ctx?.agents?.turnBoundaryOf?.(agent.session);
    if (tb && Number.isInteger(tb.lastTurn)) return tb.lastTurn;
  } catch {
    // ignore
  }
  return 0;
}

class SwarmHostController {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    // 运行期字段统一按契约归一化（0 = 无限），其它宿主/测试注入的键原样保留。
    this.config = { ...config, ...normalizeSwarmConfig(config) };
    this.stores = new SwarmStoreManager({ baseDir: readConfigValue(config.baseDir) });
    this.liveHandles = new Map();
    this.monitorTasks = new Map();
    this.disposed = false;
    this._taskSeq = 0;
    /** Pending create/resume operations, awaited by dispose before teardown. */
    this.inFlightOps = new Set();
    /** Per-member cancellation controllers for in-flight lifecycle operations. */
    this.memberAborts = new Map();
    this.disposeAbortController = new AbortController();
    /** Live watchSwarm generators that must be woken on dispose. */
    this.activeStreamWakers = new Set();
    /** Per-store member names reserved while an add is in flight. */
    this.creatingNames = new Map();
    /** `/swarm <task>` 待注入上下文映射（messageId -> { sessionId, panelUri, graphUri, commandId }）。 */
    this.pendingCommandInjections = new Map();
    /** 轻量队列 ID 镜像（sessionId -> { 'next-turn': string[], 'next-step': string[] }），用于跟踪 QueueDock 编辑/移除。 */
    this.pendingInboxMirrors = new Map();
  }

  /** 热更新运行期配置（设置页保存 / loader/volatile-update）：不改动既有成员。 */
  applyConfig(next = {}) {
    if (this.disposed) return false;
    const normalized = normalizeSwarmConfig({ ...this.config, ...next });
    this.config = { ...this.config, ...normalized };
    return true;
  }

  async dispose() {
    if (this.disposed) {
      await Promise.allSettled([...this.inFlightOps]);
      this.stores.dispose();
      return;
    }
    this.disposed = true;
    try {
      this.disposeAbortController.abort();
    } catch {
      // ignore
    }
    for (const controller of this.memberAborts.values()) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    this.memberAborts.clear();
    for (const sessionId of [...this.monitorTasks.keys()]) {
      this._clearMonitorTasksForSession(sessionId);
    }
    for (const wake of [...this.activeStreamWakers]) {
      try {
        wake();
      } catch {
        // ignore
      }
    }
    this.activeStreamWakers.clear();
    await Promise.allSettled([...this.inFlightOps]);
    const entries = [...this.liveHandles.entries()];
    this.liveHandles.clear();
    await Promise.allSettled(
      entries.map(async ([sessionId, handle]) => {
        try {
          this._cancelAgent(handle?.agent, 'swarm controller disposed');
          await handle?.dispose?.();
        } catch {
          // ignore teardown errors
        }
        this.memberAborts.delete(sessionId);
      })
    );
    this.pendingCommandInjections.clear();
    this.pendingInboxMirrors.clear();
    this.stores.dispose();
  }

  /**
   * 登记一条由 `/swarm <任务>` 入队的用户消息 ID，待 `agent/pre-step` 认领该消息时
   * 以 `skill-invocation` 上下文消息注入协调员技能说明，保持用户原始发言不被篡改。
   */
  queueCommandSkillInjection(messageId, meta = {}) {
    if (!messageId || typeof messageId !== 'string' || this.disposed) return;
    if (this.pendingCommandInjections.size >= 256) {
      const oldestKey = this.pendingCommandInjections.keys().next().value;
      if (oldestKey !== undefined) this.pendingCommandInjections.delete(oldestKey);
    }
    const sessionId = String(meta.sessionId || '');
    this.pendingCommandInjections.set(messageId, {
      sessionId,
      panelUri: meta.panelUri || (sessionId ? buildSwarmResourceUri(sessionId) : ''),
      graphUri: meta.graphUri || (sessionId ? buildSwarmResourceUri(sessionId, 'graph') : ''),
      commandId: String(meta.commandId || ''),
    });
  }

  /**
   * 同步 `agent/inbox/spliced` 事件：
   * - 用户在 QueueDock 编辑排队消息（`removedCount === 1 && inserted.length === 1 && outcome === 'canceled'`）时迁移待注入绑定；
   * - 用户在 QueueDock 删除排队消息或取消清空队列时移除待注入绑定，杜绝残留或串台。
   */
  syncInboxSpliceForCommandInjections(sessionId, splice) {
    if (!sessionId || !splice || typeof splice !== 'object') return;
    const target = splice.target;
    if (target !== 'next-turn' && target !== 'next-step') return;
    if (this.pendingCommandInjections.size === 0 && !this.pendingInboxMirrors.has(sessionId)) {
      return;
    }
    let mirror = this.pendingInboxMirrors.get(sessionId);
    if (!mirror) {
      mirror = { 'next-turn': [], 'next-step': [] };
      this.pendingInboxMirrors.set(sessionId, mirror);
    }
    const list = mirror[target];
    const rawStart = Number.isInteger(splice.start) ? splice.start : 0;
    const actualStart = Math.max(0, Math.min(rawStart, list.length));
    const rawDelete = Number.isInteger(splice.removedCount) ? splice.removedCount : 0;
    const actualDelete = Math.max(0, Math.min(rawDelete, list.length - actualStart));
    const insertedIds = Array.isArray(splice.inserted)
      ? splice.inserted.map((m) => (m && typeof m.id === 'string' ? m.id : '')).filter(Boolean)
      : [];
    const removedIds = list.splice(actualStart, actualDelete, ...insertedIds);

    if (splice.outcome === 'canceled' && removedIds.length > 0) {
      if (removedIds.length === 1 && insertedIds.length === 1) {
        const oldId = removedIds[0];
        const newId = insertedIds[0];
        const existing = this.pendingCommandInjections.get(oldId);
        if (existing) {
          this.pendingCommandInjections.delete(oldId);
          this.pendingCommandInjections.set(newId, existing);
        }
      } else {
        for (const id of removedIds) {
          this.pendingCommandInjections.delete(id);
        }
      }
    }

    if (mirror['next-turn'].length === 0 && mirror['next-step'].length === 0) {
      this.pendingInboxMirrors.delete(sessionId);
    }
  }

  /** 检查当前会话模型可见 surface 中是否已存在未压缩的完整 `swarm` 技能注入。 */
  _hasVisibleFullSwarmInjection(session) {
    if (!session || typeof session !== 'object') return false;
    const nodes = session.surface?.nodes;
    if (!Array.isArray(nodes) || typeof session.eventAt !== 'function') return false;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      let ev;
      try {
        ev = session.eventAt(nodes[i]);
      } catch {
        ev = undefined;
      }
      if (!ev || ev.type !== 'user/message') continue;
      const src = ev.data?.source;
      if (src?.kind !== 'skill-invocation' || src?.name !== 'swarm') continue;
      const blocks = Array.isArray(ev.data?.content) ? ev.data.content : [];
      const hasFullBody = blocks.some(
        (b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes('<skill_resources>')
      );
      if (hasFullBody) return true;
    }
    return false;
  }

  /**
   * HMR / 进程重启兜底：当内存映射因重载丢失时，从 Session 事件日志中折叠恢复
   * 由成功执行的 `/swarm` 命令入队且尚未落盘消费的用户消息 ID 集合。
   */
  _recoverPendingSwarmMessageIdsFromSession(session) {
    const tracked = new Set();
    if (!session || typeof session.snapshotEvents !== 'function') return tracked;
    let events;
    try {
      events = session.snapshotEvents();
    } catch {
      return tracked;
    }
    if (!Array.isArray(events) || events.length === 0) return tracked;
    const openCmdCandidates = new Map();
    const inbox = { 'next-turn': [], 'next-step': [] };

    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'command/run' && ev.data?.name === 'swarm' && ev.data?.commandId) {
        openCmdCandidates.set(String(ev.data.commandId), []);
      } else if (ev.type === 'command/done' && ev.data?.commandId) {
        const cid = String(ev.data.commandId);
        const candidates = openCmdCandidates.get(cid);
        openCmdCandidates.delete(cid);
        if (ev.data?.kind === 'success' && Array.isArray(candidates)) {
          for (const id of candidates) tracked.add(id);
        }
      } else if (ev.type === 'agent/inbox/spliced' && ev.data) {
        const target = ev.data.target;
        if (target !== 'next-turn' && target !== 'next-step') continue;
        const list = inbox[target];
        const rawStart = Number.isInteger(ev.data.start) ? ev.data.start : 0;
        const actualStart = Math.max(0, Math.min(rawStart, list.length));
        const rawDelete = Number.isInteger(ev.data.removedCount) ? ev.data.removedCount : 0;
        const actualDelete = Math.max(0, Math.min(rawDelete, list.length - actualStart));
        const insertedIds = Array.isArray(ev.data.inserted)
          ? ev.data.inserted.map((m) => (m && typeof m.id === 'string' ? m.id : '')).filter(Boolean)
          : [];
        const removedIds = list.splice(actualStart, actualDelete, ...insertedIds);

        if (openCmdCandidates.size > 0 && insertedIds.length > 0 && ev.data.outcome !== 'canceled') {
          for (const bucket of openCmdCandidates.values()) {
            bucket.push(...insertedIds);
          }
        }
        if (ev.data.outcome === 'canceled' && removedIds.length > 0) {
          if (removedIds.length === 1 && insertedIds.length === 1 && tracked.has(removedIds[0])) {
            tracked.delete(removedIds[0]);
            tracked.add(insertedIds[0]);
          } else {
            for (const id of removedIds) tracked.delete(id);
          }
        }
      } else if (ev.type === 'user/message' && typeof ev.data?.id === 'string') {
        tracked.delete(ev.data.id);
      }
    }
    return tracked;
  }

  /**
   * 在 `agent/pre-step` 阶段检查本步认领的消息是否包含 `/swarm <任务>` 提交的用户消息；
   * 若命中则消费该标记并返回标准 `skill-invocation` 注入消息。
   */
  consumeCommandSkillInjectionForStep(agent, decisionMessages = [], claimedMessages = []) {
    if (this.disposed) return null;
    const allCandidates = [];
    const seenMsgIds = new Set();
    for (const list of [decisionMessages, claimedMessages]) {
      if (!Array.isArray(list)) continue;
      for (const msg of list) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.source?.kind === 'skill-invocation' && msg.source?.name === 'swarm') {
          // 本步已包含 swarm 技能注入（例如幂等重入），不重复追加。
          return null;
        }
        if (typeof msg.id === 'string' && msg.id && !seenMsgIds.has(msg.id)) {
          seenMsgIds.add(msg.id);
          allCandidates.push(msg);
        }
      }
    }
    if (allCandidates.length === 0) return null;

    let matchedMeta = null;
    for (const msg of allCandidates) {
      const hit = this.pendingCommandInjections.get(msg.id);
      if (hit) {
        this.pendingCommandInjections.delete(msg.id);
        matchedMeta = hit;
      }
    }

    const session = agent?.session;
    const sessionId =
      matchedMeta?.sessionId || agent?.id || session?.id || session?.header?.id || '';

    if (!matchedMeta && session) {
      const hasUserMsg = allCandidates.some((m) => m.source?.kind === 'user');
      if (hasUserMsg) {
        const recovered = this._recoverPendingSwarmMessageIdsFromSession(session);
        if (recovered.size > 0 && allCandidates.some((m) => recovered.has(m.id))) {
          matchedMeta = {
            sessionId,
            panelUri: sessionId ? buildSwarmResourceUri(sessionId) : '',
            graphUri: sessionId ? buildSwarmResourceUri(sessionId, 'graph') : '',
          };
        }
      }
    }

    if (!matchedMeta) return null;

    const compact = this._hasVisibleFullSwarmInjection(session);
    const injectionText = buildCoordinatorSkillInjection({
      sessionId,
      panelUri: matchedMeta.panelUri,
      graphUri: matchedMeta.graphUri,
      compact,
    });

    return createUserMessageCompat({
      content: [{ type: 'text', text: injectionText }],
      source: {
        kind: 'skill-invocation',
        name: 'swarm',
        form: 'instructions',
      },
    });
  }

  /** Cancel one live agent with a legal host AgentCancelCause. */
  _cancelAgent(agent, reason) {
    if (!agent) return false;
    try {
      if (typeof agent.cancel === 'function') {
        agent.cancel({ kind: 'hook', reason: String(reason || 'killed by swarm') });
        return true;
      }
    } catch {
      // fall through to test-double shapes
    }
    for (const method of ['cancelTurn', 'abort']) {
      try {
        if (typeof agent[method] === 'function') {
          agent[method]();
          return true;
        }
      } catch {
        // ignore
      }
    }
    return false;
  }

  /** Create (or reuse) the per-member abort controller. */
  _memberAbort(sessionId) {
    let controller = this.memberAborts.get(sessionId);
    if (!controller) {
      controller = new AbortController();
      this.memberAborts.set(sessionId, controller);
    }
    return controller;
  }

  _abortMember(sessionId, reason) {
    const controller = this.memberAborts.get(sessionId);
    if (controller) {
      try {
        controller.abort(reason);
      } catch {
        // ignore
      }
    }
  }

  /** Whether this member's lifecycle abort has already fired. */
  _isMemberAborted(sessionId) {
    const controller = this.memberAborts.get(sessionId);
    return Boolean(controller && controller.signal && controller.signal.aborted);
  }

  _trackOp(promise) {
    const tracked = Promise.resolve(promise).catch((err) => {
      throw err;
    });
    this.inFlightOps.add(tracked);
    const cleanup = () => this.inFlightOps.delete(tracked);
    tracked.then(cleanup, cleanup);
    return tracked;
  }

  _reserveName(store, name) {
    let set = this.creatingNames.get(store.coordinatorSessionId);
    if (!set) {
      set = new Set();
      this.creatingNames.set(store.coordinatorSessionId, set);
    }
    if (set.has(name)) return false;
    set.add(name);
    return true;
  }

  _releaseName(store, name) {
    const set = this.creatingNames.get(store.coordinatorSessionId);
    if (!set) return;
    set.delete(name);
    if (set.size === 0) this.creatingNames.delete(store.coordinatorSessionId);
  }

  shouldExposeBoardTools(agent) {
    const sessionId = agent?.id || agent?.session?.id || agent?.session?.header?.id;
    if (!sessionId) return false;
    const resolved = this.stores.resolveSession(sessionId);
    if (!resolved || !resolved.store.hasSwarm()) return false;
    const member = resolved.store.getMember(resolved.memberName);
    if (member?.killed) return false;
    return true;
  }

  getSwarmSnapshot(sessionId) {
    return this.stores.getSnapshotForSession(sessionId);
  }

  async *watchSwarm(sessionId, signal) {
    let wakeResolver = null;
    let dirty = false;

    const wake = () => {
      if (wakeResolver) {
        const resolve = wakeResolver;
        wakeResolver = null;
        resolve();
      }
    };

    const notify = () => {
      dirty = true;
      wake();
    };

    // Subscribe BEFORE the first snapshot yield: a store change landing between
    // snapshot capture and the first await would otherwise be lost forever.
    const unsubStore = this.stores.subscribeAll((changedCoordId) => {
      const resolved = this.stores.resolveSession(sessionId);
      const targetCoordId = resolved ? resolved.coordinatorSessionId : sessionId;
      if (changedCoordId === targetCoordId || changedCoordId === sessionId) {
        notify();
      }
    });
    this.activeStreamWakers.add(wake);

    const onAbort = () => wake();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      do {
        if (signal?.aborted || this.disposed) return;
        dirty = false;
        yield this.getSwarmSnapshot(sessionId);
        if (signal?.aborted || this.disposed) return;
        if (!dirty) {
          await new Promise((resolve) => {
            wakeResolver = resolve;
          });
        }
      } while (!signal?.aborted && !this.disposed);
    } finally {
      this.activeStreamWakers.delete(wake);
      unsubStore();
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  resolveCaller(exec, createIfCoordinator = false) {
    const agent = exec?.agent;
    const sessionId = agent?.id || agent?.session?.id || agent?.session?.header?.id;
    if (!sessionId) {
      throw new Error('Swarm 工具调用缺少有效的宿主 Agent 会话上下文');
    }

    const existing = this.stores.resolveSession(sessionId);
    if (existing) {
      if (existing.memberName === 'coordinator') {
        const route = readAgentModelRoute(agent);
        existing.store.ensureCoordinator({
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          cwd: readAgentCwd(this.ctx, agent),
          currentTurn: readAgentTurnNumber(this.ctx, agent),
        });
      }
      return {
        store: existing.store,
        coordinatorSessionId: existing.coordinatorSessionId,
        callerName: existing.memberName,
        agent,
      };
    }

    if (!createIfCoordinator) {
      throw new Error('当前会话尚未创建或加入任何 Swarm 集群；请先调用 swarm{action:"add"} 创建成员');
    }

    const store = this.stores.getOrCreateStore(sessionId);
    const route = readAgentModelRoute(agent);
    store.ensureCoordinator({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      cwd: readAgentCwd(this.ctx, agent),
      currentTurn: readAgentTurnNumber(this.ctx, agent),
    });
    return {
      store,
      coordinatorSessionId: sessionId,
      callerName: 'coordinator',
      agent,
    };
  }

  /**
   * 已发现模型清单。
   *
   * - 默认（模型工具 `swarm{action:"models"}`）：过滤掉被 `blockedModels` /
   *   `allowedModels` 禁止的条目，模型看到的只能是真正可派发的候选。
   * - `includeBlocked: true`（设置页 `getSwarmModels`）：保留全部条目并附带
   *   `{ allowed, blocked }` 标记，供勾选面板展示完整目录。
   */
  async listAvailableModels({ includeBlocked = false } = {}) {
    const results = [];
    const seen = new Set();
    const llm = this.ctx?.get?.('llm') || this.ctx?.llm;

    if (llm && typeof llm.listProviders === 'function') {
      let providers = [];
      try {
        providers = (await llm.listProviders()) || [];
      } catch {
        providers = [];
      }
      for (const item of providers) {
        const providerId = typeof item === 'string' ? item : item?.id || item?.provider;
        if (!providerId) continue;
        let models = [];
        try {
          if (typeof llm.listModels === 'function') {
            models = (await llm.listModels(providerId)) || [];
          }
        } catch {
          models = [];
        }
        for (const m of models) {
          const modelId = typeof m === 'string' ? m : m?.id || m?.model;
          if (!modelId) continue;
          const fullKey = `${providerId}/${modelId}`;
          if (seen.has(fullKey)) continue;
          seen.add(fullKey);
          results.push({
            provider: providerId,
            model: modelId,
            key: fullKey,
            name: typeof m === 'object' && m?.name ? String(m.name) : modelId,
            description: typeof m === 'object' && m?.description ? String(m.description) : '',
          });
        }
      }
    }

    if (results.length === 0) {
      const sc = this.ctx?.get?.('sessionController') || this.ctx?.sessionController;
      if (sc && typeof sc.modelCatalog === 'function') {
        try {
          const cat = await sc.modelCatalog();
          const list = Array.isArray(cat?.models) ? cat.models : Array.isArray(cat) ? cat : [];
          for (const entry of list) {
            const provider = entry?.provider || '';
            const model = entry?.id || entry?.model || '';
            if (!provider || !model) continue;
            const fullKey = `${provider}/${model}`;
            if (seen.has(fullKey)) continue;
            seen.add(fullKey);
            results.push({
              provider,
              model,
              key: fullKey,
              name: entry?.name || model,
              description: entry?.description || '',
            });
          }
        } catch {
          // ignore
        }
      }
    }

    const ranked = results.map((entry) => ({
      entry,
      state: describeModelRuleState(this.config, entry),
    }));
    if (includeBlocked) {
      return ranked.map(({ entry, state }) => ({
        ...entry,
        allowed: state.permitted,
        blocked: state.blocked,
      }));
    }
    return ranked.filter(({ state }) => state.permitted).map(({ entry }) => entry);
  }

  /**
   * Typert `getSwarmModels` 的数据源：设置页专用，零子进程启动；
   * 被禁条目保留并附带 `allowed` / `blocked` 标记。
   */
  async listSwarmModelsResult() {
    const models = await this.listAvailableModels({ includeBlocked: true });
    return {
      models: models.map((entry) => ({
        key: entry.key,
        provider: entry.provider,
        model: entry.model,
        name: entry.name,
        backend: 'dsh',
        allowed: entry.allowed === true,
        blocked: entry.blocked === true,
      })),
    };
  }

  /**
   * 解析请求模型并强制过一遍「模型派发权限」闸门。
   *
   * 三条入口全部经此：显式 `model`、省略 `model` 继承协调员当前路由、
   * 以及 `swarm{action:"model"}` 热切。被禁用或不在白名单一律当场报错，
   * 绝不静默降级到别的模型。
   */
  async resolveRequestedModel(requestedModel, fallbackRoute) {
    const requested = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    // 解析前只做「显式黑名单」早退：原始写法直接命中 blockedModels 时立刻报黑名单错误，
    // 免得被更靠后的「未配置 provider」掩盖。
    //
    // 白名单**不能**在这一步判定：调用方可能传裸模型名（`ok`）或显示名（`Friendly`），
    // 它们要先解析成 `native/ok` 才具备可比对的规则键；提前跑白名单会把合法写法误杀。
    // 完整的 assertSwarmModelAllowed（strictAllowlist + allowedModels + blockedModels）
    // 统一在解析出最终 provider/model 之后执行。
    if (requested && describeModelRuleState(this.config, requested).blocked) {
      assertSwarmModelAllowed(this.config, requested);
    }
    const resolved = await this._resolveRequestedModelRoute(requestedModel, fallbackRoute);
    assertSwarmModelAllowed(
      this.config,
      { ...resolved, requested },
      { inherited: requested === '' }
    );
    return resolved;
  }

  /**
   * 宿主**实时注册**的 provider 名字集合（小写）。
   *
   * 返回 `null` 表示没有权威名单（宿主没挂 llm 服务、或读取失败）：
   * 此时调用方跳过 provider 校验，退回「按 `provider/model` 原样透传」的宽松行为，
   * 纯 Node 离线单测与极简宿主因此都不会被误伤。
   */
  async _listRegisteredProviderIds() {
    const llm = this.ctx?.get?.('llm') || this.ctx?.llm;
    if (!llm || typeof llm.listProviders !== 'function') return null;
    let providers = [];
    try {
      providers = (await llm.listProviders()) || [];
    } catch {
      return null;
    }
    const ids = new Set();
    for (const item of Array.isArray(providers) ? providers : []) {
      const id = typeof item === 'string' ? item : item?.id || item?.provider;
      if (typeof id === 'string' && id.trim()) ids.add(id.trim().toLowerCase());
    }
    return ids;
  }

  /** 原始路由解析（不含权限闸门）：仅供 `resolveRequestedModel` 与内部诊断使用。 */
  async _resolveRequestedModelRoute(requestedModel, fallbackRoute) {
    const clean = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const nativeCatalog = async () => this.listAvailableModels();
    if (!clean) {
      if (fallbackRoute?.provider && fallbackRoute?.model) {
        return {
          provider: fallbackRoute.provider,
          model: fallbackRoute.model,
          reasoningEffort: fallbackRoute.reasoningEffort || '',
          modelDisplay: `${fallbackRoute.provider}/${fallbackRoute.model}`,
        };
      }
      const catalog = await nativeCatalog();
      if (catalog.length > 0) {
        return {
          provider: catalog[0].provider,
          model: catalog[0].model,
          reasoningEffort: '',
          modelDisplay: catalog[0].key,
        };
      }
      return {
        provider: fallbackRoute?.provider || 'default',
        model: fallbackRoute?.model || 'default',
        reasoningEffort: fallbackRoute?.reasoningEffort || '',
        modelDisplay: 'default',
      };
    }

    const catalog = await nativeCatalog();
    const lower = clean.toLowerCase();

    const exactFull = catalog.find((m) => m.key.toLowerCase() === lower);
    if (exactFull) {
      return {
        provider: exactFull.provider,
        model: exactFull.model,
        reasoningEffort:
          exactFull.provider === fallbackRoute?.provider && exactFull.model === fallbackRoute?.model
            ? fallbackRoute?.reasoningEffort || ''
            : '',
        modelDisplay: exactFull.key,
      };
    }

    const modelMatches = catalog.filter(
      (m) => m.model.toLowerCase() === lower || m.name.toLowerCase() === lower
    );
    if (modelMatches.length > 0) {
      const preferred =
        modelMatches.find((m) => m.provider === fallbackRoute?.provider) || modelMatches[0];
      return {
        provider: preferred.provider,
        model: preferred.model,
        reasoningEffort:
          preferred.provider === fallbackRoute?.provider && preferred.model === fallbackRoute?.model
            ? fallbackRoute?.reasoningEffort || ''
            : '',
        modelDisplay: preferred.key,
      };
    }

    const slashIdx = clean.indexOf('/');
    if (slashIdx > 0 && slashIdx < clean.length - 1) {
      const provider = clean.slice(0, slashIdx);
      const model = clean.slice(slashIdx + 1);
      // 判定依据是宿主**实时注册的 provider 名字**，不是过滤后的模型条目：
      // 一个已注册 provider 的 listModels 可能返回空、抛错，或它的条目被派发权限过滤掉，
      // 这些都不该让它的合法模型被误判成「未配置 provider」；反过来，模型目录整体为空时
      // 一个从未注册的 provider（例如已移除的后端）也必须被稳定拒绝。
      const registeredProviders = await this._listRegisteredProviderIds();
      if (registeredProviders && !registeredProviders.has(provider.toLowerCase())) {
        throw new Error(
          `无法解析模型 "${clean}"：宿主未配置 provider "${provider}"（请用 swarm{action:"models"} 查看已配置模型）`
        );
      }
      return {
        provider,
        model,
        reasoningEffort: '',
        modelDisplay: `${provider}/${model}`,
      };
    }

    if (fallbackRoute?.provider) {
      return {
        provider: fallbackRoute.provider,
        model: clean,
        reasoningEffort: '',
        modelDisplay: `${fallbackRoute.provider}/${clean}`,
      };
    }

    throw new Error(
      `无法解析模型 "${clean}"：请传入 "provider/model" 格式或先调用 swarm{action:"models"} 查看已配置模型`
    );
  }

  /**
   * Resolve the fork seed for the CALLING session only.
   *
   * Cross-member forking is removed: only the coordinator may fork its OWN live
   * history (`fork: true`, or the compatible `fork: "coordinator"`). Any other
   * member name — or any non-coordinator caller — is rejected loudly instead of
   * silently sampling somebody else's conversation.
   */
  resolveCallerForkSeed(callerAgent, callerName, forkArg) {
    const raw = typeof forkArg === 'string' ? forkArg.trim() : forkArg;
    if (raw === undefined || raw === null || raw === false) return null;
    if (typeof raw === 'string' && (raw === '' || raw.toLowerCase() === 'false')) return null;

    const normalized = typeof raw === 'string' ? raw.toLowerCase() : raw;
    const allowed = normalized === true || normalized === 'true' || normalized === 'coordinator';
    if (!allowed || callerName !== 'coordinator') {
      throw new Error(
        '已移除跨成员分叉，fork 仅支持从当前 coordinator 会话分叉（请传 fork: true）'
      );
    }

    const sessionsSvc = this.ctx?.get?.('sessions') || this.ctx?.sessions;
    const liveSession = callerAgent?.session || sessionsSvc?.get?.(callerAgent?.id) || null;
    if (liveSession && typeof liveSession.snapshotEvents === 'function') {
      const events = liveSession.snapshotEvents();
      if (!events || events.length === 0) return { seed: [], inheritedEventCount: 0 };
      return buildBalancedForkSeed(events);
    }
    if (sessionsSvc && typeof sessionsSvc.fork === 'function' && liveSession) {
      const forked = sessionsSvc.fork(liveSession);
      const events = forked?.snapshotEvents?.() || [];
      return {
        seed: events,
        inheritedEventCount: forked?.inheritedEventCount ?? events.length,
      };
    }
    throw new Error('无法读取当前 coordinator 会话的活跃日志，无法执行 fork');
  }

  /** Point one child agent at a directory the host asked it to use. */
  async _setAgentWorkingDirectory(agent, cwd, signal) {
    if (!agent || !cwd) return false;
    const wd = this.ctx?.get?.('workingDirectory') || this.ctx?.workingDirectory;
    if (!wd || typeof wd.set !== 'function') return false;
    await wd.set(agent, cwd, signal);
    return true;
  }

  /**
   * Build the per-child host setup hook for `agents.create` / `agents.resume`.
   *
   * Preset inheritance is asymmetric on purpose:
   * - FRESH CREATE mirrors host `applyChildComposition`: the child inherits the
   *   caller's CURRENT composition through `composeFrom(childCtx, parentCtx)`,
   *   not an immutable old `header.agentPreset` string. `mount` is only the
   *   fallback when `composeFrom` (or the parent ctx) is unavailable.
   * - COLD RESUME restores the member's OWN preset first
   *   (`child.header.agentPreset || member.agentPreset`); a helper must never be
   *   silently rewritten into the coordinator's preset.
   *
   * Security events are written WITHOUT any swallowing try/catch: a failed
   * `session.append` (ENOSPC, readonly session) must abort `agents.create`
   * instead of producing a child that runs with a missing `approval: never`
   * pin or, worse, an inherited `danger-full-access` fork seed.
   */
  _buildWorkerSetup({
    store,
    coordinatorSessionId,
    member,
    agentOptions,
    isFork,
    isCreate,
    delegatedPolicies = {},
    parentAgent = null,
    parentAgentPreset = '',
    signal,
  }) {
    return async (childCtx, child) => {
      const presetsSvc = childCtx?.get?.('agentPresets') || childCtx?.agentPresets;

      if (isCreate) {
        // Exact host parity: inherit the live parent composition.
        if (presetsSvc && parentAgent?.ctx && typeof presetsSvc.composeFrom === 'function') {
          presetsSvc.composeFrom(childCtx, parentAgent.ctx);
        } else if (
          presetsSvc &&
          parentAgentPreset &&
          typeof presetsSvc.mount === 'function'
        ) {
          await presetsSvc.mount(childCtx, parentAgentPreset);
        }
      } else {
        // Cold resume: the member's own preset wins over the coordinator's.
        const ownPreset = child?.session?.header?.agentPreset || member.agentPreset;
        if (presetsSvc && ownPreset && typeof presetsSvc.mount === 'function') {
          await presetsSvc.mount(childCtx, ownPreset);
        } else if (
          presetsSvc &&
          !ownPreset &&
          parentAgent?.ctx &&
          typeof presetsSvc.composeFrom === 'function'
        ) {
          presetsSvc.composeFrom(childCtx, parentAgent.ctx);
        }
      }

      if (isCreate) {
        const appendEvent = typeof child?.session?.append === 'function'
          ? (type, data) => child.session.append(type, data)
          : null;
        // A fork seed can carry a wide grant; so can any session created under
        // security services. Refusing to run without a durable append is the
        // only honest outcome — never "run anyway".
        if (!appendEvent && (isFork || delegatedPolicies.hasSecurityServices === true)) {
          throw new Error(
            `无法在缺少 session.append 的子会话上持久化安全约束（成员 "${member.name}"，fork=${String(
              Boolean(isFork)
            )}）：已拒绝创建可能继承宽权限的子会话`
          );
        }
        if (appendEvent) {
          const ownPreset =
            typeof parentAgentPreset === 'string' && parentAgentPreset
              ? parentAgentPreset
              : member.agentPreset;
          if (typeof ownPreset === 'string' && ownPreset) {
            appendEvent('agent-preset/selected', { agentPreset: ownPreset });
          }
          // Host 0.2.2 continuation contract: a v3 `continuable` descriptor
          // accepts { version, mode, provider, label } plus the optional
          // agentProvider / agentModel / agentReasoningEffort triple. Every
          // optional key must be a NON-EMPTY string, so they are omitted (never
          // sent as '') when the host did not resolve them.
          appendEvent('subagent/descriptor', {
            version: 3,
            mode: 'continuable',
            provider: isFork ? 'fork' : 'spawn',
            label: member.name,
            ...(agentOptions?.provider ? { agentProvider: agentOptions.provider } : {}),
            ...(agentOptions?.model ? { agentModel: agentOptions.model } : {}),
            ...(agentOptions?.reasoningEffort
              ? { agentReasoningEffort: agentOptions.reasoningEffort }
              : {}),
          });
          // The captured delegation policy lands after any fork seed, so a
          // stale wide grant in the seed can never widen this child. An
          // UNRESOLVED mode still refuses to fork a seed that carries one.
          if (delegatedPolicies.sandboxMode !== undefined) {
            appendEvent('sandbox/mode', {
              mode: delegatedPolicies.sandboxMode,
              source: 'delegation',
            });
          } else if (isFork) {
            // Defence in depth for the P0-A path: a seed that already carries a
            // security event can only be safely constrained by an explicitly
            // resolved caller mode. Without one, refuse instead of inheriting.
            const seededTypes =
              typeof child?.session?.snapshotEvents === 'function'
                ? child.session.snapshotEvents()
                : [];
            const inheritsSecurity = Array.isArray(seededTypes)
              ? seededTypes.some(
                  (ev) => ev?.type === 'sandbox/mode' || ev?.type === 'permission/preset'
                )
              : false;
            if (inheritsSecurity) {
              throw new Error(
                `拒绝 fork：无法确定调用方的有效沙盒模式（sandboxPolicy 服务缺失），不能覆盖源成员历史中的 ` +
                  `sandbox/mode 或 permission/preset 种子（成员 "${member.name}"）`
              );
            }
          }
          if (delegatedPolicies.approvalPolicy !== undefined) {
            appendEvent('approval/policy', {
              policy: delegatedPolicies.approvalPolicy,
              source: 'delegation',
            });
          }
          if (delegatedPolicies.permissionPreset !== undefined) {
            appendEvent('permission/preset', {
              preset: delegatedPolicies.permissionPreset,
            });
          }
        }
        try {
          const wd = childCtx?.get?.('workingDirectory') || childCtx?.workingDirectory;
          if (wd && typeof wd.set === 'function' && member.cwd) {
            await wd.set(child, member.cwd, signal);
          }
        } catch {
          // ignore
        }
      }

      // Belt-and-braces: a CHILD-scoped `agent/status` listener keeps the roster
      // correct even when the global scope dispatch (or carrierKeyOf) is not
      // available in this host build. Only this member's own session is touched.
      if (typeof childCtx?.on === 'function') {
        childCtx.on('agent/status', (payload) => {
          const status = payload?.status;
          if (status !== 'running' && status !== 'idle') return;
          const current = store.getMemberBySessionId(member.sessionId);
          if (!current || current.killed) return;
          if (status === 'running') {
            store.updateMemberRuntimeState(member.sessionId, { state: 'working' });
          } else {
            this.handleMemberIdle(member.sessionId);
          }
        });
      }
    };
  }

  /**
   * Resolve the swarm member behind one host Agent, when that agent is a live
   * (not killed) non-coordinator Worker of some swarm.
   */
  resolveWorkerMember(agent) {
    const sessionId = agent?.id || agent?.session?.id || agent?.session?.header?.id;
    if (!sessionId) return null;
    const resolved = this.stores.resolveSession(sessionId);
    if (!resolved) return null;
    const member = resolved.store.getMember(resolved.memberName);
    if (!member || member.killed || member.role === 'coordinator') return null;
    return { store: resolved.store, member, coordinatorSessionId: resolved.coordinatorSessionId };
  }

  /**
   * Host-level `systemPrompt` section text: the Swarm worker brief for exactly
   * this agent, or '' for every other session (host skips empty sections).
   */
  getWorkerSystemPromptForAgent(agent) {
    const resolved = this.resolveWorkerMember(agent);
    if (!resolved) return '';
    const { member, coordinatorSessionId } = resolved;
    return buildWorkerSystemPrompt({
      memberName: member.name,
      coordinatorSessionId,
      addedBy: member.addedBy,
      workspace: member.workspace,
      cwd: member.cwd,
      channels: member.channels,
      isMonitor: isMonitorRoleOrName(member.name, member.role),
    });
  }

  /** Host-level `when` gate for the Monitor-only tools. */
  isMonitorAgent(agent) {
    const resolved = this.resolveWorkerMember(agent);
    if (!resolved) return false;
    return isMonitorRoleOrName(resolved.member.name, resolved.member.role);
  }

  /** Resolve the calling Monitor member or refuse (never silently no-op). */
  _requireActiveMonitor(exec) {
    const resolved = this.resolveWorkerMember(exec?.agent);
    if (!resolved) {
      throw new Error('schedule / manage_task 仅对活跃的 Swarm Monitor 成员可用');
    }
    const { store, member } = resolved;
    if (!isMonitorRoleOrName(member.name, member.role)) {
      throw new Error('schedule / manage_task 仅对活跃的 Swarm Monitor 成员可用');
    }
    return { store, member };
  }

  async executeMonitorScheduleTool(args, exec) {
    const { store, member } = this._requireActiveMonitor(exec);
    if (store.state.done || member.killed || this.disposed) {
      return { status: 'ignored', reason: 'swarm already done or monitor stopped' };
    }
    const taskId = `monitor-task-${++this._taskSeq}`;
    let perSession = this.monitorTasks.get(member.sessionId);
    if (!perSession) {
      perSession = new Map();
      this.monitorTasks.set(member.sessionId, perSession);
    }

    const isCron = typeof args.CronExpression === 'string' && args.CronExpression.trim() !== '';
    const delayMs = isCron
      ? parseCronIntervalMs(args.CronExpression)
      : clampTimerDelay(Number(args.DurationSeconds || 60) * 1000);

    const trigger = () => {
      if (this.disposed || member.killed || store.state.done) {
        this._cancelMonitorTask(member.sessionId, taskId);
        return;
      }
      if (member.state === 'working') return;
      this._deliverPromptToMember(
        store,
        member,
        `[schedule ${taskId}] ${args.Prompt}\n(当前留言板最新序号 #${store.state.head}，请先调用 read_board{status:true} 检查集群状态)`
      ).catch(() => {});
    };

    const handle = isCron
      ? setInterval(trigger, delayMs)
      : setTimeout(() => {
          perSession.delete(taskId);
          // A fired one-shot must not leave an empty Map keyed by the session:
          // the guard keeps a concurrently re-created map authoritative.
          if (perSession.size === 0 && this.monitorTasks.get(member.sessionId) === perSession) {
            this.monitorTasks.delete(member.sessionId);
          }
          trigger();
        }, delayMs);
    handle.unref?.();

    perSession.set(taskId, {
      TaskId: taskId,
      kind: isCron ? 'cron' : 'timer',
      expression: isCron ? args.CronExpression : `${delayMs / 1000}s`,
      isDaemon: Boolean(args.IsDaemon),
      prompt: args.Prompt,
      handle,
      isCron,
    });

    return {
      status: 'scheduled',
      TaskId: taskId,
      intervalMs: delayMs,
    };
  }

  async executeMonitorManageTaskTool(args, exec) {
    const { member } = this._requireActiveMonitor(exec);
    const perSession = this.monitorTasks.get(member.sessionId);
    if (args.Action === 'list') {
      const tasks = perSession
        ? [...perSession.values()].map((t) => ({
            TaskId: t.TaskId,
            kind: t.kind,
            expression: t.expression,
            isDaemon: t.isDaemon,
          }))
        : [];
      return { tasks };
    }
    if (args.Action === 'status') {
      const item = perSession?.get(args.TaskId);
      return item
        ? { TaskId: item.TaskId, status: 'running', expression: item.expression }
        : { TaskId: args.TaskId || '', status: 'not_found' };
    }
    if (args.Action === 'kill') {
      const removed = this._cancelMonitorTask(member.sessionId, args.TaskId);
      return { TaskId: args.TaskId || '', killed: removed };
    }
    throw new Error(`未知的 manage_task Action: ${String(args.Action)}`);
  }

  _cancelMonitorTask(sessionId, taskId) {
    const perSession = this.monitorTasks.get(sessionId);
    if (!perSession) return false;
    const item = perSession.get(taskId);
    if (!item) return false;
    if (item.isCron) clearInterval(item.handle);
    else clearTimeout(item.handle);
    perSession.delete(taskId);
    if (perSession.size === 0) this.monitorTasks.delete(sessionId);
    return true;
  }

  _clearMonitorTasksForSession(sessionId) {
    const perSession = this.monitorTasks.get(sessionId);
    if (!perSession) return;
    for (const taskId of [...perSession.keys()]) {
      this._cancelMonitorTask(sessionId, taskId);
    }
    // Also drop an already-empty map so no sessionId key can linger.
    this.monitorTasks.delete(sessionId);
  }

  _clearAllMonitorTasksForSwarm(store) {
    for (const m of store.state.members) {
      if (isMonitorRoleOrName(m.name, m.role)) {
        this._clearMonitorTasksForSession(m.sessionId);
      }
    }
  }

  async _ensureMemberLiveAgent(store, member) {
    const agentsSvc = this.ctx?.get?.('agents') || this.ctx?.agents;
    const live =
      agentsSvc?.get?.(member.sessionId) || this.liveHandles.get(member.sessionId)?.agent;
    if (live) {
      await this._applyPendingModelSync(member, live);
      return live;
    }

    if (member.role === 'coordinator') {
      const sc = this.ctx?.get?.('sessionController') || this.ctx?.sessionController;
      if (sc && typeof sc.resolveAgent === 'function') {
        const res = await sc.resolveAgent(member.sessionId);
        if (res?.agent) {
          await this._applyPendingModelSync(member, res.agent);
          return res.agent;
        }
      }
      throw new Error(`主会话 coordinator (${member.sessionId}) 当前未加载`);
    }

    if (!agentsSvc || typeof agentsSvc.resume !== 'function') {
      throw new Error(`宿主未提供 ctx.agents.resume，无法唤醒冷态成员 "${member.name}"`);
    }

    const depth =
      Number.isSafeInteger(member.delegationDepth) && member.delegationDepth >= 0
        ? member.delegationDepth
        : undefined;
    const agentOptions = {
      ...(member.provider ? { provider: member.provider } : {}),
      ...(member.model ? { model: member.model } : {}),
      ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}),
      // The host reads `max(header.delegationDepth, options.subagentDepth)`, so a
      // cold resume MUST re-seed the real depth. Otherwise the resumed child
      // reports depth 0 and can spawn past MAX_SWARM_DELEGATION_DEPTH.
      ...(depth !== undefined ? { subagentDepth: depth } : {}),
    };
    const coordAgent = agentsSvc.get?.(store.coordinatorSessionId);
    const opAbort = this._memberAbort(member.sessionId);

    // Track the WHOLE lifecycle — including a late `handle.dispose()` — so
    // `await controller.dispose()` can never resolve while a rejected resume is
    // still tearing its handle down in the background.
    const handle = await this._trackOp(
      (async () => {
        const resumed = await agentsSvc.resume({
          resumeSessionId: member.sessionId,
          ...(coordAgent ? { parentAgent: coordAgent } : {}),
          agentOptions,
          signal: opAbort.signal,
          setup: this._buildWorkerSetup({
            store,
            coordinatorSessionId: store.coordinatorSessionId,
            member,
            agentOptions,
            isFork: false,
            isCreate: false,
            parentAgent: coordAgent,
            // The member's OWN preset, never the coordinator's.
            parentAgentPreset: member.agentPreset || '',
            signal: opAbort.signal,
          }),
        });
        const latestMember = store.getMemberBySessionId(member.sessionId);
        if (this.disposed || store.closed || latestMember?.killed || opAbort.signal.aborted) {
          try {
            await resumed?.dispose?.();
          } catch {
            // ignore late-handle teardown failure
          }
          throw new Error(
            `成员 "${member.name}" 的冷恢复在完成前已被取消（killed / controller dispose），迟到句柄已释放`
          );
        }
        return resumed;
      })()
    );

    if (handle) {
      this.liveHandles.set(member.sessionId, handle);
    }
    const agent = handle?.agent || agentsSvc.get?.(member.sessionId);
    await this._applyPendingModelSync(member, agent);
    return agent;
  }

  /** Apply a model switch requested while the member was cold. */
  async _applyPendingModelSync(member, agent) {
    if (!agent || !member) return false;
    const patch = {
      provider: member.provider,
      model: member.model,
      ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}),
    };
    const current =
      typeof agent.model?.current === 'function' ? agent.model.current() : agent.model?.current;
    const mismatched =
      Boolean(member.model) &&
      Boolean(current) &&
      (current.provider !== member.provider || current.model !== member.model);
    if (!member.pendingModelSync && !mismatched) return false;
    try {
      const applied = await this._selectAgentModel(agent, patch);
      if (applied) {
        const store = this.stores.resolveSession(member.sessionId)?.store;
        store?.clearPendingModelSync(member.name);
      }
      return applied;
    } catch (err) {
      throw new Error(
        `冷态成员 "${member.name}" 恢复后应用待同步模型失败：${extractErrorMessage(err)}`
      );
    }
  }

  /** Call the host model selection seam, falling back to test doubles. */
  async _selectAgentModel(agent, selection) {
    if (!agent) return false;
    if (agent.model && typeof agent.model.select === 'function') {
      await agent.model.select(selection);
      return true;
    }
    if (typeof agent.setModel === 'function') {
      await agent.setModel(selection);
      return true;
    }
    return false;
  }

  async _deliverPromptToMember(store, member, text, senderSessionId, deliveryOptions = {}) {
    const live = await this._ensureMemberLiveAgent(store, member);
    // The await above is a cancellation window. A kill (or controller dispose)
    // landing inside it must never be followed by a followup that reports
    // "woken" for a member that is already dead.
    const fresh = store.getMember(member.name);
    if (
      this.disposed ||
      store.closed ||
      !fresh ||
      fresh.killed ||
      this._isMemberAborted(member.sessionId)
    ) {
      throw new Error(`成员 "${member.name}" 在投递前已被取消（killed / disposed），拒绝 followup`);
    }
    if (!live || typeof live.followup !== 'function') {
      throw new Error(`成员 "${member.name}" 会话不支持 followup 投递`);
    }
    live.followup(makeUserMessage(text, senderSessionId));
    store.updateMemberRuntimeState(member.sessionId, { state: 'working', lastError: '' });
  }

  _formatWakeText(store, batch, stalledMembers = []) {
    const formatted = batch
      .map((m) => {
        const chTag = m.channel && m.channel !== 'main' ? ' [#' + m.channel + ']' : '';
        return '#' + m.seq + chTag + ' (' + m.agent + ', ' + m.time + '):\n' + m.text;
      })
      .join('\n\n---\n\n');
    const lines = ['[swarm] 留言板新消息通知（当前最新 #' + store.state.head + '）：'];
    if (formatted) {
      lines.push('', formatted);
    }
    if (Array.isArray(stalledMembers) && stalledMembers.length > 0) {
      lines.push(
        '',
        '⚠️ 注意：你等待的成员 [' +
          stalledMembers.join(', ') +
          '] 已停止运行但尚未发布新留言（可能发生报错或提前休眠），请先调用 read_board{status: true} 检查成员状态。'
      );
    }
    lines.push(
      '',
      '处理完毕后，若需回复同伴请调用 post_message（带 @名字），无后续工作时调用 swarm_wait{since: ' +
        store.state.head +
        ', mentions_only: true} 休眠。'
    );
    return lines.join('\n');
  }

  _maybeReleaseDoneStoreLock(store) {
    if (!store || !store.state?.done) return false;
    const anyWorking = store.state.members.some(
      (m) => !m.killed && (m.state === 'working' || store._wakingMembers.has(m.name))
    );
    if (anyWorking) return false;
    return store.releaseWriterLock();
  }

  /**
   * Nudge a currently running member at its next step boundary via `agent.inject`
   * without starting an extra turn. Durable `pendingWakeup` remains the fallback
   * if the current turn is already finishing; if the member calls `read_board`
   * on the next step, its advanced `lastReadSeq` prevents duplicate replay at idle.
   */
  _notifyBusyMemberNextStep(store, member, message) {
    if (this.disposed || store.state.done || !member || member.killed) return false;
    const agentsSvc = this.ctx?.get?.('agents') || this.ctx?.agents;
    const live =
      this.liveHandles.get(member.sessionId)?.agent || agentsSvc?.get?.(member.sessionId);
    if (!live || live.status !== 'running' || typeof live.inject !== 'function') {
      return false;
    }
    try {
      const queuedNextStep = live.inbox?.nextStep;
      if (
        Array.isArray(queuedNextStep) &&
        queuedNextStep.some((m) =>
          Array.isArray(m?.content) &&
          m.content.some(
            (b) => typeof b?.text === 'string' && b.text.startsWith('[swarm] 留言板实时提醒：')
          )
        )
      ) {
        return false;
      }
      const notice = [
        `[swarm] 留言板实时提醒：@${message.agent} 发布了针对你的新消息 #${message.seq}（当前最新 #${store.state.head}）。`,
        `请在本步结束后立即调用 read_board{since: ${member.lastReadSeq || 0}} 阅读最新变更，避免按过期假设继续执行。`,
      ].join('\n');
      live.inject(makeUserMessage(notice, store.coordinatorSessionId));
      return true;
    } catch {
      return false;
    }
  }

  _wakeUnblockedWaiters(store) {
    if (this.disposed || !store || store.state.done) return;
    const unblocked = store.collectUnblockedWaiters();
    for (const waiter of unblocked) {
      Promise.resolve()
        .then(() => this._wakeMember(store, waiter))
        .catch(() => {});
    }
  }

  /**
   * Deliver one wake batch with the two-phase cursor protocol:
   * peek -> deliver -> ack (success) / fail (cursor preserved, pending kept).
   */
  async _wakeMember(store, member) {
    if (this.disposed || member.killed || store.state.done) {
      return { name: member.name, woken: false, reason: 'member_unavailable' };
    }
    const began = store.beginWakeDelivery(member.name);
    if (!began) {
      return { name: member.name, woken: false, reason: 'no_new_messages' };
    }
    try {
      await this._deliverPromptToMember(
        store,
        member,
        this._formatWakeText(store, began.batch, began.stalledMembers)
      );
      store.ackWakeDelivery(member.name, began.maxSeq);
      return { name: member.name, woken: true, delivered_seq: began.maxSeq };
    } catch (err) {
      const message = extractErrorMessage(err) || 'unknown wake failure';
      try {
        store.failWakeDelivery(member.name, message, 'stopped');
        this._wakeUnblockedWaiters(store);
      } catch {
        // The board may already be closing during teardown; the failure is
        // still reported to the caller.
      }
      return { name: member.name, woken: false, error: message };
    }
  }

  /**
   * Single idle transition: park the member, then re-deliver a doorbell that
   * arrived while it was working (or unblock any peer waiting on a wait_for barrier).
   */
  handleMemberIdle(sessionId) {
    if (this.disposed) return;
    const resolved = this.stores.resolveSession(sessionId);
    if (!resolved) return;
    const store = resolved.store;
    const member = store.getMemberBySessionId(sessionId);
    if (!member || member.killed) return;
    if (store.state.done) {
      store.updateMemberRuntimeState(sessionId, {
        state: 'stopped',
        activity: '',
        pendingWakeup: false,
      });
      this._maybeReleaseDoneStoreLock(store);
      return;
    }
    store.updateMemberRuntimeState(sessionId, { state: 'waiting', activity: '' });
    const pending = member.pendingWakeup === true || store.hasUnreadDoorbell(member);
    if (pending) {
      Promise.resolve()
        .then(() => this._wakeMember(store, member))
        .catch(() => {
          // _wakeMember already records the failure on the board
        });
    }
    this._wakeUnblockedWaiters(store);
  }

  async executeSwarmTool(args, exec) {
    const action = String(args?.action || '').trim().toLowerCase();
    if (!action) {
      throw new Error('swarm 工具必须指定 action（status | models | add | model | kill | title | channel）');
    }

    if (action === 'models') {
      const callerRoute = readAgentModelRoute(exec?.agent);
      const showAll = Boolean(args?.all);
      const allModels = await this.listAvailableModels();
      const filtered = showAll ? allModels : allModels.slice(0, 24);
      return {
        current_model:
          callerRoute.provider && callerRoute.model
            ? `${callerRoute.provider}/${callerRoute.model}`
            : null,
        total_configured: allModels.length,
        models: filtered,
      };
    }

    const createIfCoord =
      action === 'add' || action === 'title' || action === 'channel' || action === 'status';
    const { store, coordinatorSessionId, callerName, agent: callerAgent } = this.resolveCaller(
      exec,
      createIfCoord
    );

    if (action === 'status') {
      const boardStatus = store.readBoard(callerName, { status: true });
      return {
        ...boardStatus,
        coordinator_session_id: coordinatorSessionId,
        panel_uri: buildSwarmResourceUri(coordinatorSessionId),
        graph_uri: buildSwarmResourceUri(coordinatorSessionId, 'graph'),
      };
    }

    if (action === 'title') {
      const res = store.setTitle(callerName, args.title);
      syncHostSessionTitle(this.ctx, callerAgent, res.title);
      return {
        status: 'ok',
        title: res.title,
        panel_uri: buildSwarmResourceUri(coordinatorSessionId),
      };
    }

    if (action === 'channel') {
      const subAction = args.channel_action || args.subaction || 'list';
      return store.manageChannel(callerName, {
        channelAction: subAction,
        channel: args.channel,
        topic: args.topic,
        member: args.member || args.name,
      });
    }

    if (action === 'kill') {
      const targetName = String(args?.name || '').trim().toLowerCase();
      if (!targetName) throw new Error('swarm kill 必须指定目标成员 name');
      const { member, alreadyKilled } = store.markMemberKilled(callerName, targetName);
      this._clearMonitorTasksForSession(member.sessionId);
      this._abortMember(member.sessionId, 'killed by swarm');

      const liveHandle = this.liveHandles.get(member.sessionId);
      const agentsSvc = this.ctx?.get?.('agents') || this.ctx?.agents;
      const liveAgent = liveHandle?.agent || agentsSvc?.get?.(member.sessionId);
      this._cancelAgent(liveAgent, 'killed by swarm');
      if (liveHandle) {
        this.liveHandles.delete(member.sessionId);
        try {
          await liveHandle.dispose?.();
        } catch {
          // ignore
        }
      }

      // No manual worktree teardown: a `share` worktree belongs to the host's
      // WorktreeReclamation, which archives the session and only then removes a
      // tree with no uncommitted changes. Swarm never deletes user code.
      this._wakeUnblockedWaiters(store);
      this._maybeReleaseDoneStoreLock(store);

      return {
        status: alreadyKilled ? 'already_killed' : 'killed',
        name: member.name,
        workspace_cleaned: false,
      };
    }

    if (action === 'model') {
      const targetName = args?.name
        ? String(args.name).trim().toLowerCase()
        : callerName;
      store.assertPermission(callerName, 'model', targetName);

      const callerRoute = readAgentModelRoute(callerAgent);
      const resolvedModel = await this.resolveRequestedModel(args?.model, callerRoute);
      const currentMember = store.getMember(targetName);
      const agentsSvc = this.ctx?.get?.('agents') || this.ctx?.agents;
      const targetAgent =
        (currentMember.sessionId === callerAgent?.id ? callerAgent : null) ||
        agentsSvc?.get?.(currentMember.sessionId) ||
        this.liveHandles.get(currentMember.sessionId)?.agent;

      const selection = {
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        ...(resolvedModel.reasoningEffort
          ? { reasoningEffort: resolvedModel.reasoningEffort }
          : {}),
      };

      // A live agent switches first and only then updates the board: a failed
      // hot switch must not leave a fake "switched" record behind.
      let pendingModelSync = false;
      if (targetAgent) {
        const applied = await this._selectAgentModel(targetAgent, selection);
        if (!applied) {
          throw new Error(
            `成员 "${currentMember.name}" 的活跃 Agent 未提供 model.select，无法无损热切换模型`
          );
        }
      } else {
        // Cold member: never call the host sessionController (it rejects cold
        // sessions). Persist the intent and apply it right after the resume.
        pendingModelSync = true;
      }

      const { member, previousModelDisplay } = store.setMemberModel(
        callerName,
        targetName,
        resolvedModel,
        { pendingModelSync }
      );

      if (member.name !== callerName && member.lastError) {
        await this._deliverPromptToMember(
          store,
          member,
          `[swarm] 你的运行模型已由 @${callerName} 从 ${previousModelDisplay} 切换为 ${resolvedModel.modelDisplay}，对话历史完整保留，请继续未完成的工作。`,
          store.coordinatorSessionId
        );
      }

      return {
        status: 'switched',
        name: member.name,
        previous_model: previousModelDisplay,
        model: resolvedModel.modelDisplay,
        pending_model_sync: pendingModelSync,
      };
    }

    if (action === 'add') {
      // The WHOLE add body is one tracked in-flight operation: controller
      // dispose() must wait for it (including any late handle.dispose()).
      return this._trackOp(
        this._runAdd({ store, coordinatorSessionId, callerName, callerAgent, args, exec })
      );
    }

    throw new Error(
      `未知的 swarm action "${action}"（支持 status | models | add | model | kill | title | channel）`
    );
  }

  /**
   * Create one or more members.
   *
   * Contract points enforced here:
   * - The real delegation depth is `max(header.delegationDepth, subagentDepth)`
   *   and is persisted on the member + passed as `agentOptions.subagentDepth`.
   * - Every security-relevant `session.append` is mandatory (see setup): a
   *   failed append aborts the creation.
   * - After `resolveRequestedModel` awaits, a disposed/closed controller aborts
   *   BEFORE any workspace is prepared or child agent is created.
   * - A `share` worktree is created on the CHILD agent after the cancellation
   *   gate, and any later failure disposes the fresh handle so no live agent
   *   and no roster row survive a failed add.
   */
  async _runAdd({ store, coordinatorSessionId, callerName, callerAgent, args, exec }) {
    const specs = expandAddSpecs({
      name: args.name,
      brief: args.brief,
      n: args.n,
      tasks: args.tasks,
    });

    const agentsSvc = this.ctx?.get?.('agents') || this.ctx?.agents;
    if (!agentsSvc || typeof agentsSvc.create !== 'function') {
      throw new Error('宿主未提供 ctx.agents.create，无法创建 Swarm Worker 会话');
    }
    const coordAgent =
      (callerName === 'coordinator' ? callerAgent : null) || agentsSvc?.get?.(coordinatorSessionId);

    // ---- Everything below up to the first await is synchronous on purpose:
    // the real depth and the caller policy capture must describe the caller as
    // it is right now, not after a later parent switch.
    const creatorAgent = callerAgent;
    const parentDepth = readAgentDelegationDepth(creatorAgent);
    const childDepth = parentDepth + 1;
    if (childDepth > MAX_SWARM_DELEGATION_DEPTH) {
      throw new Error(
        `Swarm 委派深度超限：调用方有效深度 ${parentDepth}，派生子成员后为 ${childDepth}，超过上限 ${MAX_SWARM_DELEGATION_DEPTH}`
      );
    }
    const delegatedPolicies = captureDelegatedPolicyOverrides(creatorAgent);
    const presetsSvc = this.ctx?.get?.('agentPresets') || this.ctx?.agentPresets;
    const composedPreset = presetsSvc?.composedPreset?.(creatorAgent?.ctx);
    const memberPresetRaw = composedPreset ?? creatorAgent?.session?.header?.agentPreset;
    const memberPreset =
      typeof memberPresetRaw === 'string' && memberPresetRaw ? memberPresetRaw : '';
    // Validate the workspace mode before any await: an unsupported mode must
    // never reach a model catalog call, let alone a worktree or child session.
    const requestedWorkspace = normalizeWorkspaceMode(args.workspace);
    const reservedNames = [];
    try {
      for (const spec of specs) {
        if (store.getMember(spec.name)) {
          throw new Error(`成员 "${spec.name}" 已存在于花名册中`);
        }
        if (!this._reserveName(store, spec.name)) {
          throw new Error(
            `成员 "${spec.name}" 正在由另一个并发的 swarm add 创建中，请勿重复提交同名成员`
          );
        }
        reservedNames.push(spec.name);
      }

      const callerRoute = readAgentModelRoute(callerAgent);
      const coordMember = store.getMember('coordinator');
      const fallbackRoute =
        callerRoute.provider && callerRoute.model
          ? callerRoute
          : {
              provider: coordMember?.provider || '',
              model: coordMember?.model || '',
              reasoningEffort: coordMember?.reasoningEffort || '',
            };
      const resolvedModel = await this.resolveRequestedModel(args.model, fallbackRoute);

      // Cancellation gate: the model catalog await is a real window in which a
      // controller dispose (or kill) can land. Abort BEFORE allocating any
      // workspace or child session instead of leaking both.
      if (this.disposed || store.closed) {
        throw new Error('Swarm 控制器已关闭，中止创建成员');
      }

      // Only the CALLER's own history may be forked; a rejected fork target
      // fails before any child session or worktree is allocated.
      const forkData = this.resolveCallerForkSeed(callerAgent, callerName, args.fork);
      if (
        forkData &&
        delegatedPolicies?.sandboxMode === undefined &&
        Array.isArray(forkData.seed) &&
        forkData.seed.some((ev) => ev?.type === 'sandbox/mode' || ev?.type === 'permission/preset')
      ) {
        throw new Error(
          '拒绝 fork：协调员历史中含有 sandbox/mode 或 permission/preset 安全事件，' +
            '但调用方没有可解析的 sandboxPolicy 有效模式，拒绝创建可能继承宽权限的子会话'
        );
      }

      const baseCwd = readAgentCwd(this.ctx, callerAgent);
      const requestedChannels = Array.isArray(args.channels) ? args.channels : [];

      const addedMembers = [];

      for (const spec of specs) {
        const childSessionId = crypto.randomUUID();
        const opAbort = this._memberAbort(childSessionId);
        let createdHandle = null;
        let registeredMember = null;
        try {
          // Register with the CALLER's cwd first: a `share` member only learns
          // its worktree path once the host has created it on the child session.
          const member = store.registerMember({
            name: spec.name,
            sessionId: childSessionId,
            addedBy: callerName,
            provider: resolvedModel.provider,
            model: resolvedModel.model,
            modelDisplay: resolvedModel.modelDisplay,
            reasoningEffort: resolvedModel.reasoningEffort,
            workspace: requestedWorkspace,
            workspaceDir: '',
            cwd: baseCwd,
            channels: requestedChannels,
            delegationDepth: childDepth,
            agentPreset: memberPreset,
          });
          registeredMember = member;

          const agentOptions = {
            ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
            ...(resolvedModel.model ? { model: resolvedModel.model } : {}),
            ...(resolvedModel.reasoningEffort
              ? { reasoningEffort: resolvedModel.reasoningEffort }
              : {}),
            // Host depth is max(header.delegationDepth, options.subagentDepth).
            subagentDepth: childDepth,
          };

          const isSeeded = Boolean(forkData && forkData.seed.length > 0);
          const meta = {
            ...(baseCwd ? { cwd: baseCwd } : {}),
            ...(memberPreset ? { agentPreset: memberPreset } : {}),
            parentSession: coordinatorSessionId,
            isSeeded,
            origin: 'subagent',
            delegationDepth: childDepth,
          };

          const handle = await this._trackOp(
            (async () => {
              const created = await agentsSvc.create({
                sessionId: childSessionId,
                ...(coordAgent ? { parentAgent: coordAgent } : {}),
                meta,
                ...(forkData
                  ? {
                      seed: forkData.seed,
                      inheritedEventCount: forkData.inheritedEventCount,
                    }
                  : {}),
                agentOptions,
                signal: opAbort.signal,
                setup: this._buildWorkerSetup({
                  store,
                  coordinatorSessionId,
                  member,
                  agentOptions,
                  isFork: Boolean(forkData),
                  isCreate: true,
                  delegatedPolicies,
                  parentAgent: callerAgent,
                  parentAgentPreset: memberPreset,
                  signal: opAbort.signal,
                }),
              });
              const latestMember = store.getMemberBySessionId(childSessionId);
              if (this.disposed || store.closed || latestMember?.killed || opAbort.signal.aborted) {
                try {
                  await created?.dispose?.();
                } catch {
                  // ignore late-handle teardown failure
                }
                this.liveHandles.delete(childSessionId);
                throw new Error(
                  `成员 "${member.name}" 的创建在完成前已被取消（killed / controller dispose），迟到句柄已释放且未投递任何消息`
                );
              }
              return created;
            })()
          );
          createdHandle = handle;

          if (handle) {
            this.liveHandles.set(childSessionId, handle);
          }

          // A v3 NAMED catalog entry is only legal when the member name satisfies
          // the host `isAgentName` rule (lowercase alnum + '-', <=32 chars, never
          // 'lead', unique in this session); anything else falls back to v0.
          try {
            // Host `subagentCatalog` schema requires z.number().int().nonnegative().
            const rawCreatedAt = handle?.agent?.session?.header?.createdAt;
            const childCreatedAt =
              Number.isSafeInteger(rawCreatedAt) && rawCreatedAt >= 0 ? rawCreatedAt : Date.now();
            const takenNames = new Set();
            try {
              const parentEvents =
                typeof coordAgent?.session?.snapshotEvents === 'function'
                  ? coordAgent.session.snapshotEvents()
                  : [];
              for (const ev of Array.isArray(parentEvents) ? parentEvents : []) {
                if (ev?.type === 'subagent/catalog' && typeof ev?.data?.name === 'string') {
                  if (ev.data.name) takenNames.add(ev.data.name);
                }
              }
            } catch {
              // a read-only parent session simply contributes no reserved names
            }
            const namedOk =
              /^[a-z][a-z0-9-]{0,31}$/.test(member.name) &&
              member.name !== 'lead' &&
              !takenNames.has(member.name);
            coordAgent?.session?.append?.('subagent/catalog', {
              version: namedOk ? 3 : 0,
              childId: childSessionId,
              childCreatedAt,
              mode: 'continuable',
              label: member.name,
              ...(namedOk ? { name: member.name } : {}),
            });
          } catch {
            // ignore if mock coordinator session lacks append
          }

          if (requestedWorkspace === 'share') {
            // Host-native worktree. `ctx.worktrees.create(agent, ...)` switches
            // the PASSED agent's cwd and appends `plugin:worktree/created`, so it
            // must receive the freshly created CHILD agent — never the caller.
            const branchName = `swarm-${shortSha256(coordinatorSessionId, 8)}-${member.name}-${shortSha256(childSessionId, 4)}`;
            const childAgent = handle?.agent;
            if (!childAgent) {
              throw new Error(
                `成员 "${member.name}" 未返回可用的子代理句柄，无法创建 workspace:"share" 工作树`
              );
            }
            let wsPath = '';
            let wsDir = '';
            if (typeof this.config.workspacePrepare === 'function') {
              const customWs = await this.config.workspacePrepare({
                coordinatorSessionId,
                memberName: member.name,
                childSessionId,
                baseCwd,
                mode: 'share',
                branchName,
                agent: childAgent,
                signal: opAbort.signal,
              });
              wsPath = customWs?.path || customWs?.cwd || customWs?.workspaceDir || baseCwd;
              wsDir = customWs?.workspaceDir ?? wsPath;
              await this._setAgentWorkingDirectory(childAgent, wsPath, opAbort.signal);
            } else {
              const worktreesSvc = this.ctx?.get?.('worktrees') || this.ctx?.worktrees;
              if (!worktreesSvc || typeof worktreesSvc.create !== 'function') {
                throw new Error(
                  '宿主未提供 ctx.worktrees.create 服务，无法创建 workspace: "share" 隔离工作区'
                );
              }
              const wt = await worktreesSvc.create(childAgent, { name: branchName }, opAbort.signal);
              wsPath = wt?.path || '';
              wsDir = wsPath;
              if (!wsPath) {
                throw new Error(`ctx.worktrees.create 未返回工作树路径（分支 ${branchName}）`);
              }
            }
            const latest = store.getMemberBySessionId(childSessionId);
            if (this.disposed || store.closed || latest?.killed || opAbort.signal.aborted) {
              throw new Error(
                `成员 "${member.name}" 的隔离工作区创建在完成前已被取消（killed / controller dispose），未投递任何消息`
              );
            }
            member.cwd = wsPath;
            member.workspaceDir = wsDir;
            store._persistState();
          }

          member.state = 'working';
          const briefPost = store.postMessage(callerName, `@${member.name} ${spec.brief}`);
          member.lastReadSeq = briefPost.head;
          // The brief itself addressed this member; it must not stay pending.
          member.pendingWakeup = false;
          store._persistState();

          const workerAgent = handle?.agent || agentsSvc.get?.(childSessionId);
          if (workerAgent && typeof workerAgent.followup === 'function') {
            const initialPrompt = [
              `你已作为 \`${member.name}\` 启动。你的初始任务已记录在公共留言板 #${briefPost.message.seq}（由 @${callerName} 发布，当前留言板最新序号 #${briefPost.head}）：`,
              '',
              spec.brief,
              '',
              '完成后请在同一轮调用 post_message（带 @收件人）与 swarm_wait{since: <已读最大 seq>, mentions_only: true}。',
            ].join('\n');
            workerAgent.followup(makeUserMessage(initialPrompt, coordinatorSessionId));
          }

          addedMembers.push({
            name: member.name,
            sessionId: member.sessionId,
            model: member.modelDisplay,
            workspace: member.workspace,
            cwd: member.cwd,
            brief_seq: briefPost.message.seq,
          });
        } catch (err) {
          // Release the child handle this member just obtained, so a failed add
          // can never leak a live agent; the roster row is marked killed so the
          // failure stays auditable.
          if (createdHandle) {
            try {
              await createdHandle.dispose?.();
            } catch {
              // handle teardown is best effort
            }
            this.liveHandles.delete(childSessionId);
          }
          if (registeredMember) {
            try {
              if (!registeredMember.killed) {
                store.markMemberKilled('coordinator', registeredMember.name);
              }
            } catch {
              // rollback bookkeeping is best effort
            }
          }
          if (!registeredMember || registeredMember.killed) {
            this.memberAborts.delete(childSessionId);
          }
          throw err;
        }
      }

      const addResult = {
        status: 'added',
        coordinator_session_id: coordinatorSessionId,
        added: addedMembers,
        panel_uri: buildSwarmResourceUri(coordinatorSessionId),
        graph_uri: buildSwarmResourceUri(coordinatorSessionId, 'graph'),
      };

      // Optional one-step "spawn then sleep" for run_code/PTC callers: after
      // dispatching every new member, park the caller exactly like swarm_wait.
      if (args?.wait === true) {
        const callerMember = store.getMember(callerName);
        const callerCursor = Math.max(callerMember?.lastReadSeq || 0, callerMember?.waitSince || 0);
        const waitOutcome = store.prepareWait(callerName, {
          since: callerCursor,
          mentionsOnly: true,
          waitFor: args?.wait_for,
        });
        if (waitOutcome.action === 'immediate') {
          return {
            ...addResult,
            waiting: false,
            immediate_messages: waitOutcome.messages,
            ...(waitOutcome.stalled_members
              ? { stalled_members: waitOutcome.stalled_members }
              : {}),
            head: waitOutcome.head,
          };
        }
        if (typeof exec?.concludeTurn !== 'function') {
          throw new Error(
            '宿主未提供 exec.concludeTurn，swarm{action:"add", wait:true} 无法进入排他休眠（拒绝静默假休眠）'
          );
        }
        exec.concludeTurn();
        this._wakeUnblockedWaiters(store);
        return {
          ...addResult,
          waiting: true,
          since: waitOutcome.since,
          ...(waitOutcome.waitFor?.length > 0 ? { wait_for: waitOutcome.waitFor } : {}),
          head: waitOutcome.head,
        };
      }

      return addResult;
    } finally {
      for (const name of reservedNames) {
        this._releaseName(store, name);
      }
    }
  }

  async executePostMessageTool(args, exec) {
    const { store, callerName } = this.resolveCaller(exec, false);
    const outcome = store.postMessage(callerName, args.text, { channel: args.channel });
    const { message, head, markedDone } = outcome;

    if (markedDone) {
      this._clearAllMonitorTasksForSwarm(store);
      this._maybeReleaseDoneStoreLock(store);
      return {
        status: 'posted',
        seq: message.seq,
        channel: message.channel,
        marked_done: true,
        woken: [],
        head,
      };
    }

    const { woken, wakeErrors, pending, steered } = await this._dispatchPostWakes(store, outcome);

    return {
      status: 'posted',
      seq: message.seq,
      channel: message.channel,
      woken,
      ...(pending.length > 0 ? { pending_wakeup: pending } : {}),
      ...(steered.length > 0 ? { step_notified: steered } : {}),
      ...(wakeErrors.length > 0 ? { wake_errors: wakeErrors } : {}),
      head,
    };
  }

  /**
   * 把一次 postMessage 的门铃结果投递出去：忙碌成员下一步提醒 + 空闲成员唤醒。
   * 所有投递结算后才返回，"woken" 绝不谎报失败的唤醒。
   */
  async _dispatchPostWakes(store, outcome) {
    const { message, wakeTargets = [], pendingTargets = [] } = outcome;
    const steered = [];
    for (const busyMember of pendingTargets) {
      if (this._notifyBusyMemberNextStep(store, busyMember, message)) {
        steered.push(busyMember.name);
      }
    }
    const results = await Promise.all(
      wakeTargets.map((recipient) => this._wakeMember(store, recipient))
    );
    const woken = [];
    const wakeErrors = [];
    for (const result of results) {
      if (result.woken) woken.push(result.name);
      else if (result.error) wakeErrors.push({ name: result.name, error: result.error });
    }
    const pending = pendingTargets.map((m) => m.name);
    return { woken, wakeErrors, pending, steered };
  }

  async executeReadBoardTool(args, exec) {
    const { store, callerName } = this.resolveCaller(exec, false);
    return store.readBoard(callerName, {
      since: args?.since,
      limit: args?.limit,
      seqs: args?.seqs,
      channel: args?.channel,
      status: args?.status,
    });
  }

  async executeSwarmWaitTool(args, exec) {
    const { store, callerName } = this.resolveCaller(exec, false);
    const outcome = store.prepareWait(callerName, {
      since: args?.since,
      mentionsOnly: args?.mentions_only,
      waitFor: args?.wait_for,
    });

    if (outcome.action === 'immediate') {
      return {
        status: 'woken_immediately',
        head: outcome.head,
        messages: outcome.messages,
        ...(outcome.stalled_members ? { stalled_members: outcome.stalled_members } : {}),
      };
    }

    if (typeof exec?.concludeTurn !== 'function') {
      throw new Error(
        '宿主未提供 exec.concludeTurn，swarm_wait 无法进入排他休眠：拒绝静默返回 waiting 的假休眠'
      );
    }
    exec.concludeTurn();
    this._wakeUnblockedWaiters(store);

    return {
      status: 'waiting',
      since: outcome.since,
      wake_mode: outcome.wakeMode,
      ...(outcome.waitFor?.length > 0 ? { wait_for: outcome.waitFor } : {}),
      head: outcome.head,
    };
  }
}

function createSwarmTools(controller) {
  const swarmTool = buildToolCompat({
    name: 'swarm',
    description:
      'Manage the Swarm of agents collaborating on a shared message board. Actions: status, models, add, model, kill, title, channel.',
    isConcurrencySafe: () => false,
    executionMode: 'exclusive',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'models', 'add', 'model', 'kill', 'title', 'channel'],
        description: 'Operation: status, models, add, model, kill, title, or channel.',
      },
      name: {
        type: 'string',
        description: 'Member roster name (for add, model, kill) or base prefix when n > 1 / tasks is set.',
      },
      brief: {
        type: 'string',
        description: 'Public assignment posted as @<name> on the board when adding a worker.',
      },
      fork: {
        oneOf: [{ type: 'boolean' }, { type: 'string' }],
        description:
          'Pass true (or "coordinator") to fork conversation history from the current coordinator session.',
      },
      model: {
        type: 'string',
        description:
          'Optional model ("provider/model" or model ID) for add or model switch; omit on add to inherit the coordinator current DSH route. ' +
          'Any model configured in this DSH installation can be dispatched unless the Swarm model-dispatch settings forbid it; ' +
          'call swarm{action:"models"} to see the live catalog. ' +
          'A model disabled by those settings is rejected outright and never silently replaced.',
      },
      workspace: {
        type: 'string',
        enum: ['inherit', 'share'],
        description: 'Workspace mode for add: inherit (default) or share (host git worktree).',
      },
      n: {
        type: 'integer',
        description: 'Number of homogeneous copies (<name>-1 .. <name>-<n>) for add.',
      },
      tasks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Per-worker task shards (<name>-1 .. <name>-<k>) combined with brief for add.',
      },
      channels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Initial #channels to subscribe newly added worker(s) to (main is always included).',
      },
      title: {
        type: 'string',
        description: 'Short swarm title for the UI (coordinator only, for action:"title").',
      },
      all: {
        type: 'boolean',
        description: 'List every configured model across providers (for action:"models").',
      },
      channel_action: {
        type: 'string',
        enum: ['create', 'subscribe', 'unsubscribe', 'list', 'archive'],
        description: 'Sub-action when action:"channel".',
      },
      channel: {
        type: 'string',
        description: 'Channel name (without #) when action:"channel".',
      },
      topic: {
        type: 'string',
        description: 'Optional channel topic when creating a channel.',
      },
      member: {
        type: 'string',
        description: 'Target member name for channel subscribe/unsubscribe (defaults to caller).',
      },
      wait: {
        type: 'boolean',
        description:
          'Only for action:"add": after dispatching every new member, immediately park the caller like swarm_wait (concludeTurn) so one run_code step can spawn and sleep.',
      },
      wait_for: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional member names (or group prefixes) to wait for when wait: true; stays asleep until all listed members have posted (or stopped).',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const lines = [JSON.stringify(value, null, 2)];
        if (value?.status === 'added' && value?.panel_uri) {
          lines.push(
            '',
            `Swarm 侧栏链接：[打开 Swarm 面板](${value.panel_uri}) | [查看 @mention 拓扑图](${value.graph_uri})`
          );
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
      presentationMeta: (args, value) => ({
        action: args?.action || '',
        coordinatorSessionId: value?.coordinator_session_id || '',
        panelUri: value?.panel_uri || '',
        graphUri: value?.graph_uri || '',
        added: Array.isArray(value?.added) ? value.added.map((m) => m.name) : [],
        title: value?.title || '',
      }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Swarm · ${args?.action || 'action'}${args?.name ? ` (${args.name})` : ''}`,
      kind: 'other',
      content: [
        {
          type: 'text',
          text: args?.brief ? String(args.brief) : JSON.stringify(args || {}),
        },
      ],
    }),
    execute: (args, exec) => controller.executeSwarmTool(args, exec),
  });

  const postMessageTool = buildToolCompat({
    name: 'post_message',
    description:
      'Post a message to the shared Swarm message board. Include @<name>, @<prefix>, @#<channel>, or @all to wake sleeping recipients.',
    isConcurrencySafe: () => false,
    executionMode: 'exclusive',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'Message body to post on the board.',
      },
      channel: {
        type: 'string',
        description: 'Target channel name (defaults to "main").',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => controller.executePostMessageTool(args, exec),
  });

  const readBoardTool = buildToolCompat({
    name: 'read_board',
    description:
      'Read messages from the shared Swarm message board (oldest first). Pass the last seq you read as `since` to read incremental updates.',
    isConcurrencySafe: () => true,
    executionMode: 'parallel',
    parameters: {
      since: {
        type: 'integer',
        description: 'Return messages with seq > since (oldest first). Omit for most recent messages.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of messages to return (default 20).',
      },
      seqs: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Return exact messages by sequence number, ignoring since and limit.',
      },
      channel: {
        type: 'string',
        description: 'Optional single channel filter.',
      },
      status: {
        type: 'boolean',
        description: 'Return full member roster and cursor status instead of messages.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args, exec) => controller.executeReadBoardTool(args, exec),
  });

  const swarmWaitTool = buildToolCompat({
    name: 'swarm_wait',
    description:
      'Sleep at zero token cost until a board message arrives after `since` matching your wake filter. Concludes your turn immediately (exclusive barrier drains parallel post_message first).',
    isConcurrencySafe: () => false,
    executionMode: 'exclusive',
    parameters: {
      since: {
        type: 'integer',
        required: true,
        description: 'Highest board sequence number you have actually read (never pass unread head).',
      },
      mentions_only: {
        type: 'boolean',
        description: 'Wake only on @your-name, @your-prefix, @#your-channel, or @all (default true). Pass false to wake on any visible channel post.',
      },
      wait_for: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional member names or group prefixes: stay asleep until ALL listed members have posted after since (or stopped), then wake with the combined batch.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        if (value?.status === 'woken_immediately') {
          return [
            {
              type: 'text',
              text: `留言板在 #${args?.since} 之后已有满足条件的唤醒消息（未进入休眠）：\n${JSON.stringify(value, null, 2)}`,
            },
          ];
        }
        const waitTargets =
          Array.isArray(value?.wait_for) && value.wait_for.length > 0
            ? `，汇聚等待 [${value.wait_for.join(', ')}] 全员就绪`
            : '';
        return [
          {
            type: 'text',
            text: `已进入零消耗休眠（等待 #${value?.since} 之后的 ${value?.wake_mode === 'all' ? '任意可见消息' : '@点名或 @all 消息'}${waitTargets}）。`,
          },
        ];
      },
    },
    execute: (args, exec) => controller.executeSwarmWaitTool(args, exec),
  });

  // Monitor-only tools are registered ONCE at host level (see apply) and gated
  // by `when: ({ agent }) => controller.isMonitorAgent(agent)`; the execute path
  // resolves the calling monitor, so a non-monitor call is refused loudly.
  const scheduleTool = buildToolCompat({
    name: 'schedule',
    description:
      'Schedule a Swarm monitor recurring cron job (CronExpression) or one-shot timer (DurationSeconds) that wakes this monitor session.',
    isConcurrencySafe: () => false,
    parameters: {
      CronExpression: {
        type: 'string',
        description: '5-field cron expression (e.g. "*/3 * * * *")',
      },
      DurationSeconds: {
        type: 'integer',
        description: 'Seconds to wait for a one-shot timer',
      },
      IsDaemon: {
        type: 'boolean',
        description: 'Keep firing across turns until cancelled or swarm finishes',
      },
      Prompt: {
        type: 'string',
        required: true,
        description: 'Notification prompt delivered when triggered',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
    },
    execute: (args, exec) => controller.executeMonitorScheduleTool(args, exec),
  });

  const manageTaskTool = buildToolCompat({
    name: 'manage_task',
    description: 'List or kill active Swarm monitor scheduled tasks.',
    isConcurrencySafe: () => false,
    parameters: {
      Action: {
        type: 'string',
        required: true,
        enum: ['list', 'kill', 'status'],
        description: 'Action to perform: list, status, or kill',
      },
      TaskId: {
        type: 'string',
        description: 'TaskId returned by schedule',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
    },
    execute: (args, exec) => controller.executeMonitorManageTaskTool(args, exec),
  });

  return {
    swarmTool,
    postMessageTool,
    readBoardTool,
    swarmWaitTool,
    scheduleTool,
    manageTaskTool,
  };
}

const REMOTE_METHOD_DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods';

function mountSwarmRemoteService(ctx, controller) {
  const typertProto = tryRequire('@deepseek-ai/dsh-typert-protocol');

  const attachRemotePrototypeMarkers = (Proto) => {
    if (typertProto && typeof typertProto.Remote === 'function') {
      // 宿主协议的装饰器会做名称 / 上下文字段校验；版本漂移时退回手写描述符，
      // 绝不能因为一个可选元数据步骤让整个 Swarm 服务挂不上。
      try {
        let initGet;
        typertProto.Remote(Proto.getSwarmSnapshot, {
          name: 'getSwarmSnapshot',
          private: false,
          static: false,
          addInitializer(fn) {
            initGet = fn;
          },
        });
        let initWatch;
        const streamDec = typertProto.Remote({ mode: 'stream' });
        streamDec(Proto.watchSwarm, {
          name: 'watchSwarm',
          private: false,
          static: false,
          addInitializer(fn) {
            initWatch = fn;
          },
        });
        let initModels;
        typertProto.Remote(Proto.getSwarmModels, {
          name: 'getSwarmModels',
          private: false,
          static: false,
          addInitializer(fn) {
            initModels = fn;
          },
        });
        return { initGet, initWatch, initModels };
      } catch {
        // fall through to the hand-written descriptor below
      }
    }

    try {
      Object.defineProperty(Proto, REMOTE_METHOD_DESCRIPTOR_KEY, {
        configurable: true,
        value: Object.freeze({
          version: 1,
          methods: Object.freeze([
            Object.freeze({
              method: 'getSwarmSnapshot',
              invocation: Object.freeze({ kind: 'direct' }),
            }),
            Object.freeze({
              method: 'watchSwarm',
              mode: 'stream',
              invocation: Object.freeze({ kind: 'direct' }),
            }),
            Object.freeze({
              method: 'getSwarmModels',
              invocation: Object.freeze({ kind: 'direct' }),
            }),
          ]),
        }),
      });
    } catch {
      // 原型不可扩展 / 已有不可重定义描述符：服务本身依旧可用，放弃元数据声明。
    }
    return null;
  };

  if (typertProto && typeof typertProto.TypertRemoteService === 'function') {
    class SwarmRemoteService extends typertProto.TypertRemoteService {
      constructor(hostCtx) {
        super(hostCtx, SWARM_SERVICE_NAME);
      }

      async getSwarmSnapshot(request) {
        const parsed = parseSwarmRequest('getSwarmSnapshot', request);
        return controller.getSwarmSnapshot(parsed.sessionId);
      }

      async *watchSwarm(request, signal) {
        const parsed = parseSwarmRequest('watchSwarm', request);
        yield* controller.watchSwarm(parsed.sessionId, signal);
      }

      /**
       * 设置页「模型派发权限控制」的数据源：只读取宿主已发现的模型目录，零子进程启动。
       */
      async getSwarmModels(request) {
        parseSwarmModelsRequest(request);
        return parseSwarmModelsResult(await controller.listSwarmModelsResult());
      }
    }
    const initializers = attachRemotePrototypeMarkers(SwarmRemoteService.prototype);
    if (initializers) {
      const protoProxy = Object.create(SwarmRemoteService.prototype);
      initializers.initGet?.call(protoProxy);
      initializers.initWatch?.call(protoProxy);
      initializers.initModels?.call(protoProxy);
    }
    try {
      return new SwarmRemoteService(ctx);
    } catch {
      // 宿主 Cordis / Typert 契约漂移（例如 TypertRemoteService 构造签名变化）时
      // 退回插件自带实现：degrade gracefully，绝不让 apply 直接抛错。
    }
  }

  class SwarmRemoteServiceFallback {
    constructor(hostCtx) {
      this.ctx = hostCtx;
      this.name = SWARM_SERVICE_NAME;
      this.typertRemote = Object.freeze({
        service: this,
        serviceKey: SWARM_SERVICE_NAME,
        namespace: SWARM_SERVICE_NAME,
      });
      if (
        hostCtx?.root?.reflect?.props &&
        !Object.hasOwn(hostCtx.root.reflect.props, 'invocation') &&
        typeof hostCtx.root.accessor === 'function'
      ) {
        hostCtx.root.accessor('invocation', { get: () => undefined });
      }
      if (typeof hostCtx?.reflect?.provide === 'function') {
        hostCtx.reflect.provide(SWARM_SERVICE_NAME, this);
      } else if (typeof hostCtx?.provide === 'function') {
        hostCtx.provide(SWARM_SERVICE_NAME, this);
      } else if (hostCtx && typeof hostCtx === 'object') {
        hostCtx[SWARM_SERVICE_NAME] = this;
      }
    }

    async getSwarmSnapshot(request) {
      const parsed = parseSwarmRequest('getSwarmSnapshot', request);
      return controller.getSwarmSnapshot(parsed.sessionId);
    }

    async *watchSwarm(request, signal) {
      const parsed = parseSwarmRequest('watchSwarm', request);
      yield* controller.watchSwarm(parsed.sessionId, signal);
    }

    async getSwarmModels(request) {
      parseSwarmModelsRequest(request);
      return parseSwarmModelsResult(await controller.listSwarmModelsResult());
    }
  }
  attachRemotePrototypeMarkers(SwarmRemoteServiceFallback.prototype);
  return new SwarmRemoteServiceFallback(ctx);
}

function injectService(ctx, serviceName, callback) {
  if (typeof ctx?.inject === 'function') {
    ctx.inject([serviceName], (subCtx) => callback(subCtx));
  } else if (ctx && (ctx[serviceName] || ctx.get?.(serviceName))) {
    callback(ctx);
  }
}

function registerHostEventListeners(ctx, controller) {
  if (typeof ctx?.on !== 'function') return;

  // Host contract: 'agent/status' is dispatched by @deepseek-ai/dsh-scope as
  // `scopeTarget(base, agent)` bound to the listener `this`, and the payload
  // carries ONLY { status }. A plain `function` (never an arrow) is mandatory
  // so `this` is the scope carrier that `carrierKeyOf` can resolve.
  ctx.on(
    'agent/status',
    function (payload) {
      const dshScope = resolveDshScope();
      let carrierAgent = null;
      if (dshScope && typeof dshScope.carrierKeyOf === 'function') {
        try {
          carrierAgent = dshScope.carrierKeyOf(this);
        } catch {
          carrierAgent = null;
        }
      }
      const agent = payload?.agent || carrierAgent || payload;
      const sessionId = payload?.sessionId || agent?.id || agent?.session?.id;
      const status = payload?.status || agent?.status;
      if (!sessionId || !status) return;
      const resolved = controller.stores.resolveSession(sessionId);
      if (!resolved) return;
      if (status === 'running') {
        resolved.store.updateMemberRuntimeState(sessionId, { state: 'working' });
      } else if (status === 'idle') {
        // Only a real idle status means the inbox is drained; turn/end alone can
        // still have a queued next turn in the inbox.
        controller.handleMemberIdle(sessionId);
      }
    },
    { global: true }
  );

  // Host contract: 'session/event' receives (session, event). The first
  // argument is a Session, NOT an Agent.
  ctx.on(
    'session/event',
    (first, second) => {
      const session = second !== undefined ? first : first?.session;
      const event = second !== undefined ? second : first?.event;
      const sessionId = session?.id || session?.header?.id || first?.sessionId;
      if (!sessionId || !event?.type) return;
      if (event.type === 'agent/inbox/spliced') {
        controller.syncInboxSpliceForCommandInjections(sessionId, event.data);
      }
      const resolved = controller.stores.resolveSession(sessionId);
      if (!resolved) return;

      if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
        resolved.store.updateMemberRuntimeState(sessionId, {
          state: 'working',
          activity: redactActivityText(formatToolActivity(event.data)),
        });
      } else if (event.type === 'tool/result' || event.type === 'step/end') {
        resolved.store.updateMemberRuntimeState(sessionId, {
          activity: '',
        });
      } else if (event.type === 'turn/end') {
        const reason = event.data?.reason;
        const errText =
          reason?.kind === 'error' || reason?.error
            ? extractErrorMessage(reason.error || reason.message || reason)
            : undefined;
        // Never park before judging: an error is recorded as an error first.
        resolved.store.updateMemberRuntimeState(sessionId, {
          activity: '',
          ...(errText !== undefined ? { lastError: redactErrorText(errText) } : {}),
        });
        // `turn/end` alone NEVER means idle. Only park-and-replay when the real
        // live agent has no running turn and no queued inbox work, and when this
        // member is not mid wake-delivery.
        const agentsSvc = ctx?.get?.('agents') || ctx?.agents;
        const liveAgent =
          controller.liveHandles.get(sessionId)?.agent ||
          agentsSvc?.get?.(sessionId) ||
          (second !== undefined ? first?.agent : first?.agent);
        const memberRow = resolved.store.getMemberBySessionId(sessionId);
        const midDelivery = memberRow
          ? resolved.store._wakingMembers.has(memberRow.name)
          : false;
        if (!midDelivery && !hasPendingAgentWork(liveAgent)) {
          controller.handleMemberIdle(sessionId);
        }
      }
    },
    { global: true }
  );

  // agent/pre-step is a WATERFALL event: inject the /swarm coordinator skill
  // instructions as a separate `skill-invocation` context message so the user's
  // submitted prompt stays untouched in both Chat bubbles and session titles.
  ctx.on(
    'agent/pre-step',
    async function (payload, next) {
      const decision =
        typeof next === 'function'
          ? await next()
          : {
              kind: 'enter',
              messages: Array.isArray(payload?.messages) ? payload.messages : [],
            };
      try {
        if (!decision || decision.kind === 'reject') return decision;
        const dshScope = resolveDshScope();
        let carrierAgent = null;
        if (dshScope && typeof dshScope.carrierKeyOf === 'function') {
          try {
            carrierAgent = dshScope.carrierKeyOf(this);
          } catch {
            carrierAgent = null;
          }
        }
        const agent = payload?.agent || carrierAgent || null;
        const baseMessages = Array.isArray(decision.messages)
          ? decision.messages
          : Array.isArray(payload?.messages)
            ? payload.messages
            : [];
        const injection = controller.consumeCommandSkillInjectionForStep(
          agent,
          baseMessages,
          payload?.messages
        );
        if (!injection) return decision;
        return {
          ...decision,
          messages: [...baseMessages, injection],
        };
      } catch {
        // Never allow Swarm context injection to break the host pre-step waterfall
        return decision;
      }
    },
    { global: true }
  );

  // agent/request-error is a WATERFALL event: the listener must always return
  // next() so an unrelated failure can never truncate the host retry chain.
  ctx.on(
    'agent/request-error',
    async (payload, next) => {
      try {
        const agent = payload?.agent;
        const sessionId =
          payload?.sessionId || agent?.id || agent?.session?.id || agent?.session?.header?.id;
        if (sessionId) {
          const resolved = controller.stores.resolveSession(sessionId);
          if (resolved) {
            const failure = payload?.failure ?? payload?.error;
            const errMsg = extractFailureMessage(failure);
            if (errMsg) {
              resolved.store.updateMemberRuntimeState(sessionId, { lastError: redactErrorText(errMsg) });
            }
          }
        }
      } catch {
        // Swarm bookkeeping must never break the host waterfall
      }
      return typeof next === 'function' ? next() : undefined;
    },
    { global: true }
  );

  ctx.on('workspace/session-stop', ({ sessionId } = {}) => {
    if (!sessionId) return;
    const store = controller.stores.getOrLoadStore(sessionId);
    if (!store) return;
    controller._clearAllMonitorTasksForSwarm(store);
    const agentsSvc = ctx?.get?.('agents') || ctx?.agents;
    for (const member of store.state.members) {
      if (member.role === 'coordinator' || member.killed) continue;
      controller._abortMember(member.sessionId, 'workspace/session-stop');
      const live =
        controller.liveHandles.get(member.sessionId)?.agent || agentsSvc?.get?.(member.sessionId);
      controller._cancelAgent(live, 'workspace/session-stop');
    }
  });

  ctx.on(
    'agent/disposed',
    ({ agent } = {}) => {
      const sessionId = agent?.id || agent?.session?.id || agent?.session?.header?.id;
      if (!sessionId) return;
      controller.liveHandles.delete(sessionId);
      const resolved = controller.stores.resolveSession(sessionId);
      if (!resolved) return;
      const member = resolved.store.getMemberBySessionId(sessionId);
      if (!member || member.killed || member.role === 'coordinator') return;
      resolved.store.updateMemberRuntimeState(sessionId, { state: 'stopped', activity: '' });
    },
    { global: true }
  );
}

/**
 * 设置页保存后的热更新入口：只替换运行期字段，保留 controller 与成员状态，
 * 绝不中断正在执行的成员轮次。
 *
 * 传入的是局部补丁时（例如只改 `allowedModels`），未提到的运行期字段沿用
 * 当前值而不是回落到默认值——否则单独调整白名单会静默清空黑名单。
 */
function applyVolatileConfig(controller, rawConfig) {
  if (!controller || typeof controller.applyConfig !== 'function') return false;
  const incoming = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const merged = { ...(controller.config || {}), ...incoming };
  controller.applyConfig(normalizeSwarmConfig(merged));
  return true;
}

/**
 * 本插件有专属 Web 设置页（settings.section id: 'local-dsh-swarm'），
 * 关闭宿主自动生成的重复配置表单。
 * 必须用 `typeof ctx.inject === 'function'` 守卫：既不污染 plugin.inject 数组，
 * 也不破坏最小 fakeCtx（无 settings 服务）的挂载单测。
 */
function mountDedicatedSettings(ctx) {
  if (typeof ctx?.inject !== 'function') return;
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx && settingsCtx.settings;
      if (!settings || typeof settings.configure !== 'function') return;
      const configure = () => settings.configure({ auto: false }, ctx.fiber);
      if (typeof settingsCtx.effect === 'function') {
        settingsCtx.effect(configure, 'dsh-swarm: dedicated settings page');
      } else {
        configure();
      }
    });
  } catch {
    // 宿主未提供 settings 服务时保持自动表单，绝不因此中断插件挂载
  }
}

function apply(ctx, config = {}) {
  const controller = new SwarmHostController(ctx, config);
  mountDedicatedSettings(ctx);

  // 契约 0.3：Config 字段全部 .volatile()，设置页保存后由 loader 广播热更新，
  // 这里把最新值同步进运行中的 controller（不中断成员轮次）。
  if (typeof ctx?.on === 'function') {
    let lastSnapshot = JSON.stringify(normalizeSwarmConfig(config));
    ctx.on('loader/volatile-update', () => {
      let snapshot;
      try {
        snapshot = JSON.stringify(normalizeSwarmConfig(config));
      } catch {
        return;
      }
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      applyVolatileConfig(controller, config);
    });
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => controller.dispose(), 'dsh-swarm: dispose controller');
  }

  const {
    swarmTool,
    postMessageTool,
    readBoardTool,
    swarmWaitTool,
    scheduleTool,
    manageTaskTool,
  } = createSwarmTools(controller);

  // ONE host-level registration for the worker brief: the section resolves the
  // calling agent per turn and returns '' for every non-worker session, so the
  // roster's cwd/channels stay authoritative without per-child closures.
  injectService(ctx, 'systemPrompt', (pctx) => {
    const section = {
      name: 'dsh-swarm-worker',
      order: 850,
      text: ({ agent } = {}) => controller.getWorkerSystemPromptForAgent(agent),
    };
    if (typeof pctx.effect === 'function') {
      pctx.effect(() => {
        const dispose = pctx.systemPrompt.section(section);
        return typeof dispose === 'function' ? dispose : () => {};
      }, 'dsh-swarm: worker system prompt');
    } else {
      pctx.systemPrompt.section(section);
    }
  });

  injectService(ctx, 'tools', (tctx) => {
    const register = (tool, opts) => {
      if (typeof tctx.effect === 'function') {
        tctx.effect(() => tctx.tools.register(tool, opts), `dsh-swarm: tool ${tool.name}`);
      } else {
        tctx.tools.register(tool, opts);
      }
    };
    register(swarmTool);
    const boardWhen = { when: ({ agent }) => controller.shouldExposeBoardTools(agent) };
    register(postMessageTool, boardWhen);
    register(readBoardTool, boardWhen);
    register(swarmWaitTool, boardWhen);
    // Monitor-only tools: registered once, gated per session.
    const monitorWhen = { when: ({ agent }) => controller.isMonitorAgent(agent) };
    register(scheduleTool, monitorWhen);
    register(manageTaskTool, monitorWhen);
  });

  injectService(ctx, 'commands', (cctx) => {
    const cmdDef = {
      name: 'swarm',
      description: '启动或查看多智能体公共留言板协作集群 (/swarm [<任务描述> | status])',
      input: {
        hint: '[<任务目标> | status]',
        attachments: true,
      },
      handler: (invocation) => {
        const agent = invocation?.agent;
        const sessionId = agent?.id || agent?.session?.id;
        if (!sessionId) {
          return { kind: 'error', text: '无法获取当前会话 Agent。' };
        }
        const rawInput = String(invocation.rawInput || '').trim();
        const lower = rawInput.toLowerCase();
        const store = controller.stores.getOrCreateStore(sessionId);
        const route = readAgentModelRoute(agent);
        store.ensureCoordinator({
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          cwd: readAgentCwd(cctx, agent),
          currentTurn: readAgentTurnNumber(cctx, agent),
        });

        const panelUri = buildSwarmResourceUri(sessionId);
        const graphUri = buildSwarmResourceUri(sessionId, 'graph');
        const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : [];

        if (lower === 'status' && attachments.length > 0) {
          return {
            kind: 'error',
            text: '查看状态（/swarm status）不能携带附件；如需带附件发起任务，请输入 /swarm <任务描述>。',
          };
        }

        if (lower === 'status' || (rawInput === '' && attachments.length === 0)) {
          const snap = store.toSnapshot();
          const activeCount = snap.members.filter(
            (m) => m.role !== 'coordinator' && !m.killed
          ).length;
          return {
            kind: 'success',
            text: [
              `Swarm 集群已就绪（标题：${snap.title || '未命名'}，活跃 Worker：${activeCount}，留言 #${snap.head}）`,
              `右侧栏入口：${panelUri} （拓扑图：${graphUri}）`,
              rawInput === ''
                ? '用法：输入 `/swarm <你的多智能体协作任务>` 即可驱动协调员组建集群并行推进。'
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          };
        }

        // 保持用户原始输入完全不被篡改；Swarm 技能说明与面板链接通过 `agent/pre-step`
        // 作为独立的 `skill-invocation` 上下文消息注入本轮模型请求。
        const userContent = [
          ...attachments,
          ...(rawInput ? [{ type: 'text', text: rawInput }] : []),
        ];
        const userMsg = createUserMessageCompat({
          content: userContent,
          source: { kind: 'user' },
        });
        controller.queueCommandSkillInjection(userMsg.id, {
          sessionId,
          panelUri,
          graphUri,
          commandId: invocation?.commandId || '',
        });
        agent.followup(userMsg);

        return {
          kind: 'success',
          text: `已启动 /swarm 协作流程并提交任务。面板地址：${panelUri}`,
        };
      },
    };

    if (typeof cctx.effect === 'function') {
      cctx.effect(() => cctx.commands.register(cmdDef), 'dsh-swarm: /swarm command');
    } else {
      cctx.commands.register(cmdDef);
    }
  });

  // Register `swarm` and `swarm-monitor` runtime skills (hyphenated per DSH SKILL_NAME regex)
  injectService(ctx, 'skills', (sctx) => {
    const hasNativeCommands = Boolean(sctx.get?.('commands') || sctx.commands);
    const registerSkill = (def) => {
      if (typeof sctx.effect === 'function') {
        sctx.effect(() => sctx.skills.register(def), `dsh-swarm: skill ${def.name}`);
      } else {
        sctx.skills.register(def);
      }
    };

    registerSkill({
      name: 'swarm',
      description:
        '组建并协调多智能体 Swarm 协作集群：通过共享 #seq 公共留言板、@name 门铃唤醒、热分叉与隔离工作区并行完成复杂任务。',
      source: 'runtime',
      content: COORDINATOR_SKILL_CONTENT,
      invocation: {
        modelInvocable: true,
        userInvocable: !hasNativeCommands,
      },
    });

    registerSkill({
      name: 'swarm-monitor',
      description:
        '仅供 Swarm 巡检守护成员 (monitor) 加载：定期检查全员停摆并精准点名唤醒破局成员。',
      source: 'runtime',
      content: MONITOR_SKILL_CONTENT,
      invocation: {
        modelInvocable: true,
        userInvocable: false,
      },
    });
  });

  injectService(ctx, 'typert', (tctx) => {
    const reg = () =>
      tctx.typert.register({
        package: SWARM_TYPERT_PACKAGE,
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: SWARM_METHODS.map((m) =>
          SWARM_REMOTE.descriptors.find((d) => d.method === m)
        ),
      });
    if (typeof tctx.effect === 'function') {
      tctx.effect(reg, 'dsh-swarm: typert host descriptors');
    } else {
      reg();
    }
  });

  const remoteService = mountSwarmRemoteService(ctx, controller);
  registerHostEventListeners(ctx, controller);

  return { controller, remoteService };
}

module.exports = {
  name: PLUGIN_ID,
  apply,
  Config,
  SwarmHostController,
  createSwarmTools,
  mountSwarmRemoteService,
  buildBalancedForkSeed,
  parseCronIntervalMs,
  formatToolActivity,
  hasPendingAgentWork,
  readAgentDelegationDepth,
  captureDelegatedPolicyOverrides,
  setDshScopeForTests,
  SWARM_CONFIG_DEFAULTS,
  normalizeSwarmConfig,
  applyVolatileConfig,
  // 模型派发权限（开源默认完全放行，规则由用户在设置页决定）
  normalizeModelRuleList,
  isSwarmModelAllowed,
  assertSwarmModelAllowed,
  describeModelRuleState,
};
