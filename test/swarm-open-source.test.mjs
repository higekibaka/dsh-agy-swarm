/**
 * 开源发布版友好度与脱敏回归（纯原生 DSH 多智能体集群）。
 *
 * 这一套只验证原生能力与对外文本的脱敏，覆盖：
 *   1. 提示词 / 工具 Schema 不含任何已移除外部队友后端的残留；
 *   2. lastError / activity / 错误回包的脱敏；
 *   3. 插件身份（包名、0.2.0 版本、无外部后端依赖、旧表单 id 只读兼容）；
 *   4. 仓库内不留个人路径与私有模型清单；
 *   5. 模型派发权限（Config / 纯函数 / 路由解析 / 目录 / 协议 / 设置页）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const swarm = require('../index.js');
const clientMod = require('../client.js');
const protocol = require('../src/protocol.js');
const prompts = require('../src/prompts.js');
const redaction = require('../src/redaction.js');
const { BoardStore } = require('../src/board-store.js');

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 已删除的外部后端留下的可搜索标记：源码与测试里一律不得出现。 */
const REMOVED_BACKEND_MARKERS = Object.freeze([
  ['dsh', 'agy', 'acp'].join('-'),
  ['mcp', 'bridge', 'server'].join('-'),
  ['mcp', 'stdio', 'entry'].join('-'),
  ['agy', 'mode'].join('_'),
  ['agy', 'Live'].join(''),
  ['agy', 'Usage'].join(''),
  ['max', 'Agy'].join(''),
]);

test('提示词与工具 Schema 不含任何外部队友后端的残留', () => {
  const nativeSkill = prompts.COORDINATOR_SKILL_CONTENT;
  assert.ok(!nativeSkill.includes(['agy', '/'].join('')), '协调员规范不得出现外部模型路由写法');
  assert.ok(!nativeSkill.includes(['agy', 'mode'].join('_')), '协调员规范不得出现外部模式参数');
  assert.ok(!nativeSkill.includes('外部 ACP'), '协调员规范不得提到外部队友');
  assert.ok(!nativeSkill.includes(['maxConsecutive', 'PeerWakes'].join('')), '不再暴露熔断阈值参数');
  assert.ok(nativeSkill.includes('100% 实测全绿'), '内循环仍以实测全绿为收口条件');

  // 协调员规范只有一套：不再按「是否安装扩展」动态拼接
  assert.equal(prompts.buildCoordinatorSkillContent(), prompts.COORDINATOR_SKILL_CONTENT);
  assert.equal(prompts.buildCoordinatorSkillInjection.length, 0, '注入入口不再接受可选后端开关');

  const injection = prompts.buildCoordinatorSkillInjection({ sessionId: 's1' });
  assert.ok(injection.includes('<skill_content name="swarm">'));
  assert.ok(!injection.includes(['agy', '/'].join('')));

  const worker = prompts.buildWorkerSystemPrompt({ memberName: 'w', coordinatorSessionId: 'c' });
  assert.ok(!worker.includes(['agy', '/'].join('')), 'Worker 简报不得提外部模型路由');
  assert.ok(!worker.includes('7b.'), '不再注入 7b 外部队友条目');
  assert.ok(!worker.includes(['agy', 'Acp', 'Available'].join('')), '不再有可选后端开关参数');
});

test('redactSensitiveText：凭据、Token、授权头与个人主目录路径一律脱敏并限长', () => {
  const cases = [
    { input: 'Authorization: Bearer abcdef123456', hidden: 'abcdef123456', mark: '[REDACTED]' },
    { input: 'token=sk-live-0123456789abcdef', hidden: 'sk-live-0123456789abcdef', mark: '[REDACTED]' },
    {
      input: 'node cli.js --auth-file ' + ['C:', 'Users', 'someone', 'tok.json'].join(path.sep),
      hidden: 'someone',
      mark: '[REDACTED]',
    },
    { input: 'path ' + ['D:', 'Users', 'someone', 'proj'].join(path.sep), hidden: 'someone', mark: '~' },
    { input: 'home ' + ['/Users', 'someone', 'x'].join('/'), hidden: 'someone', mark: '~' },
  ];
  for (const { input, hidden, mark } of cases) {
    const out = redaction.redactSensitiveText(input);
    assert.ok(out.includes(mark), input + ' -> ' + out);
    assert.ok(!out.includes(hidden), 'secret must not survive redaction: ' + out);
  }
  const long = redaction.redactSensitiveText('x'.repeat(1000));
  assert.equal(long.length, redaction.DEFAULT_MAX_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(redaction.redactSensitiveText(null), '');
  assert.equal(redaction.redactSensitiveText('  plain  '), '  plain  ', '非敏感文本原样保留');
});

test('成员 error/activity 写入点都经过脱敏', () => {
  const indexSource = fs.readFileSync(path.join(PLUGIN_ROOT, 'index.js'), 'utf8');
  for (const call of ['redactErrorText(', 'redactActivityText(']) {
    assert.ok(indexSource.includes(call), '缺少脱敏调用：' + call);
  }
  assert.match(indexSource, /lastError: redactErrorText\(/, 'lastError 写入必须脱敏');
  assert.match(indexSource, /activity: redactActivityText\(/, 'activity 写入必须脱敏');
});

test('插件身份：清单 0.2.1、无外部后端依赖、patch 与设置页命名空间一致', () => {
  assert.equal(protocol.PLUGIN_ID, 'dsh-agy-swarm');
  assert.equal(protocol.SWARM_SETTINGS_ID, 'dsh-agy-swarm');
  assert.equal(protocol.SWARM_SETTINGS_NS, 'settings.dshAgySwarm');
  assert.equal(protocol.SWARM_SETTINGS_ID_LEGACY, 'local-dsh-swarm');
  assert.equal(swarm.name, protocol.PLUGIN_ID);

  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-agy-swarm');
  assert.equal(pkg.version, '0.2.1', '版本号必须升级为 0.2.1');
  assert.equal(pkg.private, undefined, '公开发布版不得保留 private');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.author, 'higekibaka');
  assert.match(pkg.repository.url, /dsh-agy-swarm/);
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('multi-agent'));
  assert.ok(!pkg.keywords.includes('acp'), '关键词不得再保留 acp');

  // a) 不再声明任何外部队友后端依赖（peer / optional peer / 任何 dependencies 段）
  const externalPkg = ['dsh', 'agy', 'acp'].join('-');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const block = pkg[section];
    if (!block) continue;
    assert.equal(block[externalPkg], undefined, section + ' 不得包含 ' + externalPkg);
  }
  assert.equal(pkg.peerDependenciesMeta[externalPkg], undefined, 'peerDependenciesMeta 不得包含 ' + externalPkg);
  const removedExportA = './' + ['mcp', 'bridge', 'server'].join('-');
  const removedExportB = './' + ['mcp', 'stdio', 'entry'].join('-');
  assert.equal(pkg.exports[removedExportA], undefined, '不再导出本地 MCP 桥');
  assert.equal(pkg.exports[removedExportB], undefined, '不再导出 MCP stdio 入口');
  for (const dep of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', 'react']) {
    assert.equal(pkg.peerDependenciesMeta[dep].optional, true, dep + ' must be an optional peer');
  }
  assert.ok(pkg.files.includes('docs') && pkg.files.includes('LICENSE'));

  // 测试脚本只跑两个原生套件
  assert.equal(pkg.scripts['test:acp-integration'], undefined, '不再保留 ACP 集成脚本');
  assert.match(pkg.scripts.test, /test\/swarm\.test\.mjs test\/swarm-open-source\.test\.mjs/);
  assert.ok(!pkg.scripts.check.includes(['mcp', 'bridge', 'server'].join('-')), 'check 脚本不得再检查已删文件');
  assert.ok(!pkg.scripts.check.includes(['mcp', 'stdio', 'entry'].join('-')));
  assert.ok(!pkg.scripts.check.includes('.tmp-tools'));

  const patch = fs.readFileSync(path.join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: dsh-agy-swarm/);
  assert.match(patch, /name: 'dsh-agy-swarm'/);

  const client = fs.readFileSync(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  assert.ok(client.includes("const SWARM_SETTINGS_ID = 'dsh-agy-swarm';"));
  assert.ok(client.includes("const SWARM_SETTINGS_ID_LEGACY = 'local-dsh-swarm';"));
  // 宿主 configForms.get() 永远返回 controller，所以兼容旧表只能靠 whileServed 的 served 集合
  assert.ok(client.includes('pickSettingsId'), '必须按 served 命名空间挑选表单 id');
  assert.ok(client.includes('served.has(SWARM_SETTINGS_ID_LEGACY)'), '必须识别旧命名空间');
  assert.ok(!/configForms\.get\([^)]*\)\s*\|\|/.test(client), '不得用 get() 的返回值探测表单是否存在（永不为空）');
  assert.ok(client.includes('whileServed([SWARM_SETTINGS_ID, SWARM_SETTINGS_ID_LEGACY]'), '必须同时关注新旧命名空间');
  assert.equal(swarm.__testOnlyPluginId || protocol.PLUGIN_ID, 'dsh-agy-swarm');
});

test('createSwarmTools：工具 Schema 通用，且不再含外部模式字段（b）', () => {
  const controller = Object.create(swarm.SwarmHostController.prototype);
  controller.config = {};
  controller.ctx = null;
  const built = swarm.createSwarmTools(controller);
  const list = Array.isArray(built) ? built : built && typeof built === 'object' ? Object.values(built) : [];
  assert.ok(list.length > 0, '工具工厂必须返回工具定义');

  const swarmTool = list.find((t) => (t && t.name === 'swarm') || (t && t.tool && t.tool.name === 'swarm'));
  assert.ok(swarmTool, '必须构建出 swarm 工具');
  const properties = swarmTool.parameters?.properties || {};
  assert.equal(
    Object.prototype.hasOwnProperty.call(properties, ['agy', 'mode'].join('_')),
    false,
    'swarm 参数表不得再有外部模式字段'
  );

  const serialized = JSON.stringify(list);
  for (const marker of REMOVED_BACKEND_MARKERS) {
    assert.ok(!serialized.includes(marker), '工具 Schema 不得出现已移除标记：' + marker);
  }
  assert.ok(!serialized.includes(['agy', '/'].join('')), '工具 schema 不得出现外部模型路由示例');
  assert.ok(!serialized.includes('Antigravity'), '工具 schema 不得提外部 CLI');
  assert.ok(!serialized.includes('optional extensions'), 'model 说明不再暗示可选扩展条目');

  const toolText = JSON.stringify(swarmTool);
  assert.ok(toolText.includes('configured in this DSH installation'), 'model 说明必须保持 DSH 通用路由表述');
  assert.ok(toolText.includes('"model"'), 'model 参数必须存在');
  assert.equal(built.swarmTool.deferLoading, true, '顶层 swarm 入口延迟加载（支持 Tool Retrieval 时按需召回）');
  assert.equal(built.postMessageTool.deferLoading, false, '看板 post_message 活跃时必须常驻');
  assert.equal(built.readBoardTool.deferLoading, false, '看板 read_board 活跃时必须常驻');
  assert.equal(built.swarmWaitTool.deferLoading, false, '看板 swarm_wait 活跃时必须常驻');
  assert.equal(built.scheduleTool.deferLoading, false, '监控 schedule 在 monitor 会话中必须常驻');
  assert.equal(built.manageTaskTool.deferLoading, false, '监控 manage_task 在 monitor 会话中必须常驻');
});

test('仓库文本不留个人路径、私有模型清单与兄弟目录引用（含转义与正斜杠变体）', () => {
  const banned = [
    ['3898', '7'].join(''),
    ['O:', 'AI', 'dsh'].join('\\'),
    ['O:', 'AI', 'dsh'].join('/'),
    ['DeepSeek', 'Harness'].join(''),
    ['parkour', '3d'].join(''),
    '@' + 'local' + '/' + 'dsh-swarm',
    '@' + 'local' + '/' + ['dsh', 'agy', 'acp'].join('-'),
    'deepseek' + '-account',
    'openai' + '-codex-fast',
    'google' + '-antigravity',
    'google' + '-vertex-argon',
    ['agy', 'argon'].join('/'),
    ['agy', 'sonnet'].join('/'),
    'gpt-' + 'oss',
    'deepseek' + '-v4-pro',
    ['..', '..', ['dsh', 'agy', 'acp'].join('-')].join('/'),
  ];
  // 源码里同一条路径可能被写成单反斜杠、双反斜杠（源码转义表示）或正斜杠，必须全部覆盖，
  // 否则只扫渲染后的形态会得到「假清零」。
  const variantsOf = (needle) => {
    const out = new Set([needle]);
    if (needle.includes('\\')) {
      out.add(needle.replaceAll('\\', '\\\\'));
      out.add(needle.replaceAll('\\', '/'));
    }
    return [...out];
  };
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.tmp' || entry.name === '.tmp-tools') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|cjs|mjs|json|jsonl|md|yml|yaml|txt|svg)$/.test(entry.name)) files.push(full);
    }
  };
  walk(PLUGIN_ROOT);
  assert.ok(files.length >= 12, '必须递归扫到全部源码、测试与文档，实际 ' + files.length + ' 个文件');
  const offenders = [];
  for (const full of files) {
    const text = fs.readFileSync(full, 'utf8');
    for (const needle of banned) {
      for (const variant of variantsOf(needle)) {
        if (text.includes(variant)) {
          offenders.push(path.relative(PLUGIN_ROOT, full) + ' :: ' + variant);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'shipped sources, tests and docs must stay free of personal paths');
});

test('存储层与协议层兜底脱敏：任何写入通道都不会把凭据落盘或推流', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-redact-'));
  try {
    const store = new BoardStore('coord-redact', { baseDir });
    store.ensureCoordinator({ provider: 'deepseek', model: 'deepseek-chat' });
    store.registerMember({ name: 'redactor', sessionId: 'sess-redact' });
    store.updateMemberRuntimeState('sess-redact', {
      lastError: 'boom: Authorization: Bearer abcdefghijklmnop',
      activity: 'edit ' + ['C:', 'Users', 'someone', 'a.js'].join(path.sep),
    });
    const member = store.getMemberBySessionId('sess-redact');
    assert.ok(!String(member.lastError).includes('abcdefghijklmnop'), 'lastError 不得保留 Bearer Token');
    assert.ok(String(member.lastError).includes('[REDACTED]'));
    assert.ok(!String(member.activity).includes('someone'), 'activity 不得保留个人主目录');

    // 协议层：成员快照的 activity 也要干净
    const snap = protocol.normalizeMemberSnapshot({
      name: 'redactor',
      state: 'working',
      activity: 'open ' + ['/Users', 'someone', 'b.ts'].join('/'),
    });
    assert.ok(!String(snap.activity).includes('someone'), '成员快照 activity 必须脱敏');

    // 旧持久化快照（未经脱敏写盘的历史数据）在推流时也必须被清洗
    const legacy = protocol.normalizeMemberSnapshot({
      name: 'legacy',
      state: 'stopped',
      lastError: 'connect failed: Authorization: Bearer zzzzyyyyxxxxwwww token=sk-legacy-0123456789abcdef',
      activity: 'edit ' + ['D:', 'Users', 'someone', 'c.js'].join(path.sep),
    });
    assert.ok(!String(legacy.lastError).includes('zzzzyyyyxxxxwwww'), '旧快照 lastError 必须先脱敏再推流');
    assert.ok(!String(legacy.lastError).includes('sk-legacy'), '旧快照 lastError 的 Token 必须清除');
    assert.ok(!String(legacy.activity).includes('someone'));
    const killedSnap = protocol.normalizeMemberSnapshot({ name: 'k', state: 'killed', lastError: 'Bearer aaaaabbbbbcccc' });
    assert.equal(killedSnap.lastError, '', 'killed 成员的 lastError 一律清空');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('旧版落盘 JSON 含已移除后端字段时不崩、不改写、归一化为原生成员', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-legacy-'));
  try {
    const coordId = 'coord-legacy';
    const store = new BoardStore(coordId, { baseDir });
    store.ensureCoordinator({ provider: 'vendor', model: 'model-a' });
    store.registerMember({ name: 'helper', sessionId: 'sess-helper' });
    // 释放写者锁，避免下面的重新打开被「并发双写者」保护拒绝
    store.releaseWriterLock();

    // 旧字段名在测试里也用拼接方式构造：仓库文本因此不含已移除概念的字面量。
    const legacyField = {
      backend: 'backend',
      session: ['agy', 'Session', 'Id'].join(''),
      worker: ['agy', 'Worker', 'Name'].join(''),
      mode: ['agy', 'Mode'].join(''),
      fullAccess: ['agy', 'FullAccess'].join(''),
      accessMode: ['agy', 'AccessMode'].join(''),
      live: ['agy', 'Live'].join(''),
      usage: ['agy', 'Usage'].join(''),
    };
    const legacyCounterField = {
      epoch: 'activationEpoch',
      count: 'activationCount',
      peerWakes: 'consecutivePeerWakes',
      circuit: 'circuitBreakNotified',
    };

    // 手工写入一份 0.1.x 形态的 state.json：带外部后端标记与若干遗留字段
    const stateFile = path.join(baseDir, coordId, 'state.json');
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    Object.assign(raw.members[1], {
      [legacyField.backend]: ['agy', 'acp'].join('-'),
      [legacyField.session]: 'legacy-session',
      [legacyField.worker]: 'legacy-worker',
      [legacyField.mode]: 'plan',
      [legacyField.fullAccess]: false,
      [legacyField.accessMode]: 'read-only',
      [legacyField.live]: { runId: 'r1', phase: 'prompt', pid: 42, activity: 'working' },
      [legacyField.usage]: {
        turns: 3,
        totalInput: 100,
        cacheRead: 10,
        totalOutput: 20,
        thinking: 0,
        cacheHitRate: 0.1,
      },
      [legacyCounterField.epoch]: 4,
      [legacyCounterField.count]: 5,
      [legacyCounterField.peerWakes]: 2,
      [legacyCounterField.circuit]: true,
    });
    fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2));

    const reopened = new BoardStore(coordId, { baseDir });
    const member = reopened.getMember('helper');
    assert.ok(member, '旧成员必须仍可读取');
    assert.equal(member.name, 'helper');
    for (const key of [...Object.values(legacyField), ...Object.values(legacyCounterField)]) {
      assert.equal(Object.prototype.hasOwnProperty.call(member, key), false, '已移除字段必须被丢弃：' + key);
    }

    // 快照推流同样不含这些字段
    const snapshot = reopened.toSnapshot();
    const snapMember = snapshot.members.find((m) => m.name === 'helper');
    assert.ok(snapMember);
    assert.equal(Object.prototype.hasOwnProperty.call(snapMember, legacyField.backend), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapMember, legacyField.live), false);

    // 反序列化 + 再落盘都不抛错
    assert.doesNotThrow(() => reopened.updateMemberRuntimeState('sess-helper', { state: 'waiting' }));
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 可视化模型派发权限（allowedModels / blockedModels）                    */
/* ------------------------------------------------------------------ */

/** 每个用例独立的临时目录 + 最小 Host ctx（只暴露原生 llm 模型目录）。 */
function createGateHarness(pluginConfig = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-gate-'));
  const ctx = {
    llm: {
      async listProviders() {
        return ['vendor'];
      },
      async listModels() {
        return [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }];
      },
    },
    get(name) {
      return this[name];
    },
  };
  const controller = new swarm.SwarmHostController(ctx, { baseDir, ...pluginConfig });
  return { controller, ctx, baseDir };
}

function createServiceCtx() {
  const provided = new Map();
  const ctx = {
    root: {
      reflect: { props: {} },
      accessor(name, desc) {
        this.reflect.props[name] = desc;
      },
    },
    reflect: {
      provide(name, value) {
        provided.set(name, value);
      },
    },
    get(name) {
      return this[name];
    },
  };
  return { ctx, provided };
}

async function cleanupHarness(harness) {
  try {
    await harness.controller.dispose();
  } catch {
    // 只为回收临时目录，dispose 失败不掩盖真实断言
  }
  fs.rmSync(harness.baseDir, { recursive: true, force: true });
}

test('Config：allowedModels / blockedModels 默认空数组、强校验与 volatile 热更新', async () => {
  const standard = swarm.Config['~standard'];
  const readVal = (value) => (value && typeof value.get === 'function' ? value.get() : value);

  // 开源默认：完全放行，绝不硬编码任何私人模型偏好
  assert.deepEqual([...swarm.SWARM_CONFIG_DEFAULTS.allowedModels], []);
  assert.deepEqual([...swarm.SWARM_CONFIG_DEFAULTS.blockedModels], []);
  const empty = standard.validate({});
  assert.ok(empty && empty.value, JSON.stringify(empty));
  assert.equal(readVal(empty.value.strictAllowlist), false, '严格白名单默认必须关闭');
  assert.deepEqual(readVal(empty.value.allowedModels), []);
  assert.deepEqual(readVal(empty.value.blockedModels), []);
  assert.equal(swarm.isSwarmModelAllowed(empty.value, 'any/model'), true, '默认必须不拦任何模型');

  // d) Config 只剩模型派发权限三项
  assert.deepEqual(
    Object.keys(swarm.SWARM_CONFIG_DEFAULTS).sort(),
    ['allowedModels', 'blockedModels', 'strictAllowlist'],
    'Config 只管理模型派发权限'
  );

  // 合法数组：trim + 大小写不敏感去重（保留首次写法）
  const withRules = standard.validate({
    allowedModels: [' Vendor/Model ', 'vendor/model', ''],
    blockedModels: ['other/model'],
  });
  assert.ok(withRules && withRules.value, JSON.stringify(withRules));
  assert.deepEqual(swarm.normalizeSwarmConfig(withRules.value).allowedModels, ['Vendor/Model']);
  assert.deepEqual(swarm.normalizeSwarmConfig(withRules.value).blockedModels, ['other/model']);

  // 强校验：非数组、含非字符串元素都必须报 issues 而不是静默吞掉
  const notArray = standard.validate({ allowedModels: 'vendor/model' });
  assert.ok(Array.isArray(notArray.issues) && notArray.issues.length > 0, '字符串必须被拒');
  const mixed = standard.validate({ blockedModels: ['ok/model', 42] });
  assert.ok(Array.isArray(mixed.issues) && mixed.issues.length > 0, '非字符串元素必须被拒');

  // strictAllowlist 强校验：只接受布尔值
  const strictOn = standard.validate({ strictAllowlist: true });
  assert.ok(strictOn && strictOn.value, JSON.stringify(strictOn));
  assert.equal(readVal(strictOn.value.strictAllowlist), true);
  const strictBad = standard.validate({ strictAllowlist: 'yes' });
  assert.ok(Array.isArray(strictBad.issues) && strictBad.issues.length > 0, '非布尔值必须被拒');
  assert.equal(
    swarm.normalizeSwarmConfig({ strictAllowlist: { get: () => true } }).strictAllowlist,
    true,
    'volatile 访问器必须能解包'
  );

  // normalizeModelRuleList 纯函数边界
  assert.deepEqual(swarm.normalizeModelRuleList([' A/B ', 'a/b', 42, '', 'C/D']), ['A/B', 'C/D']);
  assert.deepEqual(swarm.normalizeModelRuleList('not-an-array'), []);
  assert.deepEqual(swarm.normalizeModelRuleList(undefined), []);

  // volatile 热更新：只替换运行期字段，既有成员状态与其它键原样保留
  const harness = createGateHarness({ allowedModels: [], blockedModels: [] });
  const { controller } = harness;
  try {
    assert.equal(controller.config.baseDir, harness.baseDir, '非契约键必须保留');
    assert.ok(swarm.applyVolatileConfig(controller, { blockedModels: ['Vendor/Locked'], allowedModels: [] }));
    assert.deepEqual(controller.config.blockedModels, ['Vendor/Locked']);
    assert.equal(controller.config.baseDir, harness.baseDir);
    assert.ok(
      swarm.applyVolatileConfig(controller, {
        blockedModels: { get: () => ['vendor/locked'] },
        allowedModels: { get: () => ['vendor/model-a'] },
      }),
      '真实宿主 volatile 访问器必须能解包'
    );
    assert.deepEqual(controller.config.blockedModels, ['vendor/locked']);
    assert.deepEqual(controller.config.allowedModels, ['vendor/model-a']);
    // 局部补丁同样不得清掉未提到的 strictAllowlist
    assert.ok(swarm.applyVolatileConfig(controller, { strictAllowlist: true }));
    assert.equal(controller.config.strictAllowlist, true);
    assert.deepEqual(controller.config.allowedModels, ['vendor/model-a'], '局部补丁必须保留已有白名单');
    assert.ok(swarm.applyVolatileConfig(controller, { blockedModels: [] }));
    assert.equal(controller.config.strictAllowlist, true, '局部补丁必须保留严格模式开关');
    assert.equal(swarm.isSwarmModelAllowed(controller.config, 'vendor/model-b'), false);
    assert.equal(swarm.isSwarmModelAllowed(controller.config, 'vendor/model-a'), true);
  } finally {
    await cleanupHarness(harness);
  }
});

test('模型派发权限纯函数：大小写不敏感、黑名单优先、白名单非空即收口', () => {
  assert.equal(swarm.isSwarmModelAllowed({}, 'anything/at-all'), true);

  const blacklist = { blockedModels: ['Vendor/Model'] };
  assert.equal(swarm.isSwarmModelAllowed(blacklist, 'vendor/model'), false, '完整键大小写不敏感');
  assert.equal(swarm.isSwarmModelAllowed(blacklist, { provider: 'vendor', model: 'model' }), false);
  assert.equal(swarm.isSwarmModelAllowed(blacklist, 'vendor/other'), true);

  const whitelist = { allowedModels: ['vendor/model'] };
  assert.equal(swarm.isSwarmModelAllowed(whitelist, 'vendor/model'), true);
  assert.equal(swarm.isSwarmModelAllowed(whitelist, { provider: 'vendor', model: 'other' }), false);

  const both = { allowedModels: ['vendor/model'], blockedModels: ['vendor/model'] };
  assert.equal(swarm.isSwarmModelAllowed(both, 'vendor/model'), false, '黑名单必须优先于白名单');

  // 裸 model 名命中也算（规则写成 model 名同样生效）
  assert.equal(swarm.isSwarmModelAllowed({ blockedModels: ['model'] }, 'vendor/model'), false);

  // 严格白名单：开关为 true 时空名单一律拒绝，绝不反转成放行
  assert.equal(swarm.SWARM_CONFIG_DEFAULTS.strictAllowlist, false, '开源默认必须关闭严格白名单');
  assert.equal(swarm.isSwarmModelAllowed({ strictAllowlist: true, allowedModels: [] }, 'vendor/model'), false);
  assert.equal(swarm.isSwarmModelAllowed({ strictAllowlist: true }, 'vendor/model'), false);
  assert.equal(swarm.isSwarmModelAllowed({ strictAllowlist: false, allowedModels: [] }, 'vendor/model'), true);
  assert.equal(
    swarm.isSwarmModelAllowed({ strictAllowlist: true, allowedModels: ['vendor/model'] }, 'vendor/model'),
    true
  );
  assert.throws(() => swarm.assertSwarmModelAllowed({ strictAllowlist: true }, 'vendor/model'), /允许列表为空/);

  assert.equal(swarm.assertSwarmModelAllowed({}, 'vendor/model'), true);
  assert.throws(() => swarm.assertSwarmModelAllowed(blacklist, 'vendor/model'), /禁用规则/);
  assert.throws(() => swarm.assertSwarmModelAllowed(whitelist, 'vendor/other'), /白名单/);
  assert.throws(
    () => swarm.assertSwarmModelAllowed(blacklist, 'vendor/model', { inherited: true }),
    (err) => /继承的默认模型/.test(err.message) && /显式指定/.test(err.message),
    '继承来的默认模型被禁时必须明确要求显式指定'
  );
});

test('resolveRequestedModel：显式模型、继承协调员默认路由、白名单收口全部硬拦截', async () => {
  // 1) 显式模型命中黑名单
  const explicit = createGateHarness({ blockedModels: ['vendor/model-b'] });
  try {
    await assert.rejects(
      () => explicit.controller.resolveRequestedModel('vendor/model-b'),
      /禁用规则/,
      '显式指定被禁模型必须当场报错'
    );
    const allowed = await explicit.controller.resolveRequestedModel('vendor/model-a');
    assert.equal(allowed.modelDisplay, 'vendor/model-a');
    // 大小写不敏感命中
    await assert.rejects(
      () => explicit.controller.resolveRequestedModel('VENDOR/MODEL-B'),
      /禁用规则/
    );
  } finally {
    await cleanupHarness(explicit);
  }

  // 2) 省略 model → 继承协调员当前路由，被禁同样拦截且提示显式指定
  const inherited = createGateHarness({ blockedModels: ['vendor/model-b'] });
  try {
    await assert.rejects(
      () =>
        inherited.controller.resolveRequestedModel('', {
          provider: 'vendor',
          model: 'model-b',
          reasoningEffort: 'high',
        }),
      (err) => /继承的默认模型/.test(err.message) && /显式指定/.test(err.message)
    );
    const ok = await inherited.controller.resolveRequestedModel('', {
      provider: 'vendor',
      model: 'model-a',
    });
    assert.equal(ok.modelDisplay, 'vendor/model-a');
  } finally {
    await cleanupHarness(inherited);
  }

  // 3) 非空白名单：列表外模型一律拒绝，列表内放行
  const whitelist = createGateHarness({ allowedModels: ['vendor/model-a'] });
  try {
    await assert.rejects(
      () => whitelist.controller.resolveRequestedModel('vendor/model-b'),
      /白名单/
    );
    const ok = await whitelist.controller.resolveRequestedModel('vendor/model-a');
    assert.equal(ok.model, 'model-a');
  } finally {
    await cleanupHarness(whitelist);
  }

  // 4) 严格白名单 + 空名单：显式与继承两条路径都由「允许列表为空」拦下
  const strictEmpty = createGateHarness({ strictAllowlist: true, allowedModels: [] });
  try {
    await assert.rejects(
      () => strictEmpty.controller.resolveRequestedModel('vendor/model-a'),
      (err) => /允许列表为空/.test(err.message),
      '严格模式空名单必须拒绝任何显式模型'
    );
    await assert.rejects(
      () =>
        strictEmpty.controller.resolveRequestedModel('', {
          provider: 'vendor',
          model: 'model-a',
        }),
      (err) => /继承的默认模型/.test(err.message) && /允许列表为空/.test(err.message),
      '继承来的默认模型同样被空名单拦下'
    );
  } finally {
    await cleanupHarness(strictEmpty);
  }
});

/** provider 判定专用 harness：可以精确控制 listProviders / listModels 的行为。 */
function createProviderHarness({ providers = ['native'], modelsByProvider = {}, ...pluginConfig } = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-provider-'));
  const ctx = {
    llm: {
      async listProviders() {
        return providers;
      },
      async listModels(providerId) {
        const entry = modelsByProvider[providerId];
        if (typeof entry === 'function') return entry();
        return Array.isArray(entry) ? entry : [];
      },
    },
    get(name) {
      return this[name];
    },
  };
  return { controller: new swarm.SwarmHostController(ctx, { baseDir, ...pluginConfig }), baseDir, ctx };
}

test('c) provider 判定以 llm.listProviders() 为准：已注册 provider 的未列模型放行，未注册 provider 稳定拒绝', async () => {
  const removedRoute = ['agy', 'carbon'].join('/');

  // (1) listModels 返回空数组：provider 已注册 → 其模型照常通过
  const emptyCatalog = createProviderHarness({ providers: ['native', 'custom'], modelsByProvider: { custom: [] } });
  try {
    const resolved = await emptyCatalog.controller.resolveRequestedModel('custom/unlisted');
    assert.equal(resolved.modelDisplay, 'custom/unlisted', '已注册 provider 即使没有模型条目也必须可用');
  } finally {
    await cleanupHarness(emptyCatalog);
  }

  // (2) listModels 抛错：同样不得误杀
  const throwingCatalog = createProviderHarness({
    providers: ['native', 'custom'],
    modelsByProvider: {
      custom: () => {
        throw new Error('catalog exploded');
      },
    },
  });
  try {
    const resolved = await throwingCatalog.controller.resolveRequestedModel('custom/unlisted');
    assert.equal(resolved.modelDisplay, 'custom/unlisted', 'listModels 抛错不得让已注册 provider 失效');
  } finally {
    await cleanupHarness(throwingCatalog);
  }

  // (3) 已列模型被派发权限过滤掉：provider 依旧可用
  const filteredCatalog = createProviderHarness({
    providers: ['native', 'custom'],
    modelsByProvider: { custom: [{ id: 'model-x', name: 'X' }] },
    blockedModels: ['custom/model-x'],
  });
  try {
    assert.deepEqual(await filteredCatalog.controller.listAvailableModels(), [], '该 provider 的目录被完全过滤');
    const resolved = await filteredCatalog.controller.resolveRequestedModel('custom/unlisted');
    assert.equal(resolved.modelDisplay, 'custom/unlisted', '条目被过滤不等于 provider 未注册');
  } finally {
    await cleanupHarness(filteredCatalog);
  }

  // (4) 未注册 provider：即使模型目录整体为空也必须稳定拒绝
  const unknownProvider = createProviderHarness({ providers: ['native'], modelsByProvider: {} });
  try {
    assert.deepEqual(await unknownProvider.controller.listAvailableModels(), [], '目录整体为空');
    await assert.rejects(
      () => unknownProvider.controller.resolveRequestedModel(removedRoute),
      (err) => /未配置 provider/.test(err.message) && err.message.includes('agy'),
      '已移除的后端 provider 必须被稳定拒绝（空目录下也不漏网）'
    );
    await assert.rejects(
      () => unknownProvider.controller.resolveRequestedModel('no-such-provider/model-x'),
      /未配置 provider/
    );
    const ok = await unknownProvider.controller.resolveRequestedModel('native/anything');
    assert.equal(ok.modelDisplay, 'native/anything', '已注册 provider 的未列模型照常通过');
  } finally {
    await cleanupHarness(unknownProvider);
  }
});

test('宿主无 llm.listProviders 时跳过 provider 校验：宽松透传，绝不误伤离线 mock', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-nollm-'));
  const ctx = { get() { return undefined; } };
  const controller = new swarm.SwarmHostController(ctx, { baseDir });
  try {
    assert.equal(await controller._listRegisteredProviderIds(), null, '无权威名单时返回 null');
    const resolved = await controller.resolveRequestedModel('whatever/model');
    assert.equal(resolved.modelDisplay, 'whatever/model', '没有 provider 名单时按已有逻辑透传');
  } finally {
    await cleanupHarness({ controller, baseDir });
  }
});

test('白名单下传裸模型名与显示名同样放行（判定发生在解析之后）', async () => {
  const harness = createProviderHarness({
    providers: ['native'],
    modelsByProvider: { native: [{ id: 'ok', name: 'Friendly' }] },
    allowedModels: ['native/ok'],
  });
  const { controller } = harness;
  try {
    for (const spec of ['native/ok', 'ok', 'Friendly']) {
      const resolved = await controller.resolveRequestedModel(spec);
      assert.equal(resolved.provider, 'native', '裸名/显示名必须解析到目标 provider：' + spec);
      assert.equal(resolved.model, 'ok');
      assert.equal(resolved.modelDisplay, 'native/ok');
    }

    // 解析后的完整闸门仍在：白名单外模型一样被拦
    await assert.rejects(() => controller.resolveRequestedModel('native/other'), /白名单/);
    // 解析后的完整闸门仍在：严格模式空名单同样拒绝
    assert.ok(swarm.applyVolatileConfig(controller, { strictAllowlist: true, allowedModels: [] }));
    await assert.rejects(() => controller.resolveRequestedModel('native/ok'), /允许列表为空/);
  } finally {
    await cleanupHarness(harness);
  }
});

test('显式黑名单在解析前早退：未注册 provider 的被禁写法报黑名单而不是未配置 provider', async () => {
  const harness = createProviderHarness({
    providers: ['native'],
    blockedModels: [['agy', 'carbon'].join('/')],
  });
  const { controller } = harness;
  try {
    await assert.rejects(
      () => controller.resolveRequestedModel(['agy', 'carbon'].join('/')),
      (err) => /禁用规则/.test(err.message) && /模型派发权限控制/.test(err.message),
      '显式禁用必须优先于 provider 未注册报错'
    );
  } finally {
    await cleanupHarness(harness);
  }
});

test('listAvailableModels：默认过滤被禁模型，includeBlocked 保留全量并标记；models 工具同步收口', async () => {
  const harness = createGateHarness({ blockedModels: ['vendor/model-b'] });
  const { controller } = harness;
  try {
    const visible = await controller.listAvailableModels();
    assert.deepEqual(
      visible.map((m) => m.key),
      ['vendor/model-a'],
      '默认清单必须滤掉被禁条目'
    );
    assert.equal(visible[0].allowed, undefined, '过滤后的条目不得混入设置页专用标记');

    const everything = await controller.listAvailableModels({ includeBlocked: true });
    assert.deepEqual(everything.map((m) => m.key).sort(), ['vendor/model-a', 'vendor/model-b']);
    const blockedRow = everything.find((m) => m.key === 'vendor/model-b');
    assert.equal(blockedRow.blocked, true);
    assert.equal(blockedRow.allowed, false);
    const allowedRow = everything.find((m) => m.key === 'vendor/model-a');
    assert.equal(allowedRow.blocked, false);
    assert.equal(allowedRow.allowed, true);

    // 模型工具（swarm{action:"models"}）永远看不到被禁条目
    const listed = await controller.executeSwarmTool({ action: 'models' }, {});
    assert.ok(!listed.models.some((m) => m.key === 'vendor/model-b'));
    assert.equal(listed.total_configured, 1, 'total_configured 只统计当前允许派发的条目');

    // 白名单模式下同样收口（局部补丁不得清空未提到的黑名单字段）
    assert.ok(swarm.applyVolatileConfig(controller, { allowedModels: ['vendor/model-b'], blockedModels: [] }));
    const whitelisted = await controller.listAvailableModels();
    assert.deepEqual(whitelisted.map((m) => m.key), ['vendor/model-b']);
    const whitelistedAll = await controller.listAvailableModels({ includeBlocked: true });
    assert.equal(whitelistedAll.filter((m) => m.blocked).length, 0);
    assert.equal(
      whitelistedAll.find((m) => m.key === 'vendor/model-a').allowed,
      false,
      '白名单外的模型必须标记为不允许'
    );

    // 两个列表同时命中同一模型时，黑名单优先
    assert.ok(
      swarm.applyVolatileConfig(controller, {
        allowedModels: ['vendor/model-b'],
        blockedModels: ['vendor/model-b'],
      })
    );
    assert.deepEqual(await controller.listAvailableModels(), [], '黑名单必须优先于白名单');

    // 严格白名单 + 空名单：清单为空，且全量目录里每条都被标记 allowed:false
    assert.ok(
      swarm.applyVolatileConfig(controller, {
        strictAllowlist: true,
        allowedModels: [],
        blockedModels: [],
      })
    );
    assert.deepEqual(await controller.listAvailableModels(), [], '严格模式空名单必须一个都不放行');
    const strictAll = await controller.listAvailableModels({ includeBlocked: true });
    assert.ok(strictAll.length > 0, '全量目录仍然可见，便于用户在设置页勾选');
    assert.ok(strictAll.every((m) => m.allowed === false), '严格模式空名单下每条都必须标记为不允许');
    const strictService = swarm.mountSwarmRemoteService(createServiceCtx().ctx, controller);
    const strictDirectory = await strictService.getSwarmModels({});
    assert.ok(strictDirectory.models.every((m) => m.allowed === false && m.blocked === false));
  } finally {
    await cleanupHarness(harness);
  }
});

test('getSwarmModels：Typert 协议请求/结果校验，Host 服务零子进程返回全量目录', async () => {
  // 协议层：任意 plain object 归一化为 {}，只有非 plain object 才是协议违约。
  // 旧版 Web 客户端缓存会发送 { probeAgy: false }，升级后必须照常工作。
  assert.deepEqual(protocol.parseSwarmModelsRequest(undefined), {});
  assert.deepEqual(protocol.parseSwarmModelsRequest(null), {});
  assert.deepEqual(protocol.parseSwarmModelsRequest({}), {});
  assert.deepEqual(protocol.parseSwarmModelsRequest({ sessionId: 'x' }), {}, '未知键一律忽略');
  assert.deepEqual(protocol.parseSwarmModelsRequest({ probeAgy: false }), {}, '旧客户端字段必须被忽略');
  assert.deepEqual(protocol.parseSwarmModelsRequest({ probeAgy: true }), {}, '旧客户端字段必须被忽略');
  for (const bad of [[], ['probeAgy'], 'probeAgy', 42, true]) {
    assert.throws(() => protocol.parseSwarmModelsRequest(bad), TypeError, '非 plain object 必须被拒：' + JSON.stringify(bad));
  }

  const rawResult = {
    models: [
      { key: 'vendor/model-a', provider: 'vendor', model: 'model-a', name: 'A', backend: 'dsh', allowed: true, blocked: false },
      { key: 'vendor/model-b', provider: 'vendor', model: 'model-b', name: 'B', backend: 'dsh', allowed: false, blocked: true, extra: 'drop-me' },
    ],
  };
  const parsed = protocol.parseSwarmModelsResult(rawResult);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(parsed)), '结果必须是严格 JSON-safe（无 undefined）');
  assert.deepEqual(Object.keys(parsed.models[0]), ['key', 'provider', 'model', 'name', 'backend', 'allowed', 'blocked']);
  assert.equal(parsed.models[1].extra, undefined, '未知字段必须被丢弃');
  assert.throws(() => protocol.parseSwarmModelsResult({}), TypeError);
  assert.throws(() => protocol.parseSwarmModelsResult({ models: 'nope' }), TypeError);

  // Host ↔ Client 协议对称
  assert.deepEqual(clientMod.parseSwarmModelsRequest({}), {});
  assert.deepEqual(clientMod.parseSwarmModelsRequest({ probeAgy: false }), {}, 'Client 侧同样忽略旧字段');
  assert.deepEqual(clientMod.parseSwarmModelsRequest({ sessionId: 'x' }), {});
  assert.throws(() => clientMod.parseSwarmModelsRequest([]), /expected a JSON object/);
  assert.throws(() => clientMod.parseSwarmModelsRequest('x'), /expected a JSON object/);
  assert.deepEqual(clientMod.parseSwarmModelsResult(rawResult), parsed);
  const modelsDescriptor = clientMod.SWARM_REMOTE.descriptors.find((d) => d.method === 'getSwarmModels');
  assert.ok(modelsDescriptor, 'Client 侧必须有 getSwarmModels 描述符');
  assert.deepEqual(modelsDescriptor.parameters[0].codec.schema.parse({}), {});
  assert.ok(modelsDescriptor.result.schema.parse(rawResult));
  assert.throws(() => modelsDescriptor.result.schema.parse({ models: 1 }));

  // Host 服务：零子进程（不触发任何探测），并附带 allowed/blocked 标记
  const harness = createGateHarness({ blockedModels: ['vendor/model-b'] });
  const serviceCtx = createServiceCtx();
  try {
    const service = swarm.mountSwarmRemoteService(serviceCtx.ctx, harness.controller);
    assert.equal(typeof service.getSwarmModels, 'function');
    const result = await service.getSwarmModels({});
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
    assert.deepEqual(result.models.map((m) => m.key).sort(), ['vendor/model-a', 'vendor/model-b']);
    assert.equal(result.models.find((m) => m.key === 'vendor/model-b').blocked, true);
    assert.equal(result.models.find((m) => m.key === 'vendor/model-b').allowed, false);
    assert.ok(result.models.every((m) => m.backend === 'dsh'), '所有条目都是原生 DSH 路由');
    // 旧字段不再让服务报错：请求体被归一化为 {}，目录照常返回
    const legacyRequest = await service.getSwarmModels({ probeAgy: false, sessionId: 'x' });
    assert.deepEqual(legacyRequest.models.map((m) => m.key).sort(), ['vendor/model-a', 'vendor/model-b']);
    // 非 plain object 仍然是协议违约
    await assert.rejects(() => service.getSwarmModels([]), TypeError);

    const marker = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(service),
      '@deepseek-ai/dsh-typert-protocol/remote-methods'
    );
    if (marker) {
      assert.ok(
        marker.value.methods.some((m) => m.method === 'getSwarmModels'),
        '回退描述符必须声明 getSwarmModels'
      );
    }
  } finally {
    await cleanupHarness(harness);
  }
});

/* ---- 设置页「模型派发权限控制」-------------------------------------- */

/**
 * 设置页 harness。
 *
 * useState 做成真正的「跨渲染持久」：每轮 render 前重置 hook 游标，
 * 这样开关草稿、notice 这类状态与真实 React 行为一致（写入失败必须能观察到
 * error 提示，且开关不得停留在未保存的位置）。
 * failKeys 里的键会让 form.set 返回 false 且**不更新快照**，用来模拟保存失败。
 */
function createPermissionsSectionHarness({ initialValue = {}, models = null, failKeys = [] } = {}) {
  const hookValues = [];
  let hookIndex = 0;
  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const slot = hookIndex++;
      if (!(slot in hookValues)) hookValues[slot] = typeof init === 'function' ? init() : init;
      return [
        hookValues[slot],
        (next) => {
          hookValues[slot] = typeof next === 'function' ? next(hookValues[slot]) : next;
        },
      ];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  const writes = [];
  const failures = new Set(failKeys);
  let snapshot = {
    status: 'ready',
    writable: true,
    value: {
      strictAllowlist: false,
      allowedModels: [],
      blockedModels: [],
      ...initialValue,
    },
  };
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set(key, value) {
      writes.push([key, value]);
      if (failures.has(key)) return false;
      snapshot = { ...snapshot, value: { ...snapshot.value, [key]: value } };
      return true;
    },
  };
  const Section = clientMod.createSwarmSettingsSection(mockReact, mockReact.createElement);
  return {
    form,
    writes,
    getValue: () => snapshot.value,
    failOn: (keys) => {
      for (const key of keys) failures.add(key);
    },
    render: () => {
      hookIndex = 0;
      return Section({ form, t: (key) => key, models });
    },
  };
}

function flattenTree(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of Array.isArray(node.children) ? node.children : []) flattenTree(child, out);
  return out;
}

function nodeByAction(tree, action) {
  return flattenTree(tree).find((n) => n.props && n.props['data-action'] === action) || null;
}

const RULE_MODELS = Object.freeze([
  { key: 'vendor/model-a', provider: 'vendor', model: 'model-a', name: 'A', backend: 'dsh', allowed: true, blocked: false },
  { key: 'vendor/model-b', provider: 'vendor', model: 'model-b', name: 'B', backend: 'dsh', allowed: true, blocked: false },
]);

test('设置页：黑名单模式取消勾选写 blockedModels，重新勾选移出', async () => {
  const h = createPermissionsSectionHarness({ models: [...RULE_MODELS] });
  const tree = h.render();
  const boxes = flattenTree(tree).filter((n) => n.props && n.props['data-action'] === 'toggle-model');
  assert.equal(boxes.length, 2, '必须渲染宿主已发现的每个模型');
  assert.ok(boxes.every((b) => b.props.checked === true), '黑名单模式默认全允许');

  await boxes[0].props.onChange({ target: { checked: false } });
  assert.deepEqual(h.writes.at(-1), ['blockedModels', ['vendor/model-a']], '取消勾选必须写入黑名单');

  const rerendered = h.render();
  const secondBoxes = flattenTree(rerendered).filter((n) => n.props && n.props['data-action'] === 'toggle-model');
  assert.equal(secondBoxes[0].props.checked, false, '被禁模型必须显示为未勾选');
  assert.equal(secondBoxes[1].props.checked, true);

  await secondBoxes[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(h.writes.at(-1), ['blockedModels', []], '重新勾选必须移出黑名单');

  // 已有黑名单条目在「未拉到目录」时也能展示并可移除
  const offline = createPermissionsSectionHarness({ initialValue: { blockedModels: ['vendor/legacy-model'] } });
  const offlineTree = offline.render();
  const chips = flattenTree(offlineTree).filter((n) => n.props && n.props['data-action'] === 'remove-blocked-rule');
  assert.deepEqual(chips.map((c) => c.props['data-rule']), ['vendor/legacy-model']);
  assert.ok(
    !flattenTree(offlineTree).some((n) => n.props && n.props['data-role'] === 'model-list'),
    '没有宿主目录时不得渲染空模型列表'
  );
  assert.ok(nodeByAction(offlineTree, 'reset-defaults'), '拉取失败也不能阻塞设置页其余功能');
  await chips[0].props.onClick();
  assert.deepEqual(offline.writes.at(-1), ['blockedModels', []]);
});

test('设置页：开启严格白名单写入 allowedModels，切换回来清空白名单', async () => {
  const h = createPermissionsSectionHarness({ models: [...RULE_MODELS] });
  const first = h.render();
  const toggle = nodeByAction(first, 'toggle-whitelist');
  assert.ok(toggle, '必须有严格白名单开关');
  assert.equal(toggle.props['aria-checked'], 'false');

  await toggle.props.onClick();
  assert.deepEqual(
    h.writes.at(-1),
    ['allowedModels', ['vendor/model-a', 'vendor/model-b']],
    '开启白名单必须把当前勾选的模型全部写进 allowedModels'
  );

  // 白名单模式：取消勾选只从 allowedModels 移除，不再写 blockedModels
  const whitelisted = h.render();
  assert.equal(nodeByAction(whitelisted, 'toggle-whitelist').props['aria-checked'], 'true');
  const boxes = flattenTree(whitelisted).filter((n) => n.props && n.props['data-action'] === 'toggle-model');
  await boxes[1].props.onChange({ target: { checked: false } });
  assert.deepEqual(h.writes.at(-1), ['allowedModels', ['vendor/model-a']]);

  // 关闭白名单 → 清空 allowedModels
  const closing = h.render();
  await nodeByAction(closing, 'toggle-whitelist').props.onClick();
  assert.deepEqual(h.writes.at(-1), ['allowedModels', []]);
});

test('设置页：手动模型规则可加入禁用/允许列表，恢复默认只写模型派发权限三项（d）', async () => {
  const h = createPermissionsSectionHarness({ models: [] });
  const tree = h.render();
  const input = flattenTree(tree).find((n) => n.props && n.props['data-field'] === 'manualModelRule');
  assert.ok(input, '必须有手动规则输入框');
  input.props.onChange({ target: { value: ' vendor/model-x ' } });

  await nodeByAction(tree, 'add-blocked-rule').props.onClick();
  assert.deepEqual(h.writes.at(-1), ['blockedModels', ['vendor/model-x']]);

  const second = h.render();
  const input2 = flattenTree(second).find((n) => n.props && n.props['data-field'] === 'manualModelRule');
  input2.props.onChange({ target: { value: 'vendor/model-y' } });
  await nodeByAction(second, 'add-allowed-rule').props.onClick();
  assert.deepEqual(h.writes.at(-1), ['allowedModels', ['vendor/model-y']]);

  // 恢复默认：只覆盖模型派发权限三项
  h.writes.length = 0;
  await nodeByAction(h.render(), 'reset-defaults').props.onClick();
  const written = Object.fromEntries(h.writes);
  assert.deepEqual(written.allowedModels, []);
  assert.deepEqual(written.blockedModels, []);
  assert.deepEqual(
    Object.keys(written).sort(),
    ['allowedModels', 'blockedModels', 'strictAllowlist'],
    '恢复默认只写这三项（不残留已移除的字段）'
  );
  assert.equal(written.strictAllowlist, false, '恢复默认必须同时关掉严格白名单');
  assert.deepEqual(Object.keys(clientMod.SETTINGS_DEFAULTS).sort(), ['allowedModels', 'blockedModels', 'strictAllowlist']);
});

test('设置页：不再渲染任何外部后端配置项（d）', () => {
  const h = createPermissionsSectionHarness({ models: [...RULE_MODELS] });
  const tree = h.render();
  const nodes = flattenTree(tree);

  // 只剩模型派发权限卡片
  const cards = nodes.filter((n) => n.props && n.props['data-card']);
  assert.deepEqual(cards.map((c) => c.props['data-card']), ['models']);

  // 没有外部后端相关的字段行、输入框或提示
  const removedSettingFields = [
    'nodeExecutable',
    ['maxConsecutive', 'PeerWakes'].join(''),
    ['max', 'Agy', 'Turns', 'Per', 'Member'].join(''),
    ['max', 'Agy', 'Posts', 'Per', 'Turn'].join(''),
  ];
  for (const field of removedSettingFields) {
    assert.ok(!nodes.some((n) => n.props && n.props['data-field'] === field), '不得再渲染字段 ' + field);
  }
  assert.ok(!nodes.some((n) => n.props && n.props['data-role'] === 'agy-overlap-hint'));
  assert.ok(!nodes.some((n) => n.props && n.props['data-action'] === 'save-nodeExecutable'));
  assert.ok(nodeByAction(tree, 'toggle-whitelist'), '严格白名单开关仍在');
  assert.ok(nodeByAction(tree, 'reset-defaults'), '恢复默认仍在');

  // 文案里不再有已移除的参数名
  const serialized = JSON.stringify(tree);
  assert.ok(!serialized.includes(['maxConsecutive', 'PeerWakes'].join('')), '文案不得再提熔断阈值');
  assert.ok(!serialized.includes(['max', 'Agy'].join('')), '文案不得再提外部轮次上限');
  assert.ok(!serialized.includes('nodeExecutable'), '文案不得再提外部进程可执行文件');
});

test('严格白名单：取消最后一个勾选后 strictAllowlist 保持 true，任意模型一律拒绝', async () => {
  const h = createPermissionsSectionHarness({
    initialValue: { strictAllowlist: true, allowedModels: ['vendor/model-a'] },
    models: [...RULE_MODELS],
  });
  const tree = h.render();
  assert.equal(nodeByAction(tree, 'toggle-whitelist').props['aria-checked'], 'true');
  const boxes = flattenTree(tree).filter((n) => n.props && n.props['data-action'] === 'toggle-model');
  assert.deepEqual(boxes.map((b) => b.props.checked), [true, false], '只有白名单内的模型是勾选态');

  await boxes[0].props.onChange({ target: { checked: false } });
  assert.deepEqual(h.writes.at(-1), ['allowedModels', []]);
  assert.equal(h.getValue().strictAllowlist, true, '取消最后一个勾选绝不允许顺手关掉严格模式');
  assert.deepEqual(h.getValue().allowedModels, []);

  // Host 侧：严格模式 + 空名单 = 全部拒绝（含原允许模型、同目录模型与第三方模型）
  const config = {
    strictAllowlist: h.getValue().strictAllowlist,
    allowedModels: h.getValue().allowedModels,
    blockedModels: h.getValue().blockedModels,
  };
  for (const candidate of [
    'vendor/model-a',
    'vendor/model-b',
    'other/model-x',
    { provider: 'vendor', model: 'model-a' },
  ]) {
    assert.equal(
      swarm.isSwarmModelAllowed(config, candidate),
      false,
      '空白名单必须拒绝 ' + JSON.stringify(candidate)
    );
  }
  assert.throws(
    () => swarm.assertSwarmModelAllowed(config, 'vendor/model-a'),
    /允许列表为空/,
    '报错必须说明是严格白名单空名单导致的拒绝'
  );

  // 重新勾选任意一个即恢复该模型的允许（不会连带放行别的模型）
  const rerendered = h.render();
  const boxes2 = flattenTree(rerendered).filter((n) => n.props && n.props['data-action'] === 'toggle-model');
  assert.deepEqual(boxes2.map((b) => b.props.checked), [false, false], '空白名单下两个模型都是未勾选');
  await boxes2[1].props.onChange({ target: { checked: true } });
  assert.deepEqual(h.writes.at(-1), ['allowedModels', ['vendor/model-b']]);
  const restored = { strictAllowlist: true, allowedModels: ['vendor/model-b'] };
  assert.equal(swarm.isSwarmModelAllowed(restored, 'vendor/model-b'), true);
  assert.equal(swarm.isSwarmModelAllowed(restored, 'vendor/model-a'), false);
});

test('严格白名单：移除最后一个白名单胶囊后依然全部拒绝', async () => {
  const h = createPermissionsSectionHarness({
    initialValue: { strictAllowlist: true, allowedModels: ['vendor/model-a'] },
    models: [],
  });
  const tree = h.render();
  const chips = flattenTree(tree).filter((n) => n.props && n.props['data-action'] === 'remove-allowed-rule');
  assert.deepEqual(chips.map((c) => c.props['data-rule']), ['vendor/model-a']);

  await chips[0].props.onClick();
  assert.deepEqual(h.writes.at(-1), ['allowedModels', []]);
  assert.equal(h.getValue().strictAllowlist, true, '移除胶囊不得关掉严格模式');

  const after = h.render();
  assert.equal(nodeByAction(after, 'toggle-whitelist').props['aria-checked'], 'true');
  const empty = flattenTree(after).find((n) => n.props && n.props['data-role'] === 'models-empty');
  assert.ok(empty, '空名单必须显示提示');
  assert.deepEqual(empty.children, ['whitelistNeedsModels']);
  const config = { strictAllowlist: true, allowedModels: h.getValue().allowedModels };
  assert.equal(swarm.isSwarmModelAllowed(config, 'vendor/model-a'), false);
  assert.equal(swarm.isSwarmModelAllowed(config, 'other/model-x'), false);
});

test('严格白名单：模型目录为空时开启，写入 strictAllowlist:true + 空名单并拒绝任意模型', async () => {
  const h = createPermissionsSectionHarness({ models: [] });
  const tree = h.render();
  await nodeByAction(tree, 'toggle-whitelist').props.onClick();

  assert.deepEqual(
    h.writes.map(([key]) => key),
    ['strictAllowlist', 'allowedModels'],
    '开启严格模式必须先落开关再写白名单'
  );
  assert.equal(h.getValue().strictAllowlist, true);
  assert.deepEqual(h.getValue().allowedModels, []);

  const after = h.render();
  assert.equal(nodeByAction(after, 'toggle-whitelist').props['aria-checked'], 'true');
  const empty = flattenTree(after).find((n) => n.props && n.props['data-role'] === 'models-empty');
  assert.ok(empty, '空目录开启严格模式必须提示当前禁止所有模型');
  assert.deepEqual(empty.children, ['whitelistNeedsModels']);

  // Host 侧：host 全量目录里的任何模型此刻都不可派发
  for (const candidate of ['vendor/model-a', 'vendor/model-b', { provider: 'vendor', model: 'model-b' }]) {
    assert.equal(swarm.isSwarmModelAllowed(h.getValue(), candidate), false);
  }

  // 关闭后重新回到「未启用白名单 = 完全放行」
  await nodeByAction(h.render(), 'toggle-whitelist').props.onClick();
  assert.equal(h.getValue().strictAllowlist, false);
  assert.deepEqual(h.getValue().allowedModels, []);
  assert.equal(swarm.isSwarmModelAllowed(h.getValue(), 'vendor/model-a'), true);
});

test('严格白名单：保存失败时开关不得显示为已切换，并保留 error 提示', async () => {
  const h = createPermissionsSectionHarness({
    models: [...RULE_MODELS],
    failKeys: ['strictAllowlist'],
  });
  const tree = h.render();
  const result = await nodeByAction(tree, 'toggle-whitelist').props.onClick();

  assert.equal(result, false, '保存失败必须返回 false');
  assert.deepEqual(h.writes, [['strictAllowlist', true]], '第一步失败后不得继续写白名单');
  assert.equal(h.getValue().strictAllowlist, false, '持久化快照不得被改动');
  assert.deepEqual(h.getValue().allowedModels, []);

  const after = h.render();
  assert.equal(
    nodeByAction(after, 'toggle-whitelist').props['aria-checked'],
    'false',
    '开关不得停留在未保存的开启态'
  );
  const notice = flattenTree(after).find((n) => n.props && n.props['data-role'] === 'notice');
  assert.deepEqual(notice.children, ['error'], '必须提示保存失败');
  assert.equal(notice.props.role, 'alert');
});

test('严格白名单：legacy 仅靠 allowedModels 激活时，清空最后一项会先钉住 strictAllowlist', async () => {
  const h = createPermissionsSectionHarness({
    initialValue: { strictAllowlist: false, allowedModels: ['vendor/model-a'] },
    models: [...RULE_MODELS],
  });
  const tree = h.render();
  assert.equal(
    nodeByAction(tree, 'toggle-whitelist').props['aria-checked'],
    'true',
    '白名单非空时界面同样视为严格模式'
  );

  const boxes = flattenTree(tree).filter((n) => n.props && n.props['data-action'] === 'toggle-model');
  await boxes[0].props.onChange({ target: { checked: false } });

  assert.deepEqual(h.writes.map(([key]) => key), ['strictAllowlist', 'allowedModels']);
  assert.equal(h.writes[0][1], true, '必须先把严格开关落盘，再清空白名单');
  assert.deepEqual(h.writes.at(-1), ['allowedModels', []]);
  assert.equal(h.getValue().strictAllowlist, true);
  assert.equal(swarm.isSwarmModelAllowed(h.getValue(), 'vendor/model-a'), false);
  assert.equal(swarm.isSwarmModelAllowed(h.getValue(), 'other/model-x'), false);
});

test('模型派发权限：默认配置、工具 Schema 与提示词零私人模型硬编码', () => {
  assert.deepEqual([...swarm.SWARM_CONFIG_DEFAULTS.allowedModels], []);
  assert.deepEqual([...swarm.SWARM_CONFIG_DEFAULTS.blockedModels], []);
  assert.equal(swarm.isSwarmModelAllowed(swarm.SWARM_CONFIG_DEFAULTS, 'unknown/model'), true);

  const controller = Object.create(swarm.SwarmHostController.prototype);
  controller.config = {};
  controller.ctx = null;
  const built = swarm.createSwarmTools(controller);
  const serialized = JSON.stringify(built);
  for (const banned of [['agy', 'argon'].join('/'), ['agy', 'sonnet'].join('/'), 'gpt-' + 'oss', 'deepseek' + '-v4-pro']) {
    assert.ok(!serialized.includes(banned), '工具 Schema 不得硬编码模型名：' + banned);
  }
  assert.ok(
    serialized.includes('Swarm model-dispatch settings'),
    'model 参数说明必须提示派发权限闸门'
  );

  // 提示词：没有任何外部模型路由写法，也没有任何具体模型名
  const native = prompts.COORDINATOR_SKILL_CONTENT;
  assert.ok(!native.includes(['agy', '/'].join('')), '原生协调员规范不得出现外部路由写法');
  const worker = prompts.buildWorkerSystemPrompt({ memberName: 'w', coordinatorSessionId: 'c' });
  for (const banned of [['agy', 'argon'].join('/'), ['agy', 'sonnet'].join('/')]) {
    assert.ok(!native.includes(banned) && !worker.includes(banned));
  }

  // 设置页文案同样不得夹带任何私人模型名
  const dictSource = fs.readFileSync(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  for (const banned of [['agy', 'argon'].join('/'), ['agy', 'sonnet'].join('/'), 'gpt-' + 'oss']) {
    assert.ok(!dictSource.includes(banned), '设置页文案不得出现 ' + banned);
  }
  assert.ok(
    fs.readFileSync(path.join(PLUGIN_ROOT, 'index.js'), 'utf8').includes('模型派发权限控制'),
    'Host 拦截错误必须指向设置页入口'
  );
});

/* ---- 回归：宿主一元 Remote 的 { ok, value } 信封 ----------------------- */

/**
 * 真实宿主 @deepseek-ai/dsh-api-gateway 的一元 Remote 调用在**成功**时返回
 * { ok: true, value: payload }（失败时 { ok: false, error }）。
 * 设置页曾经把整封响应直接交给 parseSwarmModelsResult，于是
 * Array.isArray(response.models) 永远为假，设置页固定报
 * 「未能读取宿主模型列表」——本用例锁死解包行为。
 */
test('设置页：宿主 { ok: true, value } 信封必须先解包，否则报 models must be an array', async () => {
  const envelopeModels = [
    { key: 'vendor/model-a', provider: 'vendor', model: 'model-a', name: 'A', backend: 'dsh', allowed: true, blocked: false },
    { key: 'vendor/model-b', provider: 'vendor', model: 'model-b', name: 'B', backend: 'dsh', allowed: true, blocked: false },
  ];

  // 1) 纯函数层：带信封的响应直接过校验必然失败，解包后才通过
  assert.throws(
    () => clientMod.parseSwarmModelsResult({ ok: true, value: { models: envelopeModels } }),
    /models must be an array/,
    '未解包的信封必须复现原始故障'
  );
  assert.deepEqual(clientMod.unwrapRemoteResult({ ok: true, value: { models: envelopeModels } }), { models: envelopeModels });
  assert.equal(clientMod.unwrapRemoteResult(envelopeModels), envelopeModels, '裸结果（Fallback 服务）必须原样透传');
  assert.equal(clientMod.unwrapRemoteResult({ ok: false, error: { message: 'boom' } }).ok, false, '失败信封保持原样，交给错误分支');
  assert.equal(clientMod.unwrapRemoteResult(undefined), undefined);
  assert.deepEqual(
    clientMod.parseSwarmModelsResult(clientMod.unwrapRemoteResult({ ok: true, value: { models: envelopeModels } })).models.map((m) => m.key),
    ['vendor/model-a', 'vendor/model-b']
  );

  // 2) 插件层：把真实信封塞给 api.getSwarmModels，设置页 loadModels() 必须拿到全量模型
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
  const calls = [];
  const api = {
    async getSwarmModels(request) {
      calls.push(request);
      return { ok: true, value: { models: envelopeModels } };
    },
    async getSwarmSnapshot() {
      throw new Error('本用例不应拉取快照');
    },
  };
  const settings = [];
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
      get: (id) => ({
        namespace: id,
        getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
        subscribe: () => () => {},
        set: () => true,
      }),
      whileServed(namespaces, register) {
        const off = register(new Set([clientMod.SWARM_SETTINGS_ID]));
        return () => {
          if (typeof off === 'function') off();
        };
      },
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    'dsh-swarm': api,
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
  const plugin = new clientMod.SwarmClientPlugin(ctx, { React: mockReact });
  try {
    assert.equal(settings.length, 1, '设置页必须挂载');
    const injected = settings[0].spec.inject();
    assert.equal(typeof injected.loadModels, 'function');
    const list = await injected.loadModels();
    assert.deepEqual(list.map((m) => m.key), ['vendor/model-a', 'vendor/model-b'], '解包后必须返回全量宿主模型目录');
    assert.deepEqual(calls, [{}], '模型目录拉取只发空请求体');
  } finally {
    await plugin.dispose();
  }

  // 3) 仍然失败时：status 只显示本地化摘要，真实原因保留在 tooltip（modelsError）
  const findStatus = (tree) => flattenTree(tree).find((n) => n.props && n.props['data-role'] === 'models-status');
  /**
   * 每个组件一份独立的 hook 槽位（共享槽位会让上一个组件的失败态串味），
   * useEffect 同步触发、promise 在下一拍落地，然后重渲染读状态。
   */
  const makeSectionHarness = (loadModels) => {
    const hookValues = [];
    let hookIndex = 0;
    const React = {
      ...mockReact,
      useEffect: (fn) => {
        try {
          fn();
        } catch {
          // ignore
        }
      },
      useState: (init) => {
        const slot = hookIndex++;
        if (!(slot in hookValues)) hookValues[slot] = typeof init === 'function' ? init() : init;
        return [
          hookValues[slot],
          (next) => {
            hookValues[slot] = typeof next === 'function' ? next(hookValues[slot]) : next;
          },
        ];
      },
    };
    const form = {
      getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
      subscribe: () => () => {},
      set: () => true,
    };
    const Section = clientMod.createSwarmSettingsSection(React, React.createElement);
    return {
      render: () => {
        hookIndex = 0;
        return Section({ form, t: (key) => key, loadModels });
      },
    };
  };

  const failing = makeSectionHarness(async () => {
    throw new Error('dsh-swarm invalid models response: models must be an array');
  });
  failing.render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failedStatus = findStatus(failing.render());
  assert.ok(failedStatus, '必须有模型目录状态行');
  assert.deepEqual(failedStatus.children, ['modelsUnavailable'], '失败时仍是本地化摘要文案');
  assert.match(String(failedStatus.props.title || ''), /models must be an array/, '真实原因必须放进 tooltip');
  assert.match(String(failedStatus.props['data-models-error'] || ''), /models must be an array/);
  assert.match(String(failedStatus.props.className || ''), /is-error/);

  // 拉取成功时不得残留错误提示（tooltip 与 is-error 都要清掉）
  const succeeding = makeSectionHarness(async () => envelopeModels);
  succeeding.render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const okStatus = findStatus(succeeding.render());
  assert.equal(okStatus.props.title, undefined, '无错时不得残留 tooltip');
  assert.equal(okStatus.props['data-models-error'], undefined);
  assert.ok(!String(okStatus.props.className || '').includes('is-error'));
});
