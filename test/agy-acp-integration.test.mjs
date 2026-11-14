/**
 * 可选集成套件：与真实 dsh-agy-acp 扩展的联合测试。
 *
 * 本套件默认不在 npm test 里：它需要真实安装的 dsh-agy-acp（本包的可选 peer）。
 * 未安装且未设置 DSH_AGY_ACP_ROOT 时逐条带原因 skip，绝不静默降级成「假装通过」。
 *
 * 重要边界（见 arch 备忘）：已发布的 dsh-agy-acp npm 包**不包含 test/**，
 * 因此 MockAcpServer 由本仓 test/support/ 自带；对端只需它发布包里的
 * src/acp-client.js（createMemoryTransportPair）与 src/worker-service.js。
 *
 * 运行：
 *   npm install --no-save dsh-agy-acp && npm run test:acp-integration
 *   DSH_AGY_ACP_ROOT=<path-to-dsh-agy-acp> npm run test:acp-integration
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

import { MockAcpServer } from './support/mock-acp-server.mjs';

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

/** 解析可选扩展根目录：环境变量 → 包名解析。解析不到返回 null。 */
function resolveAcpRoot() {
  const explicit = process.env.DSH_AGY_ACP_ROOT;
  if (explicit && fs.existsSync(path.join(explicit, 'package.json'))) return path.resolve(explicit);
  try {
    return path.dirname(require.resolve('dsh-agy-acp/package.json'));
  } catch {
    // 未安装：继续尝试入口解析
  }
  try {
    return path.dirname(require.resolve('dsh-agy-acp'));
  } catch {
    return null;
  }
}

const ACP_ROOT = resolveAcpRoot();
const skipAcp = ACP_ROOT
  ? false
  : '可选扩展 dsh-agy-acp 未安装：先 npm install --no-save dsh-agy-acp（或设置 DSH_AGY_ACP_ROOT）再跑 npm run test:acp-integration';

let acp = null;
let AgyWorkerService = null;
let WorkerRegistry = null;
if (ACP_ROOT) {
  acp = require(path.join(ACP_ROOT, 'src', 'acp-client.js'));
  ({ AgyWorkerService, WorkerRegistry } = require(path.join(ACP_ROOT, 'src', 'worker-service.js')));
}

const DEFAULT_TMP_BASE = path.join(os.tmpdir(), 'dsh-swarm-acp-integration');
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
class BridgeCallingMockAcpServer extends MockAcpServer {
  constructor(args, hooks) {
    super(args);
    this.hooks = hooks || null;
  }

  async _handlePrompt(requestId, params) {
    const sessionRequest = [...this.log.requests]
      .reverse()
      .find((r) => r.method === 'session/new' || r.method === 'session/load');
    const servers = sessionRequest?.params?.mcpServers || [];
    const bridge = servers.find((s) => s.name === 'dsh_swarm_bridge');
    if (bridge && typeof this.hooks?.onPrompt === 'function') {
      try {
        await this.hooks.onPrompt({
          bridge,
          authFile: bridge.args[bridge.args.indexOf('--auth-file') + 1],
          mock: this,
          params,
        });
      } catch (err) {
        this.hookError = err;
      }
    }
    return super._handlePrompt(requestId, params);
  }
}

/** 真实 AgyWorkerService + MockAcpServer（内存传输）。 */
function createRealAgy(optionsFactory = () => ({}), extra = {}) {
  const stateDir = makeTempDir('agy-real-');
  const spawns = [];
  const transportFactory = ({ argv, cwd }) => {
    const pair = acp.createMemoryTransportPair();
    const options = { thoughtText: '', ...optionsFactory(spawns.length) };
    const MockClass = extra.MockClass || MockAcpServer;
    const mock = new MockClass({ transport: pair.server, options }, extra.hooks);
    mock.start();
    const record = { mock, pair, argv, cwd, terminated: 0 };
    spawns.push(record);
    return {
      transport: pair.client,
      terminate: async () => {
        record.terminated += 1;
        mock.stop();
        pair.close();
        return { exitCode: 0, confirmed: true };
      },
    };
  };
  const svc = new AgyWorkerService({
    config: {
      stateDir,
      graceMs: 120,
      cancelGraceMs: 120,
      shutdownGraceMs: 20,
      requestTimeoutMs: 5000,
      ...(extra.config || {}),
    },
    logger: silentLogger,
    transportFactory,
    registry: new WorkerRegistry({ filePath: path.join(stateDir, 'workers.json') }),
  });
  const stops = [];
  const removes = [];
  const origStop = svc.stopWorker.bind(svc);
  svc.stopWorker = (parent, name) => {
    const outcome = origStop(parent, name);
    stops.push({ parent, name, outcome });
    return outcome;
  };
  const origRemove = svc.registry.remove.bind(svc.registry);
  svc.registry.remove = (parent, name) => {
    removes.push({ parent, name });
    return origRemove(parent, name);
  };
  return { svc, spawns, stops, removes, stateDir };
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
          { id: 'claude-opus-5-5', name: 'Local Opus Mirror' },
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
/* ================================================================== */
/* 8. 端到端：Swarm + AgyWorkerService + MockAcpServer                     */
/* ================================================================== */


function swarmAdd(harness, args) {
  return harness.controller.executeSwarmTool({ action: 'add', ...args }, harness.exec);
}

function coordPost(harness, text) {
  return harness.controller.executePostMessageTool({ text }, harness.exec);
}
test('端到端：auth_judge(agy/opus-high, plan, wait) → 桥工具 allow_once / write_file reject → 真实桥发帖唤醒 → 第 2 轮 session/load → 同后端切模型', { skip: skipAcp }, async () => {
  const hookPosts = [];
  const real = createRealAgy(
    (index) => ({
      sessionId: 'sess-e2e-1',
      replyText: index === 0 ? '审查结论已发帖。' : '复核结论已发帖。',
      permissionRequests: [
        { toolCall: { name: 'dsh_swarm_bridge_read_board', title: 'read_board', kind: 'read' } },
        { toolCall: { name: 'dsh_swarm_bridge_post_message', title: 'post_message', kind: 'other' } },
        { toolCall: { name: 'write_file', title: 'Write file', kind: 'edit', rawInput: { path: 'src/auth.js' } } },
      ],
      turn: index,
    }),
    {
      MockClass: BridgeCallingMockAcpServer,
      hooks: {
        async onPrompt({ authFile, mock }) {
          const client = createMcpClient({ authFile });
          try {
            await client.request('initialize', { protocolVersion: '2024-11-05' });
            const board = toolJson(await client.callTool('read_board', { since: 0 }));
            const text =
              mock.options.turn === 0
                ? `@coordinator auth 模块审查完成（已读到 #${board.head}）`
                : '@coordinator 第二轮复核完成';
            hookPosts.push(toolJson(await client.callTool('post_message', { text })));
          } finally {
            await client.close();
          }
        },
      },
    }
  );
  const harness = createAgyHarness({ agySvc: real.svc });
  try {
    const added = await swarmAdd(harness, {
      name: 'auth_judge',
      brief: '审查 auth 模块的越权风险',
      model: 'agy/opus-high',
      agy_mode: 'plan',
      wait: true,
    });
    assert.equal(added.waiting, true);
    const worker = added.added[0].agy_worker;
    assert.match(worker, AGY_WORKER_NAME_RE);
    assert.ok(worker.startsWith('auth-judge-'));

    await harness.settle();
    await waitFor(() => harness.member('auth_judge').state === 'waiting', 4000, '首轮收敛');
    assert.equal(real.spawns.length, 1);
    const mock1 = real.spawns[0].mock;
    assert.equal(mock1.hookError, undefined, String(mock1.hookError?.stack || ''));

    const newReq = mock1.log.requests.find((r) => r.method === 'session/new');
    const bridgeServer = newReq.params.mcpServers.find((s) => s.name === 'dsh_swarm_bridge');
    assert.ok(bridgeServer, 'session/new 必须收到 dsh_swarm_bridge');
    assert.equal(bridgeServer.command, process.execPath);
    assert.equal(bridgeServer.args[0], swarm.MCP_STDIO_ENTRY);
    assert.equal(fs.existsSync(bridgeServer.args[2]), false, '首轮结束 token 文件已删除');

    const configs = Object.fromEntries(
      mock1.log.requests
        .filter((r) => r.method === 'session/set_config_option')
        .map((r) => [r.params.configId, r.params.value])
    );
    assert.deepEqual(configs, { model: 'claude-opus-5-5', thought_level: 'high', mode: 'plan' });
    assert.deepEqual(
      mock1.permissionResponses.map((r) => r.outcome.optionId),
      ['allow-1', 'allow-1', 'reject-1'],
      'plan 模式：桥读写自动 allow_once，原生 write_file reject_once'
    );

    const store = harness.store;
    const judge = harness.member('auth_judge');
    assert.equal(judge.agySessionId, 'sess-e2e-1');
    assert.equal(judge.agyWorkerName, worker);
    assert.ok(store.messages.some((m) => m.agent === 'auth_judge' && m.text.startsWith('@coordinator auth 模块审查完成')));
    assert.equal(store.messages.some((m) => m.text.includes('审查结论已发帖。')), false, '已发帖则不重复归档尾段');
    assert.ok(harness.followupTexts().some((t) => t.includes('auth 模块审查完成')));
    assert.equal(real.svc.getWorker(harness.coordId, worker).agySessionId, 'sess-e2e-1');

    // 第二轮：协调员 @ → 自动 session/load 续聊同一 agy 会话
    const wake = await coordPost(harness, '@auth_judge 请复核第二轮');
    assert.deepEqual(wake.woken, ['auth_judge']);
    await harness.settle();
    await waitFor(() => real.spawns.length === 2 && harness.member('auth_judge').state === 'waiting', 4000, '第二轮收敛');
    const mock2 = real.spawns[1].mock;
    assert.equal(mock2.hookError, undefined, String(mock2.hookError?.stack || ''));
    const loadReq = mock2.log.requests.find((r) => r.method === 'session/load');
    assert.ok(loadReq, '第二轮必须走 session/load');
    assert.equal(loadReq.params.sessionId, 'sess-e2e-1');
    assert.equal(mock2.log.requests.some((r) => r.method === 'session/new'), false);
    assert.ok(mock2.lastPrompt.includes('请复核第二轮'));
    assert.ok(store.messages.some((m) => m.agent === 'auth_judge' && m.text.includes('第二轮复核完成')));
    assert.equal(hookPosts.length, 2);

    // 同后端切模型成功；跨后端被拒
    const switched = await harness.controller.executeSwarmTool(
      { action: 'model', name: 'auth_judge', model: 'agy/carbon-high' },
      harness.exec
    );
    assert.equal(switched.status, 'switched');
    assert.equal(switched.previous_model, 'agy/claude-opus-5-5');
    assert.equal(switched.model, 'agy/gemini-4-carbon');
    assert.equal(harness.member('auth_judge').model, 'gemini-4-carbon');
    assert.equal(harness.member('auth_judge').reasoningEffort, 'high');
    await assert.rejects(
      () => harness.controller.executeSwarmTool({ action: 'model', name: 'auth_judge', model: 'deepseek/deepseek-chat' }, harness.exec),
      /跨后端/
    );
    await assert.rejects(
      () => harness.controller.executeSwarmTool({ action: 'model', name: 'coordinator', model: 'agy/opus' }, harness.exec),
      /跨后端/
    );
  } finally {
    await harness.cleanup([real.stateDir]);
  }
});

/* ================================================================== */
/* 9. 清理闭环：kill / [done] / dispose                                   */
/* ================================================================== */

async function startHangingMember(harness, real, name = 'judge') {
  await swarmAdd(harness, { name, brief: '长任务', model: 'agy/opus', agy_mode: 'plan' });
  await waitFor(() => real.spawns.length === 1 && real.spawns[0].mock.isPromptWaiting, 4000, 'agy prompt 挂起');
  const mock = real.spawns[0].mock;
  const newReq = mock.log.requests.find((r) => r.method === 'session/new');
  const server = newReq.params.mcpServers.find((s) => s.name === 'dsh_swarm_bridge');
  const authFile = server.args[server.args.indexOf('--auth-file') + 1];
  assert.equal(fs.existsSync(authFile), true, '运行中 token 文件存在');
  return { mock, authFile, member: harness.member(name) };
}

test('运行中 kill：session/cancel + Token 吊销删文件 + stopWorker + 注册表移除', { skip: skipAcp }, async () => {
  const real = createRealAgy(() => ({ manualPrompt: true }));
  const harness = createAgyHarness({ agySvc: real.svc });
  try {
    const { mock, authFile, member } = await startHangingMember(harness, real);
    const killed = await harness.controller.executeSwarmTool({ action: 'kill', name: 'judge' }, harness.exec);
    assert.equal(killed.status, 'killed');
    assert.equal(fs.existsSync(authFile), false, 'kill 立即吊销并删除 token 文件');
    await harness.settle();
    await waitFor(() => mock.log.notifications.some((n) => n.method === 'session/cancel'), 3000, 'session/cancel');
    assert.ok(real.stops.some((s) => s.name === member.agyWorkerName && s.outcome.stopped === true));
    assert.ok(real.removes.some((r) => r.name === member.agyWorkerName && r.parent === harness.coordId));
    assert.equal(harness.member('judge').killed, true);
    assert.equal(harness.member('judge').state, 'killed');
    assert.equal(real.spawns[0].terminated, 1);
    assert.equal(harness.store.messages.some((m) => m.agent === 'judge'), false);
  } finally {
    await harness.cleanup([real.stateDir]);
  }
});

test('运行中 [done]：停止 agy 轮次（session/cancel）并吊销 Token，成员收敛为 stopped', { skip: skipAcp }, async () => {
  const real = createRealAgy(() => ({ manualPrompt: true }));
  const harness = createAgyHarness({ agySvc: real.svc });
  try {
    const { mock, authFile, member } = await startHangingMember(harness, real);
    const done = await coordPost(harness, '[done] 全部完成');
    assert.equal(done.marked_done, true);
    assert.equal(fs.existsSync(authFile), false);
    await harness.settle();
    await waitFor(() => mock.log.notifications.some((n) => n.method === 'session/cancel'), 3000, 'session/cancel');
    assert.ok(real.stops.some((s) => s.name === member.agyWorkerName));
    assert.equal(real.removes.length, 0, '[done] 不删除注册表记录');
    assert.equal(harness.member('judge').state, 'stopped');
    assert.equal(harness.member('judge').killed, false);
  } finally {
    await harness.cleanup([real.stateDir]);
  }
});

test('运行中 dispose：等待 agy 轮次取消收尾（session/cancel），Token 吊销且桥停止监听', { skip: skipAcp }, async () => {
  const real = createRealAgy(() => ({ manualPrompt: true }));
  const harness = createAgyHarness({ agySvc: real.svc });
  try {
    const { mock, authFile } = await startHangingMember(harness, real);
    const bridge = harness.controller.mcpBridge;
    assert.equal(bridge.listening, true);
    await harness.controller.dispose();
    assert.ok(mock.log.notifications.some((n) => n.method === 'session/cancel'));
    assert.equal(fs.existsSync(authFile), false);
    assert.equal(bridge.listening, false);
    assert.equal(harness.controller.agyTurns.size, 0);
    assert.equal(real.spawns[0].terminated, 1);
    assert.equal(real.svc.active.size, 0);
  } finally {
    await harness.cleanup([real.stateDir]);
  }
});
/* ---- 真实联合回归：真实 AgyWorkerService + MockAcpServer（不替换 runDirectTurn）---- */

/** protobuf varint 编码（测试侧最小实现）。 */
function encodeVarint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 127) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function encodeTag(field, wire) {
  return encodeVarint(field * 8 + wire);
}

function encodeVarintField(field, value) {
  return Buffer.concat([encodeTag(field, 0), encodeVarint(value)]);
}

function encodeBytesField(field, buffer) {
  return Buffer.concat([encodeTag(field, 2), encodeVarint(buffer.length), buffer]);
}

/** 构造 gen_metadata.chat.field4 的 usage 子消息（field 2/3/4/5/9/10）。 */
function encodeUsageMessage({ uncachedInput, rawTotalOutput, cacheWrite, cacheRead, thinking, responseOutput }) {
  return Buffer.concat([
    encodeVarintField(2, uncachedInput),
    encodeVarintField(3, rawTotalOutput),
    encodeVarintField(4, cacheWrite),
    encodeVarintField(5, cacheRead),
    encodeVarintField(9, thinking),
    encodeVarintField(10, responseOutput),
  ]);
}

/** 构造一条真实的 gen_metadata.data：顶层 field1=chat，chat.field4=usage，chat.field9.10.1=contextTokens。 */
function encodeGenMetadata({ usage, contextTokens }) {
  const chat = Buffer.concat([
    encodeBytesField(4, encodeUsageMessage(usage)),
    encodeBytesField(9, encodeBytesField(10, encodeVarintField(1, contextTokens))),
  ]);
  return encodeBytesField(1, chat);
}

/** 用真实 node:sqlite 建库并写入账单行（与 agy 落盘的表结构一致）。 */
async function seedConversationDb(dbPath, rows) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS gen_metadata(idx integer primary key, data blob, size integer)');
    db.exec('CREATE TABLE IF NOT EXISTS steps(idx integer primary key, step_type integer, status integer, metadata blob)');
    const insert = db.prepare('INSERT OR REPLACE INTO gen_metadata(idx, data, size) VALUES (?, ?, ?)');
    for (const row of rows) {
      const data = encodeGenMetadata(row);
      insert.run(row.idx, data, data.length);
    }
  } finally {
    db.close();
  }
}

test('真实联合：source/swarmMeta 到达 AgyWorkerService；运行中 getAcpSnapshot→stopAcpRun 取消并吊销 MCP Token', { skip: skipAcp }, async () => {
  let harness;
  let runItem = null;
  const real = createRealAgy(
    () => ({
      sessionId: 'sess-real-cancel',
      replyText: '半截输出绝不代发',
      manualPrompt: true,
    }),
    { MockClass: BridgeCallingMockAcpServer }
  );
  harness = createAgyHarness({ agySvc: real.svc });
  try {
    await swarmAdd(harness, { name: 'real-cancel', brief: '真实取消回归', model: 'agy/hydrogen' });
    await waitFor(() => {
      const snapshot = real.svc.getAcpSnapshot(harness.coordId);
      runItem = snapshot.activeRuns.find((item) => item.source === 'swarm') || null;
      return Boolean(runItem && runItem.phase === 'prompting');
    }, 15000, '真实 AgyWorkerService 进入 prompting');

    // 1) 真实 service 已按契约收到 source / swarmMeta
    assert.equal(runItem.source, 'swarm');
    assert.deepEqual(runItem.swarmMeta, {
      coordinatorSessionId: harness.coordId,
      memberName: 'real-cancel',
      role: 'worker',
    });
    assert.match(runItem.runId, /^agy-run-\d+$/);
    assert.equal(runItem.name, harness.member('real-cancel').agyWorkerName);
    assert.equal(runItem.pid, null, '内存 transport 不暴露 OS PID，面板应显示宿主托管');

    // 2) 真实 onProgress 已把阶段/runId 同步进 swarm 成员的瞬态 agyLive
    const live = harness.member('real-cancel').agyLive;
    assert.ok(live, '运行期必须有 agyLive');
    assert.equal(live.runId, runItem.runId);
    assert.ok(
      ['spawning', 'initializing', 'creating_session', 'loading_session', 'configuring', 'prompting'].includes(live.phase),
      '真实阶段必须是契约枚举值，实际 ' + live.phase
    );
    assert.equal(live.pid, 0);
    assert.ok(live.activity.length > 0, 'activity 不能被清空');
    const grant = [...harness.controller.mcpBridge.grants.values()][0];
    assert.ok(grant, '运行中必须有一份桥 Token');
    assert.equal(fs.existsSync(grant.authFilePath), true);

    // 3) 真实 stopAcpRun 取消运行中的 Swarm 轮次
    const stopped = real.svc.stopAcpRun({ runId: runItem.runId });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.runId, runItem.runId);
    assert.equal(stopped.phase, 'cancelling');
    const midSnapshot = real.svc.getAcpSnapshot(harness.coordId);
    assert.equal(midSnapshot.activeRuns.find((item) => item.runId === runItem.runId).phase, 'cancelling');

    await harness.settle();
    await waitFor(() => harness.member('real-cancel').state === 'stopped', 15000, '成员收敛 stopped');
    const member = harness.member('real-cancel');
    assert.match(member.lastError, /取消|cancel/);
    assert.equal(member.agyLive, null, '取消后瞬态阶段必须清空');
    assert.equal(fs.existsSync(grant.authFilePath), false, '取消后 Token 文件必须删除');
    assert.equal(harness.controller.mcpBridge.grants.size, 0, '桥授权表必须清空');
    assert.equal(harness.store.messages.some((m) => m.text.includes('半截输出绝不代发')), false);
    const after = real.svc.getAcpSnapshot(harness.coordId);
    assert.equal(after.activeRuns.length, 0);
    const ended = after.recentRuns.find((item) => item.runId === runItem.runId);
    assert.ok(ended, '取消的轮次必须进入 recentRuns');
    assert.equal(ended.phase, 'cancelled');
    assert.equal(ended.swarmMeta.memberName, 'real-cancel');
  } finally {
    await harness.cleanup([real.stateDir]);
  }
});

test('真实联合：真实 SQLite 账单 → turnUsageSummary → swarm agyUsage 累计（续聊只算新增行）', { skip: skipAcp }, async () => {
  const convDir = makeTempDir('agy-conv-');
  const dbPath = path.join(convDir, 'sess-real-usage.db');
  const firstUsage = { uncachedInput: 100, rawTotalOutput: 60, cacheWrite: 50, cacheRead: 300, thinking: 10, responseOutput: 50 };
  await seedConversationDb(dbPath, [{ idx: 1, usage: firstUsage, contextTokens: 900 }]);

  let harness;
  let promptCount = 0;
  const secondUsage = { uncachedInput: 80, rawTotalOutput: 30, cacheWrite: 0, cacheRead: 40, thinking: 5, responseOutput: 25 };
  const real = createRealAgy(
    () => ({
      sessionId: 'sess-real-usage',
      replyText: '账单轮完成',
      promptResultUsage: { inputTokens: 450, outputTokens: 60, totalTokens: 510, cachedReadTokens: 300 },
      usageUpdates: [{ used: 450, size: 200000 }],
    }),
    {
      MockClass: BridgeCallingMockAcpServer,
      config: { conversationsDir: convDir },
      hooks: {
        // 续聊轮次在 prompt 前模拟 agy 把新一步写进 SQLite（本轮只应统计这一行）。
        async onPrompt() {
          promptCount += 1;
          if (promptCount === 2) {
            await seedConversationDb(dbPath, [{ idx: 2, usage: secondUsage, contextTokens: 1200 }]);
          }
        },
      },
    }
  );
  harness = createAgyHarness({ agySvc: real.svc });
  try {
    await swarmAdd(harness, { name: 'real-usage', brief: '真实账单', model: 'agy/hydrogen' });
    await harness.settle();
    await waitFor(() => harness.member('real-usage').state === 'waiting', 15000, '首轮完成');
    const first = harness.member('real-usage').agyUsage;
    assert.deepEqual(first, {
      turns: 1,
      stepCount: 1,
      totalInput: 450,
      cacheRead: 300,
      totalOutput: 60,
      thinking: 10,
      cacheHitRate: 0.6667,
      lastTurnTokens: {
        stepCount: 1,
        totalInput: 450,
        cacheRead: 300,
        totalOutput: 60,
        thinking: 10,
        cacheHitRate: 0.6667,
      },
    });

    await coordPost(harness, '@real-usage 第二轮');
    await harness.settle();
    await waitFor(() => harness.member('real-usage').agyUsage.turns === 2, 15000, '第二轮账单累计');
    const second = harness.member('real-usage').agyUsage;
    assert.equal(second.turns, 2);
    assert.equal(second.stepCount, 2);
    assert.equal(second.totalInput, 570, '首轮 450 + 次轮新增 120（绝不重复计费历史行）');
    assert.equal(second.cacheRead, 340);
    assert.equal(second.totalOutput, 90, '首轮 60 + 次轮 30');
    assert.equal(second.thinking, 15, '首轮 10 + 次轮 5');
    assert.equal(second.cacheHitRate, 0.5965);
    assert.equal(second.lastTurnTokens.totalInput, 120);
    assert.equal(second.lastTurnTokens.cacheRead, 40);
    // 真实快照 JSON-safe
    const snapshot = JSON.parse(JSON.stringify(harness.store.toSnapshot()));
    const row = snapshot.members.find((m) => m.name === 'real-usage');
    assert.equal(row.agyUsage.turns, 2);
    assert.equal(Object.values(row.agyUsage).includes(undefined), false);
  } finally {
    await harness.cleanup([real.stateDir, convDir]);
  }
});


test('真实联合：同阶段 activity（工具/思考/回复）实时落进 agyLive，不只 phase 变化', { skip: skipAcp }, async () => {
  let harness;
  const real = createRealAgy(
    () => ({
      sessionId: 'sess-real-activity',
      toolCalls: [{ name: 'read_file', title: 'Read file', kind: 'read' }],
      replyText: '活动轮完成',
      manualPrompt: true,
    }),
    { MockClass: BridgeCallingMockAcpServer }
  );
  harness = createAgyHarness({ agySvc: real.svc });
  try {
    await swarmAdd(harness, { name: 'real-activity', brief: '活动同步', model: 'agy/hydrogen' });
    await waitFor(() => harness.member('real-activity').agyLive?.phase === 'prompting', 15000, '进入 prompting');
    const initialActivity = harness.member('real-activity').agyLive.activity;
    assert.equal(typeof initialActivity, 'string');

    const mock = real.spawns[0] && real.spawns[0].mock;
    assert.ok(mock, '必须拿到真实 MockAcpServer 实例');
    // 跳过 500ms 活动节流窗口后，在同一 prompting 阶段推送真实 thought 更新。
    await delay(650);
    mock._notify('session/update', {
      sessionId: 'sess-real-activity',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考账单口径' } },
    });
    await waitFor(
      () => /思考中|调用工具|生成回复/.test(String(harness.member('real-activity').agyLive?.activity || '')),
      8000,
      '同阶段 activity 更新'
    );
    const changed = harness.member('real-activity').agyLive;
    assert.equal(changed.phase, 'prompting', '阶段不变但 activity 必须已更新');
    assert.notEqual(changed.activity, initialActivity);
    assert.match(changed.activity, /思考中/);

    const activeRun = real.svc.getAcpSnapshot(harness.coordId).activeRuns[0];
    assert.equal(activeRun.source, 'swarm');
    assert.equal(activeRun.activity, changed.activity, '面板活动与真实 run 活动一致');
    real.svc.stopAcpRun({ runId: activeRun.runId });
    await harness.settle();
    await waitFor(() => harness.member('real-activity').state === 'stopped', 15000, '停止收敛');
    assert.equal(harness.member('real-activity').agyLive, null);
  } finally {
    await harness.cleanup([real.stateDir]);
  }
});
