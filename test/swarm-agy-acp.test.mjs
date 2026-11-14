/**
 * dsh-agy-swarm：agy-acp 外部队友接入 —— 离线闭环单测。
 *
 * 零真实配额、零外部包依赖：
 *   - ACP 侧使用 test/support/agy-service-stub.mjs 的契约级替身（不复制 dsh-agy-acp 实现）；
 *   - 真实 ACP 进程链验证属于可选集成套件 test/agy-acp-integration.test.mjs。
 *   - MCP 侧用 createMcpStdioSession 挂在内存流上，经真实 Loopback HTTP 桥落盘。
 *
 * 运行：node --test --test-isolation=none test/swarm-agy-acp.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

import { AgyServiceStub, STUB_MODELS } from './support/agy-service-stub.mjs';


const require = createRequire(import.meta.url);

const swarm = require('../index.js');
const protocol = require('../src/protocol.js');
const boardStoreMod = require('../src/board-store.js');
const prompts = require('../src/prompts.js');
const clientMod = require('../client.js');
const { SwarmMcpBridgeServer, MAX_POSTS_PER_TURN } = require('../src/mcp-bridge-server.js');
const { createMcpStdioSession } = require('../src/mcp-stdio-entry.js');

const { SwarmHostController } = swarm;
const { BoardStore } = boardStoreMod;

const DEFAULT_TMP_BASE = path.join(os.tmpdir(), 'dsh-swarm-tests');
const TMP_BASE = process.env.SWARM_TEST_TMP || DEFAULT_TMP_BASE;
fs.mkdirSync(TMP_BASE, { recursive: true });
const AGY_WORKER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const silentLogger = { warn() {}, debug() {}, info() {}, error() {} };

function makeTempDir(prefix = 'dsh-swarm-agy-') {
  return fs.mkdtempSync(path.join(TMP_BASE, prefix));
}

function rmQuiet(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 偶发 EBUSY：临时目录残留不影响结论
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await delay(5);
  }
  throw new Error('timed out waiting for ' + label);
}

/* ------------------------------------------------------------------ */
/* MCP 内存客户端（驱动 createMcpStdioSession）                          */
/* ------------------------------------------------------------------ */

function createMcpClient({ authFile, resolveAuth, httpRequest, framing = 'ndjson' } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const session = createMcpStdioSession({ readable: input, writable: output, authFile, resolveAuth, httpRequest });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  const unsolicited = [];

  const deliver = (message) => {
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    } else {
      unsolicited.push(message);
    }
  };

  output.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (framing === 'content-length') {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('latin1'));
        const length = Number(match[1]);
        if (buffer.length < headerEnd + 4 + length) return;
        const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
        buffer = buffer.subarray(headerEnd + 4 + length);
        deliver(JSON.parse(body));
      } else {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        if (line.trim()) deliver(JSON.parse(line));
      }
    }
  });

  const sendRaw = (text) => {
    if (framing === 'content-length') {
      const bytes = Buffer.from(text, 'utf8');
      input.write(`Content-Length: ${bytes.length}\r\n\r\n`);
      input.write(bytes);
    } else {
      input.write(text + '\n');
    }
  };

  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP 请求超时：' + method)), 5000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  };

  return {
    session,
    unsolicited,
    request,
    sendRaw,
    nextIdPeek: () => nextId,
    waitUnsolicited: (predicate) => waitFor(() => unsolicited.some(predicate), 3000, 'unsolicited mcp frame'),
    notify: (method, params = {}) => sendRaw(JSON.stringify({ jsonrpc: '2.0', method, params })),
    async callTool(name, args = {}) {
      const message = await request('tools/call', { name, arguments: args });
      return message.result;
    },
    async close() {
      input.end();
      await session.done;
    },
  };
}

function toolJson(result) {
  assert.ok(result && Array.isArray(result.content), 'MCP tool result 必须带 content');
  assert.notEqual(result.isError, true, 'tool 不应报错：' + result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

function toolErrorText(result) {
  assert.equal(result.isError, true, '期望 isError:true');
  return String(result.content[0].text);
}

function authFileOf(input) {
  const server = (input.mcpServers || []).find((s) => s.name === swarm.SWARM_MCP_SERVER_NAME);
  assert.ok(server, 'runDirectTurn 必须带上 dsh_swarm_bridge MCP 服务');
  return server.args[server.args.indexOf('--auth-file') + 1];
}

async function withBridge(input, fn, framing = 'ndjson') {
  const client = createMcpClient({ authFile: authFileOf(input), framing });
  try {
    const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'dsh_swarm_bridge');
    client.notify('notifications/initialized', {});
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** 直连桥的原始 HTTP 请求（agent:false 绕开代理）。 */
function rawPost(url, { token, body, contentType = 'application/json', method = 'POST', pathname = '/rpc', rawBody } = {}) {
  const parsed = new URL(url);
  const payload = rawBody !== undefined ? Buffer.from(rawBody) : Buffer.from(JSON.stringify(body ?? {}));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(parsed.port),
        path: pathname,
        method,
        agent: false,
        headers: {
          ...(token !== undefined ? { Authorization: 'Bearer ' + token } : {}),
          'Content-Type': contentType,
          'Content-Length': payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/* ------------------------------------------------------------------ */
/* agy 服务夹具                                                         */
/* ------------------------------------------------------------------ */

function completed(outputText = '', extra = {}) {
  return {
    status: 'completed',
    detail: '完成',
    outputText,
    agySessionId: 'agy-sess-scripted',
    toolCalls: [],
    deniedActions: [],
    warnings: [],
    ...extra,
  };
}

/** 契约级 ACP 替身：模型校验 / peek 由替身提供，runDirectTurn 由脚本驱动。 */
function createScriptedAgy(script) {
  const stateDir = makeTempDir('agy-scripted-');
  const svc = new AgyServiceStub({ stateDir });
  const calls = [];
  const errors = [];
  const stops = [];
  svc.runDirectTurn = async (input) => {
    calls.push(input);
    try {
      return await script(input, calls.length);
    } catch (err) {
      errors.push(err);
      throw err;
    }
  };
  const origStop = svc.stopWorker.bind(svc);
  svc.stopWorker = (parent, name) => {
    const outcome = origStop(parent, name);
    stops.push({ parent, name, outcome });
    return outcome;
  };
  const listModelsCalls = { count: 0 };
  const origList = svc.listModels.bind(svc);
  svc.listModels = (...args) => {
    listModelsCalls.count += 1;
    return origList(...args);
  };
  return {
    svc,
    calls,
    errors,
    stops,
    removes: svc.removed,
    listModelsCalls,
    stateDir,
    assertNoScriptErrors() {
      if (errors.length > 0) throw errors[0];
    },
  };
}


/* ------------------------------------------------------------------ */
/* Swarm 控制器夹具                                                      */
/* ------------------------------------------------------------------ */

function createAgyHarness(options = {}) {
  const baseDir = makeTempDir('dsh-swarm-agy-');
  const coordId = options.coordinatorSessionId || 'coord-agy-001';
  const cwd = baseDir;
  const followups = [];
  const policy = {
    sandboxMode: options.sandboxMode ?? 'workspace-write',
    planMode: options.planMode === true,
    // P1-3：可动态切换的病态策略服务（缺失 / resolve 抛错 / 返回无效 mode）
    noSandboxPolicy: options.noSandboxPolicy === true,
    throwOnResolve: false,
    invalidMode: false,
  };
  const coordCtx = {
    get(name) {
      if (name === 'sandboxPolicy') {
        if (policy.noSandboxPolicy) return undefined;
        return {
          resolve: () => {
            if (policy.throwOnResolve) throw new Error('policy store unavailable');
            if (policy.invalidMode) return {};
            return { mode: policy.sandboxMode };
          },
        };
      }
      if (name === 'planMode') return { get: () => ({ active: policy.planMode, pending: false }) };
      return undefined;
    },
  };
  const coordAgent = {
    id: coordId,
    status: 'idle',
    session: {
      id: coordId,
      header: { id: coordId, cwd, createdAt: Date.now() },
      append() {},
      snapshotEvents: () => [],
    },
    ctx: coordCtx,
    options: {},
    inbox: { size: 0, nextTurn: [], nextStep: [] },
    model: { current: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' } },
    followup(message) {
      followups.push(message);
    },
  };
  const agentsMap = new Map([[coordId, coordAgent]]);
  const createCalls = [];
  const ctx = {
    get(name) {
      return this[name];
    },
    agents: {
      get: (id) => agentsMap.get(id),
      async create(createOptions) {
        createCalls.push(createOptions);
        throw new Error('agy 成员绝不应调用 ctx.agents.create');
      },
    },
    llm: {
      async listProviders() {
        return ['deepseek'];
      },
      async listModels() {
        return [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'stub-model-alpha', name: 'Local Opus Mirror' },
        ];
      },
    },
    ...(options.agySvc ? { agyAcp: options.agySvc } : {}),
  };
  const controller = new SwarmHostController(ctx, {
    baseDir,
    nodeExecutable: process.execPath,
    ...(options.config || {}),
  });
  const exec = {
    agent: coordAgent,
    concluded: 0,
    concludeTurn() {
      exec.concluded += 1;
    },
  };
  return {
    baseDir,
    coordId,
    controller,
    ctx,
    exec,
    policy,
    agentsMap,
    coordAgent,
    followups,
    createCalls,
    get store() {
      return controller.stores.getOrLoadStore(coordId);
    },
    member(name) {
      return controller.stores.getOrLoadStore(coordId)?.getMember(name);
    },
    followupTexts() {
      return followups.map((m) => m.content.map((b) => b.text || '').join(''));
    },
    async settle(rounds = 60) {
      for (let i = 0; i < rounds; i += 1) {
        const pendingTurns = [...controller.agyTurns.values()].map((t) => t.promise);
        if (pendingTurns.length > 0) {
          await Promise.all(pendingTurns);
          continue;
        }
        await delay(25);
        if (controller.agyTurns.size === 0) return;
      }
    },
    async cleanup(extraDirs = []) {
      await controller.dispose();
      if (options.agySvc && typeof options.agySvc.dispose === 'function') {
        await options.agySvc.dispose();
      }
      rmQuiet(baseDir);
      for (const dir of extraDirs) rmQuiet(dir);
    },
  };
}

function swarmAdd(harness, args) {
  return harness.controller.executeSwarmTool({ action: 'add', ...args }, harness.exec);
}

function coordPost(harness, text) {
  return harness.controller.executePostMessageTool({ text }, harness.exec);
}

/* ================================================================== */
/* 1. 纯单元：标识、策略、Node 解析、持久化、协议、提示词                   */
/* ================================================================== */

test('agy 模型标识识别与 Worker 名生成（含下划线 / 数字开头 / 超长名）', () => {
  for (const spec of ['agy', 'AGY', 'agy/stub-model-alpha', 'agy-acp', 'Agy-Acp/argon-medium', ' agy/stub-model-beta ']) {
    assert.equal(swarm.isAgyModelSpec(spec), true, spec);
  }
  for (const spec of ['', 'agyx/opus', 'deepseek/agy', 'stub-model-alpha', undefined, 42]) {
    assert.equal(swarm.isAgyModelSpec(spec), false, String(spec));
  }

  const a = swarm.makeAgyWorkerName('auth_judge', 'coord-1', 'agy-s1');
  assert.match(a, AGY_WORKER_NAME_RE);
  assert.ok(a.startsWith('auth-judge-'));
  const b = swarm.makeAgyWorkerName('auth_judge', 'coord-1', 'agy-s2');
  assert.notEqual(a, b, '不同成员会话必须得到不同 Worker 名');
  assert.match(swarm.makeAgyWorkerName('a'.repeat(48), 'c', 's'), AGY_WORKER_NAME_RE);
  assert.match(swarm.makeAgyWorkerName('x__y--z_', 'c', 's'), AGY_WORKER_NAME_RE);
});

test('resolveAgyPolicy：父会话 Plan / 只读强制 plan 且拒绝 accept-edits，fullAccess 仅 danger-full-access', () => {
  const ww = swarm.resolveAgyPolicy({ sandboxMode: 'workspace-write' });
  assert.deepEqual([ww.mode, ww.fullAccess], ['accept-edits', false]);
  const full = swarm.resolveAgyPolicy({ sandboxMode: 'danger-full-access' });
  assert.deepEqual([full.mode, full.fullAccess, full.accessMode], ['accept-edits', true, 'danger-full-access']);
  const fullPlan = swarm.resolveAgyPolicy({ sandboxMode: 'danger-full-access', requestedMode: 'plan' });
  assert.deepEqual([fullPlan.mode, fullPlan.fullAccess], ['plan', false]);
  const ro = swarm.resolveAgyPolicy({ sandboxMode: 'read-only' });
  assert.deepEqual([ro.mode, ro.fullAccess, ro.accessMode], ['plan', false, 'read-only']);
  const plan = swarm.resolveAgyPolicy({ sandboxMode: 'danger-full-access', planMode: true, requestedMode: 'default' });
  assert.deepEqual([plan.mode, plan.fullAccess], ['plan', false]);
  assert.throws(() => swarm.resolveAgyPolicy({ sandboxMode: 'read-only', requestedMode: 'accept-edits' }), /越权/);
  assert.throws(() => swarm.resolveAgyPolicy({ planMode: true, requestedMode: 'accept-edits' }), /越权/);
  assert.throws(() => swarm.resolveAgyPolicy({ requestedMode: 'yolo' }), /不支持的 agy_mode/);
  // 未解析到沙盒策略时按 workspace-write 处理，绝不放宽成完全权限
  assert.equal(swarm.resolveAgyPolicy({}).fullAccess, false);
});

test('resolveNodeExecutable：纯 Node 直用 execPath；Electron 回落宿主捆绑 node / resolveExecutable / 报错', async () => {
  assert.equal(
    await swarm.resolveNodeExecutable({ execPath: 'C:\\node\\node.exe', versions: {}, existsSync: () => true }),
    'C:\\node\\node.exe'
  );
  const bundled = path.resolve('C:\\DSH', 'resources/runtime/primary-runtime/dependencies/node/bin', 'node.exe');
  assert.equal(
    await swarm.resolveNodeExecutable({
      execPath: 'C:\\DSH\\dsh.exe',
      versions: { electron: '33.0.0' },
      platform: 'win32',
      existsSync: (p) => p === bundled,
    }),
    bundled
  );
  assert.equal(
    await swarm.resolveNodeExecutable({
      execPath: 'C:\\DSH\\dsh.exe',
      versions: { electron: '33.0.0' },
      platform: 'win32',
      existsSync: () => false,
      subprocess: { resolveExecutable: async (name) => (name === 'node' ? 'D:\\tools\\node.exe' : null) },
    }),
    'D:\\tools\\node.exe'
  );
  await assert.rejects(
    () =>
      swarm.resolveNodeExecutable({
        execPath: 'C:\\DSH\\dsh.exe',
        versions: { electron: '33.0.0' },
        platform: 'win32',
        existsSync: () => false,
      }),
    /纯 Node 可执行文件/
  );
});

test('BoardStore 持久化并恢复 backend 与全部 agy 字段；updateMemberAgyState 只写白名单', () => {
  const baseDir = makeTempDir();
  try {
    const store = new BoardStore('coord-persist', { baseDir });
    store.ensureCoordinator({ provider: 'deepseek', model: 'deepseek-chat' });
    store.registerMember({ name: 'native', sessionId: 'dsh-1' });
    store.registerMember({
      name: 'auth_judge',
      sessionId: 'agy-1',
      provider: 'agy',
      model: 'stub-model-alpha',
      modelDisplay: 'agy/stub-model-alpha',
      reasoningEffort: 'high',
      backend: 'agy-acp',
      agyWorkerName: 'auth-judge-0a1b2c3d',
      agyMode: 'plan',
    });
    const updated = store.updateMemberAgyState('agy-1', {
      agySessionId: 'sess-9',
      activationEpoch: 3,
      activationCount: 4,
      consecutivePeerWakes: 2,
      circuitBreakNotified: true,
      state: 'killed',
      killed: true,
    });
    assert.equal(updated.killed, false, 'updateMemberAgyState 绝不触碰生命周期字段');
    store.close();

    const reread = new BoardStore('coord-persist', { baseDir });
    const judge = reread.getMember('auth_judge');
    assert.equal(judge.backend, 'agy-acp');
    assert.equal(judge.agySessionId, 'sess-9');
    assert.equal(judge.agyWorkerName, 'auth-judge-0a1b2c3d');
    assert.equal(judge.agyMode, 'plan');
    assert.deepEqual(
      [judge.activationEpoch, judge.activationCount, judge.consecutivePeerWakes, judge.circuitBreakNotified],
      [3, 4, 2, true]
    );
    assert.equal(reread.getMember('native').backend, 'dsh');
    assert.equal(reread.getMember('native').agySessionId, null);

    const status = reread.readBoard('coordinator', { status: true });
    const judgeRow = status.members.find((m) => m.name === 'auth_judge');
    assert.equal(judgeRow.backend, 'agy-acp');
    assert.equal(judgeRow.agy_mode, 'plan');
    assert.equal('backend' in status.members.find((m) => m.name === 'native'), false, 'DSH 成员状态行形状保持不变');

    const snap = reread.toSnapshot();
    assert.equal(snap.members.find((m) => m.name === 'auth_judge').backend, 'agy-acp');
    assert.equal(snap.members.find((m) => m.name === 'native').backend, 'dsh');
    assert.equal(protocol.normalizeSwarmSnapshot({ members: [{ name: 'x' }] }).members[0].backend, 'dsh');
    reread.close();
  } finally {
    rmQuiet(baseDir);
  }
});

test('提示词：agy 信封说明 read_board / post_message、结轮即休眠、严禁 invoke_subagent；协调员技能含 agy/ 与 agy_mode', () => {
  const member = { name: 'auth_judge', addedBy: 'coordinator', channels: ['main'], agyMode: 'plan', cwd: 'C:\\w' };
  const initial = prompts.buildAgyWorkerPromptEnvelope({ member, coordinatorSessionId: 'c1', body: 'BODY-1', isInitial: true });
  for (const needle of ['dsh_swarm_bridge', 'read_board', 'post_message', 'invoke_subagent', 'swarm_wait', 'BODY-1', '`plan`']) {
    assert.ok(initial.includes(needle), needle);
  }
  const later = prompts.buildAgyWorkerPromptEnvelope({ member, coordinatorSessionId: 'c1', body: 'BODY-2' });
  assert.ok(later.includes('BODY-2'));
  assert.ok(later.length < initial.length, '后续轮次只发精简提醒');
  // 未安装可选扩展时，协调员规范里绝不能出现 agy 派发说明。
  assert.ok(!prompts.COORDINATOR_SKILL_CONTENT.includes('agy/'), '未挂载 ACP 时不得注入 agy/ 派发说明');
  assert.ok(!prompts.COORDINATOR_SKILL_CONTENT.includes('agy_mode'), '未挂载 ACP 时不得注入 agy_mode');
  const withAcp = prompts.buildCoordinatorSkillContent({ agyAcpAvailable: true });
  assert.ok(withAcp.includes('agy/') && withAcp.includes('agy_mode'), '挂载 ACP 后才拼接外部队友段落');
  assert.ok(withAcp.startsWith(prompts.COORDINATOR_SKILL_CONTENT), '原生规范保持不变，仅追加可选段落');
  assert.equal(prompts.buildCoordinatorSkillContent({ agyAcpAvailable: false }), prompts.COORDINATOR_SKILL_CONTENT);
});

/* ================================================================== */
/* 2. Stdio MCP 协议层（注入 httpRequest，零网络）                         */
/* ================================================================== */

test('Stdio MCP：initialize / tools/list / 未知方法 / 解析错误 / HTTP 错误统一封装为 isError', async () => {
  const requests = [];
  const client = createMcpClient({
    resolveAuth: () => ({ url: 'http://127.0.0.1:1/rpc', token: 'tok' }),
    httpRequest: async (req) => {
      requests.push(req);
      if (req.body.tool === 'read_board') return { status: 200, json: { ok: true, result: { messages: [], head: 7 } } };
      return { status: 500, json: { ok: false, error: '宿主炸了' } };
    },
  });
  try {
    const init = await client.request('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.ok(init.result.capabilities.tools);
    const list = await client.request('tools/list');
    assert.deepEqual(list.result.tools.map((t) => t.name), ['read_board', 'post_message']);
    assert.deepEqual(list.result.tools[1].inputSchema.required, ['text']);

    assert.equal(toolJson(await client.callTool('read_board', { since: 3 })).head, 7);
    assert.deepEqual(requests[0].body, { tool: 'read_board', arguments: { since: 3 } });
    assert.equal(requests[0].token, 'tok');

    assert.match(toolErrorText(await client.callTool('post_message', { text: 'x' })), /Swarm Error: 宿主炸了 \(HTTP 500\)/);
    assert.match(toolErrorText(await client.callTool('rm_rf', {})), /未知工具/);

    const unknown = await client.request('resources/templates/list');
    assert.equal(unknown.error.code, -32601);

    client.sendRaw('{not json');
    await client.waitUnsolicited((m) => m.error?.code === -32700);
  } finally {
    await client.close();
  }

  const noAuth = createMcpClient({
    resolveAuth: () => {
      throw new Error('本轮 Swarm 桥授权已失效');
    },
    httpRequest: async () => {
      throw new Error('不应发起 HTTP');
    },
  });
  try {
    assert.match(toolErrorText(await noAuth.callTool('read_board', {})), /授权已失效/);
  } finally {
    await noAuth.close();
  }
});

test('Stdio MCP：Content-Length 帧自适应（首帧带 Content-Length 头即切换回复帧格式）', async () => {
  const client = createMcpClient({
    framing: 'content-length',
    resolveAuth: () => ({ url: 'http://127.0.0.1:1/rpc', token: 't' }),
    httpRequest: async () => ({ status: 200, json: { ok: true, result: { ok: '中文结果' } } }),
  });
  try {
    const init = await client.request('initialize', {});
    assert.equal(init.result.serverInfo.name, 'dsh_swarm_bridge');
    assert.equal(client.session.framing, 'content-length');
    assert.equal(toolJson(await client.callTool('read_board', {})).ok, '中文结果');
  } finally {
    await client.close();
  }
});

/* ================================================================== */
/* 3. Loopback HTTP 桥安全（独立实例）                                    */
/* ================================================================== */

test('HTTP 桥：伪造 / 缺失 / 过期 / 吊销 Token、epoch 不符、kill、路径、媒体类型、请求体上限、身份防伪', async () => {
  const baseDir = makeTempDir();
  const store = new BoardStore('coord-bridge', { baseDir });
  store.ensureCoordinator({});
  store.registerMember({ name: 'judge', sessionId: 'agy-s1', backend: 'agy-acp', agyWorkerName: 'judge-00000001', agyMode: 'plan' });
  store.updateMemberAgyState('agy-s1', { activationEpoch: 1 });
  let now = 1_000_000;
  const bridge = new SwarmMcpBridgeServer({
    baseDir,
    now: () => now,
    maxBodyBytes: 512,
    maxPostsPerTurn: 3,
    resolveStore: () => store,
    onReadBoard: ({ store: s, callerName, args }) => ({ caller: callerName, ...s.readBoard(callerName, { since: args.since }) }),
    onPostMessage: ({ store: s, authorName, args }) => {
      const outcome = s.postMessage(authorName, args.text);
      return { seq: outcome.message.seq };
    },
  });
  try {
    assert.equal(bridge.listening, false, '桥必须惰性启动');
    await bridge.ensureStarted();
    assert.equal(bridge.listening, true);
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/rpc$/);

    const grant = bridge.issueTurnGrant({
      coordinatorSessionId: 'coord-bridge',
      memberName: 'judge',
      memberSessionId: 'agy-s1',
      activationEpoch: 1,
      ttlMs: 1000,
    });
    assert.equal(grant.authFilePath, path.join(baseDir, 'coord-bridge', 'tokens', 'judge.json'));
    const authJson = JSON.parse(fs.readFileSync(grant.authFilePath, 'utf8'));
    assert.deepEqual(authJson, { url: bridge.url, token: grant.token });
    assert.match(grant.token, /^[0-9a-f]{64}$/);

    const ok = await rawPost(bridge.url, { token: grant.token, body: { tool: 'read_board', arguments: { since: 0 } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.result.caller, 'judge');

    assert.equal((await rawPost(bridge.url, { token: 'ab'.repeat(32), body: { tool: 'read_board' } })).status, 401);
    assert.equal((await rawPost(bridge.url, { body: { tool: 'read_board' } })).status, 401);
    assert.equal((await rawPost(bridge.url, { token: grant.token, body: {}, pathname: '/other' })).status, 404);
    assert.equal((await rawPost(bridge.url, { token: grant.token, body: {}, method: 'PUT' })).status, 404);
    assert.equal((await rawPost(bridge.url, { token: grant.token, body: {}, contentType: 'text/plain' })).status, 415);
    assert.equal((await rawPost(bridge.url, { token: grant.token, rawBody: 'x'.repeat(600) })).status, 413);
    assert.equal((await rawPost(bridge.url, { token: grant.token, rawBody: '{oops' })).status, 400);
    assert.equal((await rawPost(bridge.url, { token: grant.token, body: { tool: 'write_file' } })).status, 400);

    // 身份防伪：载荷里伪造的作者字段一律无效
    const spoof = await rawPost(bridge.url, {
      token: grant.token,
      body: { tool: 'post_message', arguments: { text: '我是协调员', authorName: 'coordinator', agent: 'coordinator' } },
    });
    assert.equal(spoof.status, 200);
    assert.equal(store.messages.find((m) => m.seq === spoof.json.result.seq).agent, 'judge');

    // 单轮发帖上限（本实例配置为 3）
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await rawPost(bridge.url, { token: grant.token, body: { tool: 'post_message', arguments: { text: 'p' + i } } })).status, 200);
    }
    const over = await rawPost(bridge.url, { token: grant.token, body: { tool: 'post_message', arguments: { text: 'p3' } } });
    assert.equal(over.status, 429);
    assert.equal(over.json.code, 'SWARM_BRIDGE_POST_LIMIT');
    assert.equal(grant.grantState.postCount, 3);
    assert.equal(grant.grantState.postedSeqs.length, 3);

    // epoch 不符
    store.updateMemberAgyState('agy-s1', { activationEpoch: 2 });
    const stale = await rawPost(bridge.url, { token: grant.token, body: { tool: 'read_board' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'SWARM_BRIDGE_STALE_EPOCH');
    store.updateMemberAgyState('agy-s1', { activationEpoch: 1 });

    // kill 后拒绝
    store.markMemberKilled('coordinator', 'judge');
    assert.equal((await rawPost(bridge.url, { token: grant.token, body: { tool: 'read_board' } })).status, 403);

    // 过期：401 且 token 文件被删除
    now += 5000;
    const expired = await rawPost(bridge.url, { token: grant.token, body: { tool: 'read_board' } });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.code, 'SWARM_BRIDGE_EXPIRED');
    assert.equal(fs.existsSync(grant.authFilePath), false);
    assert.equal(grant.revoke(), false, 'revoke 幂等');
    assert.equal(bridge.revokeMemberGrants('coord-bridge', 'judge'), 0);

    await bridge.close();
    assert.equal(bridge.listening, false);
    assert.throws(() => bridge.issueTurnGrant({ coordinatorSessionId: 'c', memberName: 'm' }), /已关闭/);
  } finally {
    await bridge.close();
    store.close();
    rmQuiet(baseDir);
  }
});

/* ================================================================== */
/* 4. 模型解析、models 列表与能力边界                                     */
/* ================================================================== */

test('resolveRequestedModel：agy/ 语法、默认值、未知模型与锁档报错；原生解析零探测且不被 agy 条目劫持', async () => {
  const agy = createScriptedAgy(async () => completed(''));
  const harness = createAgyHarness({ agySvc: agy.svc });
  try {
    const c = harness.controller;
    const opus = await c.resolveRequestedModel('agy/stub-model-alpha-high');
    assert.deepEqual(opus, {
      backend: 'agy-acp',
      provider: 'agy',
      model: 'stub-model-alpha',
      reasoningEffort: 'high',
      modelDisplay: 'agy/stub-model-alpha',
    });
    const carbon = await c.resolveRequestedModel('agy/stub-model-alpha');
    assert.deepEqual([carbon.model, carbon.reasoningEffort], ['stub-model-alpha', 'high']);
    // Gemini 3.8 Flash 已退役：agy/flash 必须当场报错并列出可用模型。
    await assert.rejects(() => c.resolveRequestedModel('agy/flash'), (err) => {
      assert.match(err.message, /无法解析外部模型|未知模型/);
      assert.ok(err.message.includes('stub-model-alpha'));
      return true;
    });
    const argon = await c.resolveRequestedModel('AGY-ACP/stub-model-alpha-medium');
    assert.deepEqual([argon.model, argon.reasoningEffort], ['stub-model-alpha', 'medium']);
    const hydrogen = await c.resolveRequestedModel('agy/stub-model-beta');
    assert.deepEqual([hydrogen.backend, hydrogen.model, hydrogen.reasoningEffort], [
      'agy-acp',
      'stub-model-beta',
      'high',
    ]);
    const hydrogenHigh = await c.resolveRequestedModel('agy/stub-model-beta-high');
    assert.deepEqual([hydrogenHigh.model, hydrogenHigh.reasoningEffort], ['stub-model-beta', 'high']);
    const hydrogenXhigh = await c.resolveRequestedModel('agy/stub-model-beta-xhigh');
    assert.deepEqual([hydrogenXhigh.model, hydrogenXhigh.reasoningEffort], ['stub-model-beta', 'xhigh']);
    // Argon / Carbon 不接受 xhigh，必须当场报错而不是静默压成 high。
    await assert.rejects(() => c.resolveRequestedModel('agy/stub-model-alpha-xhigh'), (err) => /xhigh/.test(err.message));
    // Orchestrator 明确无思考档位：解析成功但 effort 为 null。
    const orchestrator = await c.resolveRequestedModel('agy/stub-model-flat');
    assert.equal(orchestrator.model, 'stub-model-flat');
    // 无档位模型在 swarm 层被规范成空字符串（null 的下游表示）。
    assert.ok(!orchestrator.reasoningEffort, 'orchestrator 不得带任何思考档位');
    const bare = await c.resolveRequestedModel('agy');
    assert.equal(bare.model, agy.svc.config.defaultModel);
    assert.equal((await c.resolveRequestedModel('agy/default')).model, agy.svc.config.defaultModel);

    await assert.rejects(() => c.resolveRequestedModel('agy/gpt-9'), (err) => {
      assert.match(err.message, /无法解析外部模型 "agy\/gpt-9"/);
      assert.ok(err.message.includes('stub-model-alpha'), '必须列出可用模型');
      return true;
    });
    await assert.rejects(() => c.resolveRequestedModel('agy/stub-model-locked-high'), /固定思考档位为 medium/);

    // 原生解析：裸写 stub-model-alpha 命中 DSH 目录，不会被路由到 agy
    const native = await c.resolveRequestedModel('stub-model-alpha', { provider: 'deepseek', model: 'deepseek-chat' });
    assert.equal(native.provider, 'deepseek');
    assert.equal(native.backend, undefined);
    assert.equal(agy.listModelsCalls.count, 0, '常规解析绝不触发 agy 目录探测');
    assert.equal(agy.calls.length, 0);
  } finally {
    await harness.cleanup([agy.stateDir]);
  }

  const bare = createAgyHarness();
  try {
    await assert.rejects(
      () => bare.controller.resolveRequestedModel('agy/stub-model-alpha'),
      /当前宿主未启用 dsh-agy-acp 插件，无法使用外部模型 "agy\/stub-model-alpha"/
    );
    const models = await bare.controller.executeSwarmTool({ action: 'models' }, bare.exec);
    assert.equal(models.models.some((m) => m.provider === 'agy'), false, '未挂载插件时不列出 agy 条目');
  } finally {
    await bare.cleanup();
  }
});

test('swarm models：默认 peekModels 零探测；all:true 真探测；探测失败降级回 peek', async () => {
  const agy = createScriptedAgy(async () => completed(''));
  const harness = createAgyHarness({ agySvc: agy.svc });
  try {
    const peek = await harness.controller.executeSwarmTool({ action: 'models' }, harness.exec);
    const peekAgy = peek.models.filter((m) => m.provider === 'agy');
    assert.equal(agy.listModelsCalls.count, 0, '默认 models 绝不探测后端目录');
    assert.equal(peekAgy.length, STUB_MODELS.length);
    assert.ok(peekAgy.every((m) => m.key === 'agy/' + m.model && m.name.startsWith('[AGY ACP] ') && m.backend === 'agy-acp'));
    assert.ok(peek.models.some((m) => m.key === 'deepseek/deepseek-chat'));

    let probeCalls = 0;
    agy.svc.listModels = async () => {
      probeCalls += 1;
      return { models: [{ value: 'stub-model-probe', name: 'Probe Model' }] };
    };
    const probed = await harness.controller.executeSwarmTool({ action: 'models', all: true }, harness.exec);
    assert.equal(probeCalls, 1, 'all:true 才真探测一次');
    assert.deepEqual(
      probed.models.filter((m) => m.provider === 'agy').map((m) => m.key),
      ['agy/stub-model-probe']
    );

    agy.svc.listModels = async () => {
      throw new Error('probe boom');
    };
    const degraded = await harness.controller.executeSwarmTool({ action: 'models', all: true }, harness.exec);
    assert.equal(degraded.models.filter((m) => m.provider === 'agy').length, STUB_MODELS.length);
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('能力边界：fork / share / monitor / 非 agy 传 agy_mode / Plan 或只读越权 accept-edits 全部当场拦截且零副作用', async () => {
  const agy = createScriptedAgy(async () => completed(''));
  const harness = createAgyHarness({ agySvc: agy.svc });
  try {
    const base = { brief: '审查', model: 'agy/stub-model-alpha-high' };
    await assert.rejects(() => swarmAdd(harness, { ...base, name: 'judge', fork: true }), /不支持 fork/);
    await assert.rejects(() => swarmAdd(harness, { ...base, name: 'judge', fork: 'coordinator' }), /不支持 fork/);
    await assert.rejects(() => swarmAdd(harness, { ...base, name: 'judge', workspace: 'share' }), /workspace:"share"/);
    await assert.rejects(() => swarmAdd(harness, { ...base, name: 'monitor' }), /不能担任 monitor/);
    await assert.rejects(() => swarmAdd(harness, { ...base, name: 'monitor', n: 2 }), /不能担任 monitor/);
    await assert.rejects(
      () => swarmAdd(harness, { name: 'native', brief: 'x', model: 'deepseek/deepseek-chat', agy_mode: 'plan' }),
      /agy_mode 仅对/
    );
    await assert.rejects(() => swarmAdd(harness, { ...base, name: 'judge', agy_mode: 'yolo' }), /不支持的 agy_mode/);
    await assert.rejects(() => swarmAdd(harness, { ...base, name: 'judge', model: 'agy/gpt-9' }), /无法解析外部模型/);
    assert.equal(harness.member('judge'), undefined);
    assert.equal(harness.member('monitor'), undefined);
    assert.equal(agy.calls.length, 0);
    assert.equal(harness.createCalls.length, 0);
  } finally {
    await harness.cleanup([agy.stateDir]);
  }

  for (const variant of [{ planMode: true }, { sandboxMode: 'read-only' }]) {
    const scripted = createScriptedAgy(async () => completed(''));
    const h = createAgyHarness({ agySvc: scripted.svc, ...variant });
    try {
      await assert.rejects(
        () => swarmAdd(h, { name: 'judge', brief: 'x', model: 'agy/stub-model-alpha', agy_mode: 'accept-edits' }),
        /越权/
      );
      assert.equal(h.member('judge'), undefined);
      // 未显式传 agy_mode：强制 plan + 无完全权限
      await swarmAdd(h, { name: 'judge', brief: 'x', model: 'agy/stub-model-alpha' });
      await h.settle();
      assert.equal(h.member('judge').agyMode, 'plan');
      assert.equal(scripted.calls[0].mode, 'plan');
      assert.equal(scripted.calls[0].planMode, true);
      assert.equal(scripted.calls[0].fullAccess, false);
    } finally {
      await h.cleanup([scripted.stateDir]);
    }
  }
});

test('add agy 成员：持久字段、runDirectTurn 入参（桥白名单 / mcpServers / 模式权限）与 danger-full-access 推导', async () => {
  const agy = createScriptedAgy(async () => completed(''));
  const harness = createAgyHarness({ agySvc: agy.svc, sandboxMode: 'danger-full-access' });
  try {
    const result = await swarmAdd(harness, { name: 'builder', brief: '实现模块 A', model: 'agy/stub-model-beta-high' });
    assert.equal(result.status, 'added');
    const added = result.added[0];
    assert.equal(added.backend, 'agy-acp');
    assert.equal(added.model, 'agy/stub-model-beta');
    assert.equal(added.agy_mode, 'accept-edits');
    assert.match(added.agy_worker, AGY_WORKER_NAME_RE);
    assert.equal(harness.createCalls.length, 0, 'agy 成员绝不创建 DSH 子会话');

    const member = harness.member('builder');
    assert.equal(member.backend, 'agy-acp');
    assert.equal(member.provider, 'agy');
    assert.equal(member.model, 'stub-model-beta');
    assert.equal(member.reasoningEffort, 'high');
    assert.equal(member.modelDisplay, 'agy/stub-model-beta');
    assert.equal(member.agyFullAccess, true);
    assert.ok(member.sessionId.startsWith('agy-'));
    assert.equal(harness.store.messages[0].text.startsWith('@builder 实现模块 A'), true);

    await harness.settle();
    const input = agy.calls[0];
    assert.equal(input.parentSessionId, harness.coordId);
    assert.equal(input.name, member.agyWorkerName);
    assert.equal(input.model, 'stub-model-beta');
    assert.equal(input.effort, 'high');
    assert.equal(input.mode, 'accept-edits');
    assert.equal(input.fullAccess, true);
    assert.equal(input.wait, false);
    assert.equal(input.sessionMode, 'new');
    assert.ok(input.signal instanceof AbortSignal);
    assert.deepEqual(input.bridgeAllowlist, {
      serverName: 'dsh_swarm_bridge',
      readOnlyTools: ['read_board'],
      coordinationTools: ['post_message'],
      writeTools: [],
    });
    assert.equal(input.mcpServers.length, 1);
    assert.equal(input.mcpServers[0].command, process.execPath);
    assert.equal(input.mcpServers[0].args[0], swarm.MCP_STDIO_ENTRY);
    assert.ok(input.prompt.includes('<swarm_agy_worker>'));
    assert.ok(input.prompt.includes('实现模块 A'));
    assert.equal(fs.existsSync(authFileOf(input)), false, '轮次结束后 token 文件必须已删除');

    // 象限 3：未发帖且空白输出 → stopped
    assert.equal(harness.member('builder').state, 'stopped');
    assert.equal(harness.member('builder').lastError, swarm.AGY_EMPTY_TURN_MESSAGE);

    // 显式 plan 锁死只读：即使父会话完全权限也不给 fullAccess
    await swarmAdd(harness, { name: 'judge', brief: '审查', model: 'agy/stub-model-alpha', agy_mode: 'plan' });
    await harness.settle();
    assert.equal(harness.member('judge').agyFullAccess, false);
    assert.equal(agy.calls[1].fullAccess, false);
    assert.equal(agy.calls[1].mode, 'plan');
    agy.assertNoScriptErrors();
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

/* ================================================================== */
/* 5. 桥闭环（真实 Loopback HTTP + Stdio 会话）                           */
/* ================================================================== */

test('桥闭环：initialize → tools/list → read_board(inbox_only) → post_message 唤醒协调员；防伪 / 上限 / epoch / 吊销', async () => {
  const saved = {};
  let harness;
  const agy = createScriptedAgy(async (input, n) => {
    if (n > 1) return completed('');
    const authFile = authFileOf(input);
    saved.auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    saved.authFile = authFile;
    const store = harness.store;
    const me = store.getMember('judge');
    await withBridge(input, async (client) => {
      const list = await client.request('tools/list');
      assert.deepEqual(list.result.tools.map((t) => t.name), ['read_board', 'post_message']);

      const note = toolJson(await client.callTool('post_message', { text: '进度备注（无门铃）' }));
      const all = toolJson(await client.callTool('read_board', { since: 0 }));
      assert.deepEqual(all.messages.map((m) => m.seq), [1, note.seq]);
      const inbox = toolJson(await client.callTool('read_board', { since: 0, inbox_only: true }));
      assert.equal(inbox.inbox_only, true);
      assert.deepEqual(inbox.messages.map((m) => m.seq), [1], 'inbox_only 只返回点名自己的消息');

      const posted = toolJson(
        await client.callTool('post_message', { text: '@coordinator 审查完成：无阻塞问题', authorName: 'coordinator', agent: 'coordinator' })
      );
      assert.equal(store.messages.find((m) => m.seq === posted.seq).agent, 'judge', '身份强制取 grant.memberName');
      assert.deepEqual(posted.woken, ['coordinator']);

      for (let i = 0; i < MAX_POSTS_PER_TURN - 2; i += 1) {
        toolJson(await client.callTool('post_message', { text: '补充说明 ' + i }));
      }
      assert.match(toolErrorText(await client.callTool('post_message', { text: '第 9 条' })), /上限 8 条.*HTTP 429/);

      const epoch = me.activationEpoch;
      store.updateMemberAgyState(me.sessionId, { activationEpoch: epoch + 7 });
      assert.match(toolErrorText(await client.callTool('read_board', {})), /epoch/);
      store.updateMemberAgyState(me.sessionId, { activationEpoch: epoch });

      const forged = await rawPost(saved.auth.url, { token: '00'.repeat(32), body: { tool: 'read_board' } });
      assert.equal(forged.status, 401);
    });
    return completed('尾段 TAIL-TEXT @coordinator', { agySessionId: 'agy-sess-A' });
  });
  harness = createAgyHarness({ agySvc: agy.svc });
  try {
    const added = await swarmAdd(harness, { name: 'judge', brief: '审查 auth', model: 'agy/stub-model-alpha-high', agy_mode: 'plan', wait: true });
    assert.equal(added.waiting, true);
    assert.equal(harness.exec.concluded, 1);
    await harness.settle();
    agy.assertNoScriptErrors();

    const judge = harness.member('judge');
    // 象限 1：已发帖 → 不重复代发尾段文本，进入 waiting
    assert.equal(judge.state, 'waiting');
    assert.equal(judge.lastError, '');
    assert.equal(harness.store.messages.some((m) => m.text.includes('TAIL-TEXT')), false);
    assert.equal(harness.store.messages.some((m) => m.text.includes(swarm.AGY_AUTO_ARCHIVE_TAG)), false);
    assert.equal(judge.agySessionId, 'agy-sess-A');
    assert.ok(harness.followupTexts().some((t) => t.includes('审查完成：无阻塞问题')), '协调员必须被门铃唤醒');

    // 吊销：token 文件已删除，旧 token 直连 401，stdio 客户端报授权失效
    assert.equal(fs.existsSync(saved.authFile), false);
    assert.equal((await rawPost(saved.auth.url, { token: saved.auth.token, body: { tool: 'read_board' } })).status, 401);
    const stale = createMcpClient({ authFile: saved.authFile });
    try {
      assert.match(toolErrorText(await stale.callTool('read_board', {})), /授权已失效/);
    } finally {
      await stale.close();
    }

    // 第二轮：沿用 agySessionId 走 load，信封为精简版
    await coordPost(harness, '@judge 请复核第二轮');
    await harness.settle();
    const second = agy.calls[1];
    assert.equal(second.sessionMode, 'load');
    assert.equal(second.agySessionId, 'agy-sess-A');
    assert.ok(second.prompt.includes('请复核第二轮'));
    assert.ok(!second.prompt.includes('## 留言板工具'), '续聊轮次只发精简提醒');
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('桥闭环：Content-Length 帧模式下 read_board{status:true} 返回 agy 成员状态', async () => {
  let harness;
  const agy = createScriptedAgy(async (input) => {
    await withBridge(
      input,
      async (client) => {
        assert.equal(client.session.framing, 'content-length');
        const status = toolJson(await client.callTool('read_board', { status: true }));
        const row = status.members.find((m) => m.name === 'cl_judge');
        assert.equal(row.backend, 'agy-acp');
        assert.equal(row.state, 'working');
        toolJson(await client.callTool('post_message', { text: '@coordinator CL 帧正常' }));
      },
      'content-length'
    );
    return completed('');
  });
  harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'cl_judge', brief: 'x', model: 'agy/stub-model-alpha' });
    await harness.settle();
    agy.assertNoScriptErrors();
    assert.ok(harness.store.messages.some((m) => m.agent === 'cl_judge' && m.text.includes('CL 帧正常')));
    assert.equal(harness.member('cl_judge').state, 'waiting');
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

/* ================================================================== */
/* 6. 四象限终态                                                         */
/* ================================================================== */

test('象限 2：漏调 post_message 的纯文本自动补 @触发者 归档上板并唤醒；自带门铃则原样归档；@#main 正文围栏包裹', async () => {
  const outputs = ['审查通过，未发现问题。', '@coordinator 已完成复核', '注意不要用 @#main 群发'];
  const agy = createScriptedAgy(async (_input, n) => completed(outputs[n - 1] ?? ''));
  const harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'judge', brief: '审查', model: 'agy/stub-model-alpha', wait: true });
    await harness.settle();
    const store = harness.store;
    const first = store.messages.find((m) => m.agent === 'judge');
    assert.equal(first.text, `@coordinator ${swarm.AGY_AUTO_ARCHIVE_TAG}\n\n审查通过，未发现问题。`);
    assert.deepEqual(first.mentions, ['coordinator']);
    assert.ok(harness.followupTexts().some((t) => t.includes('审查通过，未发现问题。')));
    assert.equal(harness.member('judge').state, 'waiting');

    await coordPost(harness, '@judge 再看一下');
    await harness.settle();
    const second = store.messages.filter((m) => m.agent === 'judge')[1];
    assert.equal(second.text, `${swarm.AGY_AUTO_ARCHIVE_TAG}\n@coordinator 已完成复核`);

    await coordPost(harness, '@judge 第三轮');
    await harness.settle();
    const third = store.messages.filter((m) => m.agent === 'judge')[2];
    assert.ok(third.text.startsWith(`@coordinator ${swarm.AGY_AUTO_ARCHIVE_TAG}`));
    assert.ok(third.text.includes('```text\n注意不要用 @#main 群发\n```'));
    assert.equal(harness.member('judge').lastError, '');
    agy.assertNoScriptErrors();
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('象限 3 / 4：空白输出置 stopped；失败与抛错绝不代发残缺文本，lastError 记录原因', async () => {
  const results = [
    () => completed('   '),
    () => ({ status: 'failed', detail: 'agy 拒绝执行本轮（stopReason=refusal）', outputText: '半截回复 HALF', agySessionId: 'agy-sess-F' }),
    () => {
      const err = new Error('ACP 连接已关闭：boom');
      err.partial = { status: 'failed', outputText: '残缺 PARTIAL', agySessionId: 'agy-sess-F2' };
      throw err;
    },
  ];
  const agy = createScriptedAgy(async (_input, n) => results[n - 1]());
  const harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'judge', brief: '审查', model: 'agy/stub-model-alpha' });
    await harness.settle();
    let judge = harness.member('judge');
    assert.equal(judge.state, 'stopped');
    assert.equal(judge.lastError, swarm.AGY_EMPTY_TURN_MESSAGE);
    assert.equal(harness.store.messages.some((m) => m.agent === 'judge'), false);

    await coordPost(harness, '@judge 重试');
    await harness.settle();
    judge = harness.member('judge');
    assert.equal(judge.state, 'stopped');
    assert.match(judge.lastError, /refusal/);
    assert.equal(judge.agySessionId, 'agy-sess-F', '失败轮次也写回 agySessionId 以便续聊');
    assert.equal(harness.store.messages.some((m) => m.text.includes('HALF')), false);

    await coordPost(harness, '@judge 再试');
    await harness.settle();
    judge = harness.member('judge');
    assert.match(judge.lastError, /boom/);
    assert.equal(judge.agySessionId, 'agy-sess-F2');
    assert.equal(harness.store.messages.some((m) => m.text.includes('PARTIAL')), false);
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

/* ================================================================== */
/* 7. 防死循环熔断                                                        */
/* ================================================================== */

test('熔断：两个 agy 成员互 @ 超过 maxConsecutivePeerWakes 停火；action:"model" 重置计数并恢复', async () => {
  const flags = { pingPong: true };
  const turnCounts = {};
  let harness;
  const agy = createScriptedAgy(async (input) => {
    const me = harness.store.state.members.find((m) => m.agyWorkerName === input.name);
    turnCounts[me.name] = (turnCounts[me.name] || 0) + 1;
    const text =
      turnCounts[me.name] === 1
        ? `@coordinator ${me.name} 就绪`
        : !flags.pingPong
          ? '@coordinator 收到，已恢复'
          : me.name === 'alpha'
            ? '@beta ping'
            : '@alpha pong';
    await withBridge(input, (client) => client.callTool('post_message', { text }).then(toolJson));
    return completed('');
  });
  harness = createAgyHarness({ agySvc: agy.svc, config: { maxConsecutivePeerWakes: 2, maxAgyTurnsPerMember: 50 } });
  try {
    await swarmAdd(harness, { name: 'alpha', brief: '对练 A', model: 'agy/stub-model-beta' });
    await swarmAdd(harness, { name: 'beta', brief: '对练 B', model: 'agy/stub-model-beta' });
    await harness.settle();
    assert.equal(harness.member('alpha').state, 'waiting');
    assert.equal(harness.member('beta').state, 'waiting');

    await coordPost(harness, '@alpha 开始对练');
    await waitFor(
      () => ['alpha', 'beta'].some((n) => harness.member(n).lastError.includes('熔断')),
      8000,
      '同伴互唤醒熔断'
    );
    await harness.settle();
    agy.assertNoScriptErrors();

    const tripped = ['alpha', 'beta'].find((n) => harness.member(n).lastError.includes('熔断'));
    const other = tripped === 'alpha' ? 'beta' : 'alpha';
    const broken = harness.member(tripped);
    assert.equal(broken.state, 'stopped');
    assert.equal(broken.circuitBreakNotified, true);
    assert.equal(broken.lastError, swarm.AGY_CIRCUIT_BREAK_MESSAGE);
    assert.equal(broken.pendingWakeup, true, '被熔断拦截的门铃保留，等待协调员裁决');
    assert.ok(turnCounts[tripped] >= 3 && turnCounts[tripped] <= 5, `熔断前轮次 ${turnCounts[tripped]}`);
    assert.equal(harness.member(other).lastError.includes('熔断'), false);
    assert.equal(harness.member(other).state, 'waiting');
    const callsAtBreak = agy.calls.length;
    await delay(80);
    assert.equal(agy.calls.length, callsAtBreak, '熔断后不再自动起新轮次');

    // 协调员裁决：同后端切模型 = 重置熔断计数，并因 lastError 自动续跑一轮
    flags.pingPong = false;
    const switched = await harness.controller.executeSwarmTool(
      { action: 'model', name: tripped, model: 'agy/stub-model-alpha-medium' },
      harness.exec
    );
    assert.equal(switched.status, 'switched');
    assert.equal(switched.model, 'agy/stub-model-alpha');
    await harness.settle();
    agy.assertNoScriptErrors();
    const recovered = harness.member(tripped);
    assert.equal(recovered.circuitBreakNotified, false);
    assert.equal(recovered.lastError, '');
    assert.equal(recovered.state, 'waiting');
    assert.ok(agy.calls.length > callsAtBreak);
    assert.equal(agy.calls[callsAtBreak].model, 'stub-model-alpha');
    assert.equal(agy.calls[callsAtBreak].effort, 'medium');
    assert.ok(harness.store.messages.some((m) => m.agent === tripped && m.text.includes('已恢复')));
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('熔断：单成员总轮次超过 maxAgyTurnsPerMember 后拦截唤醒并报告 wake_errors', async () => {
  let harness;
  const agy = createScriptedAgy(async (input) => {
    await withBridge(input, (client) => client.callTool('post_message', { text: '@coordinator done' }).then(toolJson));
    return completed('');
  });
  harness = createAgyHarness({ agySvc: agy.svc, config: { maxAgyTurnsPerMember: 2 } });
  try {
    await swarmAdd(harness, { name: 'solo', brief: '干活', model: 'agy/stub-model-beta' });
    await harness.settle();
    await coordPost(harness, '@solo 第二轮');
    await harness.settle();
    assert.equal(agy.calls.length, 2);
    const third = await coordPost(harness, '@solo 第三轮');
    assert.deepEqual(third.woken, []);
    assert.equal(third.wake_errors.length, 1);
    assert.match(third.wake_errors[0].error, /熔断.*max-turns/);
    await harness.settle();
    assert.equal(agy.calls.length, 2);
    assert.equal(harness.member('solo').state, 'stopped');
    assert.equal(harness.member('solo').pendingWakeup, true, '被拦截的门铃保留为待处理');
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

/* ================================================================== */
/* 10. 判官返工回归（P0-1 / P1-2 / P1-3 / P2-4 / P2-5）                    */
/* ================================================================== */

test('P0-1：父会话动态降级时本轮权限夹逼（只收紧不提权）；协调员离线沿用持久化快照', async () => {
  const agy = createScriptedAgy(async () => completed(''));
  const harness = createAgyHarness({ agySvc: agy.svc, sandboxMode: 'danger-full-access' });
  try {
    await swarmAdd(harness, { name: 'builder', brief: '施工', model: 'agy/stub-model-beta' });
    await harness.settle();
    const pick = (call) => ({ mode: call.mode, planMode: call.planMode, fullAccess: call.fullAccess, accessMode: call.accessMode });
    assert.deepEqual(pick(agy.calls[0]), { mode: 'accept-edits', planMode: false, fullAccess: true, accessMode: 'danger-full-access' });

    const wake = async (text) => {
      const before = agy.calls.length;
      await coordPost(harness, text);
      await harness.settle();
      assert.equal(agy.calls.length, before + 1, '门铃应起一轮：' + text);
      return agy.calls[agy.calls.length - 1];
    };

    // 父会话切 read-only：强制 plan + read-only + 无完全权限（不抛越权）
    harness.policy.sandboxMode = 'read-only';
    assert.deepEqual(pick(await wake('@builder 第二轮')), { mode: 'plan', planMode: true, fullAccess: false, accessMode: 'read-only' });
    assert.equal(harness.member('builder').agyMode, 'accept-edits', '夹逼只作用于本轮，不改写持久化角色');

    // 父会话开 Plan：plan + workspace-write
    harness.policy.sandboxMode = 'danger-full-access';
    harness.policy.planMode = true;
    assert.deepEqual(pick(await wake('@builder 第三轮')), { mode: 'plan', planMode: true, fullAccess: false, accessMode: 'workspace-write' });

    // 父会话降为 workspace-write：保留 accept-edits 但收回完全权限
    harness.policy.planMode = false;
    harness.policy.sandboxMode = 'workspace-write';
    assert.deepEqual(pick(await wake('@builder 第四轮')), { mode: 'accept-edits', planMode: false, fullAccess: false, accessMode: 'workspace-write' });

    // 父会话恢复 danger-full-access：回到成员自身快照（快照本就允许完全权限）
    harness.policy.sandboxMode = 'danger-full-access';
    assert.equal((await wake('@builder 第五轮')).fullAccess, true);

    // 协调员离线：即使当前策略是只读，也安全沿用持久化快照
    harness.policy.sandboxMode = 'read-only';
    harness.agentsMap.delete(harness.coordId);
    assert.deepEqual(pick(await wake('@builder 第六轮')), { mode: 'accept-edits', planMode: false, fullAccess: true, accessMode: 'danger-full-access' });
    harness.agentsMap.set(harness.coordId, harness.coordAgent);

    // 持久化为 plan 的审查员：父会话再宽也保持 plan、绝不提权
    harness.policy.sandboxMode = 'workspace-write';
    await swarmAdd(harness, { name: 'judge', brief: '审查', model: 'agy/stub-model-alpha', agy_mode: 'plan' });
    await harness.settle();
    harness.policy.sandboxMode = 'danger-full-access';
    const before = agy.calls.length;
    await coordPost(harness, '@judge 复核');
    await harness.settle();
    const judgeCall = agy.calls[before];
    assert.equal(judgeCall.mode, 'plan');
    assert.equal(judgeCall.fullAccess, false);

    // 异步准备窗口（_resolveNodeExecutable 挂起期间）父会话降级为 read-only + Plan：放行后仍必须夹逼
    harness.policy.sandboxMode = 'danger-full-access';
    harness.policy.planMode = false;
    let releaseNodeResolve;
    const nodeResolveGate = new Promise((resolve) => {
      releaseNodeResolve = resolve;
    });
    const origResolveNode = harness.controller._resolveNodeExecutable.bind(harness.controller);
    let enteredNodeResolve = false;
    harness.controller._resolveNodeExecutable = async () => {
      enteredNodeResolve = true;
      await nodeResolveGate;
      return origResolveNode();
    };
    const beforeAsyncWindow = agy.calls.length;
    await coordPost(harness, '@builder 第七轮（异步准备窗口降级）');
    await waitFor(() => enteredNodeResolve, 2000, 'enter _resolveNodeExecutable');
    harness.policy.sandboxMode = 'read-only';
    harness.policy.planMode = true;
    releaseNodeResolve();
    await waitFor(() => agy.calls.length > beforeAsyncWindow, 4000, 'agy turn 7');
    await harness.settle();
    assert.deepEqual(pick(agy.calls[beforeAsyncWindow]), {
      mode: 'plan',
      planMode: true,
      fullAccess: false,
      accessMode: 'read-only',
    });
    harness.controller._resolveNodeExecutable = origResolveNode;
    agy.assertNoScriptErrors();
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('P0-1：clampAgyTurnPolicy 纯函数矩阵', () => {
  const full = { agyMode: 'accept-edits', agyAccessMode: 'danger-full-access', agyFullAccess: true };
  assert.deepEqual(swarm.clampAgyTurnPolicy(full, null), { mode: 'accept-edits', planMode: false, fullAccess: true, accessMode: 'danger-full-access', live: false });
  assert.equal(swarm.clampAgyTurnPolicy(full, { sandboxMode: 'workspace-write' }).fullAccess, false);
  assert.equal(swarm.clampAgyTurnPolicy(full, { sandboxMode: 'workspace-write' }).accessMode, 'workspace-write');
  assert.deepEqual(swarm.clampAgyTurnPolicy(full, { sandboxMode: 'mystery-mode' }), {
    mode: 'plan',
    planMode: true,
    fullAccess: false,
    accessMode: 'read-only',
    live: true,
  }, '未知父会话模式按最严 read-only + plan 收紧');
  const ww = { agyMode: 'accept-edits', agyAccessMode: 'workspace-write', agyFullAccess: false };
  assert.equal(swarm.clampAgyTurnPolicy(ww, { sandboxMode: 'danger-full-access' }).fullAccess, false, '绝不越界提权');
  assert.equal(swarm.clampAgyTurnPolicy(ww, { sandboxMode: 'danger-full-access' }).accessMode, 'workspace-write');
  // 伪造的持久化记录（fullAccess:true 但 accessMode 不是 danger）也不放行
  assert.equal(swarm.clampAgyTurnPolicy({ agyMode: 'accept-edits', agyAccessMode: 'workspace-write', agyFullAccess: true }, null).fullAccess, false);
  assert.equal(swarm.clampAgyTurnPolicy({ agyMode: 'bogus', agyFullAccess: true }, null).mode, 'plan');
});

test('P1-2：add 返回后立即 [done]（setImmediate 窗口内）→ 零 runDirectTurn、零 Token、成员 stopped', async () => {
  const agy = createScriptedAgy(async () => completed('不应运行'));
  const harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'judge', brief: '审查', model: 'agy/stub-model-alpha' });
    assert.equal(harness.controller.agyTurns.size, 1, '轮次已排队但尚未越过 setImmediate');
    const done = await coordPost(harness, '[done] 立即结项');
    assert.equal(done.marked_done, true);
    assert.equal(harness.member('judge').state, 'stopped', '[done] 同步收敛 working 外部成员');
    await harness.settle();
    assert.equal(agy.calls.length, 0, '结项后绝不启动 runDirectTurn');
    assert.equal(harness.controller.mcpBridge, null, '未签发任何桥 Token（桥都未创建）');
    assert.equal(harness.controller.agyTurns.size, 0);
    assert.equal(harness.member('judge').state, 'stopped');
    assert.equal(harness.store.messages.some((m) => m.agent === 'judge'), false);
    assert.ok(agy.stops.some((s) => s.name === harness.member('judge').agyWorkerName));

    // 结项释放了成员控制器：后续 add 重新打开 swarm 后，该成员仍可被唤醒
    await swarmAdd(harness, { name: 'judge2', brief: '新任务', model: 'agy/stub-model-beta' });
    await harness.settle();
    assert.equal(harness.store.state.done, false);
    const before = agy.calls.length;
    await coordPost(harness, '@judge 继续');
    await harness.settle();
    assert.equal(agy.calls.length, before + 1);
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('P1-2：kill 落在 setImmediate 窗口内同样零 runDirectTurn', async () => {
  const agy = createScriptedAgy(async () => completed('不应运行'));
  const harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'judge', brief: '审查', model: 'agy/stub-model-alpha' });
    await harness.controller.executeSwarmTool({ action: 'kill', name: 'judge' }, harness.exec);
    await harness.settle();
    assert.equal(agy.calls.length, 0);
    assert.equal(harness.member('judge').state, 'killed');
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('P1-3：sandboxPolicy 缺失 / resolve 抛错 / 无效 mode 时拒绝添加 agy 成员；在线重读失败时本轮 fail-closed', async () => {
  for (const flags of [
    { noSandboxPolicy: true },
    { throwOnResolve: true },
    { invalidMode: true },
    { sandboxMode: 'mystery-mode' },
  ]) {
    const agy = createScriptedAgy(async () => completed(''));
    const harness = createAgyHarness({ agySvc: agy.svc, noSandboxPolicy: flags.noSandboxPolicy === true });
    Object.assign(harness.policy, flags);
    try {
      await assert.rejects(
        () => swarmAdd(harness, { name: 'judge', brief: 'x', model: 'agy/stub-model-alpha', agy_mode: 'plan' }),
        /sandboxPolicy.*拒绝启动外部 agy 成员/
      );
      assert.equal(harness.member('judge'), undefined);
      assert.equal(agy.calls.length, 0);
    } finally {
      await harness.cleanup([agy.stateDir]);
    }
  }

  const agy = createScriptedAgy(async () => completed(''));
  const harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'judge', brief: 'x', model: 'agy/stub-model-alpha' });
    await harness.settle();
    assert.equal(agy.calls.length, 1);
    harness.policy.throwOnResolve = true;
    await coordPost(harness, '@judge 第二轮');
    await harness.settle();
    assert.equal(agy.calls.length, 1, '在线父会话策略不可读时绝不运行');
    assert.equal(harness.member('judge').state, 'stopped');
    assert.match(harness.member('judge').lastError, /sandboxPolicy/);
    assert.equal(harness.controller.mcpBridge.grants.size, 0, '失败轮次的 Token 已吊销');
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('P2-4：Client 保留 backend，外部 agy 成员拒绝 openSession 跳转', () => {
  const snapshot = clientMod.normalizeSwarmSnapshot({
    hasSwarm: true,
    coordinatorSessionId: 'coord-1',
    head: 0,
    channels: [],
    messages: [],
    members: [
      { name: 'coordinator', sessionId: 'coord-1', role: 'coordinator' },
      { name: 'native', sessionId: 'dsh-1' },
      { name: 'auth_judge', sessionId: 'agy-0000', backend: 'agy-acp' },
    ],
  });
  assert.equal(snapshot.members.find((m) => m.name === 'native').backend, 'dsh');
  assert.equal(snapshot.members.find((m) => m.name === 'auth_judge').backend, 'agy-acp');

  const opened = [];
  const workspace = { openSession: (target) => opened.push(target) };
  const ctx = { uiWorkspace: workspace, get: (name) => (name === 'uiWorkspace' ? workspace : undefined) };
  const judge = snapshot.members.find((m) => m.name === 'auth_judge');
  const res = clientMod.openMemberSession(ctx, snapshot, judge);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'external-agy');
  assert.deepEqual(opened, [], '绝不把虚拟 agy-<uuid> 交给 openSession');
  assert.equal(clientMod.openMemberTranscript(ctx, snapshot, judge).reason, 'external-agy');
});

test('P2-5：NDJSON 一次推入且带换行的超长单帧被拦截（不进入 JSON.parse），后续正常帧不受影响', async () => {
  const calls = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const session = createMcpStdioSession({
    readable: input,
    writable: output,
    maxFrameBytes: 1024,
    resolveAuth: () => ({ url: 'http://127.0.0.1:1/rpc', token: 't' }),
    httpRequest: async (req) => {
      calls.push(req);
      return { status: 200, json: { ok: true, result: {} } };
    },
  });
  const frames = [];
  let buf = '';
  output.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  try {
    const huge = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'post_message', arguments: { text: 'x'.repeat(4096) } },
    });
    input.write(huge + '\n');
    await waitFor(() => frames.length >= 1, 2000, '超长帧错误响应');
    assert.equal(frames[0].error.code, -32600);
    assert.match(frames[0].error.message, /单帧超过上限/);
    assert.equal(frames[0].id, null);
    assert.equal(calls.length, 0, '超长帧绝不触发工具调用');

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    await waitFor(() => frames.some((f) => f.id === 2), 2000, '后续 ping');
    assert.deepEqual(frames.find((f) => f.id === 2).result, {});
  } finally {
    input.end();
    await session.done;
  }
});

/* ================================================================== */
/* 9. 无限自治内循环 + agy 实时联动 + 专属设置页                          */
/* ================================================================== */

test('无限内循环：默认阈值 0 不熔断，连续 20 跳同伴互 @ 仍持续流转', async () => {
  let harness;
  let hops = 0;
  let maxPeerSeen = 0;
  const agy = createScriptedAgy(async (input) => {
    hops += 1;
    const me = harness.store.state.members.find((m) => m.agyWorkerName === input.name);
    maxPeerSeen = Math.max(maxPeerSeen, me.consecutivePeerWakes || 0);
    const text =
      hops < 20
        ? me.name === 'alpha'
          ? '@beta ping'
          : '@alpha pong'
        : '@coordinator 无限内循环已跑满 ' + String(hops) + ' 跳';
    await withBridge(input, (client) => client.callTool('post_message', { text }).then(toolJson));
    return completed('');
  });
  // 不传任何阈值配置：使用契约 0.2 的默认 0（无限）
  harness = createAgyHarness({ agySvc: agy.svc });
  try {
    assert.equal(swarm.DEFAULT_MAX_CONSECUTIVE_PEER_WAKES, 0);
    assert.equal(swarm.DEFAULT_MAX_AGY_TURNS_PER_MEMBER, 0);
    await swarmAdd(harness, { name: 'alpha', brief: '对练 A', model: 'agy/stub-model-beta' });
    await swarmAdd(harness, { name: 'beta', brief: '对练 B', model: 'agy/stub-model-beta' });
    await harness.settle();
    await coordPost(harness, '@alpha 开始无限对练');
    await waitFor(() => hops >= 20, 20000, '连续 20 跳同伴互唤醒');
    await harness.settle();
    agy.assertNoScriptErrors();
    assert.ok(hops >= 20, '实际跳数 ' + String(hops));
    for (const name of ['alpha', 'beta']) {
      const member = harness.member(name);
      assert.equal(member.lastError.includes('熔断'), false, name + ' 绝不因默认阈值熔断');
      assert.notEqual(member.circuitBreakNotified, true);
    }
    assert.ok(maxPeerSeen >= 9, '单成员连跳计数必须超过旧默认 6（实测峰值 ' + String(maxPeerSeen) + '）');
    assert.ok(hops >= 20, '无限内循环不得被 6/12 之类的旧上限截断');
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('熔断阈值语义：0 = 无限放行，正整数保持 > 阈值的既有熔断行为', () => {
  const tmp = makeTempDir('swarm-cfg-');
  const controller = new SwarmHostController({}, { baseDir: tmp });
  try {
    const heavy = { consecutivePeerWakes: 999, activationCount: 999 };
    const batch = [{ agent: 'peer-b' }];
    assert.equal(controller._checkAgyCircuitBreaker(heavy, batch).reason, null, '默认 0 = 无限');
    controller.applyConfig({ maxConsecutivePeerWakes: 3, maxAgyTurnsPerMember: 2 });
    const peerTrip = controller._checkAgyCircuitBreaker(heavy, batch);
    assert.equal(peerTrip.reason, 'consecutive-peer-wakes');
    assert.equal(peerTrip.nextPeerWakes, 1000);
    const turnTrip = controller._checkAgyCircuitBreaker({ consecutivePeerWakes: 0, activationCount: 5 }, batch);
    assert.equal(turnTrip.reason, 'max-turns');
    // 协调员发言会把同伴连跳清零（既有语义不变）
    const reset = controller._checkAgyCircuitBreaker(
      { consecutivePeerWakes: 5, activationCount: 1 },
      [{ agent: 'coordinator' }]
    );
    assert.equal(reset.nextPeerWakes, 0);
    assert.equal(reset.reason, null);
  } finally {
    rmQuiet(tmp);
  }
});

test('Config：Standard Schema 默认 0/0/8，volatile 热更新只替换运行期字段', () => {
  assert.equal(typeof swarm.Config, 'object');
  const standard = swarm.Config['~standard'];
  assert.equal(typeof standard.validate, 'function');
  // 真实宿主 schemastery 的 .volatile() 字段校验后是 { get(), [write] } 访问器；
  // 离线兜底 schema 是裸值。两种形态都必须能读出真实值。
  const readVal = (value) => (value && typeof value.get === 'function' ? value.get() : value);
  const validated = standard.validate({});
  assert.ok(validated && validated.value, JSON.stringify(validated));
  assert.equal(readVal(validated.value.maxConsecutivePeerWakes), 0);
  assert.equal(readVal(validated.value.maxAgyTurnsPerMember), 0);
  assert.equal(readVal(validated.value.maxAgyPostsPerTurn), 8);
  assert.equal(readVal(validated.value.nodeExecutable), '');
  const overridden = standard.validate({ maxConsecutivePeerWakes: 24, maxAgyPostsPerTurn: 16 });
  assert.equal(readVal(overridden.value.maxConsecutivePeerWakes), 24);
  assert.equal(readVal(overridden.value.maxAgyPostsPerTurn), 16);
  assert.equal(swarm.normalizeSwarmConfig(overridden.value).maxConsecutivePeerWakes, 24, '校验后配置必须能直接归一化');
  assert.equal(swarm.normalizeSwarmConfig(validated.value).maxAgyPostsPerTurn, 8);
  // fallback / 真实 schema 都必须接受字符串路径（旧实现误走整数分支会返回 issues）
  const withPath = standard.validate({ nodeExecutable: 'C:/nodejs/node.exe' });
  assert.ok(withPath && withPath.value, 'nodeExecutable 字符串校验失败：' + JSON.stringify(withPath));
  assert.equal(swarm.normalizeSwarmConfig(withPath.value).nodeExecutable, 'C:/nodejs/node.exe');

  const tmp = makeTempDir('swarm-cfg-hot-');
  const controller = new SwarmHostController({}, { baseDir: tmp, maxAgyTurnsPerMember: 16 });
  try {
    // 保留非运行期键（baseDir）与成员状态，仅替换契约字段
    assert.equal(controller.config.baseDir, tmp);
    assert.ok(swarm.applyVolatileConfig(controller, { maxAgyTurnsPerMember: 0, maxAgyPostsPerTurn: 16 }));
    assert.equal(controller.config.maxAgyTurnsPerMember, 0);
    assert.equal(controller.config.maxAgyPostsPerTurn, 16);
    assert.equal(controller.config.baseDir, tmp);

    // 真实宿主 volatile 访问器：裸对象、{ get() }、嵌套校验结果都必须正确解包
    assert.deepEqual(
      swarm.normalizeSwarmConfig({
        nodeExecutable: { get: () => 'C:/nodejs/node.exe' },
        maxConsecutivePeerWakes: { get: () => 6 },
        maxAgyTurnsPerMember: { get: () => 32 },
        maxAgyPostsPerTurn: { get: () => 16 },
      }),
      {
        nodeExecutable: 'C:/nodejs/node.exe',
        maxConsecutivePeerWakes: 6,
        maxAgyTurnsPerMember: 32,
        maxAgyPostsPerTurn: 16,
        strictAllowlist: false,
        allowedModels: [],
        blockedModels: [],
      }
    );
    assert.ok(
      swarm.applyVolatileConfig(controller, {
        maxConsecutivePeerWakes: { get: () => 6 },
        maxAgyTurnsPerMember: { get: () => 32 },
        nodeExecutable: { get: () => 'C:/nodejs/node.exe' },
      })
    );
    assert.equal(controller.config.maxConsecutivePeerWakes, 6, '访问器配置必须真实生效');
    assert.equal(controller.config.maxAgyTurnsPerMember, 32);
    assert.equal(controller.config.nodeExecutable, 'C:/nodejs/node.exe');
    assert.equal(
      controller._checkAgyCircuitBreaker({ consecutivePeerWakes: 6, activationCount: 1 }, [{ agent: 'peer' }]).reason,
      'consecutive-peer-wakes',
      '正整数阈值经 hot update 后必须真的触发熔断'
    );
  } finally {
    rmQuiet(tmp);
  }
});

test('联动：source:"swarm" + swarmMeta + onProgress 实时 agyLive；turnUsageSummary 累加 agyUsage', async () => {
  let harness;
  const observed = [];
  const agy = createScriptedAgy(async (input, round) => {
    assert.equal(input.source, 'swarm', '必须标注 Swarm 来源');
    assert.deepEqual(input.swarmMeta, {
      coordinatorSessionId: harness.coordId,
      memberName: 'probe',
      role: 'worker',
    });
    assert.equal(typeof input.onProgress, 'function');
    input.onProgress({ phase: 'spawn', pid: 4321, runId: 'agy-run-7' });
    observed.push(JSON.parse(JSON.stringify(harness.member('probe').agyLive)));
    assert.equal(harness.member('probe').activity, 'agy 进程启动中');
    input.onProgress({ phase: 'prompt', pid: 4321, runId: 'agy-run-7' });
    observed.push(JSON.parse(JSON.stringify(harness.member('probe').agyLive)));
    await withBridge(input, (client) =>
      client.callTool('post_message', { text: '@coordinator 第 ' + String(round) + ' 轮完成' }).then(toolJson)
    );
    return completed('', {
      turnUsageSummary: {
        source: 'gen_metadata',
        stepCount: 2,
        uncachedInput: 100,
        cacheRead: 300,
        cacheWrite: 50,
        totalInput: 450,
        totalOutput: 60,
        thinking: 10,
        responseOutput: 50,
        latestContextTokens: 900,
        peakContextTokens: 1200,
        cacheHitRate: 300 / 450,
      },
    });
  });
  harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'probe', brief: '联动探针', model: 'agy/stub-model-beta' });
    await harness.settle();
    agy.assertNoScriptErrors();
    assert.deepEqual(observed[0], { runId: 'agy-run-7', phase: 'spawn', pid: 4321, activity: 'agy 进程启动中' });
    assert.equal(observed[1].phase, 'prompt');
    assert.equal(observed[1].pid, 4321);

    const done = harness.member('probe');
    assert.equal(done.agyLive, null, '轮次结束必须清空瞬态阶段');
    assert.deepEqual(done.agyUsage, {
      turns: 1,
      stepCount: 2,
      totalInput: 450,
      cacheRead: 300,
      totalOutput: 60,
      thinking: 10,
      cacheHitRate: 0.6667,
      lastTurnTokens: {
        stepCount: 2,
        totalInput: 450,
        cacheRead: 300,
        totalOutput: 60,
        thinking: 10,
        cacheHitRate: 0.6667,
      },
    });

    // 第二轮：续聊并累加
    await coordPost(harness, '@probe 第二轮');
    await harness.settle();
    agy.assertNoScriptErrors();
    const second = harness.member('probe').agyUsage;
    assert.equal(second.turns, 2);
    assert.equal(second.stepCount, 4);
    assert.equal(second.totalInput, 900);
    assert.equal(second.cacheRead, 600);
    assert.equal(second.totalOutput, 120);
    assert.equal(second.cacheHitRate, 0.6667);

    // Host 快照必须 JSON-safe 且透出 agyMode / agyLive / agyUsage
    const snapshot = JSON.parse(JSON.stringify(harness.store.toSnapshot()));
    const row = snapshot.members.find((m) => m.name === 'probe');
    assert.equal(row.backend, 'agy-acp');
    assert.equal(row.agyMode, 'accept-edits');
    assert.equal(row.agyLive, null);
    assert.equal(row.agyUsage.turns, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'agyLive'), true);
    for (const key of ['name', 'sessionId', 'role', 'backend', 'agyMode', 'agyLive', 'agyUsage']) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, key), '缺字段 ' + key);
      assert.notEqual(row[key], undefined, '快照禁止 undefined：' + key);
    }
    // 非法输入一律归一化：未知 agyMode → ''，空 phase → null，负数计数 → 0，且绝无 undefined
    const weird = protocol.normalizeSwarmSnapshot({
      hasSwarm: true,
      coordinatorSessionId: 'coord-weird',
      members: [{ name: 'odd', backend: 'agy-acp', agyMode: 'bogus', agyLive: { phase: '' }, agyUsage: { turns: -1, totalInput: -5 } }],
    });
    const odd = weird.members[0];
    assert.equal(odd.agyMode, '');
    assert.equal(odd.agyLive, null);
    assert.equal(odd.agyUsage.turns, 0);
    assert.equal(odd.agyUsage.totalInput, 0);
    assert.equal(Object.values(odd).includes(undefined), false, '快照禁止 undefined');
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('兼容：旧版 mock agyAcp 不返回 turnUsageSummary 时 agyUsage 保持 null 且零报错', async () => {
  let harness;
  const agy = createScriptedAgy(async (input) => {
    await withBridge(input, (client) => client.callTool('post_message', { text: '@coordinator 老版本完成' }).then(toolJson));
    return completed(''); // 旧版返回值：无 turnUsageSummary / 无 usage
  });
  harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'legacy', brief: '旧版兼容', model: 'agy/stub-model-beta' });
    await harness.settle();
    agy.assertNoScriptErrors();
    const member = harness.member('legacy');
    assert.equal(member.agyUsage, null, '无账单字段时绝不伪造 0 值账单');
    assert.equal(member.agyLive, null);
    assert.equal(member.state, 'waiting');
    assert.equal(harness.store.messages.some((m) => m.agent === 'legacy' && m.text.includes('老版本完成')), true);
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('取消清理：ACP 面板取消（status:cancelled）→ agyLive 清空、桥 Token 全吊销、不代发残留', async () => {
  let harness;
  let authFile = '';
  const agy = createScriptedAgy(async (input) => {
    authFile = authFileOf(input);
    input.onProgress({ phase: 'prompt', pid: 777, runId: 'agy-run-cancel' });
    assert.equal(harness.member('canceller').agyLive.phase, 'prompt');
    assert.ok(fs.existsSync(authFile), '运行期 Token 文件必须存在');
    return {
      status: 'cancelled',
      detail: '本轮被本地取消',
      cancelled: true,
      outputText: '残缺的半截输出绝不代发',
      agySessionId: 'agy-sess-cancel',
      turnUsageSummary: {
        source: 'steps',
        stepCount: 1,
        uncachedInput: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalInput: 10,
        totalOutput: 5,
        thinking: 0,
        responseOutput: 5,
        cacheHitRate: 0,
      },
    };
  });
  harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'canceller', brief: '取消清理', model: 'agy/stub-model-beta' });
    await harness.settle();
    agy.assertNoScriptErrors();
    const member = harness.member('canceller');
    assert.equal(member.state, 'stopped');
    assert.match(member.lastError, /取消/);
    assert.equal(member.agyLive, null, '取消后瞬态阶段必须清空');
    assert.equal(harness.store.messages.some((m) => m.text.includes('残缺的半截输出')), false);
    assert.equal(fs.existsSync(authFile), false, '取消后 Token 文件必须删除');
    assert.equal(harness.controller.mcpBridge.grants.size, 0, '桥授权表必须清空');
    assert.equal(member.agyUsage.turns, 1, '取消轮次若有账单也要累计');
    assert.equal(member.agyUsage.totalInput, 10);
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

test('kill 终态：瞬态 agyLive 立刻清空，快照中不再出现运行阶段', async () => {
  let harness;
  const agy = createScriptedAgy(async (input) => {
    input.onProgress({ phase: 'prompt', pid: 555 });
    return completed('');
  });
  harness = createAgyHarness({ agySvc: agy.svc });
  try {
    await swarmAdd(harness, { name: 'doomed', brief: '待销毁', model: 'agy/stub-model-beta' });
    await harness.settle();
    await harness.controller.executeSwarmTool({ action: 'kill', name: 'doomed' }, harness.exec);
    const member = harness.member('doomed');
    assert.equal(member.killed, true);
    assert.equal(member.agyLive, null);
    const row = harness.store.toSnapshot().members.find((m) => m.name === 'doomed');
    assert.equal(row.agyLive, null);
    assert.equal(row.killed, true);
  } finally {
    await harness.cleanup([agy.stateDir]);
  }
});

/* ---- 专属设置页（settings.section id: dsh-agy-swarm / order 39）---- */

function createSettingsHarness(initialValue = {}) {
  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  const writes = [];
  let snapshot = {
    status: 'ready',
    writable: true,
    value: {
      maxConsecutivePeerWakes: 0,
      maxAgyTurnsPerMember: 0,
      maxAgyPostsPerTurn: 8,
      nodeExecutable: '',
      ...initialValue,
    },
  };
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set(key, value) {
      writes.push([key, value]);
      snapshot = { ...snapshot, value: { ...snapshot.value, [key]: value } };
      return true;
    },
  };
  const Section = clientMod.createSwarmSettingsSection(mockReact, mockReact.createElement);
  return { mockReact, Section, form, writes, setWritable: (writable) => { snapshot = { ...snapshot, writable }; }, setStatus: (status) => { snapshot = { ...snapshot, status }; } };
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) collectNodes(child, out);
  return out;
}

function findByAction(tree, action) {
  return collectNodes(tree).find((n) => n.props && n.props['data-action'] === action) || null;
}

function findByField(tree, field, value) {
  return collectNodes(tree).find(
    (n) => n.props && n.props['data-field'] === field && String(n.props['data-value']) === String(value)
  ) || null;
}

test('设置页：settings.section 注册 id/order、只读态禁用、字段写入与恢复默认', async () => {
  const h = createSettingsHarness();
  const tree = h.Section({ form: h.form, t: (key) => key });
  const nodes = collectNodes(tree);
  assert.equal(tree.type, 'section');
  assert.equal(tree.props['data-settings-id'], 'dsh-agy-swarm');
  const summary = nodes.find((n) => n.props && n.props['data-role'] === 'summary');
  assert.ok(summary, '必须有顶部配置摘要条');

  // 无限档位高亮
  const infinitePeer = findByField(tree, 'maxConsecutivePeerWakes', 0);
  assert.ok(infinitePeer, '缺少 0(无限) 档位');
  assert.equal(infinitePeer.props['aria-pressed'], 'true');
  assert.equal(findByField(tree, 'maxConsecutivePeerWakes', 12).props['aria-pressed'], 'false');

  // 字段写入
  const twelve = findByField(tree, 'maxConsecutivePeerWakes', 12);
  await twelve.props.onClick();
  assert.deepEqual(h.writes.at(-1), ['maxConsecutivePeerWakes', 12]);
  await findByField(tree, 'maxAgyTurnsPerMember', 32).props.onClick();
  assert.deepEqual(h.writes.at(-1), ['maxAgyTurnsPerMember', 32]);
  await findByField(tree, 'maxAgyPostsPerTurn', 16).props.onClick();
  assert.deepEqual(h.writes.at(-1), ['maxAgyPostsPerTurn', 16]);

  // nodeExecutable 草稿 + 保存
  const input = nodes.find((n) => n.props && n.props['data-field'] === 'nodeExecutable');
  assert.ok(input, '缺少 nodeExecutable 输入框');
  input.props.onChange({ target: { value: 'C:\\nodejs\\node.exe' } });
  const saveNode = findByAction(tree, 'save-nodeExecutable');
  // 未改草稿时保存按钮禁用；改草稿后重新渲染（测试里直接调用 onChange 已写 draftRef）
  assert.equal(h.writes.some(([k]) => k === 'nodeExecutable'), false, '未点保存前绝不写回');
  await saveNode.props.onClick();
  assert.deepEqual(h.writes.at(-1), ['nodeExecutable', 'C:\\nodejs\\node.exe']);

  // 恢复默认：四项全部写回契约默认值
  h.writes.length = 0;
  await findByAction(tree, 'reset-defaults').props.onClick();
  assert.deepEqual(h.writes.map(([k]) => k).sort(), [
    'allowedModels',
    'blockedModels',
    'maxAgyPostsPerTurn',
    'maxAgyTurnsPerMember',
    'maxConsecutivePeerWakes',
    'nodeExecutable',
    'strictAllowlist',
  ]);
  assert.equal(h.writes.find(([k]) => k === 'strictAllowlist')[1], false);
  // 恢复默认同时清空两个模型派发权限列表（开源默认完全放行）
  assert.deepEqual(h.writes.find(([k]) => k === 'allowedModels')[1], []);
  assert.deepEqual(h.writes.find(([k]) => k === 'blockedModels')[1], []);
  for (const [key, value] of h.writes) {
    assert.deepEqual(value, clientMod.SETTINGS_DEFAULTS[key], '恢复默认值不一致：' + key);
  }

  // 只读态：所有写入控件禁用
  const readonly = createSettingsHarness();
  readonly.setWritable(false);
  const readonlyTree = readonly.Section({ form: readonly.form, t: (key) => key });
  const readonlyNodes = collectNodes(readonlyTree);
  const disabled = readonlyNodes.filter((n) => n.type === 'button');
  assert.ok(disabled.length >= 8);
  assert.ok(disabled.every((n) => n.props.disabled === true), '只读态全部按钮必须 disabled');
  assert.equal(readonlyNodes.find((n) => n.props && n.props['data-role'] === 'notice').props.role, 'status');

  // 非 ready 态：显示不可用文案且不写入
  const unready = createSettingsHarness();
  unready.setStatus('loading');
  const unreadyTree = unready.Section({ form: unready.form, t: (key) => key });
  assert.equal(findByField(unreadyTree, 'maxConsecutivePeerWakes', 12).props.disabled, true);
  const unreadyWrites = [];
  unready.form.set = (key, value) => {
    unreadyWrites.push([key, value]);
    return true;
  };
  await findByField(unreadyTree, 'maxConsecutivePeerWakes', 12).props.onClick();
  assert.deepEqual(unreadyWrites, [], '未就绪 / 只读态绝不写回宿主');
});


test('设置页挂载：按真实 configForms 语义区分新旧表单，仅 new / 仅 old 都能挂载，缺失则不注册', async () => {
  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  const LEGACY_ID = 'local-dsh-swarm';

  /**
   * 精确复刻宿主 @deepseek-ai/dsh-client-ui-settings 的 ConfigForms 语义：
   *  - get(id) 永远返回 controller（从不为空，因此不能用它探测存在性）；
   *  - whileServed(ids, cb) 在「任一」命名空间被服务时回调 cb(servedSet)，否则不回调。
   */
  const makeHarness = (servedNamespaces) => {
    const settings = [];
    const createdFormIds = [];
    const ctx = {
      slots: {
        inject(name, cb) {
          return cb();
        },
        register(spec, comp) {
          if (spec.name === 'settings.section') settings.push({ spec, comp });
          return () => {};
        },
      },
      resources: { register: () => () => {} },
      sidebarRightTabs: { register: () => () => {} },
      sidebarRight: { openResource() {} },
      configForms: {
        get(id) {
          createdFormIds.push(id);
          return { namespace: id, getSnapshot: () => ({ status: 'ready', writable: true, value: {} }), subscribe: () => () => {}, set: () => true };
        },
        whileServed(namespaces, register) {
          const served = new Set(servedNamespaces);
          if (!namespaces.some((ns) => served.has(ns))) return () => {};
          const off = register(served);
          return () => {
            if (typeof off === 'function') off();
          };
        },
      },
      locale: { register: () => () => {}, bind: () => (key) => key },
      effect(fn) {
        const off = fn();
        return () => {
          if (typeof off === 'function') off();
        };
      },
      get(name) {
        return this[name];
      },
    };
    return { ctx, settings, createdFormIds };
  };

  // A. 只服务新命名空间
  {
    const h = makeHarness(['dsh-agy-swarm']);
    const plugin = new clientMod.SwarmClientPlugin(h.ctx, { React: mockReact });
    try {
      assert.equal(h.settings.length, 1, '新命名空间被服务时必须挂载设置页');
      assert.equal(h.settings[0].spec.id, 'dsh-agy-swarm');
      assert.equal(h.settings[0].spec.order, 39);
      assert.equal(h.settings[0].spec.locale, 'settings.dshAgySwarm');
      assert.equal(h.settings[0].spec.inject().form.namespace, 'dsh-agy-swarm');
    } finally {
      await plugin.dispose();
    }
  }

  // B. 只服务旧命名空间（升级前安装的 patch entry）
  {
    const h = makeHarness([LEGACY_ID]);
    const plugin = new clientMod.SwarmClientPlugin(h.ctx, { React: mockReact });
    try {
      assert.equal(h.settings.length, 1, '仅旧命名空间被服务时也必须挂载，且读写它');
      assert.equal(h.settings[0].spec.id, 'dsh-agy-swarm', 'section id 仍是新 id');
      assert.equal(h.settings[0].spec.inject().form.namespace, LEGACY_ID, '表单必须指向真正被服务的旧命名空间');
    } finally {
      await plugin.dispose();
    }
  }

  // C. 两个命名空间都未被服务（插件未组合进 Profile）
  {
    const h = makeHarness([]);
    const plugin = new clientMod.SwarmClientPlugin(h.ctx, { React: mockReact });
    try {
      assert.deepEqual(h.createdFormIds, [], '未服务时不得创建任何表单 controller');
      assert.equal(h.settings.length, 0, '未服务时不得显示设置页');
    } finally {
      await plugin.dispose();
    }
  }
});


