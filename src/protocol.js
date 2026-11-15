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

/**
 * `getSwarmModels` 请求：接受任意 plain object，统一归一化为 `{}`。
 *
 * 请求体本身没有任何可配置语义（模型目录只由宿主决定），所以**忽略一切历史字段**：
 * 旧版 Web 客户端缓存会发送 `{ probeAgy: false }` 这类已被移除的开关，
 * 把这种请求打成协议错误只会让升级后的设置页莫名拉不到模型目录。
 * 只有非 plain object（数组 / 字符串 / 数字……）才是真正的协议违约。
 */
function parseSwarmModelsRequest(value) {
  if (value === undefined || value === null) return {};
  if (isPlainObject(value)) return {};
  invalidProtocol(SWARM_MODELS_METHOD, 'request', 'expected object');
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
  SWARM_SERVICE_NAME,
  SWARM_TYPERT_PACKAGE,
  SWARM_RESOURCE_PROTOCOL,
  SWARM_RESOURCE_PREFIX,
  SWARM_PANE_ID,
  SWARM_METHODS,
  SWARM_TABS,
  MEMBER_STATES,
  WORKSPACE_MODES,
  SWARM_REMOTE,
  isValidSessionId,
  buildSwarmResourceUri,
  parseSwarmResourceUri,
  createEmptySnapshot,
  normalizeSwarmSnapshot,
  normalizeMemberSnapshot,
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
