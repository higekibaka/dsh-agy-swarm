'use strict';

/**
 * Shared Host <-> Client protocol contracts, validators, and Typert descriptors
 * for dsh-agy-swarm. Zero external runtime dependencies.
 */

const { redactSensitiveText } = require('./redaction.js');

const PLUGIN_ID = 'dsh-agy-swarm';
/**
 * 设置页表单 id 与 locale 命名空间：开源发布版统一为 `dsh-agy-swarm`。
 * `SWARM_SETTINGS_ID_LEGACY` 仅用于读取旧安装残留的表单，绝不写回。
 */
const SWARM_SETTINGS_ID = 'dsh-agy-swarm';
const SWARM_SETTINGS_NS = 'settings.dshAgySwarm';
const SWARM_SETTINGS_ID_LEGACY = 'local-dsh-swarm';
/** 可选 ACP 扩展包的 npm 包名（未安装时插件必须完全可用）。 */
const AGY_ACP_PLUGIN_NAME = 'dsh-agy-acp';
const SWARM_SERVICE_NAME = 'dsh-swarm';
const SWARM_TYPERT_PACKAGE = 'dsh-swarm';
const SWARM_RESOURCE_PROTOCOL = 'swarm';
const SWARM_RESOURCE_PREFIX = 'dsh-resource://swarm/';
const SWARM_PANE_ID = 'dsh-swarm/pane';

/**
 * Typert 服务方法表。
 * - `getSwarmSnapshot` / `watchSwarm`：面板快照与流式推送；
 * - `getSwarmModels`：设置页「模型派发权限控制」拉取宿主已发现模型目录
 *   （含 `allowed` / `blocked` 标记，零子进程启动）。
 */
const SWARM_METHODS = Object.freeze(['getSwarmSnapshot', 'watchSwarm', 'getSwarmModels']);
/** 模型目录方法名（请求/结果形状与快照方法不同）。 */
const SWARM_MODELS_METHOD = 'getSwarmModels';
const SWARM_TABS = Object.freeze(['feed', 'members', 'graph']);
const MEMBER_STATES = Object.freeze(['waiting', 'working', 'stopped', 'killed']);
const WORKSPACE_MODES = Object.freeze(['inherit', 'share']);
const AGY_BACKEND = 'agy-acp';
const AGY_MODES = Object.freeze(['accept-edits', 'plan', 'default']);
/**
 * agy 轮次实时阶段（与可选扩展 dsh-agy-acp 的 onProgress phase 对齐）。
 * 本插件只透传展示，绝不因未知阶段报错：未知值原样保留字符串。
 */
const AGY_LIVE_PHASES = Object.freeze([
  'queued',
  'spawn',
  'initialize',
  'load',
  'new',
  'configure',
  'prompt',
  'settling',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeString(value, maxLen = 65536) {
  return typeof value === 'string' && value.length <= maxLen;
}

function isValidSessionId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function coerceString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function coerceNonNegInt(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function coerceStringArray(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) result.push(item);
  }
  return result;
}

function buildSwarmResourceUri(sessionId, tab) {
  const cleanId = encodeURIComponent(String(sessionId || '').trim());
  const base = `${SWARM_RESOURCE_PREFIX}${cleanId}`;
  if (tab && SWARM_TABS.includes(tab)) {
    return `${base}?tab=${encodeURIComponent(tab)}`;
  }
  return base;
}

function parseSwarmResourceUri(href) {
  if (typeof href !== 'string' || !href.startsWith(SWARM_RESOURCE_PREFIX)) {
    return null;
  }
  const rest = href.slice(SWARM_RESOURCE_PREFIX.length);
  const qIdx = rest.indexOf('?');
  const rawPath = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  const rawQuery = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
  let sessionId;
  try {
    sessionId = decodeURIComponent(rawPath.replace(/\/+$/, ''));
  } catch {
    // Malformed percent escapes (e.g. %ZZ) are hostile input, never a crash.
    return null;
  }
  if (!isValidSessionId(sessionId)) return null;
  let tab = null;
  if (rawQuery) {
    const params = new URLSearchParams(rawQuery);
    const candidate = params.get('tab');
    if (candidate && SWARM_TABS.includes(candidate)) {
      tab = candidate;
    }
  }
  return { sessionId, tab };
}

function createEmptySnapshot(sessionId, overrides = {}) {
  return normalizeSwarmSnapshot({
    hasSwarm: false,
    done: false,
    coordinatorSessionId: coerceString(sessionId, ''),
    resolvedFromMember: null,
    title: '',
    head: 0,
    updatedAt: Date.now(),
    channels: [],
    members: [],
    messages: [],
    ...overrides,
  });
}

/**
 * Normalize a snapshot into strictly lossless JSON (no undefined properties,
 * NaN, or non-plain prototypes) required by @deepseek-ai/dsh-typert-protocol.
 */
function normalizeChannelSnapshot(raw) {
  return {
    name: coerceString(raw?.name, 'main'),
    topic: coerceString(raw?.topic, ''),
    archived: Boolean(raw?.archived),
    createdBy: coerceString(raw?.createdBy, 'coordinator'),
    subscribers: coerceStringArray(raw?.subscribers),
  };
}

/**
 * agy 实时阶段快照（JSON-safe，契约 3.2）：`{ runId, phase, pid, activity }`。
 * 成员空闲时为 null；pid 未知记 0（绝不写 undefined / NaN），
 * 客户端据此决定渲染 `PID <pid>` 还是 `宿主托管 · <runId>`。
 */
function normalizeAgyLive(raw) {
  if (!isPlainObject(raw)) return null;
  const phase = coerceString(raw.phase, '').slice(0, 32);
  if (!phase) return null;
  return {
    runId: coerceString(raw.runId, '').slice(0, 64),
    phase,
    pid: Number.isSafeInteger(raw.pid) && raw.pid > 0 ? raw.pid : 0,
    // 活动摘要会进入快照、事件流与下一次模型上下文：推流端统一脱敏兜底。
    activity: redactSensitiveText(coerceString(raw.activity, ''), { maxChars: 240 }),
  };
}

/** 缓存命中率归一化到 0..1（上游可能给 0..1 或 0..100 百分比）。 */
function normalizeCacheHitRate(raw, cacheRead, totalInput) {
  let value = 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    value = raw >= 0 && raw <= 1 ? raw : raw > 1 && raw <= 100 ? raw / 100 : 0;
  } else if (totalInput > 0 && cacheRead > 0) {
    value = cacheRead / totalInput;
  }
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
}

/**
 * 单轮口径的 Token 账单摘要（来自 agy-acp 的 `turnUsageSummary`，JSON-safe）。
 * 与契约的 `lastTurnTokens` 字段一一对应，便于面板直接渲染。
 */
function normalizeAgyTurnTokens(raw) {
  if (!isPlainObject(raw)) return null;
  const totalInput = coerceNonNegInt(raw.totalInput, 0);
  const cacheRead = Math.min(coerceNonNegInt(raw.cacheRead, 0), totalInput);
  const totalOutput = coerceNonNegInt(raw.totalOutput, 0);
  return {
    stepCount: coerceNonNegInt(raw.stepCount, 0),
    totalInput,
    cacheRead,
    totalOutput,
    thinking: Math.min(coerceNonNegInt(raw.thinking, 0), totalOutput),
    cacheHitRate: normalizeCacheHitRate(raw.cacheHitRate, cacheRead, totalInput),
  };
}

/**
 * agy 累计 Token 账单（JSON-safe）：从未产生过 usage 时为 null。
 * 旧版 agy-acp（返回值无 turnUsageSummary）永远走 null 分支，完全向后兼容。
 */
function normalizeAgyUsage(raw) {
  if (!isPlainObject(raw)) return null;
  const totalInput = coerceNonNegInt(raw.totalInput, 0);
  const cacheRead = Math.min(coerceNonNegInt(raw.cacheRead, 0), totalInput);
  const totalOutput = coerceNonNegInt(raw.totalOutput, 0);
  return {
    turns: coerceNonNegInt(raw.turns, 0),
    stepCount: coerceNonNegInt(raw.stepCount, 0),
    totalInput,
    cacheRead,
    totalOutput,
    thinking: Math.min(coerceNonNegInt(raw.thinking, 0), totalOutput),
    cacheHitRate: normalizeCacheHitRate(raw.cacheHitRate, cacheRead, totalInput),
    lastTurnTokens: normalizeAgyTurnTokens(raw.lastTurnTokens),
  };
}

function normalizeMemberSnapshot(raw) {
  const killed = Boolean(raw?.killed || raw?.state === 'killed');
  const rawState = coerceString(raw?.state, 'waiting');
  const state = killed
    ? 'killed'
    : MEMBER_STATES.includes(rawState)
      ? rawState
      : 'waiting';
  const rawWs = coerceString(raw?.workspace, 'inherit');
  const workspace = WORKSPACE_MODES.includes(rawWs) ? rawWs : 'inherit';
  const provider = coerceString(raw?.provider, '');
  const model = coerceString(raw?.model, '');
  const modelDisplay = coerceString(
    raw?.modelDisplay,
    provider && model ? `${provider}/${model}` : model || provider || 'default'
  );
  return {
    name: coerceString(raw?.name, ''),
    sessionId: coerceString(raw?.sessionId, ''),
    role: coerceString(raw?.role, 'worker'),
    addedBy: coerceString(raw?.addedBy, ''),
    // 二期：成员后端（'dsh' 原生会话 / 'agy-acp' 外部 ACP 队友）。
    backend: coerceString(raw?.backend, 'dsh') || 'dsh',
    // 二期：外部 agy 队友的运行模式、实时阶段与累计 Token 账单（原生成员为零值）。
    agyMode: AGY_MODES.includes(raw?.agyMode) ? raw.agyMode : '',
    agyLive: normalizeAgyLive(raw?.agyLive),
    agyUsage: normalizeAgyUsage(raw?.agyUsage),
    provider,
    model,
    modelDisplay,
    reasoningEffort: coerceString(raw?.reasoningEffort, ''),
    workspace,
    cwd: coerceString(raw?.cwd, ''),
    channels: coerceStringArray(raw?.channels),
    state,
    killed,
    activity: killed ? '' : redactSensitiveText(coerceString(raw?.activity, ''), { maxChars: 240 }),
    // 旧持久化快照里的 lastError 可能来自未脱敏的旧版本或第三方写入：推流端兜底脱敏。
    lastError: killed ? '' : redactSensitiveText(coerceString(raw?.lastError, ''), { maxChars: 400 }),
    waitFor: coerceStringArray(raw?.waitFor),
    lastReadSeq: coerceNonNegInt(raw?.lastReadSeq, 0),
    lastPostSeq: coerceNonNegInt(raw?.lastPostSeq, 0),
    lastPostTime: coerceString(raw?.lastPostTime, ''),
  };
}

function normalizeMessageSnapshot(raw) {
  return {
    seq: coerceNonNegInt(raw?.seq, 0),
    channel: coerceString(raw?.channel, 'main'),
    agent: coerceString(raw?.agent, ''),
    text: coerceString(raw?.text, ''),
    mentions: coerceStringArray(raw?.mentions),
    channelMentions: coerceStringArray(raw?.channelMentions),
    broadcast: Boolean(raw?.broadcast),
    time: coerceString(raw?.time, ''),
  };
}

function normalizeSwarmSnapshot(raw) {
  const resolved = raw?.resolvedFromMember;
  return {
    hasSwarm: Boolean(raw?.hasSwarm),
    done: Boolean(raw?.done),
    coordinatorSessionId: coerceString(raw?.coordinatorSessionId, ''),
    resolvedFromMember: typeof resolved === 'string' && resolved.length > 0 ? resolved : null,
    title: coerceString(raw?.title, ''),
    head: coerceNonNegInt(raw?.head, 0),
    updatedAt: coerceNonNegInt(raw?.updatedAt, Date.now()),
    channels: Array.isArray(raw?.channels) ? raw.channels.map(normalizeChannelSnapshot) : [],
    members: Array.isArray(raw?.members) ? raw.members.map(normalizeMemberSnapshot) : [],
    messages: Array.isArray(raw?.messages) ? raw.messages.map(normalizeMessageSnapshot) : [],
  };
}

function invalidProtocol(method, kind, detail = '') {
  const suffix = detail ? `: ${detail}` : '';
  throw new TypeError(`dsh-swarm: invalid ${method} ${kind}${suffix}`);
}

function parseSwarmRequest(method, value) {
  if (!SWARM_METHODS.includes(method) || !isPlainObject(value)) {
    invalidProtocol(method, 'request', 'expected object');
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== 'sessionId') {
      invalidProtocol(method, 'request', `unexpected key "${key}"`);
    }
  }
  if (!isValidSessionId(value.sessionId)) {
    invalidProtocol(method, 'request', 'invalid sessionId');
  }
  return { sessionId: value.sessionId };
}

function isValidSwarmSnapshot(value) {
  if (!isPlainObject(value)) return false;
  if (typeof value.hasSwarm !== 'boolean') return false;
  if (value.done !== undefined && typeof value.done !== 'boolean') return false;
  if (!isSafeString(value.coordinatorSessionId, 160)) return false;
  if (value.resolvedFromMember !== null && value.resolvedFromMember !== undefined && !isSafeString(value.resolvedFromMember, 80)) {
    return false;
  }
  if (!isSafeString(value.title, 512)) return false;
  if (!Number.isSafeInteger(value.head) || value.head < 0) return false;
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return false;
  if (!Array.isArray(value.channels) || !Array.isArray(value.members) || !Array.isArray(value.messages)) {
    return false;
  }
  return true;
}

function parseSwarmResult(method, value) {
  if (!SWARM_METHODS.includes(method) || !isValidSwarmSnapshot(value)) {
    invalidProtocol(method, 'result', 'invalid SwarmSnapshot');
  }
  return normalizeSwarmSnapshot(value);
}

/**
 * 模型目录条目归一化为严格 JSON-safe（无 undefined / NaN）：
 * `{ key, provider, model, name, backend, allowed, blocked }`。
 */
function normalizeSwarmModelEntry(raw) {
  const provider = coerceString(raw?.provider, '');
  const model = coerceString(raw?.model, '');
  return {
    key: coerceString(raw?.key, provider && model ? `${provider}/${model}` : model || provider),
    provider,
    model,
    name: coerceString(raw?.name, model),
    backend: coerceString(raw?.backend, ''),
    allowed: Boolean(raw?.allowed),
    blocked: Boolean(raw?.blocked),
  };
}

/** `getSwarmModels` 请求：`{}` / `undefined` / `{ probeAgy?: boolean }`。 */
function parseSwarmModelsRequest(value) {
  if (value === undefined || value === null) return { probeAgy: false };
  if (!isPlainObject(value)) {
    invalidProtocol(SWARM_MODELS_METHOD, 'request', 'expected object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'probeAgy') {
      invalidProtocol(SWARM_MODELS_METHOD, 'request', `unexpected key "${key}"`);
    }
  }
  if (value.probeAgy !== undefined && value.probeAgy !== null && typeof value.probeAgy !== 'boolean') {
    invalidProtocol(SWARM_MODELS_METHOD, 'request', 'probeAgy must be boolean');
  }
  return { probeAgy: value.probeAgy === true };
}

function isValidSwarmModelsResult(value) {
  return isPlainObject(value) && Array.isArray(value.models);
}

/** `getSwarmModels` 结果：`{ models: [...] }`，逐条归一化且丢弃未知字段。 */
function parseSwarmModelsResult(value) {
  if (!isValidSwarmModelsResult(value)) {
    invalidProtocol(SWARM_MODELS_METHOD, 'result', 'expected { models: [] }');
  }
  return { models: value.models.map(normalizeSwarmModelEntry) };
}

function swarmCodec(method, direction) {
  const isReq = direction === 'request';
  const isModels = method === SWARM_MODELS_METHOD;
  const schema = {
    parse: (value) => {
      if (!SWARM_METHODS.includes(method)) invalidProtocol(method, direction, 'unknown method');
      if (isModels) {
        return isReq ? parseSwarmModelsRequest(value) : parseSwarmModelsResult(value);
      }
      return isReq ? parseSwarmRequest(method, value) : parseSwarmResult(method, value);
    },
  };
  return {
    mode: 'strict',
    typeSymbol: `${SWARM_TYPERT_PACKAGE}/${method}${isReq ? 'Request' : 'Result'}`,
    schema,
    create: () => schema,
  };
}

function swarmInvocation(method) {
  if (!SWARM_METHODS.includes(method)) {
    invalidProtocol(method, 'descriptor', 'unknown method');
  }
  const isStream = method === 'watchSwarm';
  return {
    id: `${SWARM_TYPERT_PACKAGE}#${SWARM_SERVICE_NAME}/${method}`,
    service: SWARM_SERVICE_NAME,
    namespace: SWARM_SERVICE_NAME,
    method,
    ...(isStream
      ? {
          mode: 'stream',
          cancellation: { parameter: 'signal' },
        }
      : {}),
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: swarmCodec(method, 'request'),
      },
    ],
    result: swarmCodec(method, 'result'),
  };
}

const SWARM_REMOTE = Object.freeze({
  package: SWARM_TYPERT_PACKAGE,
  descriptors: Object.freeze(SWARM_METHODS.map(swarmInvocation)),
});

module.exports = {
  PLUGIN_ID,
  SWARM_SETTINGS_ID,
  SWARM_SETTINGS_NS,
  SWARM_SETTINGS_ID_LEGACY,
  AGY_ACP_PLUGIN_NAME,
  SWARM_SERVICE_NAME,
  SWARM_TYPERT_PACKAGE,
  SWARM_RESOURCE_PROTOCOL,
  SWARM_RESOURCE_PREFIX,
  SWARM_PANE_ID,
  SWARM_METHODS,
  SWARM_TABS,
  MEMBER_STATES,
  WORKSPACE_MODES,
  AGY_BACKEND,
  AGY_MODES,
  AGY_LIVE_PHASES,
  SWARM_REMOTE,
  isValidSessionId,
  buildSwarmResourceUri,
  parseSwarmResourceUri,
  createEmptySnapshot,
  normalizeSwarmSnapshot,
  normalizeMemberSnapshot,
  normalizeAgyLive,
  normalizeAgyUsage,
  normalizeAgyTurnTokens,
  normalizeCacheHitRate,
  isValidSwarmSnapshot,
  parseSwarmRequest,
  parseSwarmResult,
  parseSwarmModelsRequest,
  parseSwarmModelsResult,
  normalizeSwarmModelEntry,
  isValidSwarmModelsResult,
  SWARM_MODELS_METHOD,
  swarmCodec,
  swarmInvocation,
};
