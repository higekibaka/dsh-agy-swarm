import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const protocol = require('../src/protocol.js');
const boardStoreMod = require('../src/board-store.js');
const promptsMod = require('../src/prompts.js');
const hostPlugin = require('../index.js');
const clientMod = require('../client.js');

const { BoardStore, SwarmStoreManager, parseMessageDoorbells, expandAddSpecs } = boardStoreMod;
const { SwarmHostController, createSwarmTools, buildBalancedForkSeed, apply: applyHostPlugin } = hostPlugin;

const DEFAULT_TMP_BASE = path.join(os.tmpdir(), 'dsh-swarm-tests');
const TMP_BASE = process.env.SWARM_TEST_TMP || DEFAULT_TMP_BASE;
fs.mkdirSync(TMP_BASE, { recursive: true });

function makeTempDir(prefix = 'dsh-swarm-test-') {
  return fs.mkdtempSync(path.join(TMP_BASE, prefix));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1500, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await delay(5);
  }
  throw new Error('timed out waiting for ' + label);
}

/**
 * Host-shaped mock environment.
 *
 * workingDirectory.get() is STRICT about its Session argument, approvals and
 * policy services mirror the host seams, and create/resume can be gated so
 * cancellation races are deterministic.
 */
function createMockHostEnv(baseDir, coordCwd = process.cwd(), options = {}) {
  const registeredTools = new Map();
  const registeredCommands = new Map();
  const registeredSkills = new Map();
  const typertRegistrations = [];
  const providedServices = new Map();
  const eventListeners = new Map();
  const disposers = [];
  // Host-level (single) registrations: one systemPrompt section set + the
  // fake worktree service every `workspace:"share"` add must delegate to.
  const promptSections = [];
  const worktreeCreateCalls = [];

  const sessionsMap = new Map();
  const agentsMap = new Map();
  const resumeCalls = [];
  const createCalls = [];
  // Filled once the host ctx exists; an agent-scoped ctx resolves services
  // through the parent scope in the real host, so the mock mirrors that.
  const serviceHost = { ctx: null };
  const env = {
    deferCreates: false,
    deferResumes: false,
    failResume: false,
    releaseCreateResolvers: [],
    releaseResumeResolvers: [],
    createCalls,
    resumeCalls,
    registeredTools,
    // Pathological-filesystem + lifecycle gates for the regression suite.
    failSessionAppend: false,
    deferDispose: false,
    releaseDisposeResolvers: [],
    deferModelCatalog: options.deferModelCatalog === true,
    releaseModelCatalogResolvers: [],
    modelCatalogStarted: false,
    presetComposeCalls: [],
    // `workspace:"share"` gates: fail the host worktree service on demand and
    // count every systemPrompt section the plugin registered at host level.
    failWorktreeCreate: options.failWorktreeCreate === true,
    worktreeCreateCalls,
    promptSections,
  };

  function requireSession(session, caller) {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.header) {
      throw new Error(caller + ' requires a Session instance (got ' + (session === null ? 'null' : typeof session) + ')');
    }
    return session;
  }

  function makeMockAgent(sessionId, opts = {}) {
    const appendedEvents = [];
    const followups = [];
    const modelSelections = [];
    let currentProvider = opts.provider || 'deepseek';
    let currentModel = opts.model || 'deepseek-chat';
    let currentEffort = opts.reasoningEffort || '';
    const seedEvents = Array.isArray(opts.seed) ? [...opts.seed] : [];

    const header = {
      id: sessionId,
      createdAt: Date.now(),
      cwd: opts.cwd || coordCwd,
      ...(Number.isInteger(opts.delegationDepth) ? { delegationDepth: opts.delegationDepth } : {}),
      ...(opts.agentPreset ? { agentPreset: opts.agentPreset } : {}),
    };
    const session = {
      id: sessionId,
      header,
      append(type, data) {
        if (opts.failAppend || env.failSessionAppend) {
          const err = new Error('ENOSPC: no space left on device, write');
          err.code = 'ENOSPC';
          throw err;
        }
        const ev = { seq: seedEvents.length + appendedEvents.length, type, data };
        appendedEvents.push(ev);
        return ev;
      },
      snapshotEvents() {
        return [...seedEvents, ...appendedEvents];
      },
      requestHeader() {
        return { config: { provider: currentProvider, model: currentModel } };
      },
    };

    const scopedTools = new Map();
    const promptSections = [];
    const presetMounts = [];
    const childListeners = [];

    const childCtx = {
      tools: {
        register(tool, regOpts) {
          scopedTools.set(tool.name, { tool, opts: regOpts });
          return () => scopedTools.delete(tool.name);
        },
      },
      systemPrompt: {
        section(sec) {
          promptSections.push(sec);
          return () => {};
        },
      },
      workingDirectory: {
        get(sessionArg) {
          const target = requireSession(sessionArg, 'workingDirectory.get');
          return target.header.cwd || coordCwd;
        },
        async set(agentArg, nextCwd) {
          if (!agentArg || !agentArg.session || !agentArg.session.header) {
            throw new Error('workingDirectory.set requires an Agent with a Session');
          }
          agentArg.session.header.cwd = nextCwd;
        },
      },
      agentPresets: {
        async mount(ctxArg, presetId) {
          presetMounts.push(presetId);
          return presetId;
        },
        ...(options.presets?.composeFrom === true
          ? {
              composeFrom(ctxArg, parentCtxArg) {
                env.presetComposeCalls.push({ child: ctxArg, parent: parentCtxArg });
              },
            }
          : {}),
      },
      on(eventName, handler) {
        childListeners.push({ eventName, handler });
        return () => {};
      },
      get(name) {
        if (this[name] !== undefined) return this[name];
        return serviceHost.ctx?.get?.(name);
      },
    };

    const injectedNextStep = [];
    const agent = {
      id: sessionId,
      status: opts.status || 'idle',
      session,
      ctx: childCtx,
      // Host reads max(header.delegationDepth, options.subagentDepth).
      options: Number.isInteger(opts.subagentDepth) ? { subagentDepth: opts.subagentDepth } : {},
      inbox: { size: 0, nextTurn: [], nextStep: injectedNextStep },
      model: {
        get current() {
          return {
            provider: currentProvider,
            model: currentModel,
            reasoningEffort: currentEffort,
          };
        },
        select(next) {
          currentProvider = next.provider;
          currentModel = next.model;
          currentEffort = next.reasoningEffort || '';
          modelSelections.push({ ...next });
        },
      },
      followup(msg) {
        followups.push(msg);
      },
      inject(msg) {
        injectedNextStep.push(msg);
      },
      cancel(reason) {
        agent.cancelledWith = reason;
        agent.status = 'idle';
      },
      _debug: {
        appendedEvents,
        followups,
        injectedNextStep,
        modelSelections,
        scopedTools,
        promptSections,
        presetMounts,
        childListeners,
        getAssignedCwd: () => session.header.cwd,
      },
    };

    sessionsMap.set(sessionId, session);
    agentsMap.set(sessionId, agent);
    return agent;
  }

  const coordinatorAgent = makeMockAgent(options.coordinatorSessionId || 'coord-session-001', {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
    cwd: coordCwd,
    delegationDepth: Number.isInteger(options.coordinatorDepth) ? options.coordinatorDepth : 0,
    agentPreset: options.coordinatorPreset || '',
    ...(Number.isInteger(options.coordinatorSubagentDepth)
      ? { subagentDepth: options.coordinatorSubagentDepth }
      : {}),
    ...(Array.isArray(options.coordinatorSeed) ? { seed: options.coordinatorSeed } : {}),
  });

  const ctx = {
    root: {
      reflect: { props: {} },
      accessor(name, desc) {
        this.reflect.props[name] = desc;
      },
    },
    reflect: {
      provide(name, value) {
        providedServices.set(name, value);
      },
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') disposers.push(cleanup);
    },
    inject(deps, cb) {
      cb(ctx);
    },
    on(eventName, handler) {
      const list = eventListeners.get(eventName) || [];
      list.push(handler);
      eventListeners.set(eventName, list);
      return () => {};
    },
    once() {},
    async emit(eventName, ...args) {
      const results = [];
      for (const fn of eventListeners.get(eventName) || []) {
        results.push(await fn(...args));
      }
      return results;
    },
    /** Emit with an explicit listener `this` (host scope-carrier contract). */
    async emitWithThis(eventName, thisArg, ...args) {
      const results = [];
      for (const fn of eventListeners.get(eventName) || []) {
        results.push(await fn.apply(thisArg, args));
      }
      return results;
    },
    get(name) {
      return this[name] ?? providedServices.get(name);
    },
    tools: {
      register(tool, opts) {
        registeredTools.set(tool.name, { tool, opts });
        return () => registeredTools.delete(tool.name);
      },
    },
    commands: {
      register(def) {
        registeredCommands.set(def.name, def);
        return () => registeredCommands.delete(def.name);
      },
    },
    skills: {
      register(def) {
        const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
        if (!SKILL_NAME_RE.test(def.name)) {
          throw new Error('invalid skill name "' + def.name + '"');
        }
        if (!def.description || typeof def.description !== 'string') {
          throw new Error('skill "' + def.name + '" requires a description');
        }
        const normalized = {
          ...def,
          invocation: def.invocation ?? { modelInvocable: true, userInvocable: true },
          provider: def.provider ?? 'runtime',
        };
        registeredSkills.set(def.name, normalized);
        return () => registeredSkills.delete(def.name);
      },
      async get(name) {
        const def = registeredSkills.get(name);
        if (!def) return undefined;
        // Mirror @deepseek-ai/dsh-skill validateDefinition()
        if (typeof def.name !== 'string') throw new TypeError('loaded skill name must be a string');
        if (typeof def.description !== 'string') throw new TypeError(`loaded skill "${name}" description must be a string`);
        if (typeof def.source !== 'string') throw new TypeError(`loaded skill "${name}" source must be a string`);
        if (typeof def.provider !== 'string') throw new TypeError(`loaded skill "${name}" provider must be a string`);
        if (typeof def.content !== 'string') throw new TypeError(`loaded skill "${name}" content must be a string`);
        return def;
      },
    },
    typert: {
      register(desc) {
        typertRegistrations.push(desc);
        return () => {};
      },
    },
    llm: {
      async listProviders() {
        if (env.deferModelCatalog) {
          env.modelCatalogStarted = true;
          await new Promise((resolve) => env.releaseModelCatalogResolvers.push(resolve));
        }
        return ['deepseek', 'anthropic'];
      },
      async listModels(provider) {
        if (provider === 'deepseek') {
          return [
            { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
            { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          ];
        }
        return [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }];
      },
    },
    workingDirectory: {
      get(sessionArg) {
        return requireSession(sessionArg, 'ctx.workingDirectory.get').header.cwd || coordCwd;
      },
      async set(agentArg, nextCwd) {
        if (!agentArg || !agentArg.session || !agentArg.session.header) {
          throw new Error('ctx.workingDirectory.set requires an Agent');
        }
        agentArg.session.header.cwd = nextCwd;
      },
    },
    // Host-level systemPrompt service: the plugin must register ONE section and
    // resolve the calling agent per turn.
    systemPrompt: {
      section(sec) {
        promptSections.push(sec);
        return () => {};
      },
    },
    // Host-native worktree service. Contract: it switches the PASSED agent's cwd
    // and appends `plugin:worktree/created` on that agent's own session.
    worktrees: {
      async create(agentArg, wtOptions = {}, signal) {
        worktreeCreateCalls.push({ agent: agentArg, name: wtOptions?.name, signal });
        if (env.failWorktreeCreate) {
          throw new Error('mock worktree create failed: (git) fatal: cannot lock worktree');
        }
        if (!agentArg || !agentArg.session || !agentArg.session.header) {
          throw new Error('ctx.worktrees.create requires an Agent');
        }
        const wtPath = path.join(coordCwd, '.agents', 'worktrees', String(wtOptions?.name || 'worktree'));
        await ctx.workingDirectory.set(agentArg, wtPath, signal);
        agentArg.session.append('plugin:worktree/created', {
          path: wtPath,
          branch: wtOptions?.name || '',
        });
        return {
          path: wtPath,
          branch: wtOptions?.name || '',
          baseCommit: '0'.repeat(40),
          repositoryRoot: coordCwd,
        };
      },
    },
    sessions: {
      get: (id) => sessionsMap.get(id),
    },
    agents: {
      get: (id) => agentsMap.get(id),
      async create(createOptions) {
        createCalls.push(createOptions);
        if (env.deferCreates) {
          await new Promise((resolve) => env.releaseCreateResolvers.push(resolve));
        }
        const child = makeMockAgent(createOptions.sessionId, {
          provider: createOptions.agentOptions?.provider,
          model: createOptions.agentOptions?.model,
          reasoningEffort: createOptions.agentOptions?.reasoningEffort,
          cwd: createOptions.meta?.cwd || coordCwd,
          seed: createOptions.seed,
          delegationDepth: createOptions.meta?.delegationDepth,
          agentPreset: createOptions.meta?.agentPreset,
          subagentDepth: createOptions.agentOptions?.subagentDepth,
        });
        if (typeof createOptions.setup === 'function') {
          await createOptions.setup(child.ctx, child);
        }
        let handleDisposed = false;
        const handle = {
          agent: child,
          get disposed() {
            return handleDisposed;
          },
          async dispose() {
            if (env.deferDispose) {
              await new Promise((resolve) => env.releaseDisposeResolvers.push(resolve));
            }
            handleDisposed = true;
            env.lastLateDisposed = child.id;
            agentsMap.delete(createOptions.sessionId);
          },
        };
        env.lastCreateHandle = handle;
        return handle;
      },
      async resume(resumeOptions) {
        resumeCalls.push(resumeOptions);
        if (env.deferResumes) {
          await new Promise((resolve) => env.releaseResumeResolvers.push(resolve));
        }
        if (env.failResume) {
          throw new Error('mock resume failure: cold session unavailable');
        }
        // A real cold resume rebuilds the Agent from the persisted session
        // header, so the mock must preserve the recorded delegation depth.
        const previous = sessionsMap.get(resumeOptions.resumeSessionId);
        const inheritedDepth = previous?.header?.delegationDepth;
        const inheritedPreset = previous?.header?.agentPreset;
        const child = makeMockAgent(resumeOptions.resumeSessionId, {
          provider: env.resumeIgnoresRoute ? 'deepseek' : resumeOptions.agentOptions?.provider,
          model: env.resumeIgnoresRoute ? 'deepseek-chat' : resumeOptions.agentOptions?.model,
          reasoningEffort: env.resumeIgnoresRoute
            ? 'low'
            : resumeOptions.agentOptions?.reasoningEffort,
          delegationDepth: Number.isInteger(inheritedDepth) ? inheritedDepth : 0,
          ...(inheritedPreset ? { agentPreset: inheritedPreset } : {}),
          subagentDepth: resumeOptions.agentOptions?.subagentDepth,
        });
        if (typeof resumeOptions.setup === 'function') {
          await resumeOptions.setup(child.ctx, child);
        }
        let handleDisposed = false;
        const handle = {
          agent: child,
          get disposed() {
            return handleDisposed;
          },
          async dispose() {
            if (env.deferDispose) {
              await new Promise((resolve) => env.releaseDisposeResolvers.push(resolve));
            }
            handleDisposed = true;
            agentsMap.delete(resumeOptions.resumeSessionId);
          },
        };
        env.lastResumeHandle = handle;
        return handle;
      },
    },
    sessionController: {
      async resolveAgent(id) {
        return { agent: agentsMap.get(id) };
      },
      async selectModel() {
        throw new Error('host sessionController.selectModel must not be used for cold members');
      },
    },
  };

  if (options.sandboxMode !== undefined || options.defaultSandboxMode !== undefined) {
    ctx.sandboxPolicy = {
      ...(options.defaultSandboxMode !== undefined
        ? { defaultMode: options.defaultSandboxMode }
        : {}),
      overrideOf(sessionArg) {
        requireSession(sessionArg, 'sandboxPolicy.overrideOf');
        return options.sandboxMode;
      },
      ...(options.resolveSandboxMode !== undefined
        ? {
            resolve(arg) {
              requireSession(arg?.session, 'sandboxPolicy.resolve');
              return { mode: options.resolveSandboxMode };
            },
          }
        : {}),
    };
  }
  if (options.agentPresets) {
    ctx.agentPresets = {
      ...(typeof options.agentPresets.composedPreset === 'function'
        ? { composedPreset: options.agentPresets.composedPreset }
        : {}),
      ...(typeof options.agentPresets.mount === 'function'
        ? { mount: options.agentPresets.mount }
        : {}),
      ...(typeof options.agentPresets.composeFrom === 'function'
        ? { composeFrom: options.agentPresets.composeFrom }
        : {}),
    };
  }
  if (options.permissionPreset !== undefined) {
    ctx.permissionPresets = {
      current(sessionArg) {
        requireSession(sessionArg, 'permissionPresets.current');
        return options.permissionPreset;
      },
    };
  }
  if (options.withApproval === true) {
    ctx.approval = { request: async () => ({ approved: false }) };
  }

  serviceHost.ctx = ctx;
  const mounted = applyHostPlugin(ctx, { baseDir, ...(options.pluginConfig || {}) });

  return {
    ctx,
    env,
    coordinatorAgent,
    registeredTools,
    registeredCommands,
    registeredSkills,
    typertRegistrations,
    providedServices,
    sessionsMap,
    agentsMap,
    createCalls,
    resumeCalls,
    promptSections,
    worktreeCreateCalls,
    mounted,
    async disposeAll() {
      for (const fn of disposers.splice(0).reverse()) {
        await fn();
      }
      await mounted.controller.dispose();
    },
  };
}


test('1. Manifest, locale metadata, and Host <-> Client protocol parity (%ZZ safety)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-agy-swarm');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh?.client?.inject));
  assert.equal(pkg.dsh?.client?.immediately, true);
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  // The invalid nested dsh.engines block must be gone; engines lives at the top.
  assert.equal(pkg.dsh?.engines, undefined);
  assert.equal(pkg.engines?.dsh, '>=0.2.2-rc.1');
  assert.equal(pkg.engines?.node, '^22.19.0 || >=24.0.0');
  assert.match(pkg.scripts?.check || '', /client\.js/);
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'], './client.js');

  for (const rel of [
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'locale/zh-CN.json',
    'locale/en-US.json',
    'locale/en.json',
    'locale/zh.json',
  ]) {
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, rel)), 'missing ' + rel);
  }
  const zhCn = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'locale/zh-CN.json'), 'utf8'));
  const enUs = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'locale/en-US.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'locale/zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'locale/en.json'), 'utf8'));
  assert.deepEqual(zh, zhCn, 'locale/zh.json must mirror zh-CN');
  assert.deepEqual(en, enUs, 'locale/en.json must mirror en-US');
  assert.ok(Object.keys(zh).length > 0 && Object.keys(en).length > 0);

  // Strict Host <-> Client constant & Typert descriptor parity
  assert.equal(protocol.PLUGIN_ID, clientMod.PLUGIN_ID);
  assert.equal(protocol.SWARM_SERVICE_NAME, clientMod.SWARM_SERVICE_NAME);
  assert.equal(protocol.SWARM_TYPERT_PACKAGE, clientMod.SWARM_TYPERT_PACKAGE);
  assert.equal(protocol.SWARM_RESOURCE_PROTOCOL, clientMod.SWARM_RESOURCE_PROTOCOL);
  assert.equal(protocol.SWARM_RESOURCE_PREFIX, clientMod.SWARM_RESOURCE_PREFIX);
  assert.equal(protocol.SWARM_PANE_ID, clientMod.SWARM_PANE_ID);
  assert.deepEqual(protocol.SWARM_TABS, clientMod.SWARM_TABS);
  assert.deepEqual(protocol.SWARM_METHODS, clientMod.SWARM_METHODS);

  assert.equal(protocol.SWARM_REMOTE.package, clientMod.SWARM_REMOTE.package);
  // Host 与 Client 两边的 Typert 方法表必须逐条对齐（含设置页用的 getSwarmModels）。
  assert.deepEqual(
    protocol.SWARM_METHODS,
    ['getSwarmSnapshot', 'watchSwarm', 'getSwarmModels'],
    'SWARM_METHODS 必须包含 getSwarmModels'
  );
  assert.equal(protocol.SWARM_REMOTE.descriptors.length, protocol.SWARM_METHODS.length);
  for (let i = 0; i < protocol.SWARM_REMOTE.descriptors.length; i++) {
    const h = protocol.SWARM_REMOTE.descriptors[i];
    const c = clientMod.SWARM_REMOTE.descriptors[i];
    assert.equal(h.id, c.id);
    assert.equal(h.service, c.service);
    assert.equal(h.namespace, c.namespace);
    assert.equal(h.method, c.method);
    assert.equal(h.mode, c.mode);
    assert.deepEqual(h.cancellation, c.cancellation);
    assert.deepEqual(h.invocation, c.invocation);
  }
  const modelsDescriptor = protocol.SWARM_REMOTE.descriptors.find((d) => d.method === 'getSwarmModels');
  assert.ok(modelsDescriptor, '必须注册 getSwarmModels 描述符');
  assert.equal(modelsDescriptor.mode, undefined, 'getSwarmModels 不是流式方法');

  // Resource URI roundtrip & malformed input safety
  const graphUri = protocol.buildSwarmResourceUri('sess_abc-123', 'graph');
  assert.equal(graphUri, 'dsh-resource://swarm/sess_abc-123?tab=graph');
  assert.deepEqual(protocol.parseSwarmResourceUri(graphUri), {
    sessionId: 'sess_abc-123',
    tab: 'graph',
  });
  const clientParsed = clientMod.parseSwarmResourceUri('dsh-resource://swarm/sess_abc-123');
  assert.equal(clientParsed?.sessionId, 'sess_abc-123');
  assert.ok(!clientParsed?.tab);
  assert.equal(protocol.parseSwarmResourceUri('https://example.com'), null);

  // Malformed percent escapes must never throw on either side of the wire.
  assert.equal(protocol.parseSwarmResourceUri('dsh-resource://swarm/%ZZ'), null);
  assert.equal(clientMod.parseSwarmResourceUri('dsh-resource://swarm/%ZZ'), null);
  assert.equal(clientMod.parseSwarmResourceUri('dsh-resource://swarm/%E0%A4%A'), null);

  // Shared session-id whitelist: 1..160 chars, [A-Za-z0-9._:-], alnum first.
  assert.equal(protocol.isValidSessionId('swarm-child-1'), true);
  assert.equal(clientMod.isValidSessionId('swarm-child-1'), true);
  assert.equal(protocol.isValidSessionId('a'.repeat(161)), false);
  assert.equal(clientMod.isValidSessionId('a'.repeat(161)), false);
  assert.equal(protocol.isValidSessionId('bad id'), false);
  assert.equal(clientMod.isValidSessionId('bad id'), false);
  assert.equal(clientMod.isValidSessionId(''), false);
  assert.equal(
    protocol.parseSwarmResourceUri('dsh-resource://swarm/' + 'a'.repeat(161)),
    null
  );
  assert.equal(
    clientMod.parseSwarmResourceUri('dsh-resource://swarm/' + 'a'.repeat(161)),
    null
  );

  assert.throws(() => protocol.parseSwarmRequest('getSwarmSnapshot', { sessionId: '' }), TypeError);
  assert.throws(
    () => protocol.parseSwarmRequest('getSwarmSnapshot', { sessionId: 'ok', extra: 1 }),
    TypeError
  );
  assert.throws(() => clientMod.parseSwarmRequest({ sessionId: 'a'.repeat(200) }), /sessionId/);

  const norm = protocol.normalizeSwarmSnapshot({
    hasSwarm: true,
    coordinatorSessionId: 'coord-1',
    members: [{ name: 'w1', killed: true, activity: 'stale tool' }],
  });
  assert.equal(norm.members[0].state, 'killed');
  assert.equal(norm.members[0].activity, '');
  assert.deepEqual(norm, JSON.parse(JSON.stringify(norm)));
});

test('2. BoardStore #seq, channels, doorbell routing, archived-channel reopen ACL, cold restart', () => {
  const tmpDir = makeTempDir();
  const store = new BoardStore('coord-100', { baseDir: tmpDir });
  try {
    store.ensureCoordinator({ provider: 'deepseek', model: 'deepseek-chat', cwd: tmpDir });

    // Reserved names & invalid names rejected
    assert.throws(() => expandAddSpecs({ name: 'all', brief: 'bad' }), /保留/);
    assert.throws(() => expandAddSpecs({ name: 'coordinator', brief: 'bad' }), /保留/);
    assert.throws(() => expandAddSpecs({ name: 'BadUpper', brief: 'bad' }), /不合法|非法/);
    assert.throws(
      () =>
        expandAddSpecs({
          name: 'shard',
          tasks: Array.from({ length: 65 }, (_, i) => 'task-' + i),
        }),
      /64/
    );
    assert.equal(
      expandAddSpecs({
        name: 'shard',
        tasks: Array.from({ length: 64 }, (_, i) => 'task-' + i),
      }).length,
      64
    );

    store.registerMember({ name: 'reviewer-1', sessionId: 's-r1', addedBy: 'coordinator' });
    store.registerMember({ name: 'reviewer-2', sessionId: 's-r2', addedBy: 'coordinator' });
    store.registerMember({ name: 'api-dev', sessionId: 's-api', addedBy: 'coordinator' });
    store.registerMember({ name: 'monitor', sessionId: 's-mon', addedBy: 'coordinator' });

    assert.equal(store.prepareWait('reviewer-1', { since: 0, mentionsOnly: true }).action, 'park');
    assert.equal(store.prepareWait('reviewer-2', { since: 0, mentionsOnly: false }).action, 'park');
    assert.equal(store.prepareWait('api-dev', { since: 0, mentionsOnly: true }).action, 'park');
    assert.equal(store.prepareWait('monitor', { since: 0, mentionsOnly: true }).action, 'park');

    const p1 = store.postMessage('coordinator', 'general unaddressed note without doorbell');
    assert.equal(p1.message.seq, 1);
    assert.deepEqual(p1.wakeTargets.map((m) => m.name), ['reviewer-2']);

    store.prepareWait('reviewer-2', { since: 1, mentionsOnly: true });

    const p2 = store.postMessage('coordinator', '@reviewer please check #1');
    assert.equal(p2.message.seq, 2);
    assert.deepEqual(p2.wakeTargets.map((m) => m.name).sort(), ['reviewer-1', 'reviewer-2']);

    store.prepareWait('reviewer-1', { since: 2, mentionsOnly: true });
    store.prepareWait('reviewer-2', { since: 2, mentionsOnly: true });

    assert.throws(() => parseMessageDoorbells('hello @#main'), /@#main/);
    assert.throws(() => store.postMessage('coordinator', 'bad @#main broadcast'), /@#main/);

    store.manageChannel('coordinator', {
      channelAction: 'create',
      channel: 'backend',
      topic: 'Backend API work',
    });
    store.manageChannel('coordinator', {
      channelAction: 'subscribe',
      channel: 'backend',
      member: 'api-dev',
    });
    assert.throws(
      () =>
        store.manageChannel('coordinator', {
          channelAction: 'unsubscribe',
          channel: 'main',
          member: 'api-dev',
        }),
      /main/
    );

    const p3 = store.postMessage('coordinator', '@#backend schema v2 landed', { channel: 'backend' });
    assert.equal(p3.message.seq, 3);
    assert.deepEqual(p3.wakeTargets.map((m) => m.name), ['api-dev']);

    const revRead = store.readBoard('reviewer-1', { since: 0 });
    assert.ok(!revRead.messages.some((m) => m.channel === 'backend'));
    const monRead = store.readBoard('monitor', { since: 0 });
    assert.ok(monRead.messages.some((m) => m.channel === 'backend'));

    store.prepareWait('api-dev', { since: 3, mentionsOnly: true });
    const p4 = store.postMessage('coordinator', '@all freeze interface for release');
    assert.deepEqual(p4.wakeTargets.map((m) => m.name).sort(), [
      'api-dev',
      'reviewer-1',
      'reviewer-2',
    ]);

    const paged = store.readBoard('coordinator', { since: 0, limit: 2 });
    assert.equal(paged.messages.length, 2);
    assert.equal(paged.has_more, true);
    assert.deepEqual(
      store.readBoard('coordinator', { seqs: [1, 3] }).messages.map((m) => m.seq),
      [1, 3]
    );

    // Archived channel: only the creator or coordinator may reopen it.
    store.manageChannel('api-dev', { channelAction: 'create', channel: 'worker-chan', topic: 'worker owned' });
    store.manageChannel('coordinator', { channelAction: 'archive', channel: 'worker-chan' });
    assert.throws(
      () => store.manageChannel('reviewer-1', { channelAction: 'create', channel: 'worker-chan' }),
      /权限|创建者/
    );
    assert.equal(
      store.manageChannel('api-dev', { channelAction: 'create', channel: 'worker-chan' }).status,
      'reopened'
    );
    store.manageChannel('coordinator', { channelAction: 'archive', channel: 'worker-chan' });
    assert.equal(
      store.manageChannel('coordinator', { channelAction: 'create', channel: 'worker-chan' }).status,
      'reopened'
    );

    store.manageChannel('coordinator', { channelAction: 'archive', channel: 'backend' });
    assert.throws(
      () => store.postMessage('coordinator', 'late post', { channel: 'backend' }),
      /归档|archived/i
    );

    store.markMemberKilled('coordinator', 'reviewer-2');

    const reloadedMgr = new SwarmStoreManager({ baseDir: tmpDir });
    try {
      const snapFromWorker = reloadedMgr.getSnapshotForSession('s-api');
      assert.equal(snapFromWorker.hasSwarm, true);
      assert.equal(snapFromWorker.coordinatorSessionId, 'coord-100');
      assert.equal(snapFromWorker.resolvedFromMember, 'api-dev');
      assert.equal(snapFromWorker.head, 4);

      const r1After = snapFromWorker.members.find((m) => m.name === 'reviewer-1');
      const r2After = snapFromWorker.members.find((m) => m.name === 'reviewer-2');
      assert.equal(r1After.state, 'stopped');
      assert.equal(r2After.state, 'killed');
      assert.equal(r2After.killed, true);
    } finally {
      reloadedMgr.dispose();
    }
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('3. Host lifecycle: dynamic visibility, v3 descriptor/catalog, cold resume, ACL, fork, model switch, monitor, Typert stream', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const {
      ctx,
      coordinatorAgent,
      registeredTools,
      registeredCommands,
      registeredSkills,
      typertRegistrations,
      providedServices,
      agentsMap,
      createCalls,
      resumeCalls,
      promptSections,
    } = env;

    // The Monitor tools are registered ONCE at host level (gated by `when`),
    // never per child ctx, so they appear in the host registry from boot.
    assert.deepEqual(
      [...registeredTools.keys()].sort(),
      ['manage_task', 'post_message', 'read_board', 'schedule', 'swarm', 'swarm_wait']
    );
    for (const [name, { tool }] of registeredTools) {
      assert.equal(
        tool.output?.schema?.additionalProperties,
        true,
        name + ' output.schema.additionalProperties must be true'
      );
    }
    assert.equal(registeredTools.get('read_board').tool.isConcurrencySafe({}), true);
    assert.equal(registeredTools.get('swarm').tool.isConcurrencySafe({}), false);
    assert.equal(registeredTools.get('post_message').tool.isConcurrencySafe({}), false);
    assert.equal(registeredTools.get('swarm_wait').tool.isConcurrencySafe({}), false);

    assert.ok(registeredSkills.has('swarm'));
    assert.ok(registeredSkills.has('swarm-monitor'));
    assert.equal(registeredSkills.get('swarm-monitor').invocation.userInvocable, false);
    assert.ok(registeredCommands.has('swarm'));
    assert.equal(typertRegistrations.length, 1);
    assert.match(promptsMod.COORDINATOR_SKILL_CONTENT, /wait: true/);
    assert.match(promptsMod.COORDINATOR_SKILL_CONTENT, /注意力路由/);

    const boardWhen = registeredTools.get('post_message').opts.when;
    assert.equal(boardWhen({ agent: coordinatorAgent }), false);

    const swarmTool = registeredTools.get('swarm').tool;
    const postTool = registeredTools.get('post_message').tool;
    const readTool = registeredTools.get('read_board').tool;
    const waitTool = registeredTools.get('swarm_wait').tool;
    assert.ok(
      Object.keys(swarmTool.parameters.properties).includes('wait'),
      'swarm tool must expose the wait convenience flag'
    );

    const remoteSvc = providedServices.get('dsh-swarm');
    assert.ok(remoteSvc, 'dsh-swarm remote service must be provided');
    const abortCtl = new AbortController();
    const streamSnapshots = [];
    const streamConsumer = (async () => {
      for await (const snap of remoteSvc.watchSwarm(
        { sessionId: coordinatorAgent.id },
        abortCtl.signal
      )) {
        streamSnapshots.push(snap);
        if (snap.hasSwarm && snap.members.length >= 3) {
          abortCtl.abort();
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 15));
    assert.equal(streamSnapshots[0]?.hasSwarm, false);

    const cmdRes = registeredCommands.get('swarm').handler({
      agent: coordinatorAgent,
      rawInput: 'Build full-stack feature',
      attachments: [],
    });
    assert.equal(cmdRes.kind, 'success');
    assert.equal(coordinatorAgent._debug.followups.length, 1);

    await swarmTool.execute(
      { action: 'title', title: 'Swarm Alpha Verification' },
      { agent: coordinatorAgent }
    );

    const addRes = await swarmTool.execute(
      { action: 'add', name: 'author', brief: 'Implement core module and report to @coordinator' },
      { agent: coordinatorAgent }
    );
    assert.equal(addRes.status, 'added');
    assert.equal(addRes.added[0].model, 'deepseek/deepseek-reasoner');
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].meta.origin, 'subagent');
    assert.equal(createCalls[0].meta.parentSession, coordinatorAgent.id);
    assert.equal(createCalls[0].meta.delegationDepth, 1, 'delegationDepth must be parent + 1');

    const authorSessionId = addRes.added[0].sessionId;
    assert.match(
      authorSessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'child session id must be a bare uuid'
    );
    const authorAgent = agentsMap.get(authorSessionId);
    assert.ok(authorAgent);

    // Host 0.2.2 continuable descriptor (v3) carrying the resolved model route.
    const descEv = authorAgent._debug.appendedEvents.find((e) => e.type === 'subagent/descriptor');
    assert.deepEqual(descEv?.data, {
      version: 3,
      mode: 'continuable',
      provider: 'spawn',
      label: 'author',
      agentProvider: 'deepseek',
      agentModel: 'deepseek-reasoner',
      agentReasoningEffort: 'high',
    });
    assert.deepEqual(Object.keys(descEv.data).sort(), [
      'agentModel',
      'agentProvider',
      'agentReasoningEffort',
      'label',
      'mode',
      'provider',
      'version',
    ]);

    // Parent-session catalog: v3 NAMED entry because "author" is a legal
    // host agent name (`/^[a-z][a-z0-9-]{0,31}$/`, not 'lead').
    const catEv = coordinatorAgent._debug.appendedEvents.find((e) => e.type === 'subagent/catalog');
    assert.equal(catEv?.data?.version, 3);
    assert.equal(catEv?.data?.childId, authorSessionId);
    assert.equal(catEv?.data?.mode, 'continuable');
    assert.equal(catEv?.data?.label, 'author');
    assert.equal(catEv?.data?.name, 'author');
    assert.ok(Number.isInteger(catEv?.data?.childCreatedAt));

    // An underscore name is legal for swarm but NOT a host agent name: the
    // catalog entry must degrade to a nameless v0 instead of failing the add.
    const underscoreAdd = await swarmTool.execute(
      { action: 'add', name: 'worker_1', brief: 'underscore name probe' },
      { agent: coordinatorAgent }
    );
    assert.equal(underscoreAdd.status, 'added');
    const underscoreCatalog = coordinatorAgent._debug.appendedEvents
      .filter((e) => e.type === 'subagent/catalog')
      .at(-1);
    assert.equal(underscoreCatalog?.data?.version, 0);
    assert.equal(underscoreCatalog?.data?.label, 'worker_1');
    assert.equal(Object.hasOwn(underscoreCatalog.data, 'name'), false);
    assert.equal(
      agentsMap.get(underscoreAdd.added[0].sessionId)._debug.appendedEvents.find(
        (e) => e.type === 'subagent/descriptor'
      ).data.label,
      'worker_1',
      'the descriptor label keeps the real swarm name'
    );

    assert.equal(boardWhen({ agent: coordinatorAgent }), true);
    assert.equal(boardWhen({ agent: authorAgent }), true);

    await postTool.execute(
      { text: '@author extra constraint before you sleep' },
      { agent: coordinatorAgent }
    );
    let concluded = 0;
    const immediateWait = await waitTool.execute(
      { since: 1, mentions_only: true },
      { agent: authorAgent, concludeTurn: () => { concluded++; } }
    );
    assert.equal(immediateWait.status, 'woken_immediately');
    assert.equal(concluded, 0, 'must NOT concludeTurn when unread wake message already exists');

    const parkedWait = await waitTool.execute(
      { since: immediateWait.head, mentions_only: true },
      { agent: authorAgent, concludeTurn: () => { concluded++; } }
    );
    assert.equal(parkedWait.status, 'waiting');
    assert.equal(concluded, 1, 'must call concludeTurn exactly once when parking');

    env.mounted.controller.liveHandles.delete(authorSessionId);
    agentsMap.delete(authorSessionId);

    const wakePost = await postTool.execute(
      { text: '@author wake up from cold storage!' },
      { agent: coordinatorAgent }
    );
    assert.deepEqual(wakePost.woken, ['author']);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(resumeCalls.length, 1);
    assert.equal(resumeCalls[0].resumeSessionId, authorSessionId);
    const resumedAuthor = agentsMap.get(authorSessionId);
    assert.equal(resumedAuthor._debug.followups.length, 1);

    const subAdd = await swarmTool.execute(
      { action: 'add', name: 'sub-helper', brief: 'Assist @author' },
      { agent: resumedAuthor }
    );
    const subHelperAgent = agentsMap.get(subAdd.added[0].sessionId);
    assert.equal(createCalls.at(-1).meta.delegationDepth, 2, 'grandchild depth must increment');

    await streamConsumer;
    assert.ok(streamSnapshots.some((s) => s.hasSwarm && s.members.length >= 3));

    const peerAdd = await swarmTool.execute(
      { action: 'add', name: 'peer', brief: 'Independent slice for @coordinator' },
      { agent: coordinatorAgent }
    );
    const peerAgent = agentsMap.get(peerAdd.added[0].sessionId);

    await assert.rejects(
      () => swarmTool.execute({ action: 'title', title: 'Hijack' }, { agent: peerAgent }),
      /coordinator/i
    );
    await assert.rejects(
      () => swarmTool.execute({ action: 'kill', name: 'sub-helper' }, { agent: peerAgent }),
      /权限|只能|创建/
    );
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'model', name: 'sub-helper', model: 'deepseek/deepseek-chat' },
          { agent: peerAgent }
        ),
      /权限|只能|创建/
    );

    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'model', name: 'sub-helper', model: 'anthropic/claude-sonnet-4-5' },
          { agent: resumedAuthor }
        ),
      /working|waiting/i
    );
    await ctx.emit(
      'session/event',
      { id: subHelperAgent.id },
      { type: 'turn/end', data: { reason: { kind: 'error', error: new Error('429 Quota exceeded') } } }
    );
    const beforeSwitchFollowups = subHelperAgent._debug.followups.length;
    const switchRes = await swarmTool.execute(
      { action: 'model', name: 'sub-helper', model: 'anthropic/claude-sonnet-4-5' },
      { agent: resumedAuthor }
    );
    assert.equal(switchRes.status, 'switched');
    assert.equal(switchRes.model, 'anthropic/claude-sonnet-4-5');
    assert.equal(switchRes.pending_model_sync, false);
    assert.equal(subHelperAgent._debug.modelSelections.at(-1).provider, 'anthropic');
    assert.equal(
      subHelperAgent._debug.followups.length,
      beforeSwitchFollowups + 1,
      'switching model on errored worker must auto-resume it'
    );

    const modelsRes = await swarmTool.execute({ action: 'models', all: true }, { agent: coordinatorAgent });
    assert.equal(modelsRes.total_configured, 3);

    coordinatorAgent.session.append('turn/start', { turn: 1 });
    coordinatorAgent.session.append('step/start', { step: 1 });
    coordinatorAgent.session.append('tool/call', { callId: 'call_open_1', name: 'read_board', args: {} });

    const balanced = buildBalancedForkSeed(coordinatorAgent.session.snapshotEvents());
    assert.ok(balanced.seed.some((e) => e.type === 'tool/result' && e.data?.callId === 'call_open_1'));
    assert.equal(balanced.seed.at(-1).type, 'turn/end');

    // Fork is COORDINATOR-ONLY: `fork: true` and the compatible string
    // "coordinator" both seed from the caller's own history.
    for (const forkArg of [true, 'coordinator']) {
      const label = forkArg === true ? 'forked-bool' : 'forked-verifier';
      const forkAdd = await swarmTool.execute(
        { action: 'add', name: label, brief: 'Verify fork context', fork: forkArg },
        { agent: coordinatorAgent }
      );
      const forkedAgent = agentsMap.get(forkAdd.added[0].sessionId);
      const forkDesc = forkedAgent._debug.appendedEvents.find(
        (e) => e.type === 'subagent/descriptor'
      );
      assert.equal(forkDesc?.data?.mode, 'continuable');
      assert.equal(forkDesc?.data?.provider, 'fork', 'a fork descriptor says provider: fork');
      assert.equal(forkDesc?.data?.label, label);
      assert.ok(createCalls.at(-1).inheritedEventCount > 0);
      assert.ok(createCalls.at(-1).seed.some((e) => e.type === 'session/end-seed'));
    }

    // Cross-member fork is gone, and a non-coordinator may not fork at all.
    const createCountBeforeRejectedForks = createCalls.length;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'bad-fork', brief: 'x', fork: 'peer' },
          { agent: coordinatorAgent }
        ),
      /已移除跨成员分叉/
    );
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'peer-fork', brief: 'x', fork: true },
          { agent: peerAgent }
        ),
      /已移除跨成员分叉/
    );
    assert.equal(
      createCalls.length,
      createCountBeforeRejectedForks,
      'a rejected fork must never reach agents.create'
    );

    const killRes = await swarmTool.execute(
      { action: 'kill', name: 'author' },
      { agent: coordinatorAgent }
    );
    assert.equal(killRes.status, 'killed');
    assert.equal(boardWhen({ agent: resumedAuthor }), false);
    assert.equal(boardWhen({ agent: subHelperAgent }), true);

    const monAdd = await swarmTool.execute(
      { action: 'add', name: 'monitor', brief: 'You are monitor for stalled swarm checks' },
      { agent: coordinatorAgent }
    );
    const monAgent = agentsMap.get(monAdd.added[0].sessionId);

    // Host-level Monitor tools: one registration each, isolated by `when`.
    const scheduleTool = registeredTools.get('schedule').tool;
    const manageTaskTool = registeredTools.get('manage_task').tool;
    const monitorWhen = registeredTools.get('schedule').opts.when;
    assert.equal(registeredTools.get('manage_task').opts.when, monitorWhen);
    assert.equal(monitorWhen({ agent: monAgent }), true);
    assert.equal(monitorWhen({ agent: peerAgent }), false, 'non-monitor must not get schedule');
    assert.equal(monitorWhen({ agent: coordinatorAgent }), false);
    assert.equal(scheduleTool.output.schema.additionalProperties, true);
    assert.equal(manageTaskTool.output.schema.additionalProperties, true);
    // A non-monitor execution is refused rather than silently no-op'ing.
    await assert.rejects(
      () => manageTaskTool.execute({ Action: 'list' }, { agent: peerAgent }),
      /仅对活跃的 Swarm Monitor/
    );

    const monExec = (extra = {}) => ({ agent: monAgent, ...extra });
    const s1 = await scheduleTool.execute(
      { CronExpression: '*/3 * * * *', IsDaemon: true, Prompt: 'Check swarm' },
      monExec()
    );
    const s2 = await scheduleTool.execute(
      { DurationSeconds: 120, Prompt: 'One-shot check' },
      monExec()
    );
    await assert.rejects(
      () =>
        scheduleTool.execute(
          { CronExpression: '0 9 * * *', Prompt: 'complex calendar' },
          monExec()
        ),
      /复杂日历|不支持/
    );
    await assert.rejects(
      () =>
        scheduleTool.execute({ CronExpression: '*/0 * * * *', Prompt: 'zero step' }, monExec()),
      /1\.\.10080|步长/
    );
    await assert.rejects(
      () =>
        scheduleTool.execute(
          { CronExpression: '*/20000 * * * *', Prompt: 'too big' },
          monExec()
        ),
      /1\.\.10080|步长/
    );

    const listedBefore = await manageTaskTool.execute({ Action: 'list' }, monExec());
    assert.equal(listedBefore.tasks.length, 2);

    const killedOne = await manageTaskTool.execute({ Action: 'kill', TaskId: s2.TaskId }, monExec());
    assert.equal(killedOne.killed, true);

    await postTool.execute(
      { text: '[done] All slices verified and merged.' },
      { agent: coordinatorAgent }
    );
    const listedAfterDone = await manageTaskTool.execute({ Action: 'list' }, monExec());
    assert.equal(listedAfterDone.tasks.length, 0);

    const finalBoard = await readTool.execute({ status: true }, { agent: coordinatorAgent });
    assert.equal(finalBoard.title, 'Swarm Alpha Verification');
    assert.ok(s1.TaskId && s2.TaskId);

    // The host-level worker prompt section resolves the CALLER per turn.
    assert.equal(promptSections.length, 1, 'exactly one host-level worker prompt section');
    const workerPrompt = promptSections[0];
    assert.equal(workerPrompt.name, 'dsh-swarm-worker');
    assert.equal(workerPrompt.order, 850);
    assert.equal(workerPrompt.text({ agent: coordinatorAgent }), '');
    assert.equal(workerPrompt.text({}), '');
    assert.match(workerPrompt.text({ agent: peerAgent }), /^<swarm_worker>/);
    const peerPrompt = workerPrompt.text({ agent: peerAgent });
    assert.ok(
      peerPrompt.includes('你是 ' + '`peer`' + '（由 ' + '`@coordinator`' + ' 创建）'),
      'the brief must name this exact worker'
    );
    assert.ok(peerPrompt.includes(coordinatorAgent.id), 'the brief must carry the coordinator id');
    assert.match(workerPrompt.text({ agent: monAgent }), /Monitor 专属指令/);
    assert.equal(
      workerPrompt.text({ agent: authorAgent }),
      '',
      'a killed member must not keep its worker brief'
    );
    assert.equal(workerPrompt.text({ agent: resumedAuthor }), '');

    // Killing the monitor withdraws both the prompt and the Monitor tools.
    await swarmTool.execute({ action: 'kill', name: 'monitor' }, { agent: coordinatorAgent });
    assert.equal(monitorWhen({ agent: monAgent }), false);
    assert.equal(workerPrompt.text({ agent: monAgent }), '');
    assert.deepEqual(monitorWhen({}), false);
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('4. Host-native worktree: workspace:"share" delegates ctx.worktrees.create on the CHILD agent', async () => {
  const repoDir = makeTempDir('dsh-swarm-wt-');
  const storeDir = makeTempDir('dsh-swarm-wt-store-');
  const env = createMockHostEnv(storeDir, repoDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const controller = env.mounted.controller;
    const coordinatorCwdBefore = env.coordinatorAgent.session.header.cwd;
    assert.equal(coordinatorCwdBefore, repoDir);

    // (a) inherit touches nothing: no worktree service call at all.
    const addInherit = await swarmTool.execute(
      { action: 'add', name: 'plain-author', brief: 'stay in the shared tree' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(addInherit.added[0].workspace, 'inherit');
    assert.equal(addInherit.added[0].cwd, repoDir);
    assert.equal(env.worktreeCreateCalls.length, 0, 'inherit must not create a worktree');
    assert.equal(env.createCalls[0].meta.cwd, repoDir, 'the child starts in the caller cwd');

    // (b) share creates the worktree ON the freshly created child agent.
    const addShare = await swarmTool.execute(
      { action: 'add', name: 'wt-author', brief: 'Edit in worktree', workspace: 'share' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(addShare.added[0].workspace, 'share');
    const shareCwd = addShare.added[0].cwd;
    const shareSid = addShare.added[0].sessionId;
    const shareAgent = env.agentsMap.get(shareSid);
    assert.equal(env.worktreeCreateCalls.length, 1);
    const wtCall = env.worktreeCreateCalls[0];
    assert.notEqual(wtCall.agent, env.coordinatorAgent, 'never pass the caller agent');
    assert.equal(wtCall.agent, shareAgent, 'the worktree belongs to the new child agent');
    assert.match(
      String(wtCall.name),
      /^swarm-[0-9a-f]{8}-[a-z0-9_-]+-[0-9a-f]{4}$/,
      'the branch name is hashed and ref-safe'
    );
    assert.ok(String(wtCall.name).includes('wt-author'));
    assert.equal(shareCwd, path.join(repoDir, '.agents', 'worktrees', wtCall.name));
    assert.equal(shareAgent._debug.getAssignedCwd(), shareCwd, 'the child cwd follows the worktree');
    assert.equal(
      env.coordinatorAgent.session.header.cwd,
      repoDir,
      'the coordinator cwd must never be switched by ctx.worktrees.create'
    );
    const shareMember = controller.stores.resolveSession(shareSid).store.getMember('wt-author');
    assert.equal(shareMember.workspace, 'share');
    assert.equal(shareMember.workspaceDir, shareCwd);
    assert.equal(shareMember.cwd, shareCwd);
    assert.equal(shareMember.workspaceFallback, undefined, 'the fallback marker is gone');
    const wtEvent = shareAgent._debug.appendedEvents.find((e) => e.type === 'plugin:worktree/created');
    assert.ok(wtEvent, 'the host worktree service appends plugin:worktree/created on the child');

    // (c) the removed branch (git clone) mode fails loudly, before any allocation.
    const createCountBefore = env.createCalls.length;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'clone-author', brief: 'Edit in clone', workspace: 'branch' },
          { agent: env.coordinatorAgent }
        ),
      /已移除 branch/
    );
    assert.equal(env.createCalls.length, createCountBefore, 'branch must not create a child');
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'weird-ws', brief: 'x', workspace: 'detached' },
          { agent: env.coordinatorAgent }
        ),
      /不支持的 workspace/
    );

    // (d) kill never deletes a worktree: reclamation belongs to the host.
    const kill = await swarmTool.execute(
      { action: 'kill', name: 'wt-author' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(kill.status, 'killed');
    assert.equal(kill.workspace_cleaned, false);
    assert.equal(env.worktreeCreateCalls.length, 1, 'kill must not touch the worktree service');
    const killInherit = await swarmTool.execute(
      { action: 'kill', name: 'plain-author' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(killInherit.workspace_cleaned, false);
  } finally {
    await env.disposeAll();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});


test('5. Desktop client bundle: boot, no private primitives dep, hashed ids, a11y nodes, explicit async dispose', () => {
  const clientCode = fs.readFileSync(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  assert.ok(
    !clientCode.includes('dsh-client-ui-primitives'),
    'client.js must not require the private UI primitives package'
  );
  assert.ok(clientCode.includes('tabIndex: 0'), 'graph nodes must be keyboard focusable');
  assert.ok(clientCode.includes("role: 'button'"), 'graph nodes must expose role=button');
  assert.ok(clientCode.includes('查看会话轨迹'), 'member session entry must be labelled as a trajectory view');

  const registrations = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(reg) {
          registrations.push(reg);
        },
      },
    },
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(clientCode, sandbox, { filename: 'client.js' });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, 'dsh-agy-swarm');

  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  };

  const materialized = registrations[0].factory((spec) => {
    if (spec === 'react') return mockReact;
    throw new Error('unexpected require(' + spec + ')');
  });
  assert.equal(typeof materialized.apply, 'function');
  assert.ok(Array.isArray(materialized.inject));

  const registeredSlots = [];
  const registeredProtocols = [];
  const registeredTabs = [];
  const mockClientCtx = {
    slots: {
      inject(slotName, cb) {
        return cb();
      },
      register(spec, comp) {
        registeredSlots.push({ spec, comp });
        return () => {};
      },
    },
    resources: {
      register(provider) {
        registeredProtocols.push(provider);
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(tabDef) {
        registeredTabs.push(tabDef);
        return () => {};
      },
    },
    sidebarRight: {
      open() {},
    },
  };

  const disposeClient = materialized.apply(mockClientCtx);
  assert.equal(typeof disposeClient, 'function');
  assert.equal(registeredProtocols[0]?.protocol, 'swarm');
  assert.equal(registeredTabs[0]?.id, 'dsh-swarm/pane');
  const slotNames = registeredSlots.map((s) => s.spec.name);
  assert.ok(slotNames.includes('sidebar.right.pane.tab'));
  assert.ok(slotNames.includes('conversation.session.header.actions'));
  assert.ok(slotNames.includes('tool.call.toolview'));
  disposeClient();

  const tokens = clientMod.tokenizeSwarmText(
    'See #12 and ping @dsh-sdk in @#backend or @all -> dsh-resource://swarm/coord-1?tab=graph'
  );
  const kinds = new Set(tokens.map((t) => t.type));
  assert.ok(kinds.has('seq-ref'));
  assert.ok(kinds.has('mention'));
  assert.ok(kinds.has('channel-mention'));
  assert.ok(kinds.has('broadcast'));
  assert.ok(kinds.has('swarm-link'));

  const tree = clientMod.orderMembersTree([
    { name: 'coordinator', role: 'coordinator', addedBy: '' },
    { name: 'author', role: 'worker', addedBy: 'coordinator' },
    { name: 'sub-1', role: 'worker', addedBy: 'author' },
  ]);
  assert.deepEqual(
    tree.map((row) => ({ name: (row.member || row).name, depth: row.depth })),
    [
      { name: 'coordinator', depth: 0 },
      { name: 'author', depth: 0 },
      { name: 'sub-1', depth: 1 },
    ]
  );

  const graph = clientMod.buildMentionGraph({
    members: [
      { name: 'coordinator', role: 'coordinator', state: 'waiting' },
      { name: 'author', role: 'worker', addedBy: 'coordinator', state: 'working' },
      { name: 'verifier', role: 'worker', addedBy: 'coordinator', state: 'waiting' },
    ],
    messages: [
      { seq: 1, agent: 'coordinator', text: '@author start', mentions: ['author'] },
      { seq: 2, agent: 'author', text: '@verifier review', mentions: ['verifier'] },
      { seq: 3, agent: 'author', text: '@verifier fixed', mentions: ['verifier'] },
    ],
  });
  assert.equal(graph.nodes.length, 3);
  const avEdge = graph.edges.find((e) => e.from === 'author' && e.to === 'verifier' && e.count >= 2);
  assert.ok(avEdge, 'expected aggregated mention edge author -> verifier with count >= 2');

  const summary = clientMod.summarizeSwarmToolCall('swarm', { action: 'add', name: 'ui' });
  assert.ok(typeof summary === 'string' || (summary && typeof summary === 'object'));

  // fork chips: boolean true and the legacy "coordinator" string both render
  // as fork:coordinator; anything falsy renders no chip at all.
  const forkTrueChips = clientMod.summarizeSwarmToolCall({
    action: 'add',
    name: 'ui',
    fork: true,
    workspace: 'share',
  });
  assert.deepEqual(forkTrueChips.chips, ['@ui', 'fork:coordinator', 'share']);
  const forkStringChips = clientMod.summarizeSwarmToolCall({
    action: 'add',
    name: 'ui',
    fork: 'coordinator',
  });
  assert.deepEqual(forkStringChips.chips, ['@ui', 'fork:coordinator']);
  const noForkChips = clientMod.summarizeSwarmToolCall({
    action: 'add',
    name: 'ui',
    fork: false,
  });
  assert.deepEqual(noForkChips.chips, ['@ui']);
  const inheritChips = clientMod.summarizeSwarmToolCall({
    action: 'add',
    name: 'ui',
    workspace: 'inherit',
  });
  assert.deepEqual(inheritChips.chips, ['@ui'], 'inherit adds no workspace chip');

  assert.equal(clientMod.isValidSessionId('swarm-child-99'), true);
  assert.equal(clientMod.isValidSessionId('bad/slash'), false);
  assert.equal(clientMod.parseSwarmResourceUri('dsh-resource://swarm/%ZZ'), null);

  const openedCalls = [];
  const jumped = clientMod.openMemberSession(
    {
      uiWorkspace: {
        openSession(arg) {
          openedCalls.push(arg);
        },
      },
    },
    { coordinatorSessionId: 'coord-root-1' },
    { name: 'author', role: 'worker', sessionId: 'swarm-child-99' }
  );
  assert.equal(jumped.ok, true);
  assert.equal(jumped.mode, 'continuable');
  assert.equal(openedCalls.length, 1);
  assert.deepEqual(openedCalls[0], {
    parentSessionId: 'coord-root-1',
    childSessionId: 'swarm-child-99',
    mode: 'continuable',
  });

  const fallbackCalls = [];
  const jumpedFallback = clientMod.openMemberSession(
    {
      uiWorkspace: {
        openSession(arg) {
          if (typeof arg === 'object') throw new Error('legacy signature');
          fallbackCalls.push(arg);
        },
      },
    },
    { coordinatorSessionId: 'coord-root-1' },
    { name: 'author', role: 'worker', sessionId: 'swarm-child-99' }
  );
  assert.equal(jumpedFallback.ok, true);
  assert.equal(jumpedFallback.mode, 'direct-fallback');
  assert.deepEqual(fallbackCalls, ['swarm-child-99']);
});

test('6. In-process SDK contract verification (no app.asar subprocess probe)', async () => {
  // The review sandbox forbids executing app.asar through a child process, so
  // the host-facing contracts are verified statically and in-process instead:
  // exported symbols, manifest wiring, patch, protocol parity and the pure
  // helpers that encode host facts. Nothing here spawns a process.
  for (const symbol of [
    'apply',
    'SwarmHostController',
    'createSwarmTools',
    'mountSwarmRemoteService',
    'buildBalancedForkSeed',
    'parseCronIntervalMs',
    'hasPendingAgentWork',
    'readAgentDelegationDepth',
    'captureDelegatedPolicyOverrides',
    'setDshScopeForTests',
  ]) {
    assert.equal(typeof hostPlugin[symbol], 'function', 'missing export ' + symbol);
  }
  assert.equal(hostPlugin.name, protocol.PLUGIN_ID);

  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'index.js');
  for (const rel of pkg.files) {
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, rel)), 'declared package file missing: ' + rel);
  }
  const patch = fs.readFileSync(path.join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /insert:/);
  assert.match(patch, /id: dsh-agy-swarm/);
  assert.match(patch, /name: 'dsh-agy-swarm'/);

  // The shipped sources must never reach into the host archive or a private dep.
  const indexCode = fs.readFileSync(path.join(PLUGIN_ROOT, 'index.js'), 'utf8');
  const clientCode = fs.readFileSync(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  const boardCode = fs.readFileSync(path.join(PLUGIN_ROOT, 'src/board-store.js'), 'utf8');
  for (const code of [indexCode, clientCode, boardCode]) {
    assert.ok(!code.includes('app.asar'), 'plugin source must not reference app.asar');
    assert.ok(!code.includes('dsh-client-ui-primitives'), 'private UI primitives are forbidden');
  }
  // Safety-critical shapes stay present in the shipped sources.
  assert.match(indexCode, /subagent\/descriptor/);
  assert.match(indexCode, /sandbox\/mode/);
  assert.match(indexCode, /approval\/policy/);
  assert.match(boardCode, /openSync\(this\.lockFile, 'wx'\)/);
  assert.match(boardCode, /_needsBoardRepair/);

  // Host delegation depth: max(header.delegationDepth, options.subagentDepth).
  assert.equal(
    hostPlugin.readAgentDelegationDepth({ session: { header: { delegationDepth: 0 } } }),
    0
  );
  assert.equal(
    hostPlugin.readAgentDelegationDepth({
      session: { header: { delegationDepth: 0 } },
      options: { subagentDepth: 4 },
    }),
    4
  );
  assert.equal(
    hostPlugin.readAgentDelegationDepth({
      session: { header: { delegationDepth: 2 } },
      options: { subagentDepth: 1 },
    }),
    2
  );
  assert.throws(
    () => hostPlugin.readAgentDelegationDepth({ options: { subagentDepth: -0 } }),
    TypeError
  );
  assert.throws(
    () => hostPlugin.readAgentDelegationDepth({ options: { subagentDepth: 1.5 } }),
    TypeError
  );
  assert.throws(
    () => hostPlugin.readAgentDelegationDepth({ session: { header: { delegationDepth: -1 } } }),
    TypeError
  );

  // Inbox truth used by turn/end: a running agent or queued work is NOT idle.
  assert.equal(hostPlugin.hasPendingAgentWork(null), false);
  assert.equal(hostPlugin.hasPendingAgentWork({ status: 'running' }), true);
  assert.equal(
    hostPlugin.hasPendingAgentWork({ status: 'idle', inbox: { nextTurn: [{}], nextStep: [] } }),
    true
  );
  assert.equal(
    hostPlugin.hasPendingAgentWork({ status: 'idle', inbox: { nextTurn: [], nextStep: [{}] } }),
    true
  );
  assert.equal(
    hostPlugin.hasPendingAgentWork({
      status: 'idle',
      inbox: { hasPending: () => true, nextTurn: [], nextStep: [] },
    }),
    true
  );
  assert.equal(
    hostPlugin.hasPendingAgentWork({
      status: 'idle',
      inbox: { hasPending: () => false, nextTurn: [], nextStep: [] },
    }),
    false
  );
  assert.equal(hostPlugin.hasPendingAgentWork({ status: 'idle', inbox: { size: 2 } }), true);
  assert.equal(hostPlugin.hasPendingAgentWork({ status: 'idle', inbox: { size: 0 } }), false);

  // Effective sandbox resolution order: override -> resolve -> deployment default.
  const captured = hostPlugin.captureDelegatedPolicyOverrides({
    ctx: {
      get(name) {
        if (name === 'sandboxPolicy') {
          return { overrideOf: () => undefined, resolve: () => ({ mode: 'read-only' }) };
        }
        if (name === 'permissionPresets') return { current: () => 'auto' };
        if (name === 'approval') return {};
        return undefined;
      },
    },
    session: { header: { agentPreset: 'desk-preset' } },
  });
  assert.equal(captured.sandboxMode, 'read-only');
  assert.equal(captured.explicitSandbox, undefined);
  assert.equal(captured.approvalPolicy, 'never');
  assert.equal(captured.permissionPreset, 'auto');
  assert.equal(captured.hasSecurityServices, true);
  assert.equal(captured.agentPreset, 'desk-preset');

  const defaultOnly = hostPlugin.captureDelegatedPolicyOverrides({
    ctx: { get: (name) => (name === 'sandboxPolicy' ? { defaultMode: 'read-only' } : undefined) },
    session: { header: {} },
  });
  assert.equal(defaultOnly.sandboxMode, 'read-only');
  assert.equal(defaultOnly.approvalPolicy, undefined);
  assert.equal(defaultOnly.hasSecurityServices, true);

  // Cron + fork-seed balancing remain pure and in-process.
  assert.equal(hostPlugin.parseCronIntervalMs('*/3 * * * *'), 180000);
  assert.equal(hostPlugin.parseCronIntervalMs('* * * * *'), 60000);
  assert.throws(() => hostPlugin.parseCronIntervalMs('0 9 * * *'), /复杂日历|不支持/);
  const balanced = hostPlugin.buildBalancedForkSeed([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { step: 1 } },
    { type: 'tool/call', seq: 2, time: 1, data: { callId: 'c1', name: 'read_board' } },
  ]);
  assert.ok(balanced.seed.some((e) => e.type === 'tool/result' && e.data?.callId === 'c1'));
  assert.equal(balanced.seed.at(-1).type, 'turn/end');

  // Remote service contract is a stream-capable duck type in-process.
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const svc = env.providedServices.get('dsh-swarm');
    assert.ok(svc, 'dsh-swarm remote service must be provided');
    assert.equal(typeof svc.getSwarmSnapshot, 'function');
    const iterator = svc.watchSwarm({ sessionId: env.coordinatorAgent.id });
    const first = await iterator.next();
    assert.equal(first.value.hasSwarm, false);
    await iterator.return?.();
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('7. Delegation policy inheritance: sandbox mode, approval pin, preset, depth cap, v3 descriptor', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir, process.cwd(), {
    sandboxMode: 'read-only',
    withApproval: true,
    permissionPreset: 'auto',
    coordinatorPreset: 'desk-preset',
    coordinatorDepth: 0,
  });
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'guarded', brief: 'stay in scope' },
      { agent: env.coordinatorAgent }
    );
    const worker = env.agentsMap.get(add.added[0].sessionId);
    const ev = (type) => worker._debug.appendedEvents.find((e) => e.type === type);

    assert.equal(env.createCalls[0].meta.delegationDepth, 1);
    // Host 0.2.2 puts a continuable v3 descriptor on every swarm child.
    assert.deepEqual(ev('subagent/descriptor').data, {
      version: 3,
      mode: 'continuable',
      provider: 'spawn',
      label: 'guarded',
      agentProvider: 'deepseek',
      agentModel: 'deepseek-reasoner',
      agentReasoningEffort: 'high',
    });
    assert.deepEqual(ev('agent-preset/selected').data, { agentPreset: 'desk-preset' });
    assert.deepEqual(ev('sandbox/mode').data, { mode: 'read-only', source: 'delegation' });
    assert.deepEqual(ev('approval/policy').data, { policy: 'never', source: 'delegation' });
    assert.deepEqual(ev('permission/preset').data, { preset: 'auto' });
    assert.deepEqual(worker._debug.presetMounts, ['desk-preset']);

    // A fork seed's stale wide grant is superseded by later delegation events.
    const types = worker._debug.appendedEvents.map((e) => e.type);
    assert.ok(types.indexOf('subagent/descriptor') < types.indexOf('sandbox/mode'));
    assert.ok(types.indexOf('sandbox/mode') < types.indexOf('approval/policy'));
    assert.ok(types.indexOf('approval/policy') < types.indexOf('permission/preset'));
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const deepDir = makeTempDir();
  const deepEnv = createMockHostEnv(deepDir, process.cwd(), { coordinatorDepth: 4 });
  try {
    const deepTool = deepEnv.registeredTools.get('swarm').tool;
    await assert.rejects(
      () => deepTool.execute({ action: 'add', name: 'too-deep', brief: 'x' }, { agent: deepEnv.coordinatorAgent }),
      /深度超限|MAX_SWARM_DELEGATION_DEPTH|超过上限/
    );
    assert.equal(deepEnv.createCalls.length, 0, 'depth cap must reject before creating anything');

    deepEnv.coordinatorAgent.session.header.delegationDepth = 3;
    const okAdd = await deepTool.execute(
      { action: 'add', name: 'deep-ok', brief: 'x' },
      { agent: deepEnv.coordinatorAgent }
    );
    assert.equal(okAdd.status, 'added');
    assert.equal(deepEnv.createCalls[0].meta.delegationDepth, 4);
  } finally {
    await deepEnv.disposeAll();
    fs.rmSync(deepDir, { recursive: true, force: true });
  }

  // Without an approval service the approval pin is not written at all.
  const plainDir = makeTempDir();
  const plainEnv = createMockHostEnv(plainDir);
  try {
    const plainTool = plainEnv.registeredTools.get('swarm').tool;
    const add = await plainTool.execute(
      { action: 'add', name: 'plain', brief: 'x' },
      { agent: plainEnv.coordinatorAgent }
    );
    const worker = plainEnv.agentsMap.get(add.added[0].sessionId);
    const types = worker._debug.appendedEvents.map((e) => e.type);
    assert.ok(!types.includes('approval/policy'));
    assert.ok(!types.includes('sandbox/mode'));
    assert.ok(!types.includes('permission/preset'));
  } finally {
    await plainEnv.disposeAll();
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
});

test('8. agent/request-error is a waterfall: always next(), reads payload.failure safely', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const { ctx } = env;

    // Non-swarm session still calls next() and returns its action.
    let nextCalls = 0;
    const results = await ctx.emit(
      'agent/request-error',
      { failure: { message: 'provider exploded' } },
      () => {
        nextCalls += 1;
        return Promise.resolve({ kind: 'retry' });
      }
    );
    assert.equal(nextCalls, 1);
    assert.deepEqual(results[0], { kind: 'retry' });

    // Missing next must resolve without throwing.
    const noNext = await ctx.emit('agent/request-error', { failure: new Error('x') });
    assert.deepEqual(noNext, [undefined]);

    const swarmTool = env.registeredTools.get('swarm').tool;
    const readTool = env.registeredTools.get('read_board').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'victim', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    const victim = env.agentsMap.get(add.added[0].sessionId);

    let swarmNext = 0;
    await ctx.emit(
      'agent/request-error',
      { agent: victim, failure: { message: '429 rate limited' } },
      () => {
        swarmNext += 1;
        return undefined;
      }
    );
    assert.equal(swarmNext, 1);
    let board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    assert.equal(board.members.find((m) => m.name === 'victim').last_error, '429 rate limited');

    // A code-only failure must never stringify an object as [object Object].
    await ctx.emit('agent/request-error', { agent: victim, failure: { code: 'E_QUOTA' } }, () => {});
    board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    const errText = board.members.find((m) => m.name === 'victim').last_error;
    assert.equal(errText, 'E_QUOTA');
    assert.ok(!errText.includes('[object Object]'));

    // An exploding failure getter must not truncate the waterfall.
    let getterNext = 0;
    const explosivePayload = { agent: victim };
    Object.defineProperty(explosivePayload, 'failure', {
      get() {
        throw new Error('getter boom');
      },
    });
    const explosiveResults = await ctx.emit('agent/request-error', explosivePayload, () => {
      getterNext += 1;
      return 'survived';
    });
    assert.equal(getterNext, 1);
    assert.deepEqual(explosiveResults, ['survived']);
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('9. workingDirectory.get(session) contract: strict Session argument and cwd inheritance', async () => {
  const tmpDir = makeTempDir();
  const baseCwd = makeTempDir('dsh-swarm-cwd-');
  const env = createMockHostEnv(tmpDir, baseCwd);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const first = await swarmTool.execute(
      { action: 'add', name: 'cwd-a', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(first.added[0].cwd, baseCwd);

    const nextCwd = makeTempDir('dsh-swarm-cwd2-');
    env.coordinatorAgent.session.header.cwd = nextCwd;
    const second = await swarmTool.execute(
      { action: 'add', name: 'cwd-b', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(second.added[0].cwd, nextCwd);
    const childB = env.agentsMap.get(second.added[0].sessionId);
    assert.equal(
      childB.session.header.cwd,
      nextCwd,
      'worker setup must apply the inherited cwd to the child session'
    );
    fs.rmSync(nextCwd, { recursive: true, force: true });
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(baseCwd, { recursive: true, force: true });
  }
});

test('10. Cross-channel visibility, two-phase wake cursor, failed cold resume retry', async () => {
  const tmpDir = makeTempDir();
  const store = new BoardStore('coord-wake-1', { baseDir: tmpDir });
  try {
    store.ensureCoordinator({ provider: 'deepseek', model: 'deepseek-chat', cwd: tmpDir });
    store.registerMember({ name: 'dest-owner', sessionId: 's-dest', addedBy: 'coordinator' });
    store.registerMember({ name: 'outsider', sessionId: 's-out', addedBy: 'coordinator' });
    store.manageChannel('coordinator', { channelAction: 'create', channel: 'dest' });
    store.manageChannel('coordinator', { channelAction: 'subscribe', channel: 'dest', member: 'dest-owner' });

    store.prepareWait('outsider', { since: 0, mentionsOnly: true });
    store.prepareWait('dest-owner', { since: 0, mentionsOnly: true });

    const p1 = store.postMessage('coordinator', '@#dest build the thing', { channel: 'dest' });
    assert.deepEqual(p1.wakeTargets.map((m) => m.name), ['dest-owner']);

    store.prepareWait('dest-owner', { since: p1.message.seq, mentionsOnly: true });
    const p2 = store.postMessage('coordinator', '@outsider please join #dest', { channel: 'dest' });
    assert.deepEqual(p2.wakeTargets.map((m) => m.name), ['outsider']);
    assert.equal(store.isMessageVisibleToMember(store.getMember('outsider'), p2.message), true);
    assert.equal(store.isMessageVisibleToMember(store.getMember('outsider'), p1.message), false);
    const batch = store.collectVisibleMessagesSince(store.getMember('outsider'), 0);
    assert.ok(
      batch.some((m) => m.seq === p2.message.seq),
      'cross-channel doorbell must appear in the visible batch'
    );

    const member = store.getMember('outsider');
    const beforeRead = member.lastReadSeq;
    const beforeWait = member.waitSince;
    const began = store.beginWakeDelivery('outsider');
    assert.ok(began && began.batch.length > 0);
    assert.equal(member.lastReadSeq, beforeRead, 'begin must not advance lastReadSeq');
    assert.equal(member.waitSince, beforeWait, 'begin must not advance waitSince');
    assert.equal(member.state, 'working');
    assert.equal(store.beginWakeDelivery('outsider'), null, 're-entrant wake must be refused');
    store.ackWakeDelivery('outsider', began.maxSeq);
    assert.equal(member.lastReadSeq, began.maxSeq);
    assert.equal(member.waitSince, began.maxSeq);
    assert.equal(member.pendingWakeup, false);

    store.prepareWait('dest-owner', { since: p2.message.seq, mentionsOnly: true });
    const p3 = store.postMessage('coordinator', '@dest-owner retry me', { channel: 'dest' });
    const begin2 = store.beginWakeDelivery('dest-owner');
    assert.ok(begin2);
    const readBeforeFail = store.getMember('dest-owner').lastReadSeq;
    store.failWakeDelivery('dest-owner', 'cold resume failed', 'stopped');
    const failedMember = store.getMember('dest-owner');
    assert.equal(failedMember.lastReadSeq, readBeforeFail);
    assert.equal(failedMember.waitSince, p2.message.seq);
    assert.equal(failedMember.pendingWakeup, true);
    assert.equal(failedMember.state, 'stopped');
    assert.equal(failedMember.lastError, 'cold resume failed');
    const retry = store.beginWakeDelivery('dest-owner');
    assert.ok(retry && retry.batch.some((m) => m.seq === p3.message.seq));
    store.ackWakeDelivery('dest-owner', retry.maxSeq);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const hostDir = makeTempDir();
  const env = createMockHostEnv(hostDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const postTool = env.registeredTools.get('post_message').tool;
    const readTool = env.registeredTools.get('read_board').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'cold-one', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    const sid = add.added[0].sessionId;
    await env.ctx.emit('session/event', { id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    const boardStore = env.mounted.controller.stores.resolveSession(sid).store;
    const before = boardStore.getMember('cold-one').lastReadSeq;
    env.mounted.controller.liveHandles.delete(sid);
    env.agentsMap.delete(sid);

    env.env.failResume = true;
    const failedPost = await postTool.execute(
      { text: '@cold-one wake up' },
      { agent: env.coordinatorAgent }
    );
    assert.deepEqual(failedPost.woken, []);
    assert.equal(failedPost.wake_errors.length, 1);
    assert.match(failedPost.wake_errors[0].error, /cold session unavailable/);
    let board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    let row = board.members.find((m) => m.name === 'cold-one');
    assert.equal(row.last_read_seq, before, 'failed delivery must not advance the cursor');
    assert.equal(row.pending_wakeup, true);
    assert.equal(row.state, 'stopped');

    env.env.failResume = false;
    const retryPost = await postTool.execute(
      { text: '@cold-one wake up again' },
      { agent: env.coordinatorAgent }
    );
    assert.deepEqual(retryPost.woken, ['cold-one']);
    assert.equal(retryPost.wake_errors, undefined);
    const resumed = env.agentsMap.get(sid);
    assert.ok(resumed._debug.followups.length >= 1);
    board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    row = board.members.find((m) => m.name === 'cold-one');
    assert.equal(row.pending_wakeup, false);
    assert.ok(row.last_read_seq > before);
  } finally {
    await env.disposeAll();
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
});


test('11. A doorbell during a working turn survives until idle (pendingWakeup replay)', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const postTool = env.registeredTools.get('post_message').tool;
    const readTool = env.registeredTools.get('read_board').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'busy', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    const sid = add.added[0].sessionId;
    const worker = env.agentsMap.get(sid);

    const post = await postTool.execute(
      { text: '@busy do more work' },
      { agent: env.coordinatorAgent }
    );
    assert.deepEqual(post.woken, []);
    assert.deepEqual(post.pending_wakeup, ['busy']);
    let board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    let row = board.members.find((m) => m.name === 'busy');
    assert.equal(row.state, 'working');
    assert.equal(row.pending_wakeup, true);

    await env.ctx.emit('agent/status', { status: 'idle', agent: worker });
    await waitFor(() => worker._debug.followups.length >= 2, 1500, 'idle replay delivery');
    board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    row = board.members.find((m) => m.name === 'busy');
    assert.equal(row.pending_wakeup, false);
    assert.equal(row.state, 'working');

    await env.ctx.emit('agent/status', { status: 'running', agent: worker });
    worker.inbox.size = 0;
    const post2 = await postTool.execute(
      { text: '@busy second bell' },
      { agent: env.coordinatorAgent }
    );
    assert.deepEqual(post2.pending_wakeup, ['busy']);
    const beforeCount = worker._debug.followups.length;
    await env.ctx.emit(
      'session/event',
      { agent: worker, id: sid },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } }
    );
    await waitFor(
      () => worker._debug.followups.length === beforeCount + 1,
      1500,
      'turn/end fallback delivery'
    );
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('12. In-flight create/resume cancellation disposes late handles and never delivers', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    env.env.deferCreates = true;
    const addPromise = swarmTool.execute(
      { action: 'add', name: 'slow', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    await waitFor(() => env.createCalls.length === 1, 1500, 'create started');

    const killRes = await swarmTool.execute(
      { action: 'kill', name: 'slow' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(killRes.status, 'killed');

    env.env.releaseCreateResolvers.shift()();
    await assert.rejects(() => addPromise, /取消|释放|killed/);
    assert.equal(env.env.lastCreateHandle.disposed, true, 'late create handle must be disposed');
    assert.equal(env.agentsMap.has(env.env.lastCreateHandle.agent.id), false);
    assert.equal(
      env.env.lastCreateHandle.agent._debug.followups.length,
      0,
      'a cancelled creation must never receive the initial prompt'
    );
    const board = await env.registeredTools
      .get('read_board')
      .tool.execute({ status: true }, { agent: env.coordinatorAgent });
    const row = board.members.find((m) => m.name === 'slow');
    assert.equal(row.state, 'killed');
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const dir2 = makeTempDir();
  const env2 = createMockHostEnv(dir2);
  try {
    const swarmTool = env2.registeredTools.get('swarm').tool;
    const postTool = env2.registeredTools.get('post_message').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'cold', brief: 'x' },
      { agent: env2.coordinatorAgent }
    );
    const sid = add.added[0].sessionId;
    await env2.ctx.emit(
      'session/event',
      { id: sid },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } }
    );
    env2.mounted.controller.liveHandles.delete(sid);
    env2.agentsMap.delete(sid);

    env2.env.deferResumes = true;
    const postPromise = postTool.execute({ text: '@cold wake' }, { agent: env2.coordinatorAgent });
    await waitFor(() => env2.resumeCalls.length === 1, 1500, 'resume started');

    const disposePromise = env2.mounted.controller.dispose();
    env2.env.releaseResumeResolvers.shift()();
    const postResult = await postPromise;
    await disposePromise;

    assert.deepEqual(postResult.woken, []);
    assert.equal(postResult.wake_errors.length, 1);
    assert.equal(env2.env.lastResumeHandle.disposed, true, 'late resume handle must be disposed');
    assert.equal(
      env2.env.lastResumeHandle.agent._debug.followups.length,
      0,
      'a disposed controller must never deliver to a late resumed agent'
    );
  } finally {
    await env2.disposeAll();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('13. Persistence: no ghost messages, JSONL self-heal, single-writer lock, atomic state', () => {
  const tmpDir = makeTempDir();
  const store = new BoardStore('coord-persist-1', { baseDir: tmpDir });
  try {
    store.ensureCoordinator({ provider: 'deepseek', model: 'deepseek-chat', cwd: tmpDir });
    const headBefore = store.state.head;
    const countBefore = store.messages.length;
    const originalAppend = fs.appendFileSync;
    fs.appendFileSync = () => {
      throw new Error('disk full');
    };
    try {
      assert.throws(() => store.postMessage('coordinator', 'ghost message'), /disk full/);
    } finally {
      fs.appendFileSync = originalAppend;
    }
    assert.equal(store.state.head, headBefore, 'failed append must not advance head');
    assert.equal(store.messages.length, countBefore, 'failed append must not leave a ghost message');

    store.postMessage('coordinator', 'real message');
    assert.equal(store.state.head, headBefore + 1);
  } finally {
    store.close();
  }

  // Two independent writers on one board dir must be rejected.
  const lockStore = new BoardStore('coord-lock-1', { baseDir: tmpDir });
  let second = null;
  try {
    lockStore.ensureCoordinator({ provider: 'deepseek', model: 'deepseek-chat' });
    lockStore.postMessage('coordinator', 'writer one');
    second = new BoardStore('coord-lock-1', { baseDir: tmpDir });
    assert.throws(() => second.postMessage('coordinator', 'writer two'), /双写者|锁定/);
    lockStore.close();
    assert.doesNotThrow(() => second.postMessage('coordinator', 'writer two after release'));
    second.postMessage('coordinator', 'writer two again');
  } finally {
    try { lockStore.close(); } catch {}
    if (second) {
      try { second.close(); } catch {}
    }
  }

  // A half-written JSONL tail is admitted in memory only: a READ-ONLY load
  // never edits the shared directory, and the rewrite happens under the writer
  // lock the moment this store actually writes.
  const healDir = makeTempDir();
  const healStore = new BoardStore('coord-heal-1', { baseDir: healDir });
  try {
    healStore.ensureCoordinator({});
    healStore.postMessage('coordinator', 'first');
    healStore.postMessage('coordinator', 'second');
  } finally {
    healStore.close();
  }
  const boardPath = path.join(healDir, 'coord-heal-1', 'board.jsonl');
  const brokenTail = '{"seq": 3, "channel": "main", "agent": "coordinator"';
  fs.appendFileSync(boardPath, brokenTail, 'utf8');
  const brokenRaw = fs.readFileSync(boardPath, 'utf8');
  const reopened = new BoardStore('coord-heal-1', { baseDir: healDir });
  try {
    assert.equal(reopened.messages.length, 2);
    assert.equal(reopened.state.head, 2);
    assert.equal(
      fs.readFileSync(boardPath, 'utf8'),
      brokenRaw,
      'a read-only load must not rewrite board.jsonl'
    );
    // Writing promotes this instance to the writer and repairs the file first.
    reopened.postMessage('coordinator', 'third');
    assert.equal(reopened.state.head, 3);
    const raw = fs.readFileSync(boardPath, 'utf8');
    assert.ok(raw.endsWith('\n'), 'repaired JSONL must end with a newline');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).seq),
      [1, 2, 3]
    );
  } finally {
    reopened.close();
    fs.rmSync(healDir, { recursive: true, force: true });
  }

  // Corrupt state.json recovers from .bak; a corrupt backup with data still
  // present must fail loudly instead of silently wiping the roster.
  const corruptDir = makeTempDir();
  const firstState = new BoardStore('coord-corrupt-1', { baseDir: corruptDir });
  try {
    firstState.ensureCoordinator({ provider: 'deepseek', model: 'deepseek-chat' });
    firstState.postMessage('coordinator', 'hello');
  } finally {
    firstState.close();
  }
  const statePath = path.join(corruptDir, 'coord-corrupt-1', 'state.json');
  fs.writeFileSync(statePath, '{ broken json', 'utf8');
  const recovered = new BoardStore('coord-corrupt-1', { baseDir: corruptDir });
  try {
    assert.equal(recovered.state.head, 1);
    assert.ok(recovered.state.members.length > 0, 'roster must be recovered from the .bak');
  } finally {
    recovered.close();
  }

  const brokenDir = new BoardStore('coord-corrupt-2', { baseDir: corruptDir });
  try {
    brokenDir.ensureCoordinator({});
    brokenDir.postMessage('coordinator', 'keep me');
  } finally {
    brokenDir.close();
  }
  const brokenBase = path.join(corruptDir, 'coord-corrupt-2');
  fs.writeFileSync(path.join(brokenBase, 'state.json'), '{ broken', 'utf8');
  fs.writeFileSync(path.join(brokenBase, 'state.json.bak'), '{ also broken', 'utf8');
  assert.throws(
    () => new BoardStore('coord-corrupt-2', { baseDir: corruptDir }),
    /损坏|备份/
  );

  // Atomic writes never fall back to overwriting the authoritative file.
  const atomicDir = makeTempDir();
  const target = path.join(atomicDir, 'state.json');
  fs.writeFileSync(target, '{"old":true}\n', 'utf8');
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EPERM rename blocked');
    err.code = 'EPERM';
    throw err;
  };
  try {
    assert.throws(
      () => boardStoreMod.atomicWriteJsonSync(target, { next: true }),
      /EPERM rename blocked/
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}\n');
  assert.deepEqual(fs.readdirSync(atomicDir), ['state.json'], 'no temp file may be left behind');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(corruptDir, { recursive: true, force: true });
  fs.rmSync(atomicDir, { recursive: true, force: true });
});

test('14. Cold-member model switch is deferred and applied right after resume', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const postTool = env.registeredTools.get('post_message').tool;
    const readTool = env.registeredTools.get('read_board').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'switcher', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    const sid = add.added[0].sessionId;
    await env.ctx.emit(
      'session/event',
      { id: sid },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } }
    );
    env.mounted.controller.liveHandles.delete(sid);
    env.agentsMap.delete(sid);

    const res = await swarmTool.execute(
      { action: 'model', name: 'switcher', model: 'anthropic/claude-sonnet-4-5' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(res.status, 'switched');
    assert.equal(res.pending_model_sync, true);
    let board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    let row = board.members.find((m) => m.name === 'switcher');
    assert.equal(row.pending_model_sync, true);
    assert.equal(row.model, 'anthropic/claude-sonnet-4-5');

    env.env.resumeIgnoresRoute = true;
    const post = await postTool.execute(
      { text: '@switcher continue' },
      { agent: env.coordinatorAgent }
    );
    assert.deepEqual(post.woken, ['switcher']);
    const agent = env.agentsMap.get(sid);
    assert.ok(
      agent._debug.modelSelections.length >= 1,
      'resume must apply the pending model selection even with an outdated request header'
    );
    assert.equal(agent._debug.modelSelections.at(-1).provider, 'anthropic');
    assert.equal(agent._debug.modelSelections.at(-1).model, 'claude-sonnet-4-5');
    board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    row = board.members.find((m) => m.name === 'switcher');
    assert.equal(row.pending_model_sync, false);
    assert.equal(row.model, 'anthropic/claude-sonnet-4-5');
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('15. watchSwarm registers before the first yield and dispose wakes signal-less iterators', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  const controller = env.mounted.controller;
  try {
    const iterator = controller.watchSwarm(env.coordinatorAgent.id);
    const first = await iterator.next();
    assert.equal(first.value.hasSwarm, false);

    await env.registeredTools
      .get('swarm')
      .tool.execute({ action: 'title', title: 'race-free' }, { agent: env.coordinatorAgent });

    const second = await Promise.race([iterator.next(), delay(1000).then(() => 'TIMEOUT')]);
    assert.notEqual(second, 'TIMEOUT', 'an update right after the first frame must not be lost');
    assert.equal(second.value.hasSwarm, true);
    assert.equal(second.value.title, 'race-free');

    const pending = Promise.race([iterator.next(), delay(2000).then(() => 'TIMEOUT')]);
    const disposePromise = controller.dispose();
    const final = await pending;
    assert.notEqual(final, 'TIMEOUT', 'dispose must wake a signal-less iterator');
    assert.equal(final.done, true);
    await disposePromise;
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('16. swarm{action:"add", wait:true} parks the caller; missing concludeTurn is a hard error', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    let concluded = 0;
    const add = await swarmTool.execute(
      { action: 'add', name: 'w1', brief: 'x', wait: true },
      { agent: env.coordinatorAgent, concludeTurn: () => { concluded += 1; } }
    );
    assert.equal(add.status, 'added');
    assert.equal(add.waiting, true);
    assert.equal(concluded, 1);
    const board = await env.registeredTools
      .get('read_board')
      .tool.execute({ status: true }, { agent: env.coordinatorAgent });
    const coord = board.members.find((m) => m.name === 'coordinator');
    assert.equal(coord.state, 'waiting');

    const w1 = env.agentsMap.get(add.added[0].sessionId);
    const store = env.mounted.controller.stores.resolveSession(w1.id).store;
    store.postMessage('w1', '@coordinator please decide');

    let concluded2 = 0;
    const add2 = await swarmTool.execute(
      { action: 'add', name: 'w2', brief: 'y', wait: true },
      { agent: env.coordinatorAgent, concludeTurn: () => { concluded2 += 1; } }
    );
    assert.equal(add2.waiting, false, 'a pending doorbell must not park the caller');
    assert.equal(concluded2, 0);
    assert.ok(Array.isArray(add2.immediate_messages));
    assert.ok(add2.immediate_messages.some((m) => m.text.includes('please decide')));
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const dir2 = makeTempDir();
  const env2 = createMockHostEnv(dir2);
  try {
    const swarmTool = env2.registeredTools.get('swarm').tool;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'w3', brief: 'x', wait: true },
          { agent: env2.coordinatorAgent }
        ),
      /concludeTurn/
    );
    await assert.rejects(
      () =>
        env2.registeredTools
          .get('swarm_wait')
          .tool.execute({ since: 0, mentions_only: true }, { agent: env2.coordinatorAgent }),
      /concludeTurn/
    );
  } finally {
    await env2.disposeAll();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('17. Coordinator fork pins the caller sandbox; a failing append aborts the add', async () => {
  const tmpDir = makeTempDir();
  // The caller has a sandboxPolicy service, but nothing overrides the mode: the
  // deployment default (read-only) is what actually applies to this call.
  const env = createMockHostEnv(tmpDir, process.cwd(), {
    defaultSandboxMode: 'read-only',
    withApproval: true,
    permissionPreset: 'auto',
  });
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const readTool = env.registeredTools.get('read_board').tool;

    // A legacy sibling member whose history carries a wide sandbox grant.
    const wideAdd = await swarmTool.execute(
      { action: 'add', name: 'wide', brief: 'legacy member' },
      { agent: env.coordinatorAgent }
    );
    const wideSid = wideAdd.added[0].sessionId;
    const wideAgent = env.agentsMap.get(wideSid);
    wideAgent.session.append('sandbox/mode', { mode: 'danger-full-access', source: 'preset' });
    wideAgent.session.append('permission/preset', { preset: 'danger-full-access' });

    assert.equal(
      env.ctx.sandboxPolicy.overrideOf(env.coordinatorAgent.session),
      undefined,
      'this scenario relies on the deployment default, not on an explicit override'
    );

    // Cross-member forking is gone: naming a sibling is a hard error.
    const createsBeforeRejectedFork = env.createCalls.length;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'forked-sibling', brief: 'x', fork: 'wide' },
          { agent: env.coordinatorAgent }
        ),
      /已移除跨成员分叉/
    );
    assert.equal(env.createCalls.length, createsBeforeRejectedFork);

    // The COORDINATOR's own history carries the wide grant; the delegation pin
    // captured from the caller must still land AFTER the fork seed.
    env.coordinatorAgent.session.append('sandbox/mode', {
      mode: 'danger-full-access',
      source: 'preset',
    });
    env.coordinatorAgent.session.append('permission/preset', { preset: 'danger-full-access' });

    const forkAdd = await swarmTool.execute(
      { action: 'add', name: 'forked', brief: 'fork it', fork: true },
      { agent: env.coordinatorAgent }
    );
    const forked = env.agentsMap.get(forkAdd.added[0].sessionId);
    const forkDescriptor = forked._debug.appendedEvents.find(
      (ev) => ev.type === 'subagent/descriptor'
    );
    assert.equal(forkDescriptor?.data?.provider, 'fork');
    assert.equal(forkDescriptor?.data?.mode, 'continuable');
    assert.equal(forkDescriptor?.data?.label, 'forked');

    const events = forked.session.snapshotEvents();
    const lastSandbox = events.filter((ev) => ev.type === 'sandbox/mode').at(-1);
    assert.deepEqual(lastSandbox.data, { mode: 'read-only', source: 'delegation' });
    const wideIndex = events.findIndex(
      (ev) => ev.type === 'sandbox/mode' && ev.data?.mode === 'danger-full-access'
    );
    const pinnedIndex = events.reduce(
      (acc, ev, index) =>
        ev.type === 'sandbox/mode' && ev.data?.source === 'delegation' ? index : acc,
      -1
    );
    assert.ok(wideIndex >= 0, 'the fork seed must actually carry the wide grant');
    assert.ok(pinnedIndex > wideIndex, 'the delegation pin must land AFTER the fork seed');
    assert.deepEqual(
      forked._debug.appendedEvents.find((ev) => ev.type === 'approval/policy')?.data,
      { policy: 'never', source: 'delegation' }
    );
    assert.deepEqual(
      forked._debug.appendedEvents.find((ev) => ev.type === 'permission/preset')?.data,
      { preset: 'auto' }
    );

    // A failed session.append must abort agents.create instead of producing a
    // child that runs without the very pins captured above.
    env.env.failSessionAppend = true;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'enospc', brief: 'must fail' },
          { agent: env.coordinatorAgent }
        ),
      /ENOSPC|no space/i
    );
    env.env.failSessionAppend = false;

    const board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    const enospcRow = board.members.find((m) => m.name === 'enospc');
    assert.ok(enospcRow, 'the failed member must be recorded so it can be audited');
    assert.equal(enospcRow.state, 'killed');
    const halfCreatedAgent = env.agentsMap.get(enospcRow.sessionId);
    assert.equal(
      halfCreatedAgent?._debug.followups.length ?? 0,
      0,
      'an aborted add must never deliver the initial prompt'
    );
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('18. Runtime subagentDepth counts toward the delegation cap and is re-seeded on resume', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir, process.cwd(), {
    coordinatorDepth: 0,
    coordinatorSubagentDepth: 4,
  });
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'too-deep', brief: 'x' },
          { agent: env.coordinatorAgent }
        ),
      /深度超限|超过上限/
    );
    assert.equal(env.createCalls.length, 0, 'the cap must reject before creating anything');

    // Drop the runtime depth: the same caller may now spawn depth-1 children.
    env.coordinatorAgent.options = {};
    const okAdd = await swarmTool.execute(
      { action: 'add', name: 'depth-ok', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(env.createCalls.at(-1).meta.delegationDepth, 1);
    assert.equal(env.createCalls.at(-1).agentOptions.subagentDepth, 1);
    const sid = okAdd.added[0].sessionId;
    const store = env.mounted.controller.stores.resolveSession(sid).store;
    assert.equal(store.getMember('depth-ok').delegationDepth, 1);

    // Cold resume re-seeds subagentDepth from the persisted member record and
    // passes the member abort signal through to the host resume call.
    await env.ctx.emit(
      'session/event',
      { id: sid },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } }
    );
    env.mounted.controller.liveHandles.delete(sid);
    env.agentsMap.delete(sid);
    await env.registeredTools
      .get('post_message')
      .tool.execute({ text: '@depth-ok ping' }, { agent: env.coordinatorAgent });
    await waitFor(() => env.resumeCalls.length === 1, 2000, 'cold resume');
    assert.equal(env.resumeCalls[0].agentOptions.subagentDepth, 1);
    assert.ok(env.resumeCalls[0].signal, 'agents.resume must receive the member abort signal');
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('19. Preset ownership: live composeFrom on create, the member own preset on cold resume', async () => {
  // (a) Fresh create mirrors host applyChildComposition: the caller's LIVE
  // composition wins over the immutable header.agentPreset string.
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir, process.cwd(), {
    coordinatorPreset: 'stale-preset',
    presets: { composeFrom: true },
    agentPresets: { composedPreset: () => 'live-preset' },
  });
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'composed', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    const child = env.agentsMap.get(add.added[0].sessionId);
    assert.equal(env.env.presetComposeCalls.length, 1, 'composeFrom must be preferred on create');
    assert.deepEqual(child._debug.presetMounts, [], 'composeFrom must not be replaced by mount()');
    assert.deepEqual(
      child._debug.appendedEvents.find((ev) => ev.type === 'agent-preset/selected')?.data,
      { agentPreset: 'live-preset' }
    );
    assert.equal(env.createCalls.at(-1).meta.agentPreset, 'live-preset');
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // (b) Cold resume restores the member's OWN preset, never the coordinator's.
  const dir2 = makeTempDir();
  const env2 = createMockHostEnv(dir2, process.cwd(), {
    coordinatorPreset: 'coord-preset',
    agentPresets: { composedPreset: () => 'coord-preset' },
  });
  try {
    const swarmTool = env2.registeredTools.get('swarm').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'helper', brief: 'x' },
      { agent: env2.coordinatorAgent }
    );
    const sid = add.added[0].sessionId;
    const helper = env2.agentsMap.get(sid);
    assert.deepEqual(helper._debug.presetMounts, ['coord-preset']);
    // The member later carries its own preset identity.
    helper.session.header.agentPreset = 'worker-preset';

    await env2.ctx.emit(
      'session/event',
      { id: sid },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } }
    );
    env2.mounted.controller.liveHandles.delete(sid);
    env2.agentsMap.delete(sid);
    await env2.registeredTools
      .get('post_message')
      .tool.execute({ text: '@helper ping' }, { agent: env2.coordinatorAgent });
    await waitFor(() => env2.resumeCalls.length === 1, 2000, 'cold resume');
    const resumed = env2.agentsMap.get(sid);
    assert.deepEqual(
      resumed._debug.presetMounts,
      ['worker-preset'],
      'a helper must resume with its OWN preset'
    );
    assert.ok(!resumed._debug.presetMounts.includes('coord-preset'));
  } finally {
    await env2.disposeAll();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('20. Atomic writer.lock plus promotion re-read keeps #seq monotonic across instances', () => {
  const baseDir = makeTempDir();
  const dir = path.join(baseDir, 'coord-lockprobe');
  const boardPath = path.join(dir, 'board.jsonl');
  const writerA = new BoardStore('coord-lockprobe', { baseDir });
  let readerB = null;
  try {
    writerA.ensureCoordinator({});
    writerA.postMessage('coordinator', 'one');
    assert.equal(fs.existsSync(path.join(dir, 'writer.lock')), true);

    // A second instance opened read-only caches head=1 without touching the lock.
    readerB = new BoardStore('coord-lockprobe', { baseDir });
    assert.equal(readerB.state.head, 1);
    assert.equal(readerB.lockHeld, false);

    writerA.postMessage('coordinator', 'two');
    writerA.close();

    // B promotes itself: it must re-read the newest on-disk head before writing.
    readerB.postMessage('coordinator', 'three');
    assert.equal(readerB.state.head, 3);
    const lines = fs
      .readFileSync(boardPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((m) => m.seq),
      [1, 2, 3],
      'a promoted writer must never re-emit a seq the previous writer already persisted'
    );
    assert.deepEqual(
      lines.map((m) => m.text),
      ['one', 'two', 'three']
    );
  } finally {
    try {
      writerA.close();
    } catch {}
    if (readerB) {
      try {
        readerB.close();
      } catch {}
    }
  }
  fs.rmSync(baseDir, { recursive: true, force: true });

  // Cross-owner exclusivity: a LIVE foreign owner is refused and its lock is
  // left untouched; a provably DEAD owner's lock is stolen exactly once.
  const lockBase = makeTempDir();
  const seedLock = new BoardStore('coord-lockx', { baseDir: lockBase });
  try {
    seedLock.ensureCoordinator({});
  } finally {
    seedLock.close();
  }
  const lockDir = path.join(lockBase, 'coord-lockx');
  const lockFile = path.join(lockDir, 'writer.lock');
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, ownerId: 'foreign-live-owner', acquiredAt: Date.now() }),
    'utf8'
  );
  const blocked = new BoardStore('coord-lockx', { baseDir: lockBase });
  try {
    assert.throws(() => blocked.postMessage('coordinator', 'blocked'), /锁定|双写者/);
  } finally {
    try {
      blocked.close();
    } catch {}
  }
  assert.equal(fs.existsSync(lockFile), true, 'a refused writer must not delete a live lock');

  // A lock with no usable positive pid can never be PROVEN dead: it is refused
  // and left untouched instead of being stolen.
  fs.writeFileSync(lockFile, JSON.stringify({ ownerId: 'no-usable-pid' }), 'utf8');
  const doubtful = new BoardStore('coord-lockx', { baseDir: lockBase });
  try {
    assert.throws(() => doubtful.postMessage('coordinator', 'unprovable'), /锁定|双写者/);
  } finally {
    try {
      doubtful.close();
    } catch {}
  }
  assert.equal(fs.existsSync(lockFile), true, 'an unprovable lock must never be deleted');

  // A lock whose positive pid is PROVABLY dead is stolen exactly once.
  const deadPid = 999999;
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === deadPid) {
      const err = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    }
    return originalKill.call(process, pid, signal);
  };
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: deadPid, ownerId: 'dead-owner', acquiredAt: 1 }),
    'utf8'
  );
  const stealer = new BoardStore('coord-lockx', { baseDir: lockBase });
  try {
    const posted = stealer.postMessage('coordinator', 'stolen lock');
    assert.equal(posted.message.seq, 1);
    const onDisk = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(onDisk.ownerId, stealer.ownerId, 'the stale lock must be replaced by ours');
    assert.equal(onDisk.pid, process.pid);
  } finally {
    process.kill = originalKill;
    stealer.close();
    fs.rmSync(lockBase, { recursive: true, force: true });
  }
});

test('21. Read-only access writes nothing (bad tail, corrupt state + backup, malformed lines)', () => {
  const baseDir = makeTempDir();
  const seed = new BoardStore('coord-ro', { baseDir });
  try {
    seed.ensureCoordinator({ provider: 'deepseek', model: 'deepseek-chat' });
    seed.postMessage('coordinator', 'hello');
    seed.postMessage('coordinator', 'world');
  } finally {
    seed.close();
  }
  const dir = path.join(baseDir, 'coord-ro');
  const boardFile = path.join(dir, 'board.jsonl');
  const stateFile = path.join(dir, 'state.json');
  const brokenBoard =
    fs.readFileSync(boardFile, 'utf8') +
    '{"seq":1}\n' +
    '{"seq": 3, "agent": "coordinator", "te';
  fs.writeFileSync(boardFile, brokenBoard, 'utf8');
  fs.writeFileSync(stateFile, '{ broken json', 'utf8');
  const originalBak = fs.readFileSync(stateFile + '.bak', 'utf8');

  const mgr = new SwarmStoreManager({ baseDir });
  try {
    const snap = mgr.getSnapshotForSession('coord-ro');
    assert.equal(snap.hasSwarm, true);
    assert.equal(snap.head, 2, 'the .bak state must be adopted in memory');
    assert.equal(snap.messages.length, 2, 'malformed and half-written lines must be dropped');
    assert.equal(fs.existsSync(path.join(dir, 'writer.lock')), false, 'read-only must not lock');
    assert.equal(fs.readFileSync(boardFile, 'utf8'), brokenBoard, 'read-only must not rewrite JSONL');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ broken json', 'read-only must not rewrite state');
    assert.equal(fs.readFileSync(stateFile + '.bak', 'utf8'), originalBak);
  } finally {
    mgr.dispose();
  }

  // A structurally broken JSON object is dropped rather than trusted, and it
  // never breaks a later prepareWait.
  const dir3 = makeTempDir();
  const coordDir = path.join(dir3, 'coord-malformed');
  fs.mkdirSync(coordDir, { recursive: true });
  fs.writeFileSync(
    path.join(coordDir, 'state.json'),
    JSON.stringify({
      version: 1,
      coordinatorSessionId: 'coord-malformed',
      head: 0,
      title: '',
      done: false,
      channels: [],
      members: [],
    }),
    'utf8'
  );
  fs.writeFileSync(path.join(coordDir, 'board.jsonl'), '{"seq":1}\n', 'utf8');
  const store = new BoardStore('coord-malformed', { baseDir: dir3 });
  try {
    assert.equal(store.messages.length, 0, 'a missing agent/text must drop the record');
    store.ensureCoordinator({});
    assert.equal(store.messages.length, 0);
    const posted = store.postMessage('coordinator', 'after malformed line');
    assert.equal(posted.message.seq, 1);
    assert.equal(store.prepareWait('coordinator', { since: 1, mentionsOnly: true }).action, 'park');
  } finally {
    store.close();
    fs.rmSync(dir3, { recursive: true, force: true });
  }
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('22. A half-written append is rolled back so the retry never loses a message', () => {
  const baseDir = makeTempDir();
  const dir = path.join(baseDir, 'coord-half');
  const boardFile = path.join(dir, 'board.jsonl');
  const store = new BoardStore('coord-half', { baseDir });
  try {
    store.ensureCoordinator({});
    store.postMessage('coordinator', 'first');

    const originalAppend = fs.appendFileSync;
    let intercepted = 0;
    fs.appendFileSync = function (file, data, encoding) {
      if (String(file) === boardFile && intercepted === 0) {
        intercepted += 1;
        originalAppend.call(fs, file, String(data).slice(0, 19), encoding);
        const err = new Error('ENOSPC: no space left on device, write');
        err.code = 'ENOSPC';
        throw err;
      }
      return originalAppend.call(fs, file, data, encoding);
    };
    try {
      assert.throws(() => store.postMessage('coordinator', 'half written'), /ENOSPC/);
    } finally {
      fs.appendFileSync = originalAppend;
    }
    assert.equal(store.state.head, 1, 'a failed append must not advance the head');
    assert.equal(store.messages.length, 1);

    store.postMessage('coordinator', 'second');
    assert.equal(store.state.head, 2);
  } finally {
    store.close();
  }

  const reopened = new BoardStore('coord-half', { baseDir });
  try {
    assert.deepEqual(
      reopened.messages.map((m) => [m.seq, m.text]),
      [
        [1, 'first'],
        [2, 'second'],
      ],
      'the retried record must not be glued onto a half-written fragment'
    );
    assert.equal(reopened.state.head, 2);
  } finally {
    reopened.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('23. turn/end respects running turns and queued inbox work; carrierKeyOf idle replays', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const postTool = env.registeredTools.get('post_message').tool;
    const readTool = env.registeredTools.get('read_board').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'busy', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    const sid = add.added[0].sessionId;
    const worker = env.agentsMap.get(sid);
    const followupsBefore = worker._debug.followups.length;

    // Host signature: session/event(session, event). The agent is still running
    // and already has a queued next turn.
    worker.status = 'running';
    worker.inbox = { nextTurn: [{ id: 'queued' }], nextStep: [], hasPending: () => true };

    const post = await postTool.execute({ text: '@busy more work' }, { agent: env.coordinatorAgent });
    assert.deepEqual(post.woken, []);
    assert.deepEqual(post.pending_wakeup, ['busy']);

    await env.ctx.emit('session/event', worker.session, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    });
    let board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    let row = board.members.find((m) => m.name === 'busy');
    assert.equal(
      row.state,
      'working',
      'a running/queued agent must never be parked by turn/end alone'
    );
    assert.equal(
      worker._debug.followups.length,
      followupsBefore,
      'turn/end must not duplicate a followup while work is still pending'
    );

    // Only a REAL idle status parks the member and replays the durable bell.
    worker.status = 'idle';
    worker.inbox = { nextTurn: [], nextStep: [], hasPending: () => false };
    const carrier = { agent: worker };
    hostPlugin.setDshScopeForTests({ carrierKeyOf: (scope) => scope.agent });
    try {
      await env.ctx.emitWithThis('agent/status', carrier, { status: 'idle' });
    } finally {
      hostPlugin.setDshScopeForTests(null);
    }
    await waitFor(
      () => worker._debug.followups.length === followupsBefore + 1,
      2000,
      'pendingWakeup replay through carrierKeyOf'
    );
    board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    row = board.members.find((m) => m.name === 'busy');
    assert.equal(row.state, 'working');
    assert.equal(row.pending_wakeup, false);

    // An idle agent with an empty inbox is still parked by the turn/end fallback.
    worker.status = 'idle';
    worker.inbox = { nextTurn: [], nextStep: [], hasPending: () => false };
    await env.ctx.emit('session/event', worker.session, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    });
    board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    row = board.members.find((m) => m.name === 'busy');
    assert.equal(row.state, 'waiting');

    // An error reason is recorded as lastError even when the member stays busy.
    // The CHILD-scoped listener (belt-and-braces path) is what moves it back to
    // working here, proving that registration exists per member context.
    const childStatus = worker._debug.childListeners.find(
      (item) => item.eventName === 'agent/status'
    );
    assert.ok(childStatus, 'each child context must register its own agent/status listener');
    childStatus.handler({ status: 'running' });
    worker.status = 'running';
    worker.inbox = { nextTurn: [{}], nextStep: [], hasPending: () => true };
    await env.ctx.emit('session/event', worker.session, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: new Error('429 quota exceeded') } },
    });
    board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    row = board.members.find((m) => m.name === 'busy');
    assert.equal(row.state, 'working');
    assert.match(row.last_error, /429 quota exceeded/);
  } finally {
    hostPlugin.setDshScopeForTests(null);
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('24. Full-lifecycle tracking: late dispose is awaited, killed members never get a followup', async () => {
  // (a) controller.dispose() must not resolve while a late handle.dispose() runs.
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const controller = env.mounted.controller;
    env.env.deferCreates = true;
    const addPromise = swarmTool.execute(
      { action: 'add', name: 'slow', brief: 'x' },
      { agent: env.coordinatorAgent }
    );
    await waitFor(() => env.createCalls.length === 1, 2000, 'create started');

    env.env.deferDispose = true;
    const disposePromise = controller.dispose();
    env.env.releaseCreateResolvers.shift()();
    await delay(40);
    let settled = false;
    disposePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await delay(40);
    assert.equal(
      settled,
      false,
      'controller.dispose() must wait for the late handle.dispose() to settle'
    );
    assert.equal(env.env.lastCreateHandle.disposed, false);
    env.env.releaseDisposeResolvers.shift()();
    await assert.rejects(() => addPromise, /取消|释放|dispose/);
    await disposePromise;
    assert.equal(settled, true);
    assert.equal(env.env.lastCreateHandle.disposed, true);
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // (b) A kill inside the wake await window must not deliver any followup.
  const dir2 = makeTempDir();
  const env2 = createMockHostEnv(dir2);
  try {
    const swarmTool = env2.registeredTools.get('swarm').tool;
    const postTool = env2.registeredTools.get('post_message').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'cold', brief: 'x' },
      { agent: env2.coordinatorAgent }
    );
    const sid = add.added[0].sessionId;
    await env2.ctx.emit('session/event', { id: sid }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    });
    env2.mounted.controller.liveHandles.delete(sid);
    env2.agentsMap.delete(sid);

    env2.env.deferResumes = true;
    const postPromise = postTool.execute({ text: '@cold wake' }, { agent: env2.coordinatorAgent });
    await waitFor(() => env2.resumeCalls.length === 1, 2000, 'resume started');
    await swarmTool.execute({ action: 'kill', name: 'cold' }, { agent: env2.coordinatorAgent });
    env2.env.releaseResumeResolvers.shift()();
    const postResult = await postPromise;
    assert.deepEqual(postResult.woken, [], 'a killed member must never be reported as woken');
    assert.equal(postResult.wake_errors.length, 1);
    assert.match(postResult.wake_errors[0].error, /取消|killed|disposed/);
    assert.equal(
      env2.env.lastResumeHandle.agent._debug.followups.length,
      0,
      'no followup may reach a member killed inside the wake window'
    );
    const board = await env2.registeredTools
      .get('read_board')
      .tool.execute({ status: true }, { agent: env2.coordinatorAgent });
    const row = board.members.find((m) => m.name === 'cold');
    assert.equal(row.state, 'killed', 'a failed wake must not resurrect a killed member');
  } finally {
    await env2.disposeAll();
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // (c) A dispose landing while the model catalog is awaited must not allocate
  // any workspace at all.
  const dir3 = makeTempDir();
  let prepareCalls = 0;
  const env3 = createMockHostEnv(dir3, process.cwd(), {
    deferModelCatalog: true,
    pluginConfig: {
      workspacePrepare: ({ mode }) => {
        prepareCalls += 1;
        return { workspace: mode, cwd: dir3, workspaceDir: dir3 };
      },
    },
  });
  try {
    const swarmTool = env3.registeredTools.get('swarm').tool;
    const addPromise = swarmTool.execute(
      { action: 'add', name: 'late', brief: 'x', model: 'custom-model', workspace: 'share' },
      { agent: env3.coordinatorAgent }
    );
    await waitFor(() => env3.env.modelCatalogStarted === true, 2000, 'model catalog started');
    const disposePromise = env3.mounted.controller.dispose();
    env3.env.releaseModelCatalogResolvers.shift()();
    await assert.rejects(() => addPromise, /已关闭|中止/);
    await disposePromise;
    assert.equal(prepareCalls, 0, 'a disposed controller must never allocate a workspace');
    assert.equal(env3.createCalls.length, 0);
  } finally {
    await env3.disposeAll();
    fs.rmSync(dir3, { recursive: true, force: true });
  }
});

test('25. workspace:"share" failure releases the fresh child handle, kills the row, sends nothing', async () => {
  // (a) The host worktree service fails: nothing may leak.
  const tmpDir = makeTempDir('dsh-swarm-wt-fail-');
  const repoDir = makeTempDir('dsh-swarm-wt-fail-repo-');
  const env = createMockHostEnv(tmpDir, repoDir, { failWorktreeCreate: true });
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const readTool = env.registeredTools.get('read_board').tool;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'wt-fail', brief: 'must not survive', workspace: 'share' },
          { agent: env.coordinatorAgent }
        ),
      /worktree|lock/i
    );
    assert.equal(env.worktreeCreateCalls.length, 1, 'the failure came from the worktree service');

    const failedHandle = env.env.lastCreateHandle;
    assert.equal(failedHandle.disposed, true, 'the fresh child handle must be disposed');
    assert.equal(
      failedHandle.agent._debug.followups.length,
      0,
      'a failed add must never deliver the initial prompt'
    );
    assert.equal(
      env.mounted.controller.liveHandles.has(failedHandle.agent.id),
      false,
      'no live handle may survive a failed share allocation'
    );
    assert.equal(env.agentsMap.get(failedHandle.agent.id), undefined, 'the agent is gone');

    const board = await readTool.execute({ status: true }, { agent: env.coordinatorAgent });
    const row = board.members.find((m) => m.name === 'wt-fail');
    assert.ok(row, 'the failed member stays on the roster so it can be audited');
    assert.equal(row.state, 'killed');
    assert.equal(row.workspace, 'share');
    const failedMember = env.mounted.controller.stores
      .resolveSession(failedHandle.agent.id)
      .store.getMember('wt-fail');
    assert.equal(failedMember.cwd, repoDir, 'the row keeps the caller cwd until a worktree exists');
    assert.equal(failedMember.workspaceDir, '', 'no worktree dir is recorded on a failed share');
    const feed = await readTool.execute({}, { agent: env.coordinatorAgent });
    assert.equal(
      feed.messages.some((m) => String(m.text).includes('@wt-fail')),
      false,
      'no brief may be posted for a member whose worktree failed'
    );
    assert.equal(
      env.coordinatorAgent.session.header.cwd,
      repoDir,
      'the coordinator cwd stays intact on a failed share'
    );
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  // (b) A host without ctx.worktrees.create must refuse loudly, not silently
  // fall back to sharing the caller's directory.
  const dir2 = makeTempDir('dsh-swarm-wt-nowt-');
  const repo2 = makeTempDir('dsh-swarm-wt-nowt-repo-');
  const env2 = createMockHostEnv(dir2, repo2);
  try {
    delete env2.ctx.worktrees;
    const swarmTool = env2.registeredTools.get('swarm').tool;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'no-service', brief: 'x', workspace: 'share' },
          { agent: env2.coordinatorAgent }
        ),
      /未提供 ctx\.worktrees\.create/
    );
    assert.equal(env2.env.lastCreateHandle.disposed, true);
    assert.equal(env2.mounted.controller.liveHandles.size, 0);
    const board = await env2.registeredTools
      .get('read_board')
      .tool.execute({ status: true }, { agent: env2.coordinatorAgent });
    assert.equal(board.members.find((m) => m.name === 'no-service').state, 'killed');
  } finally {
    await env2.disposeAll();
    fs.rmSync(dir2, { recursive: true, force: true });
    fs.rmSync(repo2, { recursive: true, force: true });
  }

  // (c) An injected workspacePrepare stub is honoured instead of the host
  // service, and its path becomes the member cwd.
  const dir3 = makeTempDir('dsh-swarm-wt-stub-');
  const stubPath = path.join(dir3, 'stub-worktree');
  const prepareArgs = [];
  const env3 = createMockHostEnv(dir3, dir3, {
    pluginConfig: {
      workspacePrepare: (input) => {
        prepareArgs.push(input);
        return { cwd: stubPath, workspaceDir: stubPath };
      },
    },
  });
  try {
    const add = await env3.registeredTools
      .get('swarm')
      .tool.execute(
        { action: 'add', name: 'stub-ws', brief: 'x', workspace: 'share' },
        { agent: env3.coordinatorAgent }
      );
    assert.equal(env3.worktreeCreateCalls.length, 0, 'the stub replaces the host service');
    assert.equal(prepareArgs.length, 1);
    assert.equal(prepareArgs[0].mode, 'share');
    assert.equal(prepareArgs[0].memberName, 'stub-ws');
    assert.equal(prepareArgs[0].baseCwd, dir3);
    assert.match(prepareArgs[0].branchName, /^swarm-[0-9a-f]{8}-stub-ws-[0-9a-f]{4}$/);
    assert.ok(prepareArgs[0].agent, 'the stub receives the freshly created child agent');
    assert.equal(add.added[0].cwd, stubPath);
    const member = env3.mounted.controller.stores
      .resolveSession(add.added[0].sessionId)
      .store.getMember('stub-ws');
    assert.equal(member.workspaceDir, stubPath);
    assert.equal(
      env3.agentsMap.get(add.added[0].sessionId)._debug.getAssignedCwd(),
      stubPath,
      'the child cwd is switched to the stub path'
    );
  } finally {
    await env3.disposeAll();
    fs.rmSync(dir3, { recursive: true, force: true });
  }
});

test('26. Both parseSwarmRequest sides agree, and the feed follows a long incoming message', () => {
  // Unknown keys and untrimmed whitespace are rejected identically on both ends.
  assert.throws(
    () => protocol.parseSwarmRequest('getSwarmSnapshot', { sessionId: ' good ' }),
    TypeError
  );
  assert.throws(
    () => clientMod.parseSwarmRequest({ sessionId: ' good ' }),
    (err) => err.code === 'DSH_SWARM_INVALID_REQUEST'
  );
  assert.throws(
    () => protocol.parseSwarmRequest('getSwarmSnapshot', { sessionId: 'good', extra: 1 }),
    TypeError
  );
  assert.throws(
    () => clientMod.parseSwarmRequest({ sessionId: 'good', extra: 1 }),
    (err) => err.code === 'DSH_SWARM_INVALID_REQUEST'
  );
  assert.throws(
    () => clientMod.parseSwarmRequest({ sessionId: 'good', __proto__probe: 1 }),
    /unexpected key/
  );
  assert.deepEqual(protocol.parseSwarmRequest('getSwarmSnapshot', { sessionId: 'good' }), {
    sessionId: 'good',
  });
  assert.deepEqual(clientMod.parseSwarmRequest({ sessionId: 'good' }), { sessionId: 'good' });
  assert.throws(() => clientMod.parseSwarmRequest({}), /sessionId/);
  assert.throws(() => clientMod.parseSwarmRequest(null), /request/);

  // Stick-to-bottom: the flag is captured from the REAL scroll position, so a
  // long new message that grows scrollHeight by 200px still follows.
  const stick = { current: true };
  const el = { scrollHeight: 500, scrollTop: 400, clientHeight: 100 };
  assert.equal(clientMod.isNearBottom(el), true);
  assert.equal(clientMod.followStickToBottom(stick, el), true);
  assert.equal(el.scrollTop, 500);

  el.scrollHeight = 700;
  assert.equal(
    clientMod.followStickToBottom(stick, el),
    true,
    'a reader parked at the bottom must follow a message taller than the threshold'
  );
  assert.equal(el.scrollTop, 700);

  el.scrollTop = 100;
  assert.equal(clientMod.applyStickToBottomOnScroll(stick, el), false);
  el.scrollHeight = 900;
  assert.equal(clientMod.followStickToBottom(stick, el), false, 'history reading must not be yanked');
  assert.equal(el.scrollTop, 100);

  el.scrollTop = 800;
  assert.equal(clientMod.applyStickToBottomOnScroll(stick, el), true);
  el.scrollHeight = 1100;
  assert.equal(clientMod.followStickToBottom(stick, el), true);
  assert.equal(el.scrollTop, 1100);
});

/**
 * Load an isolated copy of board-store.js.
 *
 * The module-level WRITER_LOCKS registry is per module instance, so a second
 * copy gives two stores inside ONE process exactly the isolation two real
 * processes have. The cached module is restored afterwards so every other test
 * keeps using the shared instance.
 */
function loadIsolatedBoardStoreModule() {
  const modPath = require.resolve('../src/board-store.js');
  const cached = require.cache[modPath];
  delete require.cache[modPath];
  try {
    return require('../src/board-store.js');
  } finally {
    if (cached) require.cache[modPath] = cached;
  }
}

test('27. Stale-lock takeover is serialized across module copies (no TOCTOU double writer)', () => {
  const DEAD_PID = 999999;
  const isolated = loadIsolatedBoardStoreModule();
  const BoardStoreB = isolated.BoardStore;
  assert.notEqual(BoardStoreB, BoardStore, 'the second copy must own its own WRITER_LOCKS registry');

  // A pid the OS PROVES dead: every liveness probe of 999999 raises ESRCH.
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === DEAD_PID) {
      const err = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    }
    return originalKill.call(process, pid, signal);
  };

  try {
    // ---------------------------------------------------------------
    // Interleaving 1: B completes the whole takeover while A sits between
    // its failed 'wx' create and the reclaim gate. A therefore holds NO lock
    // snapshot when it finally enters the gate; acting on one would delete the
    // lock B just created.
    // ---------------------------------------------------------------
    {
      const baseDir = makeTempDir('dsh-swarm-toctou-');
      const dirOne = path.join(baseDir, 'coord-toctou-1');
      fs.mkdirSync(dirOne, { recursive: true });
      const lockOne = path.join(dirOne, 'writer.lock');
      const gateOne = path.join(dirOne, 'writer.lock.reclaim');
      const boardOne = path.join(dirOne, 'board.jsonl');
      fs.writeFileSync(
        lockOne,
        JSON.stringify({ pid: DEAD_PID, ownerId: 'dead-owner', acquiredAt: 1 }),
        'utf8'
      );

      const storeA = new BoardStore('coord-toctou-1', { baseDir });
      const storeB = new BoardStoreB('coord-toctou-1', { baseDir });
      const originalOpen = fs.openSync;
      let interleaved = false;
      let interleaveError = null;
      fs.openSync = function openSyncHook(...args) {
        try {
          return originalOpen.apply(fs, args);
        } catch (err) {
          if (
            !interleaved &&
            String(args[0]) === lockOne &&
            args[1] === 'wx' &&
            err &&
            err.code === 'EEXIST'
          ) {
            interleaved = true;
            // A has just failed the create and has not entered the gate yet:
            // B wins the entire takeover while A is descheduled right here.
            try {
              storeB.ensureCoordinator({});
              storeB.postMessage('coordinator', 'B-first');
            } catch (innerErr) {
              interleaveError = innerErr;
            }
          }
          throw err;
        }
      };

      try {
        let refusalA = null;
        try {
          storeA.ensureCoordinator({});
        } catch (err) {
          refusalA = err;
        } finally {
          fs.openSync = originalOpen;
        }

        assert.equal(interleaveError, null);
        assert.equal(interleaved, true, 'the interleaving hook must have run');
        assert.ok(refusalA, 'A must be refused once B owns the lock');
        assert.match(refusalA.message, /锁定|双写者|接管/);
        assert.equal(storeA.lockHeld, false, 'the loser must never believe it holds the lock');
        assert.equal(storeB.lockHeld, true);
        assert.ok(
          !(storeA.lockHeld && storeB.lockHeld),
          'two writers must never hold the same lock at once'
        );

        const ownerOne = JSON.parse(fs.readFileSync(lockOne, 'utf8'));
        assert.equal(ownerOne.ownerId, storeB.ownerId, 'A must never delete the lock B created');
        assert.equal(fs.existsSync(gateOne), false, 'the reclaim gate must be released');

        // The winner keeps writing: seq 2 must follow its own in-memory head.
        storeB.postMessage('coordinator', 'B-second');
        assert.equal(storeB.state.head, 2);

        const readerOne = new BoardStore('coord-toctou-1', { baseDir });
        assert.deepEqual(
          readerOne.messages.map((m) => m.seq),
          [1, 2],
          'seqs must stay unique and monotonic (never [1, 2, 2])'
        );
        assert.deepEqual(
          readerOne.messages.map((m) => m.text),
          ['B-first', 'B-second']
        );
        assert.equal(
          fs.readFileSync(boardOne, 'utf8').trim().split('\n').filter(Boolean).length,
          2
        );
      } finally {
        fs.openSync = originalOpen;
        try {
          storeA.close();
        } catch {}
        try {
          storeB.close();
        } catch {}
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    }

    // ---------------------------------------------------------------
    // Interleaving 2: B tries to take over INSIDE A's reclaim critical
    // section. A holds the gate, so B must fail closed; A re-reads the same
    // stale lock and wins the takeover alone.
    // ---------------------------------------------------------------
    {
      const baseDir2 = makeTempDir('dsh-swarm-toctou-');
      const dirTwo = path.join(baseDir2, 'coord-toctou-2');
      fs.mkdirSync(dirTwo, { recursive: true });
      const lockTwo = path.join(dirTwo, 'writer.lock');
      const gateTwo = path.join(dirTwo, 'writer.lock.reclaim');
      const boardTwo = path.join(dirTwo, 'board.jsonl');
      fs.writeFileSync(
        lockTwo,
        JSON.stringify({ pid: DEAD_PID, ownerId: 'dead-owner', acquiredAt: 1 }),
        'utf8'
      );

      const storeC = new BoardStore('coord-toctou-2', { baseDir: baseDir2 });
      const storeD = new BoardStoreB('coord-toctou-2', { baseDir: baseDir2 });
      const originalRead = fs.readFileSync;
      let gateInterleaved = false;
      let refusalD = null;
      fs.readFileSync = function readFileSyncHook(...args) {
        // Hand the pre-interleaving snapshot to the caller, THEN let the
        // competitor run: this is exactly the "stale snapshot in hand" window.
        const value = originalRead.apply(fs, args);
        if (!gateInterleaved && String(args[0]) === lockTwo) {
          gateInterleaved = true;
          try {
            storeD.ensureCoordinator({});
            storeD.postMessage('coordinator', 'D-first');
          } catch (err) {
            refusalD = err;
          }
        }
        return value;
      };

      try {
        storeC.ensureCoordinator({});
        storeC.postMessage('coordinator', 'C-first');
        storeC.postMessage('coordinator', 'C-second');
      } finally {
        fs.readFileSync = originalRead;
      }

      try {
        assert.equal(gateInterleaved, true, 'the gate interleaving hook must have run');
        assert.ok(refusalD, 'a competitor inside the gate must be refused');
        assert.match(refusalD.message, /接管|锁定|双写者/);
        assert.equal(storeC.lockHeld, true);
        assert.equal(storeD.lockHeld, false);
        assert.ok(
          !(storeC.lockHeld && storeD.lockHeld),
          'the gate must let exactly one writer through'
        );
        assert.equal(fs.existsSync(gateTwo), false, 'the gate must be released by its owner');

        const ownerTwo = JSON.parse(fs.readFileSync(lockTwo, 'utf8'));
        assert.equal(ownerTwo.ownerId, storeC.ownerId);

        const readerTwo = new BoardStore('coord-toctou-2', { baseDir: baseDir2 });
        assert.deepEqual(
          readerTwo.messages.map((m) => m.seq),
          [1, 2],
          'only the gate winner may extend the feed'
        );
        assert.deepEqual(
          readerTwo.messages.map((m) => m.text),
          ['C-first', 'C-second']
        );
        assert.equal(
          fs.readFileSync(boardTwo, 'utf8').trim().split('\n').filter(Boolean).length,
          2
        );
      } finally {
        try {
          storeC.close();
        } catch {}
        try {
          storeD.close();
        } catch {}
        fs.rmSync(baseDir2, { recursive: true, force: true });
      }
    }

    // ---------------------------------------------------------------
    // 3. The lock is the only cross-process truth: if it is deleted
    // externally, a cached head must abort the write instead of blindly
    // re-emitting the seq the disk already holds. The next write re-locks and
    // adopts the on-disk head, so the feed stays unique.
    // ---------------------------------------------------------------
    {
      const baseDir3 = makeTempDir('dsh-swarm-toctou-');
      const storeE = new BoardStore('coord-toctou-3', { baseDir: baseDir3 });
      try {
        storeE.ensureCoordinator({});
        storeE.postMessage('coordinator', 'E-first');
        const lockThree = path.join(baseDir3, 'coord-toctou-3', 'writer.lock');
        fs.unlinkSync(lockThree);
        assert.throws(
          () => storeE.postMessage('coordinator', 'E-lost'),
          /写锁已丢失|序号唯一性/,
          'a write beneath a lock we no longer own must abort'
        );
        assert.equal(storeE.lockHeld, false, 'a lost lock must drop the cached flag');
        assert.equal(storeE.state.head, 1, 'the aborted write must not advance head');

        storeE.postMessage('coordinator', 'E-recovered');
        assert.equal(storeE.state.head, 2, 'the re-locked writer adopts the disk head');
        const readerE = new BoardStore('coord-toctou-3', { baseDir: baseDir3 });
        assert.deepEqual(
          readerE.messages.map((m) => m.seq),
          [1, 2],
          'an externally deleted lock must never produce a duplicate seq'
        );
        assert.deepEqual(
          readerE.messages.map((m) => m.text),
          ['E-first', 'E-recovered']
        );
      } finally {
        try {
          storeE.close();
        } catch {}
        fs.rmSync(baseDir3, { recursive: true, force: true });
      }
    }

    // ---------------------------------------------------------------
    // 4. A gate left behind by a crashed reclaimer fails closed: it is never
    // force-deleted (that would hand the same TOCTOU to whoever deletes it)
    // and the stale lock stays untouched for manual cleanup.
    // ---------------------------------------------------------------
    {
      const baseDir4 = makeTempDir('dsh-swarm-toctou-');
      const dirFour = path.join(baseDir4, 'coord-toctou-4');
      fs.mkdirSync(dirFour, { recursive: true });
      const staleLockFour = path.join(dirFour, 'writer.lock');
      fs.writeFileSync(
        staleLockFour,
        JSON.stringify({ pid: DEAD_PID, ownerId: 'dead-owner', acquiredAt: 1 }),
        'utf8'
      );
      const orphanGate = path.join(dirFour, 'writer.lock.reclaim');
      fs.writeFileSync(
        orphanGate,
        JSON.stringify({ pid: 4242, ownerId: 'crashed-reclaimer' }),
        'utf8'
      );
      const blockedByGate = new BoardStore('coord-toctou-4', { baseDir: baseDir4 });
      try {
        assert.throws(() => blockedByGate.ensureCoordinator({}), /接管临界区|双写者|锁定/);
        assert.equal(blockedByGate.lockHeld, false);
      } finally {
        try {
          blockedByGate.close();
        } catch {}
      }
      assert.equal(fs.existsSync(orphanGate), true, 'an orphan gate must never be force-deleted');
      assert.equal(
        JSON.parse(fs.readFileSync(staleLockFour, 'utf8')).ownerId,
        'dead-owner',
        'the stale lock must stay untouched while a gate is orphaned'
      );
      fs.rmSync(baseDir4, { recursive: true, force: true });
    }

    // ---------------------------------------------------------------
    // 5. A gate WE created is always released, even when stamping the gate
    // itself fails: an I/O error must never leave a permanent reclaim gate
    // that would block every future takeover.
    // ---------------------------------------------------------------
    {
      const baseDir5 = makeTempDir('dsh-swarm-toctou-');
      const dirFive = path.join(baseDir5, 'coord-toctou-5');
      fs.mkdirSync(dirFive, { recursive: true });
      const lockFive = path.join(dirFive, 'writer.lock');
      const gateFive = path.join(dirFive, 'writer.lock.reclaim');
      fs.writeFileSync(
        lockFive,
        JSON.stringify({ pid: DEAD_PID, ownerId: 'dead-owner', acquiredAt: 1 }),
        'utf8'
      );

      const storeF = new BoardStore('coord-toctou-5', { baseDir: baseDir5 });
      const originalOpenFive = fs.openSync;
      const originalWriteFive = fs.writeSync;
      let gateFdValue = null;
      fs.openSync = function openGateHook(...args) {
        const fd = originalOpenFive.apply(fs, args);
        if (String(args[0]) === gateFive && args[1] === 'wx') gateFdValue = fd;
        return fd;
      };
      fs.writeSync = function writeGateHook(...args) {
        if (gateFdValue !== null && args[0] === gateFdValue) {
          const err = new Error('ENOSPC: gate stamp failed');
          err.code = 'ENOSPC';
          throw err;
        }
        return originalWriteFive.apply(fs, args);
      };
      try {
        assert.throws(() => storeF.ensureCoordinator({}), /ENOSPC/);
      } finally {
        fs.openSync = originalOpenFive;
        fs.writeSync = originalWriteFive;
      }
      assert.equal(storeF.lockHeld, false);
      assert.equal(fs.existsSync(gateFive), false, 'a gate we created is always released');
      assert.equal(
        JSON.parse(fs.readFileSync(lockFive, 'utf8')).ownerId,
        'dead-owner',
        'a failed takeover must leave the stale lock untouched'
      );
      fs.rmSync(baseDir5, { recursive: true, force: true });
    }
  } finally {
    process.kill = originalKill;
  }
});

test('28. [done] post suppresses zombie wakeups, exposes done in snapshot, and releases writer.lock', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const postTool = env.registeredTools.get('post_message').tool;
    const waitTool = env.registeredTools.get('swarm_wait').tool;
    const remoteSvc = env.providedServices.get('dsh-swarm');

    const addW1 = await swarmTool.execute(
      { action: 'add', name: 'world-forge', brief: 'Build world module' },
      { agent: env.coordinatorAgent }
    );
    const addW2 = await swarmTool.execute(
      { action: 'add', name: 'hud-craft', brief: 'Build HUD module' },
      { agent: env.coordinatorAgent }
    );
    const w1 = env.agentsMap.get(addW1.added[0].sessionId);
    const w2 = env.agentsMap.get(addW2.added[0].sessionId);

    // Park both workers as sleeping.
    await waitTool.execute({ since: 2 }, { agent: w1, concludeTurn: () => {} });
    await waitTool.execute({ since: 2 }, { agent: w2, concludeTurn: () => {} });
    const w1FollowupsBefore = w1._debug.followups.length;
    const w2FollowupsBefore = w2._debug.followups.length;

    // Coordinator posts [done] while mentioning both workers: neither may be woken!
    const donePost = await postTool.execute(
      { text: '[done] All modules verified. @world-forge @hud-craft great job!' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(donePost.marked_done, true);
    assert.deepEqual(donePost.woken, [], '[done] must never wake sleeping workers');
    assert.equal(w1._debug.followups.length, w1FollowupsBefore);
    assert.equal(w2._debug.followups.length, w2FollowupsBefore);

    // Snapshot carries done: true on both Host and Client normalizers.
    const snap = await remoteSvc.getSwarmSnapshot({ sessionId: env.coordinatorAgent.id });
    assert.equal(snap.done, true);
    assert.equal(clientMod.normalizeSwarmSnapshot(snap).done, true);
    const coordRow = snap.members.find((m) => m.name === 'coordinator');
    assert.equal(coordRow.state, 'stopped', 'settled coordinator becomes stopped');

    // Kill remaining workers and finish coordinator turn: writer.lock is released
    // and no-op step/end or idle events do not recreate it.
    await swarmTool.execute({ action: 'kill', name: 'world-forge' }, { agent: env.coordinatorAgent });
    await swarmTool.execute({ action: 'kill', name: 'hud-craft' }, { agent: env.coordinatorAgent });
    const lockPath = path.join(tmpDir, env.coordinatorAgent.id, 'writer.lock');
    assert.equal(fs.existsSync(lockPath), false, 'writer.lock must be released once swarm is done');

    await env.ctx.emit('session/event', { id: env.coordinatorAgent.id }, { type: 'step/end', data: { step: 1 } });
    env.mounted.controller.handleMemberIdle(env.coordinatorAgent.id);
    assert.equal(fs.existsSync(lockPath), false, 'no-op post-done idle events must not recreate writer.lock');
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('29. /swarm puts rawInput first (clean title), syncs sessionTitle.rename, and registers SwarmCommandView', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  const renamedTitles = [];
  env.ctx.sessionTitle = {
    rename(session, title) {
      renamedTitles.push({ sessionId: session.id, title });
    },
  };
  try {
    const cmd = env.registeredCommands.get('swarm');
    const res = cmd.handler({
      agent: env.coordinatorAgent,
      rawInput: '制作一个html网页，内容是跑酷3d游戏，第一人称，精美',
      attachments: [],
    });
    assert.equal(res.kind, 'success');
    assert.equal(env.coordinatorAgent._debug.followups.length, 1);
    const userFollowup = env.coordinatorAgent._debug.followups[0];
    assert.deepEqual(userFollowup.source, { kind: 'user' });
    const firstText = userFollowup.content[0].text;
    assert.equal(
      firstText,
      '制作一个html网页，内容是跑酷3d游戏，第一人称，精美',
      'user message must remain the exact untouched rawInput without inline skill instructions'
    );
    assert.doesNotMatch(firstText, /<skill_content/);

    // Verify agent/pre-step injects the coordinator skill as a separate skill-invocation context message
    const [preStepDecision] = await env.ctx.emit(
      'agent/pre-step',
      { agent: env.coordinatorAgent, messages: [userFollowup], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [userFollowup] })
    );
    assert.equal(preStepDecision.kind, 'enter');
    assert.equal(preStepDecision.messages.length, 2);
    assert.equal(preStepDecision.messages[0], userFollowup);
    const injected = preStepDecision.messages[1];
    assert.deepEqual(injected.source, {
      kind: 'skill-invocation',
      name: 'swarm',
      form: 'instructions',
    });
    assert.match(injected.content[0].text, /<skill_content name="swarm">/);
    assert.match(injected.content[0].text, new RegExp('dsh-resource://swarm/coord-session-001'));

    const swarmTool = env.registeredTools.get('swarm').tool;
    await swarmTool.execute(
      { action: 'title', title: '霓虹跑酷 · 3D 第一人称跑酷页' },
      { agent: env.coordinatorAgent }
    );
    assert.deepEqual(renamedTitles, [
      { sessionId: env.coordinatorAgent.id, title: '霓虹跑酷 · 3D 第一人称跑酷页' },
    ]);

    // Verify Client registers conversation.chat.commandview (key: 'swarm') and renders done UI.
    const slotRegs = [];
    const mockReact = {
      Fragment: Symbol('Fragment'),
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
    };
    const clientCtx = {
      slots: {
        register(spec, comp) {
          slotRegs.push({ spec, comp });
          return () => {};
        },
      },
    };
    const pluginInstance = new clientMod.SwarmClientPlugin(clientCtx, { React: mockReact });
    try {
      const cmdSlot = slotRegs.find(
        (r) => r.spec.name === 'conversation.chat.commandview' && r.spec.key === 'swarm'
      );
      assert.ok(cmdSlot, 'client must register SwarmCommandView on conversation.chat.commandview');
      const tree = cmdSlot.comp({
        sessionId: 'coord-session-001',
        node: { name: 'swarm', args: 'build game', outcome: { kind: 'success', text: '已启动' } },
      });
      const serialized = JSON.stringify(tree);
      assert.match(serialized, /留言流/);
      assert.match(serialized, /拓扑图/);
    } finally {
      await pluginInstance.dispose();
    }
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('30. cordis-ptc activity formatting: JSON-string arguments, run_code description, and ptc-dispatch-start', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    assert.equal(
      hostPlugin.formatToolActivity({
        name: 'run_code',
        arguments: JSON.stringify({ code: 'return 1;', description: '探测网络与 three.js 可用性' }),
      }),
      'run_code: 探测网络与 three.js 可用性'
    );
    assert.equal(
      hostPlugin.formatToolActivity({
        name: 'edit',
        arguments: { file_path: 'src/world.js' },
      }),
      'edit (world.js)'
    );
    assert.equal(
      hostPlugin.formatToolActivity({
        name: 'swarm',
        arguments: { action: 'add', name: 'world-forge' },
      }),
      'swarm:add (world-forge)'
    );

    const swarmTool = env.registeredTools.get('swarm').tool;
    const add = await swarmTool.execute(
      { action: 'add', name: 'fx-forge', brief: 'Write fx.js' },
      { agent: env.coordinatorAgent }
    );
    const workerId = add.added[0].sessionId;
    await env.ctx.emit(
      'session/event',
      { id: workerId },
      {
        type: 'tool/call',
        data: { name: 'run_code', arguments: '{"code":"...","description":"编译着色器并跑单测"}' },
      }
    );
    let snap = env.mounted.controller.getSwarmSnapshot(env.coordinatorAgent.id);
    assert.equal(snap.members.find((m) => m.name === 'fx-forge').activity, 'run_code: 编译着色器并跑单测');

    await env.ctx.emit(
      'session/event',
      { id: workerId },
      {
        type: 'tool/ptc-dispatch-start',
        data: { name: 'edit', arguments: { file_path: 'src/fx.js' } },
      }
    );
    snap = env.mounted.controller.getSwarmSnapshot(env.coordinatorAgent.id);
    assert.equal(snap.members.find((m) => m.name === 'fx-forge').activity, 'edit (fx.js)');
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('31. Working member receives next-step inject notice on mid-turn doorbell without duplicate idle wakeup', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const postTool = env.registeredTools.get('post_message').tool;
    const readTool = env.registeredTools.get('read_board').tool;

    const add = await swarmTool.execute(
      { action: 'add', name: 'player-core', brief: 'Implement player physics' },
      { agent: env.coordinatorAgent }
    );
    const worker = env.agentsMap.get(add.added[0].sessionId);
    worker.status = 'running';

    const patchPost = await postTool.execute(
      { text: '@player-core Contract patch v1: handle boost cooldown inside player.js' },
      { agent: env.coordinatorAgent }
    );
    assert.deepEqual(patchPost.pending_wakeup, ['player-core']);
    assert.deepEqual(patchPost.step_notified, ['player-core']);
    assert.equal(worker._debug.injectedNextStep.length, 1);
    assert.match(worker._debug.injectedNextStep[0].content[0].text, /留言板实时提醒/);

    // A second post before the next step claims inbox must not spam a second notice.
    await postTool.execute(
      { text: '@player-core Also expose standingCollider' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(worker._debug.injectedNextStep.length, 1);

    // Simulate worker consuming nextStep and calling read_board before its turn ends:
    worker._debug.injectedNextStep.length = 0;
    worker.status = 'idle';
    await readTool.execute({ since: 1, limit: 20 }, { agent: worker });
    const followupsBeforeIdle = worker._debug.followups.length;
    env.mounted.controller.handleMemberIdle(worker.id);
    await delay(25);
    assert.equal(
      worker._debug.followups.length,
      followupsBeforeIdle,
      'reading the board mid-turn must clear pendingWakeup without a duplicate turn'
    );
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('32. wait_for barrier waits for all peers (with stall fallback), and inline/fenced code @mentions are ignored', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    // 1. Code-quoted @mentions do not ring doorbells or add graph edges.
    const members = new Map([
      ['coordinator', {}],
      ['world-forge', {}],
      ['verifier', {}],
    ]);
    const parsed = parseMessageDoorbells(
      '@world-forge 完成后发帖 `@coordinator`，切勿抄送 `@verifier`\n```js\n// @all @verifier\n```',
      members,
      new Map([['main', {}]])
    );
    assert.deepEqual(parsed.mentions, ['world-forge']);
    assert.equal(parsed.broadcast, false);

    // 2. wait_for barrier holds wakeup until ALL listed workers report.
    const swarmTool = env.registeredTools.get('swarm').tool;
    const postTool = env.registeredTools.get('post_message').tool;
    const waitTool = env.registeredTools.get('swarm_wait').tool;

    const a1 = await swarmTool.execute(
      { action: 'add', name: 'w-one', brief: 'Slice 1' },
      { agent: env.coordinatorAgent }
    );
    const a2 = await swarmTool.execute(
      { action: 'add', name: 'w-two', brief: 'Slice 2' },
      { agent: env.coordinatorAgent }
    );
    const w1 = env.agentsMap.get(a1.added[0].sessionId);
    const w2 = env.agentsMap.get(a2.added[0].sessionId);

    let concluded = 0;
    const waitRes = await waitTool.execute(
      { since: 2, wait_for: ['w-one', 'w-two'] },
      { agent: env.coordinatorAgent, concludeTurn: () => { concluded++; } }
    );
    assert.equal(waitRes.status, 'waiting');
    assert.deepEqual(waitRes.wait_for, ['w-one', 'w-two']);
    assert.equal(concluded, 1);

    const coordFollowupsBase = env.coordinatorAgent._debug.followups.length;

    // First worker finishes: coordinator must stay asleep!
    const p1 = await postTool.execute(
      { text: '@coordinator w-one finished slice 1' },
      { agent: w1 }
    );
    assert.deepEqual(p1.woken, [], 'first peer alone must NOT wake coordinator waiting on both');
    await waitTool.execute({ since: 3 }, { agent: w1, concludeTurn: () => {} });
    assert.equal(env.coordinatorAgent._debug.followups.length, coordFollowupsBase);

    // Second worker finishes: coordinator wakes ONCE with BOTH #3 and #4 in batch!
    const p2 = await postTool.execute(
      { text: '@coordinator w-two finished slice 2' },
      { agent: w2 }
    );
    assert.deepEqual(p2.woken, ['coordinator']);
    assert.equal(env.coordinatorAgent._debug.followups.length, coordFollowupsBase + 1);
    const combinedPrompt = env.coordinatorAgent._debug.followups.at(-1).content[0].text;
    assert.match(combinedPrompt, /w-one finished slice 1/);
    assert.match(combinedPrompt, /w-two finished slice 2/);

    // 3. Stall deadlock guard: if a waited worker errors/idles without posting, barrier unblocks.
    await waitTool.execute({ since: 4 }, { agent: w2, concludeTurn: () => {} });
    const a3 = await swarmTool.execute(
      { action: 'add', name: 'w-three', brief: 'Slice 3' },
      { agent: env.coordinatorAgent }
    );
    const w3 = env.agentsMap.get(a3.added[0].sessionId);
    await waitTool.execute(
      { since: 5, wait_for: ['w-three'] },
      { agent: env.coordinatorAgent, concludeTurn: () => {} }
    );
    const beforeStallFollowups = env.coordinatorAgent._debug.followups.length;
    // w-three crashes/stops without posting
    await env.ctx.emit(
      'session/event',
      { id: w3.id },
      { type: 'turn/end', data: { reason: { kind: 'error', error: new Error('OOM') } } }
    );
    await waitFor(() => env.coordinatorAgent._debug.followups.length === beforeStallFollowups + 1, 1000, 'stalled barrier wakeup');
    assert.match(env.coordinatorAgent._debug.followups.at(-1).content[0].text, /w-three/);
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('33. Adversarial edge cases: unlocked precheck, multi-backtick spans, peer handoff vs report, stale pendingWakeup, strict client codec, and reopen after done', async () => {
  const tmpDir = makeTempDir();
  try {
    // (A) P0-1: Unlocked updateMemberRuntimeState must reload disk state before short-circuiting.
    {
      const storeA = new BoardStore('coord-precheck', { baseDir: tmpDir });
      storeA.ensureCoordinator({});
      storeA.registerMember({ name: 'w1', sessionId: 'sess-w1' });
      storeA.updateMemberRuntimeState('sess-w1', { lastError: '' });
      storeA.releaseWriterLock();

      const storeB = new BoardStore('coord-precheck', { baseDir: tmpDir });
      storeB.updateMemberRuntimeState('sess-w1', { lastError: 'new error' });
      storeB.releaseWriterLock();

      storeA.updateMemberRuntimeState('sess-w1', { lastError: '' });
      storeA.releaseWriterLock();
      const reader = new BoardStore('coord-precheck', { baseDir: tmpDir });
      assert.equal(
        reader.getMember('w1').lastError,
        '',
        'unlocked storeA must observe disk change and write the cleared lastError'
      );
      storeA.close();
      storeB.close();
    }

    // (B) P0-2: Double-backtick inline code wrapping single backticks must neither leak inner @w1 nor swallow outer @coordinator.
    {
      const roster = new Map([
        ['coordinator', {}],
        ['w1', {}],
      ]);
      const tricky = '`` `@w1` `` @coordinator `x`';
      const parsed = parseMessageDoorbells(tricky, roster, new Map([['main', {}]]));
      assert.deepEqual(parsed.mentions, ['coordinator']);

      const graph = clientMod.buildMentionGraph({
        hasSwarm: true,
        done: false,
        coordinatorSessionId: 'c1',
        title: 't',
        head: 1,
        updatedAt: 1,
        channels: [{ name: 'main', topic: '', archived: false, createdBy: 'coordinator', subscribers: ['coordinator', 'w1'] }],
        members: [{ name: 'w1', sessionId: 's1', role: 'worker', state: 'waiting' }],
        // Force raw-text fallback by omitting mentions array:
        messages: [{ seq: 1, channel: 'main', agent: 'w1', text: tricky }],
      });
      assert.deepEqual(graph.edges.map((e) => e.id), ['w1->coordinator']);
    }

    // (C) P1-1: wait_for in mentionsOnly mode ignores intermediate @peer handoffs, AND unblocks if all peers park after plain posts without @.
    {
      const envDir = makeTempDir();
      const env = createMockHostEnv(envDir);
      try {
        const swarmTool = env.registeredTools.get('swarm').tool;
        const postTool = env.registeredTools.get('post_message').tool;
        const waitTool = env.registeredTools.get('swarm_wait').tool;

        const r1 = await swarmTool.execute({ action: 'add', name: 'w1', brief: 's1' }, { agent: env.coordinatorAgent });
        const r2 = await swarmTool.execute({ action: 'add', name: 'w2', brief: 's2' }, { agent: env.coordinatorAgent });
        const w1 = env.agentsMap.get(r1.added[0].sessionId);
        const w2 = env.agentsMap.get(r2.added[0].sessionId);

        await waitTool.execute({ since: 2, wait_for: ['w1', 'w2'] }, { agent: env.coordinatorAgent, concludeTurn: () => {} });
        const baseFollowups = env.coordinatorAgent._debug.followups.length;

        // w1 sends an intermediate handoff ONLY to @w2 (still working, has not reported to @coordinator):
        await postTool.execute({ text: '@w2 schema is ready for you' }, { agent: w1 });
        // w2 finishes and reports to @coordinator: coordinator must NOT wake yet because w1 has not reported to @coordinator!
        const w2Report = await postTool.execute({ text: '@coordinator w2 finished' }, { agent: w2 });
        assert.deepEqual(w2Report.woken, [], 'intermediate @w2 handoff by w1 must not satisfy coordinator barrier');
        await waitTool.execute({ since: 4 }, { agent: w2, concludeTurn: () => {} });
        assert.equal(env.coordinatorAgent._debug.followups.length, baseFollowups);

        // Now w1 finishes WITHOUT remembering @coordinator (plain post) and parks via swarm_wait:
        await postTool.execute({ text: 'w1 finished too (forgot mention)' }, { agent: w1 });
        await waitTool.execute({ since: 5 }, { agent: w1, concludeTurn: () => {} });
        await waitFor(() => env.coordinatorAgent._debug.followups.length === baseFollowups + 1, 1000, 'plain-post stall fallback wakeup');
        assert.match(env.coordinatorAgent._debug.followups.at(-1).content[0].text, /w1/);
      } finally {
        await env.disposeAll();
        fs.rmSync(envDir, { recursive: true, force: true });
      }
    }

    // (D) P1-2: ackWakeDelivery + readBoard cursor advancement must not leave stale pendingWakeup that fires on plain post #3.
    {
      const store = new BoardStore('coord-ack', { baseDir: tmpDir });
      store.ensureCoordinator({});
      store.registerMember({ name: 'w1', sessionId: 's-w1' });
      store.prepareWait('w1', { since: 0 });
      store.postMessage('coordinator', '@w1 task #1');
      const began = store.beginWakeDelivery('w1');
      assert.equal(began.maxSeq, 1);
      store.postMessage('coordinator', '@w1 urgent #2');
      // w1 reads #2 mid-delivery before ack(1) runs:
      store.readBoard('w1', { since: 1, limit: 10 });
      const acked = store.ackWakeDelivery('w1', began.maxSeq);
      assert.equal(acked.pendingWakeup, false, 'already-read #2 must not leave pendingWakeup=true');
      // Plain post #3 without @w1 arrives; w1 must NOT get a wake batch:
      store.postMessage('coordinator', 'plain status note #3');
      assert.equal(store.beginWakeDelivery('w1'), null);
      store.close();
    }

    // (E) P1-3: Client codec strictly strips undefined-bearing fields into lossless JSON.
    {
      const resCodec = clientMod.SWARM_REMOTE.descriptors[0].result.schema;
      const parsedSnap = resCodec.parse({
        hasSwarm: true,
        done: true,
        coordinatorSessionId: 'coord-1',
        resolvedFromMember: null,
        title: 'Strict Check',
        head: 1,
        updatedAt: 100,
        channels: [],
        members: [{ name: 'w1', sessionId: 's1', lastPostTime: { bad: undefined } }],
        messages: [{ seq: 1, agent: 'w1', text: 'hi', time: { bad: undefined } }],
      });
      assert.equal(parsedSnap.members[0].lastPostTime, '');
      assert.equal(parsedSnap.messages[0].time, '');
    }

    // (F) P1-4: Reopening a done swarm via registerMember restores coordinator to working.
    {
      const store = new BoardStore('coord-reopen', { baseDir: tmpDir });
      store.ensureCoordinator({});
      store.postMessage('coordinator', '[done] Phase 1 complete');
      store.releaseWriterLock();
      assert.equal(store.getMember('coordinator').state, 'stopped');
      store.ensureCoordinator({});
      store.registerMember({ name: 'phase2-worker', sessionId: 's-p2' });
      assert.equal(store.state.done, false);
      assert.equal(store.getMember('coordinator').state, 'working');
      store.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('34. wait_for terminal safety: killed targets (before/after park), failed cold-resume stopped targets, and mid-wait readBoard window', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const postTool = env.registeredTools.get('post_message').tool;
    const waitTool = env.registeredTools.get('swarm_wait').tool;
    const readTool = env.registeredTools.get('read_board').tool;

    // 1. Target killed AFTER waiter parks -> waiter wakes immediately via stalled fallback.
    const r1 = await swarmTool.execute({ action: 'add', name: 'k-target', brief: 'do work' }, { agent: env.coordinatorAgent });
    const rWaiter = await swarmTool.execute({ action: 'add', name: 'waiter-a', brief: 'wait on k-target' }, { agent: env.coordinatorAgent });
    const waiterA = env.agentsMap.get(rWaiter.added[0].sessionId);
    const parked = await waitTool.execute(
      { since: 2, wait_for: ['k-target'] },
      { agent: waiterA, concludeTurn: () => {} }
    );
    assert.equal(parked.status, 'waiting');
    const baseWaiterFollowups = waiterA._debug.followups.length;

    await swarmTool.execute({ action: 'kill', name: 'k-target' }, { agent: env.coordinatorAgent });
    await waitFor(() => waiterA._debug.followups.length === baseWaiterFollowups + 1, 1000, 'killed target unblocks parked waiter');
    assert.match(waiterA._debug.followups.at(-1).content[0].text, /k-target/);

    // 2. Target ALREADY killed BEFORE prepareWait -> returns woken_immediately with stalled_members.
    let concludedDead = 0;
    const immKilled = await waitTool.execute(
      { since: 2, wait_for: ['k-target'] },
      { agent: env.coordinatorAgent, concludeTurn: () => { concludedDead++; } }
    );
    assert.equal(immKilled.status, 'woken_immediately');
    assert.deepEqual(immKilled.stalled_members, ['k-target']);
    assert.equal(concludedDead, 0);

    // 3. While cold-resume is in flight, waiter parks FIRST; once resume rejects, catch -> _wakeUnblockedWaiters auto-wakes waiter.
    const rCold = await swarmTool.execute({ action: 'add', name: 'cold-fail', brief: 'sleep then fail resume' }, { agent: env.coordinatorAgent });
    const coldSessionId = rCold.added[0].sessionId;
    const coldAgent = env.agentsMap.get(coldSessionId);
    await waitTool.execute({ since: 3 }, { agent: coldAgent, concludeTurn: () => {} });
    env.mounted.controller.liveHandles.delete(coldSessionId);
    env.agentsMap.delete(coldSessionId);
    env.env.deferResumes = true;
    env.env.failResume = true;

    const inFlightWake = postTool.execute({ text: '@cold-fail wake up' }, { agent: env.coordinatorAgent });
    await waitFor(() => env.env.releaseResumeResolvers.length === 1, 1000, 'cold resume in flight');

    const parkedOnCold = await waitTool.execute(
      { since: 4, wait_for: ['cold-fail'] },
      { agent: waiterA, concludeTurn: () => {} }
    );
    assert.equal(parkedOnCold.status, 'waiting');
    const beforeColdFailFollowups = waiterA._debug.followups.length;

    env.env.deferResumes = false;
    env.env.releaseResumeResolvers.pop()();
    const wakeFail = await inFlightWake;
    assert.equal(wakeFail.wake_errors.length, 1);
    await waitFor(
      () => waiterA._debug.followups.length === beforeColdFailFollowups + 1,
      1000,
      'parked waiter must auto-wake when waited cold target fails resume'
    );
    assert.match(waiterA._debug.followups.at(-1).content[0].text, /cold-fail/);

    // Also verify prepareWait AFTER cold failure returns woken_immediately.
    let concludedCold = 0;
    const immCold = await waitTool.execute(
      { since: 4, wait_for: ['cold-fail'] },
      { agent: waiterA, concludeTurn: () => { concludedCold++; } }
    );
    assert.equal(immCold.status, 'woken_immediately');
    assert.deepEqual(immCold.stalled_members, ['cold-fail']);
    assert.equal(concludedCold, 0);
    env.env.failResume = false;

    // 3b. Mixed barrier: m1 killed without reporting + m2 still working posts @waiter -> wakes IMMEDIATELY on m2's post!
    const m1Add = await swarmTool.execute({ action: 'add', name: 'mix-dead', brief: 'dies early' }, { agent: env.coordinatorAgent });
    const m2Add = await swarmTool.execute({ action: 'add', name: 'mix-live', brief: 'reports while working' }, { agent: env.coordinatorAgent });
    const mixLive = env.agentsMap.get(m2Add.added[0].sessionId);
    const mixFloor = env.mounted.controller.getSwarmSnapshot(env.coordinatorAgent.id).head;
    await waitTool.execute(
      { since: mixFloor, wait_for: ['mix-dead', 'mix-live'] },
      { agent: waiterA, concludeTurn: () => {} }
    );
    await swarmTool.execute({ action: 'kill', name: 'mix-dead' }, { agent: env.coordinatorAgent });
    const mixPost = await postTool.execute({ text: '@waiter-a mix-live report ready' }, { agent: mixLive });
    assert.deepEqual(
      mixPost.woken,
      ['waiter-a'],
      'once mix-live reports, dead mix-dead is the only missing target so waiter must wake immediately without waiting for mix-live to idle'
    );
    assert.match(waiterA._debug.followups.at(-1).content[0].text, /mix-live report ready/);
    assert.match(waiterA._debug.followups.at(-1).content[0].text, /mix-dead/);
    void m1Add;

    // 4. Mid-wait readBoard advancing lastReadSeq must not erase earlier peer reports from waitSince window.
    const p1 = await swarmTool.execute({ action: 'add', name: 'peer-1', brief: 'p1' }, { agent: env.coordinatorAgent });
    const p2 = await swarmTool.execute({ action: 'add', name: 'peer-2', brief: 'p2' }, { agent: env.coordinatorAgent });
    const peer1 = env.agentsMap.get(p1.added[0].sessionId);
    const peer2 = env.agentsMap.get(p2.added[0].sessionId);
    const headBefore = env.mounted.controller.getSwarmSnapshot(env.coordinatorAgent.id).head;
    await waitTool.execute(
      { since: headBefore, wait_for: ['peer-1', 'peer-2'] },
      { agent: env.coordinatorAgent, concludeTurn: () => {} }
    );
    await postTool.execute({ text: '@coordinator peer-1 done' }, { agent: peer1 });
    await readTool.execute({ since: headBefore, limit: 10 }, { agent: env.coordinatorAgent });
    const post2 = await postTool.execute({ text: '@coordinator peer-2 done' }, { agent: peer2 });
    assert.deepEqual(post2.woken, ['coordinator'], 'peer-1 report since waitSince must remain counted even if lastReadSeq advanced');
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('35. A fired Monitor one-shot leaves no empty monitorTasks entry behind', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const scheduleTool = env.registeredTools.get('schedule').tool;
    const manageTaskTool = env.registeredTools.get('manage_task').tool;
    const controller = env.mounted.controller;

    const add = await swarmTool.execute(
      { action: 'add', name: 'monitor', brief: 'watch the swarm for stalls' },
      { agent: env.coordinatorAgent }
    );
    const monSid = add.added[0].sessionId;
    const monAgent = env.agentsMap.get(monSid);
    assert.equal(controller.monitorTasks.has(monSid), false);

    const oneShot = await scheduleTool.execute(
      { DurationSeconds: 1, Prompt: 'one-shot stall check' },
      { agent: monAgent }
    );
    assert.equal(oneShot.status, 'scheduled');
    assert.equal(controller.monitorTasks.get(monSid).size, 1);

    // The timer fires ~1s later, deletes its own task and must also drop the
    // now-empty Map instead of leaking a sessionId key forever.
    await waitFor(
      () => controller.monitorTasks.has(monSid) === false,
      3000,
      'one-shot monitor timer cleanup'
    );
    assert.deepEqual((await manageTaskTool.execute({ Action: 'list' }, { agent: monAgent })).tasks, []);
    assert.equal(
      (await manageTaskTool.execute({ Action: 'status', TaskId: oneShot.TaskId }, { agent: monAgent }))
        .status,
      'not_found'
    );

    // A recurring task legitimately keeps the map alive...
    const cron = await scheduleTool.execute(
      { CronExpression: '*/3 * * * *', IsDaemon: true, Prompt: 'cron stall check' },
      { agent: monAgent }
    );
    assert.equal(controller.monitorTasks.get(monSid).size, 1);

    // ...and an explicit clear removes the sessionId key outright.
    controller._clearMonitorTasksForSession(monSid);
    assert.equal(controller.monitorTasks.has(monSid), false, 'clear must drop the sessionId key');
    assert.ok(cron.TaskId);
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('36. subagent/catalog childCreatedAt stays a non-negative safe integer for bad headers', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    const originalCreate = env.ctx.agents.create;
    // undefined means "leave the real header alone".
    let pendingBad;
    // The host catalog schema is z.number().int().nonnegative(); a pathological
    // child header must never hand it a negative number, a float or a string.
    env.ctx.agents.create = async (createOptions) => {
      const handle = await originalCreate(createOptions);
      if (pendingBad !== undefined) handle.agent.session.header.createdAt = pendingBad;
      return handle;
    };

    const badValues = [-5, 1.5, 'soon', NaN];
    let index = 0;
    for (const bad of badValues) {
      index += 1;
      pendingBad = bad;
      const add = await swarmTool.execute(
        { action: 'add', name: 'probe-' + index, brief: 'catalog createdAt probe' },
        { agent: env.coordinatorAgent }
      );
      assert.equal(add.status, 'added');
      const catalog = env.coordinatorAgent._debug.appendedEvents
        .filter((e) => e.type === 'subagent/catalog')
        .at(-1);
      assert.equal(catalog?.data?.name, 'probe-' + index, 'the v3 named entry is still written');
      const createdAt = catalog?.data?.childCreatedAt;
      assert.ok(
        Number.isSafeInteger(createdAt) && createdAt >= 0,
        'childCreatedAt must be a non-negative safe integer, got ' + String(createdAt)
      );
      assert.notEqual(createdAt, bad, 'the bad header value must be replaced');
    }

    // The healthy path keeps the real header value untouched.
    pendingBad = undefined;
    const realAdd = await swarmTool.execute(
      { action: 'add', name: 'probe-real', brief: 'real createdAt' },
      { agent: env.coordinatorAgent }
    );
    const realHeader = env.agentsMap.get(realAdd.added[0].sessionId).session.header.createdAt;
    const realCatalog = env.coordinatorAgent._debug.appendedEvents
      .filter((e) => e.type === 'subagent/catalog')
      .at(-1);
    assert.equal(realCatalog.data.childCreatedAt, realHeader);
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('37. Feed long-message folding thresholds, preview clipping, and getSwarmApi proxy safety', async () => {
  // ── Fold threshold: longer than 280 chars OR more than 6 lines, nothing else.
  assert.equal(clientMod.isLongSwarmMessage(''), false);
  assert.equal(clientMod.isLongSwarmMessage('短消息 @author 完成'), false);
  assert.equal(clientMod.isLongSwarmMessage(null), false);
  assert.equal(clientMod.isLongSwarmMessage(undefined), false);
  assert.equal(clientMod.LONG_MESSAGE_MAX_CHARS, 280);
  assert.equal(clientMod.LONG_MESSAGE_MAX_LINES, 6);
  assert.equal(clientMod.isLongSwarmMessage('a'.repeat(280)), false, 'exactly 280 chars still fits');
  assert.equal(clientMod.isLongSwarmMessage('a'.repeat(281)), true, '281 chars folds');
  assert.equal(clientMod.isLongSwarmMessage(Array.from({ length: 6 }, () => 'line').join('\n')), false);
  assert.equal(clientMod.isLongSwarmMessage(Array.from({ length: 7 }, () => 'line').join('\n')), true);
  assert.equal(clientMod.isLongSwarmMessage(Array.from({ length: 7 }, () => 'line').join('\r\n')), true);
  assert.equal(clientMod.isLongSwarmMessage(Array.from({ length: 6 }, () => 'line').join('\r\n')), false);

  // ── Collapsed preview: first 6 lines, clipped to 260 chars, plus the ellipsis.
  const longText = ['# 报告'].concat(Array.from({ length: 9 }, (_, i) => '第 ' + (i + 1) + ' 行内容')).join('\n');
  const preview = clientMod.getCollapsedPreviewText(longText);
  assert.ok(preview.endsWith('…'), 'a folded preview always ends with the ellipsis');
  assert.equal(preview.split('\n').length, 6, 'only the first 6 lines survive');
  assert.ok(preview.startsWith('# 报告'));
  assert.ok(preview.includes('第 5 行内容'), 'the 6th rendered line is still inside the preview');
  assert.ok(!preview.includes('第 6 行内容'), 'content past the 6th line is dropped');

  const wide = 'x'.repeat(400);
  assert.equal(clientMod.getCollapsedPreviewText(wide), 'x'.repeat(260) + '…');
  assert.equal(Array.from(clientMod.getCollapsedPreviewText(wide)).length, 261);
  assert.equal(clientMod.getCollapsedPreviewText('a'.repeat(280)), 'a'.repeat(280), 'short text passes through untouched');
  assert.equal(clientMod.getCollapsedPreviewText('短消息'), '短消息');
  assert.deepEqual(clientMod.countSwarmMessageStats('ab\ncd'), { chars: 5, lines: 2 });
  assert.deepEqual(clientMod.countSwarmMessageStats(null), { chars: 0, lines: 1 });

  // The fold/jump interaction itself is covered by an executable component test
  // (test 38); only the settings copy is asserted statically here.
  const clientCode = fs.readFileSync(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  assert.ok(clientCode.includes('guideModels:'), 'the settings guide explains model routing');
  assert.ok(
    clientCode.includes('成员默认继承协调员当前的 DSH 模型路由'),
    'the settings guide explains inherited routing instead of a private whitelist'
  );
  assert.ok(
    !clientCode.includes('模型红线') && !clientCode.includes('严禁派发'),
    'the client bundle must not carry a private dispatch whitelist or ban list'
  );

  // ── getSwarmApi() must swallow the Cordis namespace-proxy throw. Before
  //    $mount, remote['dsh-swarm'] raises "cannot get property without inject";
  //    an uncaught throw would leak that internal message instead of the
  //    documented not-ready error.
  const proxyRemote = {};
  Object.defineProperty(proxyRemote, 'dsh-swarm', {
    configurable: true,
    get() {
      throw new Error('cannot get property without inject');
    },
  });
  Object.defineProperty(proxyRemote, Symbol.for('cordis.original'), { value: proxyRemote });
  let mountCalls = 0;
  proxyRemote.$mount = async () => {
    mountCalls += 1;
    return () => {};
  };

  const mockReact = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  };

  const probe = new clientMod.SwarmClientPlugin({ remote: proxyRemote }, { React: mockReact });
  await assert.rejects(
    () => probe.fetchSnapshotOnce('swarm-probe'),
    /未就绪/,
    'the proxy throw is swallowed and surfaces as the documented not-ready error'
  );
  assert.ok(mountCalls >= 1, 'the plugin still tried to mount the remote namespace');
  assert.equal(probe.disposed, false);

  // No remote service at all takes the same guarded path.
  const blind = new clientMod.SwarmClientPlugin({}, { React: mockReact });
  await assert.rejects(() => blind.fetchSnapshotOnce('swarm-probe'), /尚未就绪/);
});

/**
 * Minimal hook runtime: renders the REAL FeedView component offline so folding
 * and #seq-jump behaviour is verified by executing it (clicking real buttons,
 * running real effects), not by grepping the source.
 *
 * Effects run after commit, like React; setState outside a flush re-renders
 * synchronously, setState inside an effect re-renders in the same flush loop.
 */
function createMiniReactRuntime() {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let inFlush = false;
  let currentRender = null;
  let effectQueue = [];
  let committedTree = null;
  let scrollCalls = [];

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  function slotAt(index) {
    if (!slots[index]) slots[index] = {};
    return slots[index];
  }

  function textOf(node) {
    if (!node) return '';
    if (node.kind === 'text') return node.text;
    if (Array.isArray(node.children)) return node.children.map(textOf).join('');
    return '';
  }

  function commit(node) {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) };
    if (Array.isArray(node)) return { kind: 'frag', children: node.map(commit).filter(Boolean) };
    if (!node || !node.__el) return null;
    if (node.type === ReactImpl.Fragment) {
      return { kind: 'frag', children: node.children.map(commit).filter(Boolean) };
    }
    if (typeof node.type === 'function') {
      // In-tree function components must not use hooks (StatusDot does not).
      return commit(node.type(node.props));
    }
    const el = {
      kind: 'host',
      type: node.type,
      props: node.props,
      children: node.children.map(commit).filter(Boolean),
    };
    const seq = node.props && node.props['data-swarm-seq'];
    if (seq !== undefined && seq !== null) {
      el.__seq = String(seq);
      el.scrollIntoView = () => {
        scrollCalls.push({ seq: el.__seq, text: textOf(el) });
      };
    }
    if (typeof node.props.ref === 'function') node.props.ref(el);
    return el;
  }

  const ReactImpl = {
    Fragment: Symbol.for('mini.fragment'),
    createElement: (type, props, ...children) => ({ __el: true, type, props: props || {}, children }),
    useState(init) {
      const index = cursor++;
      const slot = slotAt(index);
      if (slot.kind !== 'state') {
        slot.kind = 'state';
        slot.value = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        const resolved = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(resolved, slot.value)) return;
        slot.value = resolved;
        dirty = true;
        if (!inFlush) flush();
      };
      return [slot.value, setState];
    },
    useRef(init) {
      const index = cursor++;
      const slot = slotAt(index);
      if (slot.kind !== 'ref') {
        slot.kind = 'ref';
        slot.value = { current: init === undefined ? null : init };
      }
      return slot.value;
    },
    useMemo(fn, deps) {
      const index = cursor++;
      const slot = slotAt(index);
      if (slot.kind === 'memo' && sameDeps(slot.deps, deps)) return slot.value;
      slot.kind = 'memo';
      slot.deps = deps;
      slot.value = fn();
      return slot.value;
    },
    useCallback(fn, deps) {
      const index = cursor++;
      const slot = slotAt(index);
      if (slot.kind === 'callback' && sameDeps(slot.deps, deps)) return slot.value;
      slot.kind = 'callback';
      slot.deps = deps;
      slot.value = fn;
      return slot.value;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const slot = slotAt(index);
      if (slot.kind === 'effect' && sameDeps(slot.deps, deps)) return;
      slot.kind = 'effect';
      slot.deps = deps;
      slot.next = fn;
      effectQueue.push(slot);
    },
  };

  function flush() {
    inFlush = true;
    let guard = 0;
    do {
      dirty = false;
      cursor = 0;
      effectQueue = [];
      committedTree = commit(currentRender());
      const queued = effectQueue.slice();
      for (const slot of queued) {
        if (typeof slot.cleanup === 'function') {
          try { slot.cleanup(); } catch {}
        }
        slot.cleanup = null;
        const cleanup = slot.next();
        if (typeof cleanup === 'function') slot.cleanup = cleanup;
      }
      guard += 1;
      if (guard > 100) throw new Error('mini react did not settle');
    } while (dirty);
    inFlush = false;
  }

  function walk(node, out) {
    if (!node || node.kind === 'text') return;
    if (node.kind === 'frag') {
      for (const child of node.children) walk(child, out);
      return;
    }
    out.push(node);
    for (const child of node.children) walk(child, out);
  }

  return {
    React: ReactImpl,
    render(component, props) {
      currentRender = () => component(props);
      flush();
      return committedTree;
    },
    get scrollCalls() {
      return scrollCalls;
    },
    resetScrollCalls() {
      scrollCalls = [];
    },
    findAll(predicate) {
      const all = [];
      walk(committedTree, all);
      return all.filter(predicate);
    },
    find(predicate) {
      const all = [];
      walk(committedTree, all);
      return all.find(predicate);
    },
    textOf,
  };
}

test('38. FeedView component behaviour: folding, bulk toggle, #seq jump expands before scrolling', () => {
  const runtime = createMiniReactRuntime();
  const plugin = new clientMod.SwarmClientPlugin({}, { React: runtime.React });
  const FeedView = plugin.components.FeedView;
  assert.equal(typeof FeedView, 'function');

  const longA = ['# 长报告 A'].concat(Array.from({ length: 9 }, (_, i) => 'A 第 ' + (i + 1) + ' 行')).concat(['A-END']).join('\n');
  const longB = ['# 长报告 B'].concat(Array.from({ length: 9 }, (_, i) => 'B 第 ' + (i + 1) + ' 行')).concat(['B-END']).join('\n');
  const snapshot = {
    hasSwarm: true,
    head: 3,
    channels: [{ name: 'main' }],
    members: [
      { name: 'coordinator', role: 'coordinator', state: 'waiting' },
      { name: 'author', role: 'worker', state: 'working' },
    ],
    messages: [
      { seq: 1, agent: 'coordinator', channel: 'main', text: '短消息 @author 开工', mentions: ['author'], time: null },
      { seq: 2, agent: 'author', channel: 'main', text: longA, mentions: [], time: null },
      { seq: 3, agent: 'author', channel: 'main', text: longB, mentions: [], time: null },
    ],
  };

  const jumped = [];
  const baseProps = {
    snapshot,
    selectedChannel: 'all',
    setSelectedChannel() {},
    speakerFilter: '',
    setSpeakerFilter() {},
    highlightedSeq: 0,
    onJumpSeq: (seq) => jumped.push(seq),
    onJumpMember() {},
  };

  const msgText = (seq) => runtime.textOf(runtime.find((el) => el.__seq === String(seq)));
  const buttonsWithLabel = (label) => runtime.findAll((el) => el.type === 'button' && runtime.textOf(el) === label);
  const buttonWithLabel = (label) => buttonsWithLabel(label)[0];
  const expandToggles = () => runtime.findAll((el) => el.type === 'button' && runtime.textOf(el).startsWith('展开全文（共 '));
  const click = (el, why) => {
    assert.ok(el, 'expected button: ' + why);
    assert.equal(typeof el.props.onClick, 'function');
    el.props.onClick();
  };

  // ── Default state: long messages collapse to a preview, short ones do not.
  runtime.render(FeedView, baseProps);
  assert.ok(msgText(1).includes('短消息 @author 开工'), 'a short message renders in full');
  assert.ok(!msgText(1).includes('展开全文'), 'a short message has no fold toggle');
  assert.ok(msgText(2).includes('…'), 'a long message defaults to the collapsed preview');
  assert.ok(!msgText(2).includes('A-END'), 'the tail of a long message is folded away');
  assert.equal(expandToggles().length, 2, 'both long messages expose a toggle');
  assert.ok(buttonWithLabel('全部展开'), 'bulk expand chip is offered when long messages exist');
  assert.ok(buttonWithLabel('全部收起'), 'bulk collapse chip is offered when long messages exist');

  // ── Single expand / collapse.
  click(expandToggles()[0], 'first fold toggle');
  assert.ok(msgText(2).includes('A-END'), 'expanding one message reveals its full text');
  assert.ok(!msgText(2).includes('…'), 'expansion drops the preview ellipsis');
  assert.equal(buttonsWithLabel('收起 ▲').length, 1, 'the expanded message shows the collapse label');
  click(buttonWithLabel('收起 ▲'), 'collapse the expanded message');
  assert.ok(msgText(2).includes('…'), 'collapsing restores the preview');
  assert.ok(!msgText(2).includes('A-END'));

  // ── Bulk expand / collapse.
  click(buttonWithLabel('全部展开'), 'bulk expand');
  assert.ok(msgText(2).includes('A-END') && msgText(3).includes('B-END'), 'bulk expand reveals every long message');
  click(buttonWithLabel('全部收起'), 'bulk collapse');
  assert.ok(!msgText(2).includes('A-END') && !msgText(3).includes('B-END'), 'bulk collapse hides every long message');

  // ── #seq jump: expands, then scrolls only once the full text is committed.
  runtime.resetScrollCalls();
  click(buttonWithLabel('#2'), '#2 seq card');
  assert.ok(jumped.includes(2), 'onJumpSeq is still delegated to the pane');
  assert.ok(msgText(2).includes('A-END'), 'jumping to a seq reveals its full text');
  assert.equal(runtime.scrollCalls.length, 1, 'the jump scrolls exactly once');
  assert.equal(runtime.scrollCalls[0].seq, '2');
  assert.ok(
    runtime.scrollCalls[0].text.includes('A-END'),
    'the scroll must happen on the committed full-text body, not the collapsed preview'
  );
  assert.ok(!runtime.scrollCalls[0].text.includes('…'));

  // ── Re-clicking the SAME seq after a manual collapse (highlight unchanged)
  //    still expands it: jumps are requests, not reads of highlightedSeq.
  click(buttonWithLabel('收起 ▲'), 'manually collapse the jumped message');
  assert.ok(!msgText(2).includes('A-END'));
  runtime.resetScrollCalls();
  click(buttonWithLabel('#2'), '#2 seq card again');
  assert.ok(msgText(2).includes('A-END'), 're-clicking the same seq expands it again');
  assert.equal(runtime.scrollCalls.length, 1, 'the second jump scrolls again');
  assert.ok(runtime.scrollCalls[0].text.includes('A-END'));

  // ── External jump (topology node / deep link) arrives as highlightedSeq.
  runtime.render(FeedView, Object.assign({}, baseProps, { highlightedSeq: 3 }));
  assert.ok(msgText(3).includes('B-END'), 'an external highlightedSeq expands its target');
  assert.ok(
    runtime.scrollCalls.some((call) => call.seq === '3' && call.text.includes('B-END')),
    'the external jump scrolls on the full-text body'
  );
});

test('39. DSH 0.2.2 skill source validation & /swarm context-injection lifecycle (compact dedup, QueueDock edit/remove, HMR log recovery)', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir);
  try {
    // (1) Both runtime skills carry source: 'runtime' and pass strict ctx.skills.get() validation
    const swarmSkill = await env.ctx.skills.get('swarm');
    const monitorSkill = await env.ctx.skills.get('swarm-monitor');
    assert.equal(swarmSkill.source, 'runtime');
    assert.equal(swarmSkill.provider, 'runtime');
    assert.equal(monitorSkill.source, 'runtime');
    assert.equal(monitorSkill.provider, 'runtime');

    const cmd = env.registeredCommands.get('swarm');
    const coord = env.coordinatorAgent;

    // (2) /swarm status with attachments is rejected so the composer preserves draft attachments
    const fakeImg = {
      type: 'image',
      attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 12, width: 1, height: 1 },
    };
    const badStatus = cmd.handler({
      agent: coord,
      rawInput: 'status',
      attachments: [fakeImg],
    });
    assert.equal(badStatus.kind, 'error');
    assert.equal(coord._debug.followups.length, 0);

    // Attachment-only /swarm (empty text + image) is accepted cleanly without adding junk text
    const imgOnlyRes = cmd.handler({
      agent: coord,
      rawInput: '',
      attachments: [fakeImg],
    });
    assert.equal(imgOnlyRes.kind, 'success');
    assert.equal(coord._debug.followups.length, 1);
    const imgOnlyMsg = coord._debug.followups[0];
    assert.deepEqual(imgOnlyMsg.content, [fakeImg]);

    // If pre-step rejects, the pending injection is preserved for the next accepted step
    const [rejected] = await env.ctx.emit(
      'agent/pre-step',
      { agent: coord, messages: [imgOnlyMsg], turn: 1, step: 1 },
      async () => ({ kind: 'reject' })
    );
    assert.equal(rejected.kind, 'reject');

    const [accepted1] = await env.ctx.emit(
      'agent/pre-step',
      { agent: coord, messages: [imgOnlyMsg], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [imgOnlyMsg] })
    );
    assert.equal(accepted1.messages.length, 2);
    const firstInjection = accepted1.messages[1];
    assert.deepEqual(firstInjection.source, {
      kind: 'skill-invocation',
      name: 'swarm',
      form: 'instructions',
    });
    assert.match(firstInjection.content[0].text, /<skill_resources>/);
    assert.match(firstInjection.content[0].text, new RegExp('# /swarm — 多智能体公共留言板协作集群'));

    // Ordinary user messages must NOT receive a swarm injection
    const plainMsg = { id: 'plain-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] };
    const [plainStep] = await env.ctx.emit(
      'agent/pre-step',
      { agent: coord, messages: [plainMsg], turn: 2, step: 1 },
      async () => ({ kind: 'enter', messages: [plainMsg] })
    );
    assert.equal(plainStep.messages.length, 1);

    // (3) Visible-surface deduplication: when the session surface already holds the full injection,
    // a second /swarm injects the compact anchor instead of repeating hundreds of lines;
    // once compaction removes the old node from surface.nodes, full injection resumes.
    const loggedBySeq = new Map([[10, { seq: 10, type: 'user/message', data: firstInjection }]]);
    coord.session.surface = { nodes: [10] };
    coord.session.eventAt = (seq) => loggedBySeq.get(seq);

    cmd.handler({ agent: coord, rawInput: '补充第二阶段验证任务', attachments: [] });
    const secondUserMsg = coord._debug.followups.at(-1);
    assert.equal(secondUserMsg.content[0].text, '补充第二阶段验证任务');
    const [accepted2] = await env.ctx.emit(
      'agent/pre-step',
      { agent: coord, messages: [secondUserMsg], turn: 3, step: 1 },
      async () => ({ kind: 'enter', messages: [secondUserMsg] })
    );
    assert.equal(accepted2.messages.length, 2);
    const compactText = accepted2.messages[1].content[0].text;
    assert.doesNotMatch(compactText, /<skill_resources>/, 'visible full injection must switch repeat /swarm to compact anchor');
    assert.match(compactText, /沿用本会话上文已注入的/);

    // Simulate compaction shadowing seq 10 out of surface.nodes
    coord.session.surface = { nodes: [] };
    cmd.handler({ agent: coord, rawInput: '压缩后继续推进第三阶段', attachments: [] });
    const thirdUserMsg = coord._debug.followups.at(-1);
    const [accepted3] = await env.ctx.emit(
      'agent/pre-step',
      { agent: coord, messages: [thirdUserMsg], turn: 4, step: 1 },
      async () => ({ kind: 'enter', messages: [thirdUserMsg] })
    );
    assert.match(accepted3.content ? '' : accepted3.messages[1].content[0].text, /<skill_resources>/, 'after compaction, full skill instructions must be re-injected');

    // (4) QueueDock edit (inbox.replace) migrates the binding; QueueDock delete clears it
    cmd.handler({ agent: coord, rawInput: '初版任务文案', attachments: [] });
    const queuedMsg = coord._debug.followups.at(-1);
    await env.ctx.emit(
      'session/event',
      coord.session,
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [queuedMsg] } }
    );
    const editedMsg = {
      id: 'edited-msg-id-001',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '编辑后的任务文案' }],
    };
    await env.ctx.emit(
      'session/event',
      coord.session,
      {
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [editedMsg], outcome: 'canceled' },
      }
    );
    const [acceptedEdited] = await env.ctx.emit(
      'agent/pre-step',
      { agent: coord, messages: [editedMsg], turn: 5, step: 1 },
      async () => ({ kind: 'enter', messages: [editedMsg] })
    );
    assert.equal(acceptedEdited.messages.length, 2, 'QueueDock in-place edit must preserve /swarm injection');

    // QueueDock delete removes pending injection cleanly
    cmd.handler({ agent: coord, rawInput: '即将被删除的排队任务', attachments: [] });
    const deletedMsg = coord._debug.followups.at(-1);
    await env.ctx.emit(
      'session/event',
      coord.session,
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [deletedMsg] } }
    );
    await env.ctx.emit(
      'session/event',
      coord.session,
      {
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
      }
    );
    assert.equal(env.mounted.controller.pendingCommandInjections.has(deletedMsg.id), false);

    // (5) HMR reload / controller restart recovery from durable session log
    const hmrMsg = {
      id: 'hmr-queued-msg-99',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'HMR 重载前排队的任务' }],
    };
    coord.session.snapshotEvents = () => [
      { seq: 0, type: 'command/run', data: { commandId: 'cmd-hmr-1', name: 'swarm', args: 'HMR 重载前排队的任务' } },
      { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [hmrMsg] } },
      { seq: 2, type: 'command/done', data: { commandId: 'cmd-hmr-1', kind: 'success', text: 'ok' } },
    ];
    env.mounted.controller.pendingCommandInjections.clear();
    const [acceptedHmr] = await env.ctx.emit(
      'agent/pre-step',
      { agent: coord, messages: [hmrMsg], turn: 6, step: 1 },
      async () => ({ kind: 'enter', messages: [hmrMsg] })
    );
    assert.equal(acceptedHmr.messages.length, 2, 'HMR reload must recover pending /swarm injection from session events');
    assert.deepEqual(acceptedHmr.messages[1].source, {
      kind: 'skill-invocation',
      name: 'swarm',
      form: 'instructions',
    });
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('41. 模型派发权限：add / model / models 在 Host 工具入口硬拦截被禁模型且零副作用', async () => {
  const tmpDir = makeTempDir();
  // 协调员当前路由是 deepseek/deepseek-reasoner，被禁的候选是 anthropic/claude-sonnet-4-5。
  const env = createMockHostEnv(tmpDir, process.cwd(), {
    pluginConfig: { blockedModels: ['anthropic/claude-sonnet-4-5'] },
  });
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;

    // (1) 显式 add 被禁模型：当场报错，且绝不创建子会话
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'add', name: 'ghost', brief: '不该被拉起', model: 'anthropic/claude-sonnet-4-5' },
          { agent: env.coordinatorAgent }
        ),
      (err) => /禁用规则/.test(err.message) && /模型派发权限控制/.test(err.message),
      '被禁模型必须在工具入口被拦住'
    );
    assert.equal(env.createCalls.length, 0, '被禁模型不得产生任何 create 副作用');

    // (2) models 清单默认过滤被禁条目
    const listed = await swarmTool.execute({ action: 'models' }, { agent: env.coordinatorAgent });
    assert.ok(
      !listed.models.some((m) => m.key === 'anthropic/claude-sonnet-4-5'),
      'swarm{action:"models"} 不得列出被禁模型'
    );
    assert.ok(listed.models.some((m) => m.key === 'deepseek/deepseek-reasoner'));
    assert.equal(listed.total_configured, 2, '被禁模型不得计入可用模型总数');

    // (3) 放行的模型照常创建，随后热切到被禁模型必须被拦
    const added = await swarmTool.execute(
      { action: 'add', name: 'allowed-one', brief: '正常派发', model: 'deepseek/deepseek-chat' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(added.added[0].model, 'deepseek/deepseek-chat');
    const member = env.agentsMap.get(added.added[0].sessionId);
    // 成员创建后处于 working：先让它空闲下来，才能验证「热切被禁模型」这一分支
    await env.ctx.emit(
      'session/event',
      { id: member.id },
      { type: 'turn/end', data: { reason: { kind: 'error', error: new Error('boom') } } }
    );
    const before = member._debug.modelSelections.length;
    await assert.rejects(
      () =>
        swarmTool.execute(
          { action: 'model', name: 'allowed-one', model: 'anthropic/claude-sonnet-4-5' },
          { agent: env.coordinatorAgent }
        ),
      /禁用规则/,
      'swarm{action:"model"} 同样必须被拦'
    );
    assert.equal(member._debug.modelSelections.length, before, '被禁热切不得改动成员模型');
    assert.equal(
      env.mounted.controller.stores.getSnapshotForSession(env.coordinatorAgent.id).members.find(
        (m) => m.name === 'allowed-one'
      ).model,
      'deepseek-chat',
      '花名册不得记录被禁的模型切换'
    );
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('42. 模型派发权限：省略 model 继承协调员默认路由被禁时明确要求显式指定', async () => {
  const tmpDir = makeTempDir();
  const env = createMockHostEnv(tmpDir, process.cwd(), {
    pluginConfig: { blockedModels: ['deepseek/deepseek-reasoner'] },
  });
  try {
    const swarmTool = env.registeredTools.get('swarm').tool;
    await assert.rejects(
      () => swarmTool.execute({ action: 'add', name: 'inherited', brief: '继承默认路由' }, { agent: env.coordinatorAgent }),
      (err) =>
        /继承的默认模型/.test(err.message) &&
        /deepseek\/deepseek-reasoner/.test(err.message) &&
        /显式指定/.test(err.message),
      '继承默认模型被禁时必须明确提示显式指定允许的模型'
    );
    assert.equal(env.createCalls.length, 0);

    // 显式指定未被禁的模型即可继续
    const ok = await swarmTool.execute(
      { action: 'add', name: 'explicit', brief: '显式指定', model: 'deepseek/deepseek-chat' },
      { agent: env.coordinatorAgent }
    );
    assert.equal(ok.added[0].model, 'deepseek/deepseek-chat');
  } finally {
    await env.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

