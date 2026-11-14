/**
 * 离线 Mock ACP Server（agy 1.5.5 wire 格式的精简复刻）。
 *
 * 说明：本文件由 dsh-agy-swarm 自己维护，不依赖 dsh-agy-acp 的 test/ 目录——
 * 已发布的 dsh-agy-acp 包并不包含 test/，从那里 require 会让用户环境 MODULE_NOT_FOUND。
 * 模型清单只保留本套件实际用到的条目，不携带任何厂商私有清单。
 *
 * 跑在内存 PassThrough 传输上（createMemoryTransportPair 的 server 端），
 * 因此单测完全不碰 child_process —— Windows workspace-write 沙盒里
 * spawn(stdio:'pipe') 会报 EPERM，这里绕开它仍然跑真实的 NDJSON 帧。
 */

const DEFAULT_MODELS = [
  { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
  { value: 'gemini-pro-orchestrator', name: 'Orchestrator' },
  { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
];

const DEFAULT_LEVELS = ['low', 'medium', 'high'];
const DEFAULT_MODES = ['default', 'accept-edits', 'plan'];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function findOption(list, id) {
  return Array.isArray(list) ? list.find((item) => item && item.id === id) : undefined;
}

export class MockAcpServer {
  constructor({ transport, options = {} } = {}) {
    if (!transport || typeof transport.onLine !== 'function') {
      throw new Error('MockAcpServer 需要 transport.onLine');
    }
    this.transport = transport;
    this.options = {
      models: DEFAULT_MODELS,
      levels: DEFAULT_LEVELS,
      modes: DEFAULT_MODES,
      sessionId: 'sess-mock-1',
      replyText: '你好，我是 mock agy。',
      thoughtText: '先想一想。',
      chunkSize: null,
      framing: 'line',
      toolCalls: [],
      toolCallUpdates: [],
      permissionRequests: [],
      mismatchConfigId: null,
      manualPrompt: false,
      manualInitialize: false,
      ignoreCancel: false,
      stopReason: 'end_turn',
      updateSessionId: null,
      loadReturnsSessionId: null,
      replayUpdates: 0,
      promptDelayMs: 0,
      // 三期：ACP usage_update 推送序列（每项直接作为 update 载荷）。
      usageUpdates: [],
      promptResultUsage: null,
      ...options,
    };
    this.configOptions = [];
    this.sessions = new Map();
    this.currentModel = this.options.models[0].value;
    this.currentEffort = 'medium';
    this.currentMode = 'default';
    this.nextServerId = 1;
    this.pendingClientRequests = new Map();
    this.cancelled = false;
    this.stopped = false;
    this.log = { requests: [], notifications: [], responses: [], errors: [] };
    this.permissionResponses = [];
    this.promptCount = 0;
    this.cancelAt = 0;
    this.initCount = 0;
    this.loadCount = 0;
    this.newCount = 0;
    this.terminateCount = 0;
    this._unsubscribe = null;
    this._manualGate = null;
    this._initGate = null;
    this._releaseInit = null;
  }

  start() {
    this._unsubscribe = this.transport.onLine((line) => this._handleLine(line));
    return this;
  }

  stop() {
    this.stopped = true;
    this.terminateCount += 1;
    if (typeof this._unsubscribe === 'function') this._unsubscribe();
    this._releaseManualGate();
    this.finishInitialize();
    for (const [, pending] of this.pendingClientRequests) pending.reject(new Error('mock 已停止'));
    this.pendingClientRequests.clear();
  }

  /* -------- 帧发送（可控切分） -------- */

  _sendRawLine(message, framing = 'line') {
    try {
      this._writeFramed(message, framing);
    } catch (error) {
      this.log.errors.push('发送失败: ' + String(error?.message ?? error));
    }
  }

  _writeFramed(message, framing) {
    const text = JSON.stringify(message);
    if (framing === 'coalesce') {
      this.transport.writeRaw(text + '\n');
      return;
    }
    if (framing === 'crlf') {
      this.transport.writeRaw(text + '\r\n');
      return;
    }
    if (framing === 'split') {
      let index = 0;
      let step = 3;
      while (index < text.length) {
        const size = 1 + (step % 7);
        this.transport.writeRaw(text.slice(index, index + size));
        index += size;
        step += 3;
      }
      this.transport.writeRaw('\n');
      return;
    }
    this.transport.write(text);
  }

  _sendCoalesced(messages) {
    try {
      this.transport.writeRaw(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
    } catch (error) {
      this.log.errors.push('发送失败: ' + String(error?.message ?? error));
    }
  }

  _respond(id, result) {
    this._sendRawLine({ jsonrpc: '2.0', id, result }, 'line');
  }

  _respondError(id, code, message) {
    this._sendRawLine({ jsonrpc: '2.0', id, error: { code, message } }, 'line');
  }

  _notify(method, params, framing) {
    this._sendRawLine({ jsonrpc: '2.0', method, params }, framing ?? this.options.framing);
  }

  _requestClient(method, params) {
    const id = 'srv-' + this.nextServerId++;
    const promise = new Promise((resolve, reject) => {
      this.pendingClientRequests.set(id, { resolve, reject, method });
    });
    this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return { id, promise };
  }

  /* -------- 入站 -------- */

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log.errors.push('非 JSON 帧: ' + String(line).slice(0, 80));
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        this.log.requests.push({ method: message.method, params: message.params, id: message.id });
        void this._dispatchRequest(message);
      } else {
        this.log.notifications.push({ method: message.method, params: message.params });
        this._handleNotification(message);
      }
      return;
    }

    if (message.id !== undefined && message.id !== null) {
      this.log.responses.push({ id: message.id, result: message.result, error: message.error });
      const pending = this.pendingClientRequests.get(message.id);
      if (pending) {
        this.pendingClientRequests.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'client error'));
        else pending.resolve(message.result);
      }
    }
  }

  _handleNotification(message) {
    if (message.method === 'session/cancel') {
      this.cancelAt = Date.now();
      if (this.options.ignoreCancel) return;
      this.cancelled = true;
      this._releaseManualGate();
    }
  }

  async _dispatchRequest(message) {
    const { method, params, id } = message;
    try {
      switch (method) {
        case 'initialize': {
          this.initCount += 1;
          if (this.options.manualInitialize) {
            if (typeof this._releaseInit !== 'function') {
              this._initGate = new Promise((resolve) => {
                this._releaseInit = resolve;
              });
            }
            await this._initGate;
          }
          this._respond(id, {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
            authMethods: [],
          });
          return;
        }
        case 'session/new': {
          this.newCount += 1;
          this.sessions.set(this.options.sessionId, { cwd: params?.cwd, loaded: false });
          this._respond(id, this._sessionPayload());
          return;
        }
        case 'session/load': {
          this.loadCount += 1;
          const requested = params?.sessionId ?? this.options.sessionId;
          this.sessions.set(requested, { cwd: params?.cwd, loaded: true });
          const replay = Number(this.options.replayUpdates) || 0;
          for (let index = 0; index < replay; index += 1) {
            this._notify('session/update', {
              sessionId: requested,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '[REPLAY-' + index + ']' },
              },
            });
            await tick();
          }
          const returned = this.options.loadReturnsSessionId ?? requested;
          this._respond(id, this._sessionPayload(returned));
          return;
        }
        case 'session/set_config_option': {
          this._applyConfigOption(id, params);
          return;
        }
        case 'session/prompt': {
          await this._handlePrompt(id, params);
          return;
        }
        default: {
          this._respondError(id, -32601, 'Method not found: ' + method);
        }
      }
    } catch (error) {
      this.log.errors.push(String(error?.message ?? error));
      this._respondError(id, -32603, String(error?.message ?? error));
    }
  }

  _sessionPayload(sessionId = this.options.sessionId) {
    this._ensureConfigOptions();
    this._syncEffortOption();
    return {
      sessionId,
      models: {
        availableModels: this.options.models.map((model) => model.value),
        currentModelId: this.currentModel,
      },
      modes: {
        currentModeId: this.currentMode,
        availableModes: this.options.modes,
      },
      configOptions: this._cloneConfigOptions(),
    };
  }

  _ensureConfigOptions() {
    if (this.configOptions.length > 0) return;
    this.configOptions = [
      {
        id: 'model',
        name: 'Model',
        currentValue: this.currentModel,
        options: this.options.models.map((model) => ({ value: model.value, name: model.name })),
      },
      {
        id: 'thought_level',
        name: 'Thinking',
        currentValue: this.currentEffort,
        options: this.options.levels.map((level) => ({ value: level, name: level })),
      },
      {
        id: 'mode',
        name: 'Mode',
        currentValue: this.currentMode,
        options: this.options.modes.map((mode) => ({ value: mode, name: mode })),
      },
    ];
  }

  _applyConfigOption(id, params) {
    this._ensureConfigOptions();
    const configId = params?.configId;
    const value = params?.value;
    const option = findOption(this.configOptions, configId);
    if (!option) {
      this._respondError(id, -32602, 'unknown config option: ' + String(configId));
      return;
    }
    if (this.options.mismatchConfigId === configId) {
      this._respond(id, { configOptions: this._cloneConfigOptions() });
      return;
    }
    const allowed = Array.isArray(option.options) ? option.options.map((item) => item.value) : [];
    if (!allowed.includes(value)) {
      this._respondError(id, -32602, 'invalid value for ' + String(configId) + ': ' + String(value));
      return;
    }
    option.currentValue = value;
    if (configId === 'model') {
      this.currentModel = value;
      // 服务端按模型真实收窄档位目录：Orchestrator 直接没有 thought_level。
      this._syncEffortOption();
    }
    if (configId === 'thought_level') this.currentEffort = value;
    if (configId === 'mode') this.currentMode = value;
    this._respond(id, { configOptions: this._cloneConfigOptions() });
  }

  /** 模型级档位目录：Orchestrator 无档位（返回 null），Hydrogen 独有 xhigh。 */
  _effortLevelsFor(model) {
    if (model === 'gemini-pro-orchestrator') return null;
    const levels = [...this.options.levels];
    if (model === 'gemini-4-hydrogen' && !levels.includes('xhigh')) levels.push('xhigh');
    return levels;
  }

  _syncEffortOption() {
    const index = this.configOptions.findIndex((option) => option.id === 'thought_level');
    const levels = this._effortLevelsFor(this.currentModel);
    if (levels === null) {
      if (index >= 0) this.configOptions.splice(index, 1);
      return;
    }
    const next = {
      id: 'thought_level',
      name: 'Thinking',
      currentValue: this.currentEffort,
      options: levels.map((level) => ({ value: level, name: level })),
    };
    if (index >= 0) this.configOptions[index] = next;
    else this.configOptions.splice(1, 0, next);
  }

  _cloneConfigOptions() {
    return this.configOptions.map((option) => ({
      ...option,
      options: option.options.map((item) => ({ ...item })),
    }));
  }

  /* -------- prompt -------- */

  async _handlePrompt(requestId, params) {
    this.promptCount += 1;
    const text = Array.isArray(params?.prompt)
      ? params.prompt.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
      : '';
    this.lastPrompt = text;
    this.cancelled = false;
    const sessionId = this.options.updateSessionId ?? params?.sessionId;

    for (const toolCall of this.options.toolCalls) {
      this._notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: toolCall.toolCallId ?? 'call-' + String(this.promptCount) + '-' + String(toolCall.name ?? 'tool'),
          name: toolCall.name ?? 'tool',
          title: toolCall.title ?? toolCall.name ?? 'tool',
          kind: toolCall.kind ?? 'execute',
          status: toolCall.status ?? 'completed',
        },
      });
      await tick();
      if (this.cancelled) {
        this._respond(requestId, { stopReason: 'cancelled' });
        return;
      }
    }

    for (const update of this.options.toolCallUpdates) {
      this._notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: update.toolCallId,
          name: update.name,
          title: update.title,
          status: update.status ?? 'completed',
        },
      });
      await tick();
    }

    if (this.options.thoughtText) {
      this._notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: this.options.thoughtText },
        },
      });
      await tick();
    }

    for (const request of this.options.permissionRequests) {
      const { promise } = this._requestClient('session/request_permission', {
        sessionId,
        toolCall: request.toolCall,
        options: request.options ?? [
          { optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject-1', kind: 'reject_once', name: 'Reject once' },
        ],
      });
      try {
        const result = await promise;
        this.permissionResponses.push(result);
      } catch (error) {
        this.log.errors.push('权限请求失败: ' + String(error?.message ?? error));
        this.permissionResponses.push({ error: String(error?.message ?? error) });
      }
      await tick();
      if (this.cancelled) {
        this._respond(requestId, { stopReason: 'cancelled' });
        return;
      }
    }

    for (const usage of Array.isArray(this.options.usageUpdates) ? this.options.usageUpdates : []) {
      this._notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'usage_update', ...usage },
      });
      await tick();
      if (this.cancelled) {
        this._respond(requestId, { stopReason: 'cancelled' });
        return;
      }
    }

    const reply = String(this.options.replyText ?? '');
    const chunkSize = Number(this.options.chunkSize);
    const chunks =
      Number.isFinite(chunkSize) && chunkSize > 0 ? splitBySize(reply, chunkSize) : [reply];

    for (const chunk of chunks) {
      if (this.cancelled) break;
      this._notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk },
        },
      });
      await tick();
    }

    if (this.options.promptDelayMs > 0) await delay(this.options.promptDelayMs);

    if (this.options.manualPrompt && !this.cancelled) {
      await new Promise((resolve) => {
        this._manualGate = resolve;
      });
    }

    const stopReason = this.cancelled ? 'cancelled' : this.options.stopReason ?? 'end_turn';
    const resultPayload = { stopReason };
    if (this.options.promptResultUsage && typeof this.options.promptResultUsage === 'object') {
      resultPayload.usage = this.options.promptResultUsage;
    }
    this._respond(requestId, resultPayload);
  }

  _releaseManualGate() {
    if (typeof this._manualGate === 'function') {
      const gate = this._manualGate;
      this._manualGate = null;
      gate();
    }
  }

  finishPrompt() {
    this._releaseManualGate();
  }

  finishInitialize() {
    if (typeof this._releaseInit === 'function') {
      const release = this._releaseInit;
      this._releaseInit = null;
      release();
    }
  }

  get isPromptWaiting() {
    return typeof this._manualGate === 'function';
  }

  get isInitializeWaiting() {
    return typeof this._releaseInit === 'function';
  }
}

function splitBySize(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

export { DEFAULT_MODELS, DEFAULT_LEVELS, DEFAULT_MODES, splitBySize, tick, delay };
