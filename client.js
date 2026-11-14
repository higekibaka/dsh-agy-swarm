/* Classic-script browser bundle + CommonJS exports for Node's test runner.
 * DSH Desktop loads lazy client factories via classic <script>, NOT ESM import(). */
(function () {
  'use strict';

  const PLUGIN_ID = 'dsh-agy-swarm';
  const SWARM_SERVICE = 'dsh-swarm';
  const SWARM_SERVICE_NAME = 'dsh-swarm';
  const SWARM_TYPERT_PACKAGE = 'dsh-swarm';
  const SWARM_PROTOCOL = 'swarm';
  const SWARM_RESOURCE_PROTOCOL = 'swarm';
  const SWARM_TAB_ID = 'dsh-swarm/pane';
  const SWARM_PANE_ID = 'dsh-swarm/pane';
  const SWARM_TAB_SLOT = 'sidebar.right.pane.tab';
  const HEADER_ACTION_SLOT = 'conversation.session.header.actions';
  const TOOL_VIEW_SLOT = 'tool.call.toolview';
  const COMMAND_VIEW_SLOT = 'conversation.chat.commandview';
  const RESOURCE_SCHEME = 'dsh-resource:';
  const ADDRESS_PREFIX = 'dsh-resource://swarm/';
  const SWARM_RESOURCE_PREFIX = 'dsh-resource://swarm/';
  const SWARM_TABS = Object.freeze(['feed', 'members', 'graph']);
  /** 与 Host 侧 protocol.SWARM_METHODS 严格一致（含设置页用的 getSwarmModels）。 */
  const SWARM_METHODS = Object.freeze(['getSwarmSnapshot', 'watchSwarm', 'getSwarmModels']);
  const SWARM_MODELS_METHOD = 'getSwarmModels';

  const STATE_META = Object.freeze({
    working: { label: '运行中', tone: 'working' },
    waiting: { label: '休眠待命', tone: 'waiting' },
    stopped: { label: '已冷停', tone: 'stopped' },
    killed: { label: '已销毁', tone: 'killed' },
    done: { label: '已结项', tone: 'done' },
  });

  const ACTION_LABELS = Object.freeze({
    status: '查看集群状态',
    models: '查询可用模型',
    add: '派生集群成员',
    model: '切换成员模型',
    kill: '终止集群成员',
    title: '更新集群标题',
    channel: '管理消息频道',
  });

  const WORKSPACE_LABELS = Object.freeze({
    inherit: '共享目录 (inherit)',
    share: 'Git 工作树 (share)',
  });

  /** 外部 agy 队友的阶段文案（与 Host 侧 AGY_PHASE_LABELS 对齐的简表）。 */
  const AGY_PHASE_TEXT = Object.freeze({
    queued: '排队中',
    spawn: '进程启动',
    spawning: '进程启动',
    initialize: 'ACP 握手',
    initializing: 'ACP 握手',
    new: '建会话',
    creating_session: '建会话',
    load: '加载会话',
    loading_session: '加载会话',
    configure: '应用配置',
    configuring: '应用配置',
    prompt: '生成中',
    prompting: '生成中',
    cancelling: '取消中',
    stopping: '停止中',
  });

  /** Token 数量紧凑展示（1.2K / 3.4M）。 */
  function formatTokenCount(value) {
    if (!Number.isFinite(value) || value < 0) return '0';
    if (value < 1000) return String(value);
    if (value < 1000000) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 'K';
    return (value / 1000000).toFixed(1) + 'M';
  }

  /** 缓存命中率百分比（0..1 → 87.5%）。 */
  function formatHitRate(value) {
    if (!Number.isFinite(value) || value <= 0) return '0%';
    return (Math.min(1, value) * 100).toFixed(value < 0.1 ? 1 : 0) + '%';
  }

  // ── 专属设置页（settings.section id: 'dsh-agy-swarm'）────────────────────

  const SWARM_SETTINGS_ID = 'dsh-agy-swarm';
  const SWARM_SETTINGS_NS = 'settings.dshAgySwarm';
  /** 旧安装残留的表单 id：只读兜底，绝不写回。 */
  const SWARM_SETTINGS_ID_LEGACY = 'local-dsh-swarm';
  const SWARM_SETTINGS_ORDER = 39;

  /** 与 Host 侧 SWARM_CONFIG_DEFAULTS 严格一致：恢复默认即写回这四项。 */
  const SETTINGS_DEFAULTS = Object.freeze({
    maxConsecutivePeerWakes: 0,
    maxAgyTurnsPerMember: 0,
    maxAgyPostsPerTurn: 8,
    nodeExecutable: '',
    // 模型派发权限：恢复默认 = 关闭严格白名单 + 两个列表同时清空（完全放行）。
    strictAllowlist: false,
    allowedModels: Object.freeze([]),
    blockedModels: Object.freeze([]),
  });

  const SETTINGS_PRESETS = Object.freeze({
    maxConsecutivePeerWakes: [0, 6, 12, 24],
    maxAgyTurnsPerMember: [0, 16, 32, 64],
    maxAgyPostsPerTurn: [4, 8, 16],
  });

  const SETTINGS_DICTS = {
    zh: {
      title: 'Swarm 协作集群',
      subtitle: '自治内循环（总工 @architect → 铁匠 @builder → 判官 @reviewer）默认无限轮次运行，直到实测全绿才收口。',
      summaryLabel: '当前配置',
      summaryPeer: '同伴唤醒上限',
      summaryTurns: '单成员轮次上限',
      summaryPosts: '单轮发帖上限',
      summaryNode: 'ACP 桥 Node',
      infinite: '无限',
      loading: '正在读取配置…',
      unavailable: '此连接无法读取宿主设置。',
      readonlyBanner: '当前连接只能查看设置，不能修改。',
      saving: '保存中…',
      saved: '已保存',
      error: '保存失败，请重试。',
      loopTitle: '自治内循环唤醒与轮次上限',
      peerLabel: '连续同伴唤醒上限 maxConsecutivePeerWakes',
      peerHint: '0 = 无限（推荐）：总工-铁匠-判官在留言板内循环返工不设轮次上限；正整数则超过即熔断停火。',
      turnsLabel: '单成员总轮次上限 maxAgyTurnsPerMember（可选 ACP 扩展项）',
      turnsHint: '0 = 无限（推荐）；正整数在成员累计激活轮次超过该值时拦截唤醒并置 stopped。仅对 model:"agy/<model>" 的外部队友（需安装 dsh-agy-acp）生效。',
      postsLabel: '单轮发帖上限 maxAgyPostsPerTurn',
      postsHint: '外部 ACP 队友单轮最多能发几条留言，超出返回 429 强制合并；仅在启用可选扩展 dsh-agy-acp 时生效。',
      runtimeTitle: '外部 ACP 桥运行时（可选扩展 dsh-agy-acp）',
      nodeLabel: '桥进程 Node 可执行文件 nodeExecutable（可选 ACP 扩展项）',
      nodePlaceholder: '留空 = 自动解析宿主捆绑 Node',
      nodeHint: '仅在启用 dsh-agy-acp 且 Electron 宿主无法自动解析纯 node 时才需要手填绝对路径；留空即可满足绝大多数场景。',
      saveNode: '保存路径',
      resetDefaults: '恢复默认设置',
      guideTitle: '自治内循环使用说明',
      guideLoop: '复杂研发优先 /swarm 拉起 @architect（规划只读定契约）、@builder（施工自测）、@reviewer（独立审查实测）三角色后休眠；同伴之间直接 @ 交接，中间返工绝不抄送 @coordinator。',
      guideFallback: '内循环默认无限轮次：只要属于代码施工、单测修复或技术分歧 Triage，就一直在留言板闭环直到 100% 实测全绿；仅不可逆高危操作或需求取舍冲突才提前 @coordinator。',
      guideModels: '模型调度：成员默认继承协调员当前的 DSH 模型路由；需要跨模型家族时可按需指定任意已配置的 model（provider/model）。安装可选扩展 dsh-agy-acp 后，还会额外出现 agy/<model> 外部队友条目（以 swarm{action:"models"} 的实际输出为准）；未安装时该扩展项自动隐藏。',
      summaryModels: '模型派发权限',
      modeWhitelist: '严格白名单',
      modeWhitelistEmpty: '严格白名单（空 = 全禁）',
      modeBlacklist: '黑名单',
      modelsTitle: '模型派发权限控制',
      modelsHint: '开源默认完全放行。这里勾选后会在工具入口硬拦截：被禁用或不在白名单的模型一律拒绝派发，绝不静默降级成别的模型。',
      modelsLoading: '正在读取宿主已发现的模型列表…',
      modelsUnavailable: '未能读取宿主模型列表（不影响其它设置）：仍可手写规则管理白名单 / 黑名单。',
      modelsEmpty: '宿主暂未发现可派发模型；可先用下方手动规则管理。',
      refreshModels: '重新拉取模型列表',
      whitelistLabel: '严格白名单模式（仅允许已勾选模型）',
      whitelistHintOn: '已开启：只有白名单内的模型可以被 Swarm 派发。取消最后一个勾选后白名单为空，此时将禁止所有模型（不会反转成放行）。',
      whitelistHintOff: '已关闭（黑名单模式）：默认全部允许，取消勾选即加入禁用列表。',
      whitelistNeedsModels: '严格白名单已开启但允许列表为空：当前禁止所有模型。请勾选或手动添加至少一个允许的模型。',
      modelBlocked: '已禁用',
      manualLabel: '手动添加模型规则 (provider/model)',
      manualPlaceholder: '例如 provider/model',
      manualInvalid: '规则必须写成 provider/model 形式。',
      addBlocked: '加入禁用列表',
      addAllowed: '加入允许列表',
      allowedListLabel: '白名单',
      blockedListLabel: '黑名单',
      emptyRules: '（空）',
      removeRule: '移除',
      agyOverlapHint: '若使用 agy/... 外部队友：dsh-agy-acp 设置页里的禁用 / 仅 Plan 规则会与此处叠加生效，两侧都放行才能真正派发。',
    },
    en: {
      title: 'Swarm Collaboration Cluster',
      subtitle: 'The autonomous inner loop (architect → builder → reviewer) runs unlimited rounds by default until tests are fully green.',
      summaryLabel: 'Current configuration',
      summaryPeer: 'Peer wake limit',
      summaryTurns: 'Per-member turn limit',
      summaryPosts: 'Posts per turn',
      summaryNode: 'ACP bridge node',
      infinite: 'unlimited',
      loading: 'Loading configuration…',
      unavailable: 'This connection cannot read host settings.',
      readonlyBanner: 'This connection can only view settings.',
      saving: 'Saving…',
      saved: 'Saved',
      error: 'Save failed, please retry.',
      loopTitle: 'Inner-loop wake and turn limits',
      peerLabel: 'Consecutive peer wakes (maxConsecutivePeerWakes)',
      peerHint: '0 = unlimited (recommended): the architect-builder-reviewer loop may rework without a round cap; a positive value trips the circuit breaker.',
      turnsLabel: 'Total turns per member (maxAgyTurnsPerMember, optional ACP extension)',
      turnsHint: '0 = unlimited (recommended); a positive value stops the member once its activation count exceeds it. Only applies to external model:"agy/<model>" teammates, which require dsh-agy-acp.',
      postsLabel: 'Posts per turn (maxAgyPostsPerTurn)',
      postsHint: 'How many board posts an external ACP teammate may send per turn; extra posts get HTTP 429. Only relevant when the optional dsh-agy-acp extension is installed.',
      runtimeTitle: 'External ACP bridge runtime (optional dsh-agy-acp extension)',
      nodeLabel: 'Bridge node executable (nodeExecutable, optional ACP extension)',
      nodePlaceholder: 'Empty = resolve the host bundled node automatically',
      nodeHint: 'Only needed when dsh-agy-acp is installed and the Electron host cannot resolve a plain node executable; leaving it empty covers almost every setup.',
      saveNode: 'Save path',
      resetDefaults: 'Restore defaults',
      guideTitle: 'How the autonomous inner loop works',
      guideLoop: 'Start /swarm with @architect (read-only planning and contracts), @builder (implementation and self-test) and @reviewer (independent review), then park. Peers hand off with direct @ mentions and never cc @coordinator mid-loop.',
      guideFallback: 'The loop is unlimited by default: keep iterating on the board until 100% tests pass; only irreversible high-risk actions or requirement tradeoffs should ping @coordinator early.',
      guideModels: 'Model routing: members inherit the coordinator current DSH route by default; pass any configured model (provider/model) when you need a different model family. With the optional dsh-agy-acp extension installed, agy/<model> external teammate entries appear as well (see the live swarm{action:"models"} output); they stay hidden when the extension is absent.',
      summaryModels: 'Model dispatch',
      modeWhitelist: 'strict whitelist',
      modeWhitelistEmpty: 'strict whitelist (empty = deny all)',
      modeBlacklist: 'blocklist',
      modelsTitle: 'Model dispatch permissions',
      modelsHint: 'Fully permissive by default. Once you tick models here the gate is enforced at the tool entry: a disabled model or one outside the whitelist is rejected outright and never silently replaced.',
      modelsLoading: 'Loading the host model catalog…',
      modelsUnavailable: 'Could not load the host model catalog (other settings still work): you can still manage both lists by hand below.',
      modelsEmpty: 'No dispatchable model discovered yet; use the manual rule fields below.',
      refreshModels: 'Reload model catalog',
      whitelistLabel: 'Strict whitelist mode (only ticked models)',
      whitelistHintOn: 'Enabled: only whitelisted models may be dispatched. Unticking the last model leaves the whitelist empty, which denies every model (it never flips to permissive).',
      whitelistHintOff: 'Disabled (blocklist mode): everything is allowed unless you untick it, which adds it to the blocklist.',
      whitelistNeedsModels: 'Strict whitelist is on but the allow list is empty: every model is denied right now. Tick or add at least one allowed model.',
      modelBlocked: 'blocked',
      manualLabel: 'Add a model rule manually (provider/model)',
      manualPlaceholder: 'for example provider/model',
      manualInvalid: 'A rule must be written as provider/model.',
      addBlocked: 'Add to blocklist',
      addAllowed: 'Add to whitelist',
      allowedListLabel: 'Whitelist',
      blockedListLabel: 'Blocklist',
      emptyRules: '(empty)',
      removeRule: 'Remove',
      agyOverlapHint: 'For agy/... external teammates: disable / plan-only rules in the dsh-agy-acp settings stack with this gate, so both sides must permit the model.',
    },
  };

  /** 设置页数值字段归一化（0 合法 = 无限）。 */
  function normalizeSettingsCount(raw, fallback, min = 0) {
    return Number.isSafeInteger(raw) && raw >= min ? raw : fallback;
  }

  // ── Pure Address & Protocol Helpers ─────────────────────────────────────

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function safeDecodeSegment(segment) {
    if (typeof segment !== 'string' || segment === '') return null;
    try {
      const decoded = decodeURIComponent(segment).trim();
      if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
      return decoded;
    } catch {
      return null;
    }
  }

  /**
   * Session-id validity shared with the Host protocol: 1..160 chars, starting
   * with an alphanumeric and restricted to [A-Za-z0-9._:-].
   */
  function isValidSessionId(value) {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 160 &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    );
  }

  function normalizeTab(value) {
    if (typeof value !== 'string') return undefined;
    const lower = value.trim().toLowerCase();
    if (lower === 'roster') return 'members';
    return SWARM_TABS.includes(lower) ? lower : undefined;
  }

  function normalizePositiveInt(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value.trim())) return Number(value.trim());
    return undefined;
  }

  /**
   * Build the canonical `dsh-client-resources` address for a Swarm session.
   * Query parameters are intentionally omitted so all views of one session share one resource stream.
   */
  function swarmAddress(sessionId) {
    const clean = typeof sessionId === 'string' ? sessionId.trim() : String(sessionId ?? '').trim();
    if (!clean) throw new TypeError('swarmAddress requires a non-empty sessionId');
    return ADDRESS_PREFIX + encodeURIComponent(clean);
  }

  /**
   * Build a clickable href for chat Markdown pills or deep-links.
   */
  function swarmLinkHref(sessionId, options) {
    const base = swarmAddress(sessionId);
    const opts = typeof options === 'string' ? { tab: options } : (isPlainObject(options) ? options : {});
    const tab = normalizeTab(opts.tab);
    const seq = normalizePositiveInt(opts.focusSeq ?? opts.seq);
    const params = [];
    if (tab) params.push('tab=' + encodeURIComponent(tab));
    if (seq !== undefined) params.push('seq=' + String(seq));
    return params.length > 0 ? base + '?' + params.join('&') : base;
  }

  /**
   * Parse either a canonical `dsh-resource://swarm/<sessionId>` address or a
   * chat deep-link `dsh-resource://swarm/<sessionId>?tab=graph&seq=12#12`.
   */
  function parseSwarmAddress(input) {
    if (typeof input !== 'string' || input.trim() === '') return null;
    let url;
    try {
      url = new URL(input.trim());
    } catch {
      return null;
    }
    if (url.protocol !== RESOURCE_SCHEME) return null;
    if (url.username !== '' || url.password !== '' || url.port !== '') return null;
    if (url.hostname.toLowerCase() !== SWARM_PROTOCOL) return null;

    const rawSegments = url.pathname.split('/').filter(Boolean);
    let targetSegment = null;
    if (rawSegments.length === 1) {
      targetSegment = rawSegments[0];
    } else if (rawSegments.length === 2 && rawSegments[0] === 'session') {
      targetSegment = rawSegments[1];
    } else {
      return null;
    }

    const sessionId = safeDecodeSegment(targetSegment);
    if (!sessionId || !isValidSessionId(sessionId)) return null;

    const tab = normalizeTab(url.searchParams.get('tab') ?? undefined);
    let focusSeq = normalizePositiveInt(url.searchParams.get('seq') ?? undefined);
    if (focusSeq === undefined && url.hash) {
      const hashMatch = /^#(?:seq-?)?([1-9]\d{0,8})$/i.exec(url.hash);
      if (hashMatch) focusSeq = Number(hashMatch[1]);
    }

    return {
      protocol: SWARM_PROTOCOL,
      sessionId,
      address: swarmAddress(sessionId),
      tab,
      focusSeq,
    };
  }

  // ── Typert Descriptor & Snapshot Normalization ──────────────────────────

  /**
   * Parse a remote Swarm request EXACTLY like the Host `parseSwarmRequest`:
   * unknown keys are rejected outright, and the raw `sessionId` string is
   * validated with the shared whitelist WITHOUT trimming. Client and Host
   * therefore accept precisely the same set (" good " is invalid on both).
   */
  function parseSwarmRequest(value) {
    const fail = (detail) => {
      const err = new Error('dsh-swarm invalid request: ' + detail);
      err.code = 'DSH_SWARM_INVALID_REQUEST';
      return err;
    };
    if (!isPlainObject(value)) throw fail('expected a JSON object');
    for (const key of Object.keys(value)) {
      if (key !== 'sessionId') throw fail('unexpected key "' + key + '"');
    }
    if (!isValidSessionId(value.sessionId)) {
      throw fail('invalid sessionId (expected 1..160 chars of [A-Za-z0-9._:-], alnum first)');
    }
    return { sessionId: value.sessionId };
  }

  function normalizeChannel(raw) {
    if (!isPlainObject(raw)) return null;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    if (!name) return null;
    return {
      name,
      topic: typeof raw.topic === 'string' ? raw.topic : '',
      archived: raw.archived === true,
      createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
      subscribers: Array.isArray(raw.subscribers) ? raw.subscribers.filter((s) => typeof s === 'string' && s) : [],
    };
  }

  function normalizeMemberState(state, killed) {
    if (killed === true || state === 'killed') return 'killed';
    if (state === 'working' || state === 'waiting' || state === 'stopped') return state;
    return 'waiting';
  }

  /** 非负安全整数（客户端侧与 Host 归一化口径保持一致）。 */
  function nonNegInt(value, fallback = 0) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  /**
   * 外部 agy 队友的瞬态阶段（契约 3.2）：`{ runId, phase, pid, activity }`。
   * 空闲 / 原生 DSH 成员一律 null，绝不让面板渲染残缺对象。
   */
  function normalizeAgyLive(raw) {
    if (!isPlainObject(raw)) return null;
    const phase = typeof raw.phase === 'string' ? raw.phase.slice(0, 32) : '';
    if (!phase) return null;
    return {
      runId: typeof raw.runId === 'string' ? raw.runId.slice(0, 64) : '',
      phase,
      pid: Number.isSafeInteger(raw.pid) && raw.pid > 0 ? raw.pid : 0,
      activity: typeof raw.activity === 'string' ? raw.activity.slice(0, 240) : '',
    };
  }

  function normalizeHitRate(raw, cacheRead, totalInput) {
    let value = 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      value = raw >= 0 && raw <= 1 ? raw : raw > 1 && raw <= 100 ? raw / 100 : 0;
    } else if (totalInput > 0 && cacheRead > 0) {
      value = cacheRead / totalInput;
    }
    return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
  }

  /** 累计 Token 账单（契约 3.2 的 `agyUsage`）：无账单时为 null。 */
  function normalizeAgyUsage(raw) {
    if (!isPlainObject(raw)) return null;
    const totalInput = nonNegInt(raw.totalInput, 0);
    const cacheRead = Math.min(nonNegInt(raw.cacheRead, 0), totalInput);
    const totalOutput = nonNegInt(raw.totalOutput, 0);
    const last = isPlainObject(raw.lastTurnTokens)
      ? {
          stepCount: nonNegInt(raw.lastTurnTokens.stepCount, 0),
          totalInput: nonNegInt(raw.lastTurnTokens.totalInput, 0),
          cacheRead: nonNegInt(raw.lastTurnTokens.cacheRead, 0),
          totalOutput: nonNegInt(raw.lastTurnTokens.totalOutput, 0),
          thinking: nonNegInt(raw.lastTurnTokens.thinking, 0),
          cacheHitRate: normalizeHitRate(undefined, nonNegInt(raw.lastTurnTokens.cacheRead, 0), nonNegInt(raw.lastTurnTokens.totalInput, 0)),
        }
      : null;
    return {
      turns: nonNegInt(raw.turns, 0),
      stepCount: nonNegInt(raw.stepCount, 0),
      totalInput,
      cacheRead,
      totalOutput,
      thinking: Math.min(nonNegInt(raw.thinking, 0), totalOutput),
      cacheHitRate: normalizeHitRate(raw.cacheHitRate, cacheRead, totalInput),
      lastTurnTokens: last,
    };
  }

  function normalizeMember(raw) {
    if (!isPlainObject(raw)) return null;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    if (!name) return null;
    const killed = raw.killed === true || raw.state === 'killed';
    const provider = typeof raw.provider === 'string' ? raw.provider : '';
    const model = typeof raw.model === 'string' ? raw.model : '';
    const modelDisplay = typeof raw.modelDisplay === 'string' && raw.modelDisplay.trim()
      ? raw.modelDisplay.trim()
      : (provider && model ? provider + '/' + model : (model || provider || '默认模型'));
    return {
      name,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
      role: typeof raw.role === 'string' && raw.role ? raw.role : (name === 'coordinator' ? 'coordinator' : (name === 'monitor' || name.startsWith('monitor-') ? 'monitor' : 'worker')),
      addedBy: typeof raw.addedBy === 'string' && raw.addedBy ? raw.addedBy : 'coordinator',
      // 二期：成员后端（'dsh' 原生会话 / 'agy-acp' 外部 ACP 队友，没有可打开的原生会话）。
      backend: typeof raw.backend === 'string' && raw.backend ? raw.backend : 'dsh',
      // 二期：外部 agy 队友的只读模式、实时阶段与累计 Token 账单（原生成员为零值）。
      agyMode: typeof raw.agyMode === 'string' ? raw.agyMode : '',
      agyLive: normalizeAgyLive(raw.agyLive),
      agyUsage: normalizeAgyUsage(raw.agyUsage),
      provider,
      model,
      modelDisplay,
      reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : '',
      workspace: typeof raw.workspace === 'string' && raw.workspace ? raw.workspace : 'inherit',
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      channels: Array.isArray(raw.channels) && raw.channels.length > 0
        ? raw.channels.filter((c) => typeof c === 'string' && c)
        : ['main'],
      state: normalizeMemberState(raw.state, killed),
      killed,
      activity: typeof raw.activity === 'string' ? raw.activity : '',
      lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
      waitFor: Array.isArray(raw.waitFor) ? raw.waitFor.filter((w) => typeof w === 'string' && w) : [],
      lastReadSeq: Number.isFinite(raw.lastReadSeq) ? Number(raw.lastReadSeq) : 0,
      lastPostSeq: Number.isFinite(raw.lastPostSeq) ? Number(raw.lastPostSeq) : 0,
      lastPostTime: typeof raw.lastPostTime === 'string' ? raw.lastPostTime : '',
    };
  }

  function normalizeMessage(raw) {
    if (!isPlainObject(raw)) return null;
    const seq = Number.isFinite(raw.seq) ? Number(raw.seq) : 0;
    if (seq <= 0) return null;
    return {
      seq,
      channel: typeof raw.channel === 'string' && raw.channel.trim() ? raw.channel.trim() : 'main',
      agent: typeof raw.agent === 'string' && raw.agent.trim() ? raw.agent.trim() : 'unknown',
      text: typeof raw.text === 'string' ? raw.text : String(raw.text ?? ''),
      mentions: Array.isArray(raw.mentions) ? raw.mentions.filter((m) => typeof m === 'string' && m) : [],
      channelMentions: Array.isArray(raw.channelMentions) ? raw.channelMentions.filter((c) => typeof c === 'string' && c) : [],
      broadcast: raw.broadcast === true,
      time: typeof raw.time === 'string' ? raw.time : '',
    };
  }

  /**
   * Normalize any Host response envelope (`SwarmSnapshot`, `{ ok: true, value }`,
   * or `{ ok: true, snapshot }`) into a guaranteed safe `SwarmSnapshot` shape.
   */
  function normalizeSwarmSnapshot(input, fallbackSessionId) {
    let candidate = input;
    if (isPlainObject(candidate) && candidate.ok === true) {
      if (isPlainObject(candidate.value)) candidate = candidate.value;
      else if (isPlainObject(candidate.snapshot)) candidate = candidate.snapshot;
    }
    if (!isPlainObject(candidate)) {
      return {
        hasSwarm: false,
        done: false,
        coordinatorSessionId: typeof fallbackSessionId === 'string' ? fallbackSessionId : '',
        resolvedFromMember: null,
        title: '',
        head: 0,
        updatedAt: 0,
        channels: [],
        members: [],
        messages: [],
      };
    }

    const channels = Array.isArray(candidate.channels)
      ? candidate.channels.map(normalizeChannel).filter(Boolean)
      : [];
    const members = Array.isArray(candidate.members)
      ? candidate.members.map(normalizeMember).filter(Boolean)
      : [];
    const messages = Array.isArray(candidate.messages)
      ? candidate.messages.map(normalizeMessage).filter(Boolean).sort((a, b) => a.seq - b.seq)
      : [];

    const head = Number.isFinite(candidate.head)
      ? Number(candidate.head)
      : (messages.length > 0 ? messages[messages.length - 1].seq : 0);

    const hasSwarm = typeof candidate.hasSwarm === 'boolean'
      ? candidate.hasSwarm
      : (members.length > 0 || messages.length > 0 || head > 0);

    return {
      hasSwarm,
      done: candidate.done === true,
      coordinatorSessionId: typeof candidate.coordinatorSessionId === 'string' && candidate.coordinatorSessionId
        ? candidate.coordinatorSessionId
        : (typeof fallbackSessionId === 'string' ? fallbackSessionId : ''),
      resolvedFromMember: typeof candidate.resolvedFromMember === 'string' ? candidate.resolvedFromMember : null,
      title: typeof candidate.title === 'string' ? candidate.title : '',
      head,
      updatedAt: Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : 0,
      channels,
      members,
      messages,
    };
  }

  /** 模型目录条目归一化（与 Host `normalizeSwarmModelEntry` 一致，JSON-safe）。 */
  function normalizeSwarmModelEntry(input) {
    const raw = isPlainObject(input) ? input : {};
    const provider = typeof raw.provider === 'string' ? raw.provider : '';
    const model = typeof raw.model === 'string' ? raw.model : '';
    return {
      key: typeof raw.key === 'string' && raw.key
        ? raw.key
        : (provider && model ? provider + '/' + model : (model || provider)),
      provider,
      model,
      name: typeof raw.name === 'string' ? raw.name : model,
      backend: typeof raw.backend === 'string' ? raw.backend : '',
      allowed: raw.allowed === true,
      blocked: raw.blocked === true,
    };
  }

  /** 归一化模型规则列表（trim + 大小写不敏感去重，保留首次写法）。 */
  function normalizeRuleList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const clean = item.trim();
      if (!clean) continue;
      if (out.some((existing) => existing.toLowerCase() === clean.toLowerCase())) continue;
      out.push(clean);
    }
    return out;
  }

  /**
   * 模型条目命中的规则键（全部小写）：完整 `provider/model` 键与裸 `model` 名。
   * 与 Host 侧判定口径一致，勾选面板因此不会出现「显示了但实际拦不住」。
   */
  function modelEntryRuleKeys(entry) {
    const keys = [];
    const push = (value) => {
      if (typeof value !== 'string') return;
      const clean = value.trim().toLowerCase();
      if (clean && !keys.includes(clean)) keys.push(clean);
    };
    push(entry?.key);
    if (entry?.provider && entry?.model) push(entry.provider + '/' + entry.model);
    push(entry?.model);
    return keys;
  }

  /** 条目是否命中某条规则列表。 */
  function modelEntryHitsRuleList(list, entry) {
    const keys = modelEntryRuleKeys(entry);
    return normalizeRuleList(list).some((rule) => keys.includes(rule.toLowerCase()));
  }

  /** `getSwarmModels` 请求校验：`{}` / `undefined` / `{ probeAgy?: boolean }`。 */
  function parseSwarmModelsRequest(value) {
    const fail = (detail) => {
      const err = new Error('dsh-swarm invalid models request: ' + detail);
      err.code = 'DSH_SWARM_INVALID_REQUEST';
      return err;
    };
    if (value === undefined || value === null) return { probeAgy: false };
    if (!isPlainObject(value)) throw fail('expected a JSON object');
    for (const key of Object.keys(value)) {
      if (key !== 'probeAgy') throw fail('unexpected key "' + key + '"');
    }
    if (value.probeAgy !== undefined && value.probeAgy !== null && typeof value.probeAgy !== 'boolean') {
      throw fail('probeAgy must be boolean');
    }
    return { probeAgy: value.probeAgy === true };
  }

  /** `getSwarmModels` 结果归一化：`{ models: [...] }`，逐条丢弃未知字段。 */
  function parseSwarmModelsResult(value) {
    const fail = (detail) => {
      const err = new Error('dsh-swarm invalid models response: ' + detail);
      err.code = 'DSH_SWARM_INVALID_RESPONSE';
      return err;
    };
    if (!isPlainObject(value)) throw fail('expected object');
    if (!Array.isArray(value.models)) throw fail('models must be an array');
    return { models: value.models.map(normalizeSwarmModelEntry) };
  }

  function parseSwarmResult(value) {
    const fail = (detail) => {
      const err = new Error('dsh-swarm invalid response: ' + detail);
      err.code = 'DSH_SWARM_INVALID_RESPONSE';
      return err;
    };
    if (!isPlainObject(value)) throw fail('expected object');
    if (typeof value.hasSwarm !== 'boolean') throw fail('hasSwarm must be boolean');
    if (value.done !== undefined && typeof value.done !== 'boolean') throw fail('done must be boolean');
    if (typeof value.coordinatorSessionId !== 'string' || value.coordinatorSessionId.length > 160) {
      throw fail('invalid coordinatorSessionId');
    }
    if (value.resolvedFromMember !== null && value.resolvedFromMember !== undefined && (typeof value.resolvedFromMember !== 'string' || value.resolvedFromMember.length > 80)) {
      throw fail('invalid resolvedFromMember');
    }
    if (typeof value.title !== 'string' || value.title.length > 512) throw fail('invalid title');
    if (!Number.isSafeInteger(value.head) || value.head < 0) throw fail('invalid head');
    if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw fail('invalid updatedAt');
    if (!Array.isArray(value.channels) || !Array.isArray(value.members) || !Array.isArray(value.messages)) {
      throw fail('channels/members/messages must be arrays');
    }
    return normalizeSwarmSnapshot(value);
  }

  function createStrictCodec(method, direction) {
    const isReq = direction === 'request';
    const isModels = method === SWARM_MODELS_METHOD;
    const schema = {
      parse: (value) => {
        if (isModels) {
          return isReq ? parseSwarmModelsRequest(value) : parseSwarmModelsResult(value);
        }
        return isReq ? parseSwarmRequest(value) : parseSwarmResult(value);
      },
    };
    return {
      mode: 'strict',
      typeSymbol: SWARM_TYPERT_PACKAGE + '/' + method + (isReq ? 'Request' : 'Result'),
      schema,
      create: () => schema,
    };
  }

  function createSwarmDescriptor(method) {
    const isStream = method === 'watchSwarm';
    const reqCodec = createStrictCodec(method, 'request');
    const resCodec = createStrictCodec(method, 'result');
    return {
      id: SWARM_TYPERT_PACKAGE + '#' + SWARM_SERVICE + '/' + method,
      service: SWARM_SERVICE,
      namespace: SWARM_SERVICE,
      method,
      ...(isStream
        ? {
            mode: 'stream',
            cancellation: { parameter: 'signal' },
          }
        : {}),
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: reqCodec,
        strictCodec: reqCodec,
      }],
      result: resCodec,
    };
  }

  const SWARM_REMOTE = Object.freeze({
    package: SWARM_TYPERT_PACKAGE,
    descriptors: Object.freeze(SWARM_METHODS.map(createSwarmDescriptor)),
  });

  // ── Pure Feed Tokenizer & Graph Topology Builder ────────────────────────

  const TOKEN_PATTERN = /(dsh-resource:\/\/swarm\/[^\s)\]>]+)|(@#[A-Za-z][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_-])|(@all)(?![A-Za-z0-9_-])|(@[A-Za-z][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_-])|(#[1-9]\d{0,7})(?!\d)|(#[A-Za-z][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_-])/g;

  function isBoundaryBefore(text, index) {
    if (index <= 0) return true;
    const prev = text[index - 1];
    return !/[A-Za-z0-9_/@#]/.test(prev);
  }

  // ── Feed follow-the-bottom scrolling ─────────────────────────────────────
  // The reader is "following" when the scroll position was already within
  // STICK_BOTTOM_THRESHOLD_PX of the bottom BEFORE new content arrived.
  // Measuring the distance AFTER the list grew (the previous behaviour) can
  // never follow a message taller than the threshold: a long post would push
  // the reader away from the bottom they were parked on.
  const STICK_BOTTOM_THRESHOLD_PX = 60;

  function isNearBottom(el, threshold) {
    if (!el) return true;
    const limit = typeof threshold === 'number' ? threshold : STICK_BOTTOM_THRESHOLD_PX;
    const scrollHeight = Number(el.scrollHeight) || 0;
    const scrollTop = Number(el.scrollTop) || 0;
    const clientHeight = Number(el.clientHeight) || 0;
    return scrollHeight - scrollTop - clientHeight <= limit;
  }

  /** Scroll handler: keep the sticky flag in sync with the REAL position. */
  function applyStickToBottomOnScroll(stickRef, el) {
    if (!stickRef) return false;
    stickRef.current = isNearBottom(el);
    return stickRef.current;
  }

  /** After the list changes: follow only when the reader wanted to follow. */
  function followStickToBottom(stickRef, el) {
    if (!stickRef || !el) return false;
    if (!stickRef.current) return false;
    el.scrollTop = el.scrollHeight;
    return true;
  }

  /**
   * Tokenize board message text into interactive segments (`@name`, `@#channel`,
   * `@all`, `#12` seq refs, `#channel` tags, and `dsh-resource://swarm/` links).
   */
  function tokenizeSwarmText(text) {
    const source = typeof text === 'string' ? text : String(text ?? '');
    if (source === '') return [];
    const tokens = [];
    let cursor = 0;
    TOKEN_PATTERN.lastIndex = 0;
    let match;

    while ((match = TOKEN_PATTERN.exec(source)) !== null) {
      const start = match.index;
      const raw = match[0];
      if (!isBoundaryBefore(source, start)) continue;

      let node = null;
      if (match[1]) {
        const parsed = parseSwarmAddress(match[1]);
        if (parsed) node = { type: 'swarm-link', raw, parsed };
      } else if (match[2]) {
        node = { type: 'channel-mention', raw, channel: match[2].slice(2) };
      } else if (match[3]) {
        node = { type: 'broadcast', raw };
      } else if (match[4]) {
        node = { type: 'mention', raw, target: match[4].slice(1) };
      } else if (match[5]) {
        node = { type: 'seq-ref', raw, seq: Number(match[5].slice(1)) };
      } else if (match[6]) {
        node = { type: 'channel-tag', raw, channel: match[6].slice(1) };
      }

      if (!node) continue;
      if (start > cursor) {
        tokens.push({ type: 'text', text: source.slice(cursor, start) });
      }
      tokens.push(node);
      cursor = start + raw.length;
    }

    if (cursor < source.length) {
      tokens.push({ type: 'text', text: source.slice(cursor) });
    }
    return tokens;
  }

  // ── Long-Message Folding (留言流长消息折叠) ─────────────────────────────
  /** Fold threshold: a message is long when it exceeds 280 chars or 6 lines. */
  const LONG_MESSAGE_MAX_CHARS = 280;
  const LONG_MESSAGE_MAX_LINES = 6;
  /** Collapsed preview caps: at most the first 6 lines and 260 characters. */
  const COLLAPSED_PREVIEW_MAX_CHARS = 260;
  const COLLAPSED_PREVIEW_MAX_LINES = 6;
  const COLLAPSED_PREVIEW_ELLIPSIS = '…';

  function toSwarmMessageText(text) {
    return typeof text === 'string' ? text : String(text ?? '');
  }

  /** Code-point char count plus line count, used by the fold toggle label. */
  function countSwarmMessageStats(text) {
    const source = toSwarmMessageText(text);
    return { chars: Array.from(source).length, lines: source.split(/\r?\n/).length };
  }

  /**
   * True when a board message folds by default (more than 280 characters or more
   * than 6 lines). Kept pure so the feed and the test suite share one threshold.
   */
  function isLongSwarmMessage(text) {
    const stats = countSwarmMessageStats(text);
    return stats.chars > LONG_MESSAGE_MAX_CHARS || stats.lines > LONG_MESSAGE_MAX_LINES;
  }

  /**
   * The collapsed preview of a long message: the first 6 lines clipped to 260
   * characters and suffixed with an ellipsis. Short messages pass through as-is.
   */
  function getCollapsedPreviewText(text) {
    const source = toSwarmMessageText(text);
    if (!isLongSwarmMessage(source)) return source;
    const head = source.split(/\r?\n/).slice(0, COLLAPSED_PREVIEW_MAX_LINES).join('\n');
    const clipped = Array.from(head).slice(0, COLLAPSED_PREVIEW_MAX_CHARS).join('');
    return clipped.replace(/\s+$/, '') + COLLAPSED_PREVIEW_ELLIPSIS;
  }

  /**
   * Order members in parent-first tree order so helpers appear directly beneath the worker that added them.
   */
  function orderMembersTree(members) {
    const list = Array.isArray(members) ? members.slice() : [];
    const byName = new Map();
    for (const m of list) byName.set(m.name, m);

    const childrenOf = new Map();
    const roots = [];
    for (const m of list) {
      const parent = m.addedBy && m.addedBy !== m.name && byName.has(m.addedBy) && m.addedBy !== 'coordinator'
        ? m.addedBy
        : null;
      if (parent === null) {
        roots.push(m);
      } else {
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(m);
      }
    }

    const result = [];
    const visited = new Set();
    function visit(member, depth) {
      if (visited.has(member.name)) return;
      visited.add(member.name);
      result.push({ member, depth });
      const kids = childrenOf.get(member.name) || [];
      for (const kid of kids) visit(kid, depth + 1);
    }
    for (const root of roots) visit(root, 0);
    for (const m of list) {
      if (!visited.has(m.name)) visit(m, 0);
    }
    return result;
  }

  /**
   * Build deterministic SVG nodes, hierarchy links, and `@mention` directed edges
   * with non-overlapping curved Bezier paths and midpoint badge coordinates.
   */
  function buildMentionGraph(snapshot, options) {
    const snap = normalizeSwarmSnapshot(snapshot);
    const opts = isPlainObject(options) ? options : {};
    const width = Number.isFinite(opts.width) ? opts.width : 560;
    const height = Number.isFinite(opts.height) ? opts.height : 380;
    const includeBroadcast = opts.includeBroadcast !== false;

    const nodeMap = new Map();
    const ensureNode = (name, patch) => {
      if (!name) return null;
      let existing = nodeMap.get(name);
      if (!existing) {
        existing = {
          name,
          sessionId: name === 'coordinator' ? snap.coordinatorSessionId : '',
          role: name === 'coordinator' ? 'coordinator' : 'worker',
          addedBy: name === 'coordinator' ? '' : 'coordinator',
          state: 'waiting',
          modelDisplay: '',
          activity: '',
          lastError: '',
          postCount: 0,
          mentionInCount: 0,
          x: width / 2,
          y: height / 2,
        };
        nodeMap.set(name, existing);
      }
      if (patch) Object.assign(existing, patch);
      return existing;
    };

    const stripCode = (rawText) => {
      const rawLines = String(rawText ?? '').split(/\r?\n/);
      const unFenced = [];
      let fenceChar = '';
      let fenceLen = 0;
      for (const line of rawLines) {
        if (!fenceChar) {
          const open = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
          if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
            fenceChar = open[1][0];
            fenceLen = open[1].length;
            unFenced.push('');
            continue;
          }
          unFenced.push(line);
        } else {
          const closeRe = new RegExp('^[ \\t]{0,3}' + fenceChar + '{' + fenceLen + ',}[ \\t]*$');
          if (closeRe.test(line)) {
            fenceChar = '';
            fenceLen = 0;
          }
          unFenced.push('');
        }
      }
      const src = unFenced.join('\n');
      const runs = [];
      for (let i = 0; i < src.length; ) {
        if (src[i] === '`') {
          let end = i + 1;
          while (end < src.length && src[end] === '`') end += 1;
          runs.push({ start: i, len: end - i });
          i = end;
        } else {
          i += 1;
        }
      }
      if (runs.length === 0) return src;
      const byLen = new Map();
      for (let idx = 0; idx < runs.length; idx += 1) {
        let list = byLen.get(runs[idx].len);
        if (!list) { list = []; byLen.set(runs[idx].len, list); }
        list.push(idx);
      }
      const ptrByLen = new Map();
      const spans = [];
      let runIdx = 0;
      while (runIdx < runs.length) {
        const openRun = runs[runIdx];
        const list = byLen.get(openRun.len);
        let p = ptrByLen.get(openRun.len) || 0;
        while (p < list.length && list[p] <= runIdx) p += 1;
        ptrByLen.set(openRun.len, p);
        if (p < list.length) {
          const closeIdx = list[p];
          spans.push({ start: openRun.start, end: runs[closeIdx].start + runs[closeIdx].len });
          ptrByLen.set(openRun.len, p + 1);
          runIdx = closeIdx + 1;
        } else {
          runIdx += 1;
        }
      }
      if (spans.length === 0) return src;
      const chunks = [];
      let cursor = 0;
      for (const sp of spans) {
        if (sp.start > cursor) chunks.push(src.slice(cursor, sp.start));
        chunks.push(' ');
        cursor = sp.end;
      }
      if (cursor < src.length) chunks.push(src.slice(cursor));
      return chunks.join('');
    };

    ensureNode('coordinator', {
      sessionId: snap.coordinatorSessionId,
      role: 'coordinator',
      state: snap.done ? 'done' : 'waiting',
      modelDisplay: 'Coordinator',
    });

    for (const m of snap.members) {
      const effectiveState =
        snap.done && m.role === 'coordinator' && m.state !== 'working' ? 'done' : m.state;
      ensureNode(m.name, {
        sessionId: m.sessionId || (m.name === 'coordinator' ? snap.coordinatorSessionId : ''),
        role: m.role,
        addedBy: m.addedBy,
        state: effectiveState,
        modelDisplay: m.modelDisplay,
        activity: m.activity,
        lastError: m.lastError,
      });
    }

    const memberNames = [...nodeMap.keys()];
    const channelSubscribers = new Map();
    for (const ch of snap.channels) {
      channelSubscribers.set(ch.name, new Set(ch.subscribers));
    }
    for (const m of snap.members) {
      for (const chName of m.channels) {
        if (!channelSubscribers.has(chName)) channelSubscribers.set(chName, new Set());
        channelSubscribers.get(chName).add(m.name);
      }
    }

    const resolveMentionTargets = (rawTarget) => {
      if (!rawTarget) return [];
      if (nodeMap.has(rawTarget)) return [rawTarget];
      const prefix = rawTarget + '-';
      return memberNames.filter((n) => n.startsWith(prefix));
    };

    const edgeMap = new Map();
    const recordEdge = (from, to, seq, channel, isBroadcast) => {
      if (!from || !to || from === to) return;
      ensureNode(from);
      ensureNode(to);
      const key = from + '->' + to;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = {
          id: key,
          from,
          to,
          count: 0,
          broadcastCount: 0,
          directCount: 0,
          lastSeq: seq,
          channels: new Set(),
        };
        edgeMap.set(key, edge);
      }
      edge.count += 1;
      if (isBroadcast) edge.broadcastCount += 1;
      else edge.directCount += 1;
      if (seq > edge.lastSeq) edge.lastSeq = seq;
      if (channel) edge.channels.add(channel);
    };

    for (const msg of snap.messages) {
      const sender = msg.agent || 'coordinator';
      const senderNode = ensureNode(sender);
      if (senderNode) senderNode.postCount += 1;

      const unquotedText = stripCode(msg.text);
      const directMentions = new Set();
      if (Array.isArray(msg.mentions) && msg.mentions.length > 0) {
        for (const m of msg.mentions) {
          for (const resolved of resolveMentionTargets(m)) directMentions.add(resolved);
        }
      } else {
        for (const tok of tokenizeSwarmText(unquotedText)) {
          if (tok.type === 'mention') {
            for (const resolved of resolveMentionTargets(tok.target)) directMentions.add(resolved);
          }
        }
      }

      const chMentions = Array.isArray(msg.channelMentions) && msg.channelMentions.length > 0
        ? msg.channelMentions
        : tokenizeSwarmText(unquotedText).filter((t) => t.type === 'channel-mention').map((t) => t.channel);
      for (const chName of chMentions) {
        const subs = channelSubscribers.get(chName);
        if (subs) {
          for (const sub of subs) directMentions.add(sub);
        }
      }

      for (const target of directMentions) {
        if (target !== sender) {
          recordEdge(sender, target, msg.seq, msg.channel, false);
          const targetNode = nodeMap.get(target);
          if (targetNode) targetNode.mentionInCount += 1;
        }
      }

      const isBroadcast = msg.broadcast === true || /(?:^|[^A-Za-z0-9_/@#])@all(?![A-Za-z0-9_-])/.test(unquotedText);
      if (isBroadcast && includeBroadcast) {
        for (const target of nodeMap.keys()) {
          if (target !== sender && !directMentions.has(target)) {
            recordEdge(sender, target, msg.seq, msg.channel, true);
          }
        }
      }
    }

    // Position nodes cleanly: coordinator at center (or top when <=2 peers), peers arranged around an ellipse.
    const allNodes = [...nodeMap.values()];
    const coordNode = nodeMap.get('coordinator');
    const others = allNodes.filter((n) => n.name !== 'coordinator');
    const cx = width / 2;
    const cy = height / 2;

    if (others.length === 0) {
      if (coordNode) {
        coordNode.x = cx;
        coordNode.y = cy;
      }
    } else if (others.length <= 2) {
      if (coordNode) {
        coordNode.x = cx;
        coordNode.y = 84;
      }
      if (others.length === 1) {
        others[0].x = cx;
        others[0].y = height - 88;
      } else {
        others[0].x = Math.round(cx - 145);
        others[0].y = height - 92;
        others[1].x = Math.round(cx + 145);
        others[1].y = height - 92;
      }
    } else {
      if (coordNode) {
        coordNode.x = cx;
        coordNode.y = cy;
      }
      const rx = Math.min(212, Math.max(145, width * 0.37));
      const ry = Math.min(138, Math.max(105, height * 0.35));
      const orderedNames = orderMembersTree(
        others.map((n) => ({ name: n.name, addedBy: n.addedBy }))
      ).map((entry) => entry.member.name);
      const count = orderedNames.length;
      for (let i = 0; i < count; i += 1) {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
        const node = nodeMap.get(orderedNames[i]);
        const isSubHelper = node && node.addedBy && node.addedBy !== 'coordinator' && nodeMap.has(node.addedBy);
        const radiusScale = isSubHelper ? 1.12 : 1.0;
        if (node) {
          node.x = Math.round((cx + Math.cos(angle) * rx * radiusScale) * 10) / 10;
          node.y = Math.round((cy + Math.sin(angle) * ry * radiusScale) * 10) / 10;
        }
      }
    }

    const NODE_RADIUS = 24;
    const edges = [];
    for (const rawEdge of edgeMap.values()) {
      const source = nodeMap.get(rawEdge.from);
      const target = nodeMap.get(rawEdge.to);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const nx = -uy;
      const ny = ux;

      const hasReverse = edgeMap.has(rawEdge.to + '->' + rawEdge.from);
      const curveOffset = hasReverse ? 24 : 10;
      const startX = source.x + ux * (NODE_RADIUS + 2) + nx * (hasReverse ? 5 : 0);
      const startY = source.y + uy * (NODE_RADIUS + 2) + ny * (hasReverse ? 5 : 0);
      const endX = target.x - ux * (NODE_RADIUS + 7) + nx * (hasReverse ? 5 : 0);
      const endY = target.y - uy * (NODE_RADIUS + 7) + ny * (hasReverse ? 5 : 0);
      const ctrlX = (startX + endX) / 2 + nx * curveOffset;
      const ctrlY = (startY + endY) / 2 + ny * curveOffset;
      const midX = 0.25 * startX + 0.5 * ctrlX + 0.25 * endX;
      const midY = 0.25 * startY + 0.5 * ctrlY + 0.25 * endY;

      edges.push({
        id: rawEdge.id,
        from: rawEdge.from,
        to: rawEdge.to,
        count: rawEdge.count,
        directCount: rawEdge.directCount,
        broadcastCount: rawEdge.broadcastCount,
        onlyBroadcast: rawEdge.directCount === 0 && rawEdge.broadcastCount > 0,
        lastSeq: rawEdge.lastSeq,
        channels: [...rawEdge.channels],
        path: `M ${startX.toFixed(1)} ${startY.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`,
        midX: Math.round(midX * 10) / 10,
        midY: Math.round(midY * 10) / 10,
      });
    }

    const lineageLinks = [];
    for (const node of others) {
      const parentName = node.addedBy || 'coordinator';
      const parent = nodeMap.get(parentName);
      if (parent && parent.name !== node.name) {
        lineageLinks.push({
          id: parent.name + '::' + node.name,
          from: parent.name,
          to: node.name,
          x1: parent.x,
          y1: parent.y,
          x2: node.x,
          y2: node.y,
        });
      }
    }

    return { width, height, nodeRadius: NODE_RADIUS, nodes: allNodes, edges, lineageLinks };
  }

  /**
   * Parse `swarm` tool arguments & result text into a compact Chinese summary for `tool.call.toolview`.
   */
  function summarizeSwarmToolCall(argsInput, bodyText, isError) {
    let args = {};
    if (typeof argsInput === 'string' && argsInput.trim() !== '') {
      try {
        const parsed = JSON.parse(argsInput);
        if (isPlainObject(parsed)) args = parsed;
      } catch {
        args = {};
      }
    } else if (isPlainObject(argsInput)) {
      args = argsInput;
    }

    const action = typeof args.action === 'string' ? args.action.trim() : '';
    const baseTitle = ACTION_LABELS[action] || (action ? 'Swarm · ' + action : 'Swarm 集群操作');
    const chips = [];

    if (action === 'add') {
      const count = Array.isArray(args.tasks) && args.tasks.length > 0
        ? args.tasks.length
        : (Number.isInteger(args.n) && args.n > 1 ? args.n : 1);
      if (typeof args.name === 'string' && args.name) {
        chips.push(count > 1 ? `@${args.name}-1..${count}` : `@${args.name}`);
      }
      if (args.fork === true || (typeof args.fork === 'string' && args.fork && args.fork !== 'false')) {
        chips.push(typeof args.fork === 'string' && args.fork !== 'true' ? 'fork:' + args.fork : 'fork:coordinator');
      }
      if (typeof args.workspace === 'string' && args.workspace !== 'inherit') chips.push(args.workspace);
      if (typeof args.model === 'string' && args.model) chips.push(args.model);
    } else if (action === 'model') {
      if (typeof args.name === 'string' && args.name) chips.push('@' + args.name);
      if (typeof args.model === 'string' && args.model) chips.push(args.model);
    } else if (action === 'kill') {
      if (typeof args.name === 'string' && args.name) chips.push('@' + args.name);
    } else if (action === 'title') {
      if (typeof args.title === 'string' && args.title) chips.push(args.title.slice(0, 32));
    } else if (action === 'channel') {
      if (typeof args.channel_action === 'string') chips.push(args.channel_action);
      if (typeof args.channel === 'string') chips.push('#' + args.channel.replace(/^#/, ''));
    }

    const preview = typeof bodyText === 'string'
      ? bodyText.replace(/\s+/g, ' ').trim().slice(0, 140)
      : '';

    return {
      action,
      title: isError ? baseTitle + '（失败）' : baseTitle,
      chips,
      preview,
    };
  }

  // ── Service Lookup & Navigation Helpers ─────────────────────────────────

  function resolveService(ctx, name) {
    if (!ctx || typeof ctx !== 'object') return undefined;
    if (typeof ctx.get === 'function') {
      try {
        const found = ctx.get(name);
        if (found !== undefined && found !== null) return found;
      } catch {
        // Ignore uninjected property errors
      }
    }
    try {
      return ctx[name];
    } catch {
      return undefined;
    }
  }

  function formatErrorMessage(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message || String(error);
    if (isPlainObject(error)) {
      if (typeof error.message === 'string' && error.message) return error.message;
      if (isPlainObject(error.error) && typeof error.error.message === 'string') return error.error.message;
      if (typeof error.error === 'string' && error.error) return error.error;
      if (typeof error.code === 'string' && error.code) return error.code;
    }
    return String(error);
  }

  function makeRemoteFailureFrame(code, message, details) {
    const error = new Error(message);
    error.name = 'RemoteError';
    error.isDSHRemoteError = true;
    error.code = code;
    error.details = isPlainObject(details) ? details : {};
    return { ok: false, error };
  }

  function formatDisplayTime(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      try {
        const d = new Date(value);
        return d.toTimeString().slice(0, 8);
      } catch {
        return '';
      }
    }
    const text = String(value).trim();
    const timeMatch = /(\d{2}:\d{2}:\d{2})/.exec(text);
    return timeMatch ? timeMatch[1] : text;
  }

  /**
   * Jump into a Swarm member's child session (or back to Coordinator),
   * supporting both the continuable subagent descriptor object and single-string fallback.
   */
  function openMemberSession(ctx, snapshot, member) {
    // 二期：外部 agy ACP 队友只有虚拟 sessionId（agy-<uuid>），没有可打开的原生会话。
    if (member && member.backend === 'agy-acp') {
      return {
        ok: false,
        reason: 'external-agy',
        error: '@' + member.name + ' 是外部 agy ACP 队友，没有原生会话轨迹；请通过 Swarm 留言板与其交互',
      };
    }
    const workspace = resolveService(ctx, 'uiWorkspace');
    if (!workspace || typeof workspace.openSession !== 'function') {
      return { ok: false, error: '当前环境不支持会话切换（uiWorkspace 不可用）' };
    }
    const coordId = snapshot && typeof snapshot.coordinatorSessionId === 'string' ? snapshot.coordinatorSessionId : '';
    const targetId = member && typeof member.sessionId === 'string' && member.sessionId
      ? member.sessionId
      : (member && member.name === 'coordinator' ? coordId : '');
    if (!targetId) {
      return { ok: false, error: '该成员尚未绑定可打开的会话 ID' };
    }

    if (!coordId || targetId === coordId || (member && member.name === 'coordinator')) {
      try {
        workspace.openSession(targetId);
        return { ok: true, sessionId: targetId, mode: 'root' };
      } catch (err) {
        return { ok: false, error: formatErrorMessage(err) };
      }
    }

    try {
      workspace.openSession({
        parentSessionId: coordId,
        childSessionId: targetId,
        mode: 'continuable',
      });
      return { ok: true, sessionId: targetId, mode: 'continuable' };
    } catch {
      try {
        workspace.openSession(targetId);
        return { ok: true, sessionId: targetId, mode: 'direct-fallback' };
      } catch (fallbackErr) {
        return { ok: false, error: formatErrorMessage(fallbackErr) };
      }
    }
  }

  /**
   * 打开可选扩展 dsh-agy-acp 的右侧栏 ACP 监控面板（契约 3.2）。
   * 外部 agy 队友没有原生会话轨迹，但它们的单步账单 / PID / 停止按钮都在 ACP 面板里。
   */
  function openMemberAcpMonitor(ctx, snapshot, member) {
    const sidebarRight = resolveService(ctx, 'sidebarRight');
    if (!sidebarRight || typeof sidebarRight.openResource !== 'function') {
      return { ok: false, error: '右侧边栏服务 sidebarRight 暂不可用' };
    }
    const coordId =
      snapshot && typeof snapshot.coordinatorSessionId === 'string' && snapshot.coordinatorSessionId
        ? snapshot.coordinatorSessionId
        : member && typeof member.sessionId === 'string'
          ? member.sessionId
          : '';
    const address = 'dsh-resource://agy-acp/' + encodeURIComponent(coordId || 'global');
    try {
      sidebarRight.openResource(address, { kind: 'agy-acp' });
      return { ok: true, address };
    } catch (err) {
      // 宿主未注册 agy-acp 的资源 kind 时降级为纯地址打开，绝不因此报错阻塞面板。
      try {
        sidebarRight.openResource(address);
        return { ok: true, address };
      } catch (fallbackErr) {
        return { ok: false, error: formatErrorMessage(fallbackErr) };
      }
    }
  }


  /**
   * 构造 `dsh-agy-swarm` 专属设置面板。
   * 采用 `React.useSyncExternalStore` 订阅 configForms 表单快照：
   * 只在 `status === 'ready' && writable === true` 时允许写入，文本框本地记草稿、
   * 失焦或点保存才写回宿主，并带防重入锁与「恢复默认设置」。
   */
  function createSwarmSettingsSection(React, h) {
    const useState = React.useState || ((init) => [typeof init === 'function' ? init() : init, () => {}]);
    const useEffect = React.useEffect || (() => {});
    const useRef = React.useRef || ((value) => ({ current: value }));
    const useSyncExternalStore = typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore
      : null;

    function useFormSnapshot(form) {
      if (useSyncExternalStore) {
        return useSyncExternalStore(
          (listener) => form.subscribe(listener),
          () => form.getSnapshot(),
          () => form.getSnapshot()
        );
      }
      // 离线单测的极简 React 替身没有 useSyncExternalStore：读一次快照即可。
      const [snapshot] = useState(() => (form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : null));
      return snapshot;
    }

    return function SwarmSettingsSection(props) {
      const form = props && props.form ? props.form : null;
      const t = typeof props?.t === 'function' ? props.t : (key) => String(key);
      const state = form ? useFormSnapshot(form) : null;
      const [pending, setPending] = useState(false);
      const [notice, setNotice] = useState('');
      const [drafts, setDrafts] = useState({});
      const writing = useRef(false);
      const alive = useRef(true);
      const draftRef = useRef({});
      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          draftRef.current = {};
        };
      }, []);

      /**
       * 模型派发权限面板的宿主模型目录。
       * - `props.models` 直接注入（离线单测 / 宿主预取）；
       * - `props.loadModels` 异步拉取（`getSwarmModels`）。
       * 两者都没有或拉取失败时，面板退化到「只用已保存规则 + 手动输入」，
       * 绝不阻塞设置页其它功能。
       */
      const [discoveredModels, setDiscoveredModels] = useState(() =>
        Array.isArray(props?.models) ? props.models.map(normalizeSwarmModelEntry) : null
      );
      const [modelsStatus, setModelsStatus] = useState('');
      const loadModels = typeof props?.loadModels === 'function' ? props.loadModels : null;
      useEffect(() => {
        if (!loadModels) return undefined;
        let cancelled = false;
        Promise.resolve()
          .then(() => loadModels())
          .then((list) => {
            if (cancelled || !alive.current) return;
            setDiscoveredModels(Array.isArray(list) ? list.map(normalizeSwarmModelEntry) : []);
            setModelsStatus('');
          })
          .catch(() => {
            if (cancelled || !alive.current) return;
            setModelsStatus('modelsUnavailable');
          });
        return () => {
          cancelled = true;
        };
      }, []);

      const value = (state && state.value) || {};
      const isReady = Boolean(state && state.status === 'ready');
      const writable = isReady && state.writable === true;
      const disabled = pending || !writable;

      const peerLimit = normalizeSettingsCount(value.maxConsecutivePeerWakes, SETTINGS_DEFAULTS.maxConsecutivePeerWakes);
      const turnLimit = normalizeSettingsCount(value.maxAgyTurnsPerMember, SETTINGS_DEFAULTS.maxAgyTurnsPerMember);
      const postLimit = normalizeSettingsCount(value.maxAgyPostsPerTurn, SETTINGS_DEFAULTS.maxAgyPostsPerTurn, 1);
      const nodeExecutable = typeof value.nodeExecutable === 'string' ? value.nodeExecutable : SETTINGS_DEFAULTS.nodeExecutable;

      // ── 模型派发权限（白名单 allowedModels / 黑名单 blockedModels）──────────
      const [whitelistDraft, setWhitelistDraft] = useState(null);
      const allowedRules = normalizeRuleList(value.allowedModels);
      const blockedRules = normalizeRuleList(value.blockedModels);
      /**
       * 严格白名单模式的权威来源是持久化的 `strictAllowlist` 开关；
       * `allowedModels` 非空时同样视为激活（兼容只手动配白名单的旧用法）。
       * 本地草稿只在写入成功后才保留，写失败即回滚到已持久化快照。
       */
      const strictPersisted = value.strictAllowlist === true || allowedRules.length > 0;
      const whitelistMode = whitelistDraft === null ? strictPersisted : whitelistDraft === true;
      const modelRows = (discoveredModels || []).map((entry) => {
        const blocked = modelEntryHitsRuleList(blockedRules, entry);
        const allowed = modelEntryHitsRuleList(allowedRules, entry);
        return {
          entry,
          blocked,
          allowed,
          checked: whitelistMode ? allowed && !blocked : !blocked,
        };
      });
      const modelRuleOf = (entry) =>
        entry.key || (entry.provider && entry.model ? entry.provider + '/' + entry.model : entry.model);

      const countText = (count, fallback) => (count === 0 ? t('infinite') : String(count === undefined ? fallback : count));
      const nodeSummary = nodeExecutable.trim()
        ? nodeExecutable.trim().split(/[\\/]/).pop()
        : t('nodePlaceholder');

      let status = '';
      if (state && state.status === 'loading') status = t('loading');
      else if (!isReady) status = t('unavailable');
      else if (isReady && !writable && !notice) status = t('readonlyBanner');
      else if (notice) status = t(notice);
      const noticeError = notice === 'error';

      const updateField = async (key, nextValue) => {
        if (!alive.current || disabled || writing.current || !form || typeof form.set !== 'function') return false;
        writing.current = true;
        setPending(true);
        setNotice('');
        try {
          const saved = await form.set(key, nextValue);
          if (alive.current && saved && Object.prototype.hasOwnProperty.call(draftRef.current, key) && draftRef.current[key] === nextValue) {
            const next = { ...draftRef.current };
            delete next[key];
            draftRef.current = next;
            setDrafts(next);
          }
          if (alive.current) setNotice(saved ? 'saved' : 'error');
          return saved === true;
        } catch {
          if (alive.current) setNotice('error');
          return false;
        } finally {
          writing.current = false;
          if (alive.current) setPending(false);
        }
      };

      const editField = (key, nextValue) => {
        if (!alive.current || disabled) return;
        const next = { ...draftRef.current, [key]: nextValue };
        draftRef.current = next;
        setDrafts(next);
      };
      const saveField = (key) => {
        if (!Object.prototype.hasOwnProperty.call(draftRef.current, key)) return undefined;
        return updateField(key, draftRef.current[key]);
      };

      const dropDraft = (key) => {
        if (!Object.prototype.hasOwnProperty.call(draftRef.current, key)) return;
        const next = { ...draftRef.current };
        delete next[key];
        draftRef.current = next;
        if (alive.current) setDrafts(next);
      };

      /**
       * 勾选/取消一个模型条目。
       * 黑名单模式：取消勾选 = 写入 blockedModels，重新勾选 = 移出。
       * 白名单模式：勾选 = 写入 allowedModels，取消 = 移出（黑名单优先，仍会拦截）。
       */
      /**
       * 写入白名单的**唯一**出口。白名单模式下先把 `strictAllowlist` 落盘：
       * 仅靠 `allowedModels` 非空激活的 legacy 配置，一旦清空最后一项就会
       * 反转成「未启用白名单 = 全部放行」，这里把它钉死为「严格模式 + 空名单 = 全禁」。
       */
      const writeAllowedRules = async (next) => {
        if (whitelistMode && value.strictAllowlist !== true) {
          if (!(await updateField('strictAllowlist', true))) return false;
        }
        return updateField('allowedModels', next);
      };

      const toggleModelRule = async (entry, nextChecked) => {
        if (!alive.current || disabled) return undefined;
        const rule = modelRuleOf(entry);
        if (!rule) return undefined;
        const keys = modelEntryRuleKeys(entry);
        if (whitelistMode) {
          const next = nextChecked
            ? [...allowedRules, rule]
            : allowedRules.filter((item) => !keys.includes(item.toLowerCase()));
          return writeAllowedRules(next);
        }
        const next = nextChecked
          ? blockedRules.filter((item) => !keys.includes(item.toLowerCase()))
          : [...blockedRules, rule];
        return updateField('blockedModels', next);
      };

      /**
       * 严格白名单开关。
       *
       * - 开启：先落 `strictAllowlist: true`，再把当前已勾选的模型写进白名单
       *   （目录为空时写 `[]`——此时 Host 会把「严格模式 + 空名单」判定为
       *   **全部拒绝**，与「未启用白名单」彻底区分开）。
       * - 关闭：先落 `strictAllowlist: false`，再清空白名单。
       * - 任一步写入失败：立即丢弃本地草稿，开关回落到已持久化快照并显示 error，
       *   绝不让界面显示一个实际没保存的开关状态。
       */
      const toggleWhitelistMode = async () => {
        if (!alive.current || disabled) return false;
        const next = !whitelistMode;
        if (next) {
          if (!(await updateField('strictAllowlist', true))) {
            if (alive.current) setWhitelistDraft(null);
            return false;
          }
          const merged = [...allowedRules];
          for (const row of modelRows) {
            if (!row.checked) continue;
            const rule = modelRuleOf(row.entry);
            if (!rule) continue;
            if (merged.some((item) => item.toLowerCase() === rule.toLowerCase())) continue;
            merged.push(rule);
          }
          if (!(await updateField('allowedModels', merged))) {
            if (alive.current) setWhitelistDraft(null);
            return false;
          }
        } else {
          if (!(await updateField('strictAllowlist', false))) {
            if (alive.current) setWhitelistDraft(null);
            return false;
          }
          if (!(await updateField('allowedModels', []))) {
            if (alive.current) setWhitelistDraft(null);
            return false;
          }
        }
        if (alive.current) setWhitelistDraft(next);
        return true;
      };

      /** 手动规则：支持直接加入禁用列表或允许列表。 */
      const manualRuleValue = () =>
        Object.prototype.hasOwnProperty.call(draftRef.current, 'manualModelRule')
          ? draftRef.current.manualModelRule
          : manualDraft;

      const addManualRule = async (target) => {
        if (!alive.current || disabled) return undefined;
        const rule = String(manualRuleValue() || '').trim();
        if (!rule) return undefined;
        if (!rule.includes('/')) {
          if (alive.current) setNotice('manualInvalid');
          return undefined;
        }
        const list = target === 'allowed' ? allowedRules : blockedRules;
        const merged = list.some((item) => item.toLowerCase() === rule.toLowerCase())
          ? [...list]
          : [...list, rule];
        const saved = target === 'allowed'
          ? await writeAllowedRules(merged)
          : await updateField('blockedModels', merged);
        if (saved) dropDraft('manualModelRule');
        return saved;
      };

      /** 手动重试拉取宿主模型目录（设置页零子进程，失败也不阻塞其它设置）。 */
      const refreshModels = async () => {
        if (!alive.current || disabled || !loadModels) return undefined;
        try {
          const list = await loadModels();
          if (!alive.current) return undefined;
          setDiscoveredModels(Array.isArray(list) ? list.map(normalizeSwarmModelEntry) : []);
          setModelsStatus('');
          return true;
        } catch {
          if (alive.current) setModelsStatus('modelsUnavailable');
          return false;
        }
      };

      const removeRuleChip = async (target, rule) => {
        if (!alive.current || disabled) return undefined;
        const list = target === 'allowed' ? allowedRules : blockedRules;
        const next = list.filter((item) => item.toLowerCase() !== String(rule).toLowerCase());
        if (target === 'allowed') return writeAllowedRules(next);
        return updateField('blockedModels', next);
      };

      const resetAll = async () => {
        if (!alive.current || disabled || writing.current || !form || typeof form.set !== 'function') return;
        writing.current = true;
        setPending(true);
        setNotice('');
        const keys = Object.keys(SETTINGS_DEFAULTS);
        const results = [];
        try {
          for (const key of keys) {
            if (!alive.current) return;
            const fallback = SETTINGS_DEFAULTS[key];
            results.push(Boolean(await form.set(key, Array.isArray(fallback) ? [...fallback] : fallback)));
          }
          if (!alive.current) return;
          draftRef.current = {};
          setDrafts({});
          setWhitelistDraft(null);
          setNotice(results.length === keys.length && results.every(Boolean) ? 'saved' : 'error');
        } catch {
          if (alive.current) setNotice('error');
        } finally {
          writing.current = false;
          if (alive.current) setPending(false);
        }
      };

      const presetRow = (field, labelText, hintText, presets) =>
        h('div', { className: 'dsh-swarm-settings-row', 'data-field-row': field },
          h('strong', null, labelText),
          h('div', { className: 'dsh-swarm-settings-group', role: 'group', 'aria-label': labelText },
            ...presets.map((preset) => h('button', {
              key: field + '-' + String(preset),
              type: 'button',
              className: 'dsh-swarm-settings-chip',
              'data-field': field,
              'data-value': String(preset),
              'aria-pressed': String((field === 'maxAgyPostsPerTurn' ? postLimit : field === 'maxAgyTurnsPerMember' ? turnLimit : peerLimit) === preset),
              disabled,
              onClick: () => updateField(field, preset),
            }, preset === 0 ? t('infinite') : String(preset)))
          ),
          h('p', { className: 'dsh-swarm-settings-hint' }, hintText)
        );

      const fieldValue = Object.prototype.hasOwnProperty.call(drafts, 'nodeExecutable')
        ? drafts.nodeExecutable
        : nodeExecutable;
      const manualDraft = Object.prototype.hasOwnProperty.call(drafts, 'manualModelRule')
        ? drafts.manualModelRule
        : '';

      return h('section', { className: 'dsh-swarm-settings', 'data-settings-id': SWARM_SETTINGS_ID, 'aria-label': t('title') },
        h('h2', null, t('title')),
        h('p', { className: 'dsh-swarm-settings-hint' }, t('subtitle')),
        h('div', { className: 'dsh-swarm-settings-summary', role: 'region', 'data-role': 'summary' },
          isReady
            ? h('span', null,
                t('summaryLabel') + ' · ' +
                t('summaryPeer') + ' ' + countText(peerLimit) + ' · ' +
                t('summaryTurns') + ' ' + countText(turnLimit) + ' · ' +
                t('summaryPosts') + ' ' + String(postLimit) + ' · ' +
                t('summaryNode') + ' ' + nodeSummary + ' · ' +
                t('summaryModels') + ' ' +
                (whitelistMode
                  ? (allowedRules.length === 0
                      ? t('modeWhitelistEmpty')
                      : t('modeWhitelist') + ' ' + String(allowedRules.length))
                  : t('modeBlacklist') + ' ' + String(blockedRules.length)))
            : h('span', null, status)
        ),
        h('div', { className: 'dsh-swarm-settings-card', 'data-card': 'loop' },
          h('h3', null, t('loopTitle')),
          presetRow('maxConsecutivePeerWakes', t('peerLabel'), t('peerHint'), SETTINGS_PRESETS.maxConsecutivePeerWakes),
          presetRow('maxAgyTurnsPerMember', t('turnsLabel'), t('turnsHint'), SETTINGS_PRESETS.maxAgyTurnsPerMember),
          presetRow('maxAgyPostsPerTurn', t('postsLabel'), t('postsHint'), SETTINGS_PRESETS.maxAgyPostsPerTurn)
        ),
        h('div', { className: 'dsh-swarm-settings-card', 'data-card': 'models' },
          h('h3', null, t('modelsTitle')),
          h('p', { className: 'dsh-swarm-settings-hint' }, t('modelsHint')),
          h('div', { className: 'dsh-swarm-settings-row' },
            h('button', {
              type: 'button',
              role: 'switch',
              className: 'dsh-swarm-settings-chip',
              'aria-checked': String(whitelistMode),
              'data-action': 'toggle-whitelist',
              'data-active': String(whitelistMode),
              disabled,
              onClick: toggleWhitelistMode,
            }, t('whitelistLabel'))
          ),
          h('p', { className: 'dsh-swarm-settings-hint', 'data-role': 'whitelist-hint' },
            whitelistMode ? t('whitelistHintOn') : t('whitelistHintOff')),
          h('div', { className: 'dsh-swarm-settings-row' },
            h('p', { className: 'dsh-swarm-settings-status', 'data-role': 'models-status' },
              modelsStatus ? t(modelsStatus) : (discoveredModels ? '' : t('modelsLoading'))),
            h('button', {
              type: 'button',
              className: 'dsh-swarm-settings-chip',
              'data-action': 'refresh-models',
              disabled: disabled || !loadModels,
              onClick: refreshModels,
            }, t('refreshModels'))
          ),
          modelRows.length === 0
            ? h('p', { className: 'dsh-swarm-settings-hint', 'data-role': 'models-empty' },
                whitelistMode && allowedRules.length === 0 ? t('whitelistNeedsModels') : t('modelsEmpty'))
            : h('ul', { className: 'dsh-swarm-settings-modellist', 'data-role': 'model-list' },
                ...modelRows.map((row, index) => {
                  const rule = modelRuleOf(row.entry);
                  return h('li', {
                    key: 'model-' + String(index) + '-' + rule,
                    className: 'dsh-swarm-settings-modelrow',
                    'data-model-key': rule,
                    'data-model-state': row.checked ? 'allowed' : (whitelistMode ? 'not-allowed' : 'blocked'),
                  },
                    h('label', { htmlFor: 'dsh-swarm-model-rule-' + String(index) },
                      h('input', {
                        id: 'dsh-swarm-model-rule-' + String(index),
                        type: 'checkbox',
                        checked: row.checked,
                        disabled,
                        'data-action': 'toggle-model',
                        'data-model-key': rule,
                        onChange: (event) => toggleModelRule(row.entry, event.target.checked),
                      }),
                      h('span', { className: 'dsh-swarm-settings-modelname' }, rule)
                    ),
                    row.entry.backend
                      ? h('span', { className: 'dsh-swarm-badge' }, row.entry.backend)
                      : null,
                    row.blocked
                      ? h('span', { className: 'dsh-swarm-settings-modelstate' }, t('modelBlocked'))
                      : null
                  );
                })
              ),
          h('label', { htmlFor: 'dsh-swarm-manualModelRule' }, t('manualLabel')),
          h('input', {
            id: 'dsh-swarm-manualModelRule',
            name: 'manualModelRule',
            type: 'text',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: t('manualPlaceholder'),
            value: manualDraft,
            disabled,
            'data-field': 'manualModelRule',
            onChange: (event) => editField('manualModelRule', event.target.value),
          }),
          h('div', { className: 'dsh-swarm-settings-row' },
            h('button', {
              type: 'button',
              className: 'dsh-swarm-settings-chip',
              'data-action': 'add-blocked-rule',
              disabled: disabled || String(manualDraft).trim() === '',
              onClick: () => addManualRule('blocked'),
            }, t('addBlocked')),
            h('button', {
              type: 'button',
              className: 'dsh-swarm-settings-chip',
              'data-action': 'add-allowed-rule',
              disabled: disabled || String(manualDraft).trim() === '',
              onClick: () => addManualRule('allowed'),
            }, t('addAllowed'))
          ),
          h('div', { className: 'dsh-swarm-settings-row', 'data-role': 'allowed-rules' },
            h('strong', null, t('allowedListLabel')),
            ...(allowedRules.length === 0
              ? [h('span', { key: 'allowed-empty', className: 'dsh-swarm-settings-hint' }, t('emptyRules'))]
              : allowedRules.map((rule) => h('button', {
                  key: 'allowed-' + rule,
                  type: 'button',
                  className: 'dsh-swarm-settings-chip',
                  'data-action': 'remove-allowed-rule',
                  'data-rule': rule,
                  title: t('removeRule'),
                  disabled,
                  onClick: () => removeRuleChip('allowed', rule),
                }, rule + ' ✕')))
          ),
          h('div', { className: 'dsh-swarm-settings-row', 'data-role': 'blocked-rules' },
            h('strong', null, t('blockedListLabel')),
            ...(blockedRules.length === 0
              ? [h('span', { key: 'blocked-empty', className: 'dsh-swarm-settings-hint' }, t('emptyRules'))]
              : blockedRules.map((rule) => h('button', {
                  key: 'blocked-' + rule,
                  type: 'button',
                  className: 'dsh-swarm-settings-chip',
                  'data-action': 'remove-blocked-rule',
                  'data-rule': rule,
                  title: t('removeRule'),
                  disabled,
                  onClick: () => removeRuleChip('blocked', rule),
                }, rule + ' ✕')))
          ),
          h('p', { className: 'dsh-swarm-settings-hint', 'data-role': 'agy-overlap-hint' }, t('agyOverlapHint'))
        ),
        h('div', { className: 'dsh-swarm-settings-card', 'data-card': 'runtime' },
          h('h3', null, t('runtimeTitle')),
          h('label', { htmlFor: 'dsh-swarm-nodeExecutable' }, t('nodeLabel')),
          h('input', {
            id: 'dsh-swarm-nodeExecutable',
            name: 'nodeExecutable',
            type: 'text',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: t('nodePlaceholder'),
            value: fieldValue,
            disabled,
            'data-field': 'nodeExecutable',
            onChange: (event) => editField('nodeExecutable', event.target.value),
            onBlur: () => saveField('nodeExecutable'),
          }),
          h('div', { className: 'dsh-swarm-settings-row' },
            h('button', {
              type: 'button',
              className: 'dsh-swarm-settings-chip',
              'data-action': 'save-nodeExecutable',
              disabled: disabled || !Object.prototype.hasOwnProperty.call(drafts, 'nodeExecutable'),
              onClick: () => saveField('nodeExecutable'),
            }, t('saveNode'))
          ),
          h('p', { className: 'dsh-swarm-settings-hint' }, t('nodeHint'))
        ),
        h('div', { className: 'dsh-swarm-settings-card' },
          h('p', {
            className: 'dsh-swarm-settings-status' + (noticeError ? ' is-error' : ''),
            role: noticeError ? 'alert' : 'status',
            'aria-live': 'polite',
            'data-role': 'notice',
          }, status),
          h('button', {
            type: 'button',
            className: 'dsh-swarm-settings-chip',
            'data-action': 'reset-defaults',
            disabled,
            onClick: resetAll,
          }, t('resetDefaults'))
        ),
        h('details', { className: 'dsh-swarm-settings-card' },
          h('summary', null, t('guideTitle')),
          h('p', { className: 'dsh-swarm-settings-hint' }, t('guideLoop')),
          h('p', { className: 'dsh-swarm-settings-hint' }, t('guideFallback')),
          h('p', { className: 'dsh-swarm-settings-hint' }, t('guideModels'))
        )
      );
    };
  }

  function sleepWithAbort(ms, signal) {
    if (signal && signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        resolve();
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // ── Scoped Stylesheet (Host CSS Tokens, Dark/Light Adaptive) ────────────

  const SWARM_CSS = [
    'a[href^="dsh-resource://swarm/"]{display:inline-flex;align-items:center;gap:4px;padding:1px 9px;margin:0 2px;border-radius:999px;font-size:12px;line-height:1.6;font-weight:500;text-decoration:none!important;cursor:pointer;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#3b82f6));background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 30%,transparent);transition:background .15s,border-color .15s}',
    'a[href^="dsh-resource://swarm/"]::before{content:"⬡";font-size:11px;opacity:.85}',
    'a[href^="dsh-resource://swarm/"]:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 20%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 50%,transparent)}',
    '.dsh-swarm-hdr-btn{min-height:28px;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:7px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:16px;cursor:pointer;font-variant-numeric:tabular-nums;transition:color .15s,background .15s,border-color .15s}',
    '.dsh-swarm-hdr-btn:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.36))}',
    '.dsh-swarm-hdr-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3b82f6);outline-offset:1px}',
    '.dsh-swarm-hdr-meta{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));font-size:11.5px}',
    '@keyframes dsh-swarm-pulse{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.45);opacity:.35}}',
    '@keyframes dsh-swarm-flash{0%{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 14%,transparent)}100%{box-shadow:none;background:var(--dsw-alias-bg-layer-2,transparent)}}',
    '.dsh-swarm-dot{position:relative;display:inline-flex;width:8px;height:8px;border-radius:999px;flex:none}',
    '.dsh-swarm-dot-working{background:var(--dsw-alias-state-success-primary,#10b981)}',
    '.dsh-swarm-dot-working::after{content:"";position:absolute;inset:-3px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#10b981);animation:dsh-swarm-pulse 1.6s ease-in-out infinite}',
    '.dsh-swarm-dot-waiting{background:var(--dsw-alias-state-business-primary,#3b82f6)}',
    '.dsh-swarm-dot-stopped{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
    '.dsh-swarm-dot-killed{background:var(--dsw-alias-label-tertiary,#6b7280);opacity:.55}',
    '.dsh-swarm-dot-done{background:var(--dsw-alias-state-success-primary,#10b981);opacity:.8}',
    '.dsh-swarm-pane{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.55;box-sizing:border-box}',
    '.dsh-swarm-pane-top{flex:none;padding:10px 14px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,transparent);display:flex;flex-direction:column;gap:8px}',
    '.dsh-swarm-title-row{display:flex;align-items:center;gap:8px;min-width:0}',
    '.dsh-swarm-title{font-size:13.5px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-swarm-stats{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
    '.dsh-swarm-tabs{display:flex;gap:4px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.1))}',
    '.dsh-swarm-tab{flex:1;appearance:none;border:0;border-radius:6px;padding:5px 8px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;gap:5px;transition:background .14s,color .14s}',
    '.dsh-swarm-tab:hover{color:var(--dsw-alias-label-primary)}',
    '.dsh-swarm-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-stroke,0 1px 2px rgba(0,0,0,.12))}',
    '.dsh-swarm-tab-count{font-size:10.5px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#888) 18%,transparent);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
    '.dsh-swarm-content{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 16px;display:flex;flex-direction:column;gap:8px}',
    '.dsh-swarm-filterbar{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding-bottom:6px;border-bottom:1px dashed var(--dsw-alias-border-l2)}',
    '.dsh-swarm-chip{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 9px;font:inherit;font-size:11.5px;line-height:16px;cursor:pointer;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:4px}',
    '.dsh-swarm-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
    '.dsh-swarm-chip[data-active="true"]{color:var(--dsw-alias-state-business-primary,#3b82f6);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 13%,transparent);font-weight:500}',
    '.dsh-swarm-badge{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;line-height:15px;padding:0 6px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary)}',
    '.dsh-swarm-badge-coord{color:var(--dsw-alias-state-business-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 13%,transparent)}',
    '.dsh-swarm-badge-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent)}',
    '.dsh-swarm-msg{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2,transparent);display:flex;flex-direction:column;gap:5px;transition:border-color .16s}',
    '.dsh-swarm-msg[data-highlighted="true"]{animation:dsh-swarm-flash 1.8s ease-out}',
    '.dsh-swarm-msg-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:11.5px}',
    '.dsh-swarm-seq{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;color:var(--dsw-alias-label-tertiary);cursor:pointer;border:0;background:none;padding:0}',
    '.dsh-swarm-seq:hover{color:var(--dsw-alias-state-business-primary,#3b82f6)}',
    '.dsh-swarm-speaker{font-weight:600;color:var(--dsw-alias-label-primary);cursor:pointer;border:0;background:none;padding:0}',
    '.dsh-swarm-speaker:hover{text-decoration:underline}',
    '.dsh-swarm-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
    '.dsh-swarm-msg-body{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
    '.dsh-swarm-msg-toggle{align-self:flex-start;appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 9px;margin-top:1px;font:inherit;font-size:11px;line-height:16px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary);transition:color .14s,border-color .14s}',
    '.dsh-swarm-msg-toggle:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary,#3b82f6)}',
    '.dsh-swarm-msg-toggle[data-expanded="true"]{color:var(--dsw-alias-label-tertiary)}',
    '.dsh-swarm-msg-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3b82f6);outline-offset:1px}',
    '.dsh-swarm-msg-body-collapsed{color:var(--dsw-alias-label-secondary);-webkit-mask-image:linear-gradient(180deg,#000 84%,transparent);mask-image:linear-gradient(180deg,#000 84%,transparent)}',
    '.dsh-swarm-fold-chip{font-variant-numeric:tabular-nums}',
    '.dsh-swarm-tok-mention{display:inline;padding:0 5px;border-radius:4px;font-weight:500;cursor:pointer;border:0;font:inherit;font-size:12px;color:var(--dsw-alias-state-business-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 13%,transparent)}',
    '.dsh-swarm-tok-broadcast{display:inline;padding:0 5px;border-radius:4px;font-weight:600;font-size:12px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 15%,transparent)}',
    '.dsh-swarm-tok-seq{display:inline;padding:0 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary)}',
    '.dsh-swarm-tok-seq:hover{border-color:var(--dsw-alias-state-business-primary,#3b82f6);color:var(--dsw-alias-state-business-primary,#3b82f6)}',
    '.dsh-swarm-member{text-align:left;width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:5px;cursor:pointer;font:inherit;transition:border-color .15s,background .15s}',
    '.dsh-swarm-member:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.07))}',
    '.dsh-swarm-member[data-killed="true"]{opacity:.68}',
    '.dsh-swarm-member-top{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
    '.dsh-swarm-member-name{font-weight:600;font-size:13px}',
    '.dsh-swarm-member-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
    '.dsh-swarm-member-activity{font-size:11.5px;color:var(--dsw-alias-state-success-primary,#10b981);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-swarm-member-error{margin-top:2px;padding:4px 8px;border-radius:6px;font-size:11.5px;color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 30%,transparent);white-space:pre-wrap;overflow-wrap:anywhere}',
    '.dsh-swarm-jump-hint{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
    '.dsh-swarm-badge-live{color:var(--dsw-alias-state-success-primary,#10b981);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 14%,transparent)}',
    '.dsh-swarm-member-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:2px}',
    '.dsh-swarm-settings{display:flex;flex-direction:column;gap:10px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
    '.dsh-swarm-settings h2{margin:0;font-size:15px}',
    '.dsh-swarm-settings h3{margin:0 0 2px;font-size:12.5px;font-weight:600}',
    '.dsh-swarm-settings-summary{padding:8px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
    '.dsh-swarm-settings-card{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2,transparent);display:flex;flex-direction:column;gap:7px}',
    '.dsh-swarm-settings-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
    '.dsh-swarm-settings-group{display:inline-flex;flex-wrap:wrap;gap:4px}',
    '.dsh-swarm-settings-chip{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 9px;font:inherit;font-size:11.5px;line-height:17px;cursor:pointer;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary);transition:border-color .14s,background .14s}',
    '.dsh-swarm-settings-chip:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#3b82f6);color:var(--dsw-alias-state-business-primary,#3b82f6)}',
    '.dsh-swarm-settings-chip[aria-pressed="true"]{color:var(--dsw-alias-state-business-primary,#3b82f6);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 13%,transparent);font-weight:500}',
    '.dsh-swarm-settings-chip[aria-checked="true"]{color:var(--dsw-alias-state-business-primary,#3b82f6);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 13%,transparent);font-weight:500}',
    '.dsh-swarm-settings-chip:disabled{opacity:.55;cursor:not-allowed}',
    '.dsh-swarm-settings-modellist{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto}',
    '.dsh-swarm-settings-modelrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent)}',
    '.dsh-swarm-settings-modelrow label{display:inline-flex;align-items:center;gap:6px;min-width:0;cursor:pointer;font-size:12px}',
    '.dsh-swarm-settings-modelname{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;overflow-wrap:anywhere}',
    '.dsh-swarm-settings-modelstate{font-size:11px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
    '.dsh-swarm-settings input[type="checkbox"]{width:auto;flex:none;margin:0;padding:0;accent-color:var(--dsw-alias-state-business-primary,#3b82f6)}',
    '.dsh-swarm-settings-hint{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}',
    '.dsh-swarm-settings-status{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
    '.dsh-swarm-settings-status.is-error{color:var(--dsw-alias-state-error-primary,#ef4444)}',
    '.dsh-swarm-settings input{width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
    '.dsh-swarm-graph-wrap{display:flex;flex-direction:column;gap:8px}',
    '.dsh-swarm-svg{width:100%;height:auto;max-height:400px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2,transparent);user-select:none}',
    '@keyframes dsh-swarm-ring-breathe{0%,100%{r:27px;stroke-opacity:.75}50%{r:33px;stroke-opacity:.15}}',
    '.dsh-swarm-svg-halo{fill:none;stroke:var(--dsw-alias-state-success-primary,#10b981);stroke-width:2.5;animation:dsh-swarm-ring-breathe 1.8s ease-in-out infinite}',
    '.dsh-swarm-node-group{cursor:pointer}',
    '.dsh-swarm-graph-inspector{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2,transparent);display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px}',
    '.dsh-swarm-card{margin:6px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);overflow:hidden;font-size:12.5px;line-height:1.55}',
    '.dsh-swarm-card-head{padding:8px 12px;display:flex;align-items:center;flex-wrap:wrap;gap:7px}',
    '.dsh-swarm-card-title{font-weight:600;font-size:12.5px}',
    '.dsh-swarm-card-actions{margin-left:auto;display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}',
    '.dsh-swarm-card-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 8px;font:inherit;font-size:11.5px;cursor:pointer;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary);transition:border-color .14s,background .14s}',
    '.dsh-swarm-card-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3b82f6);color:var(--dsw-alias-state-business-primary,#3b82f6)}',
    '.dsh-swarm-card-preview{padding:0 12px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
    '.dsh-swarm-empty{padding:24px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px}',
  ].join('\n');

  // ── Client Plugin Class ─────────────────────────────────────────────────

  class SwarmClientPlugin {
    static inject = ['slots', 'configForms', 'locale'];

    constructor(ctx, runtime) {
      if (!ctx || typeof ctx !== 'object') {
        throw new TypeError('SwarmClientPlugin requires a Cordis client context');
      }
      const rt = isPlainObject(runtime) ? runtime : {};
      const React = rt.React;
      if (!React || typeof React.createElement !== 'function') {
        throw new TypeError('SwarmClientPlugin requires React with createElement');
      }
      const h = React.createElement;
      const { useState, useEffect, useRef, useMemo } = React;

      this.ctx = ctx;
      this.React = React;
      this.disposed = false;
      this._cleanups = [];
      this._titleCache = new Map();

      let active = true;
      let mountedRemoteIdentity = null;
      let pendingMount = null;
      let disposeMount = null;

      const originalIdentity = (remote) => (remote && remote[Symbol.for('cordis.original')]) || remote;
      const getRemoteService = () => resolveService(ctx, 'remote');
      const getSwarmApi = () => {
        const direct = resolveService(ctx, 'remote.' + SWARM_SERVICE) || resolveService(ctx, SWARM_SERVICE);
        if (direct) return direct;
        const remote = getRemoteService();
        if (remote) {
          try {
            const sub = remote[SWARM_SERVICE];
            if (isPlainObject(sub)) return sub;
          } catch {
            // Cordis namespace proxy throws "cannot get property without inject" before $mount
          }
        }
        return undefined;
      };

      const ensureRemoteMounted = async () => {
        if (!active) throw new Error('Swarm 客户端已卸载');
        if (getSwarmApi()) return;
        if (pendingMount) return pendingMount;
        const remote = getRemoteService();
        if (!remote || typeof remote.$mount !== 'function') {
          throw new Error('Swarm 远程连接尚未就绪');
        }
        const currentId = originalIdentity(remote);
        if (mountedRemoteIdentity && mountedRemoteIdentity === currentId && getSwarmApi()) return;

        pendingMount = (async () => {
          const prevDispose = disposeMount;
          disposeMount = null;
          mountedRemoteIdentity = null;
          if (typeof prevDispose === 'function') {
            try { await prevDispose(); } catch {}
          }
          const unmount = await remote.$mount(SWARM_REMOTE);
          if (!active) {
            if (typeof unmount === 'function') {
              try { await unmount(); } catch {}
            }
            throw new Error('Swarm 客户端已卸载');
          }
          disposeMount = unmount;
          mountedRemoteIdentity = currentId;
        })();

        try {
          await pendingMount;
        } finally {
          pendingMount = null;
        }
      };

      const fetchSnapshotOnce = async (sessionId, _signal) => {
        await ensureRemoteMounted();
        const api = getSwarmApi();
        if (!api || typeof api.getSwarmSnapshot !== 'function') {
          throw new Error('Host 端 dsh-swarm.getSwarmSnapshot 服务未就绪');
        }
        const response = await api.getSwarmSnapshot({ sessionId });
        if (isPlainObject(response) && response.ok === false) {
          throw new Error(formatErrorMessage(response.error || response));
        }
        const snap = normalizeSwarmSnapshot(response, sessionId);
        if (snap.title) {
          this._titleCache.set(sessionId, snap.title);
          if (snap.coordinatorSessionId) this._titleCache.set(snap.coordinatorSessionId, snap.title);
        }
        return snap;
      };

      this.fetchSnapshotOnce = fetchSnapshotOnce;

      const openSwarmPane = (sessionId, tab, focusSeq) => {
        if (this.disposed) return { ok: false, error: 'Swarm 面板已卸载' };
        const cleanSession = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!cleanSession) return { ok: false, error: '缺少会话标识 sessionId' };
        const sidebarRight = resolveService(ctx, 'sidebarRight');
        if (!sidebarRight || typeof sidebarRight.openResource !== 'function') {
          return { ok: false, error: '右侧边栏服务 sidebarRight 暂不可用' };
        }
        const address = swarmAddress(cleanSession);
        const params = {};
        const normalizedTab = normalizeTab(tab);
        const normalizedSeq = normalizePositiveInt(focusSeq);
        if (normalizedTab) params.tab = normalizedTab;
        if (normalizedSeq !== undefined) params.focusSeq = normalizedSeq;
        const options = { kind: SWARM_PROTOCOL };
        if (Object.keys(params).length > 0) options.params = params;
        try {
          sidebarRight.openResource(address, options);
          return { ok: true, address, params };
        } catch (err) {
          return { ok: false, error: formatErrorMessage(err) };
        }
      };

      this.openSwarmPane = openSwarmPane;

      const createSwarmResourceProvider = () => ({
        protocol: SWARM_PROTOCOL,
        open: async function* (address, context) {
          const signal = context && context.signal ? context.signal : undefined;
          if (signal && signal.aborted) return;

          const parsed = parseSwarmAddress(address);
          if (!parsed) {
            yield makeRemoteFailureFrame('dsh-swarm/unsupported-address', '无效的 Swarm 资源地址：' + String(address), { address });
            return;
          }

          const sessionId = parsed.sessionId;
          let backoffMs = 800;
          let yieldedOnce = false;

          while (!signal || !signal.aborted) {
            try {
              const initial = await fetchSnapshotOnce(sessionId, signal);
              if (signal && signal.aborted) return;
              yield { ok: true, value: initial };
              yieldedOnce = true;
              backoffMs = 800;
            } catch (err) {
              if (signal && signal.aborted) return;
              if (!yieldedOnce) {
                yield makeRemoteFailureFrame('dsh-swarm/read-failed', formatErrorMessage(err), { sessionId });
              }
            }

            if (signal && signal.aborted) return;

            const api = getSwarmApi();
            if (api && typeof api.watchSwarm === 'function') {
              const streamAbort = new AbortController();
              const onCallerAbort = () => streamAbort.abort();
              if (signal && typeof signal.addEventListener === 'function') {
                signal.addEventListener('abort', onCallerAbort, { once: true });
              }
              let streamHandle = null;
              try {
                streamHandle = api.watchSwarm({ sessionId }, streamAbort.signal);
                if (streamHandle && typeof streamHandle.then === 'function') {
                  streamHandle = await streamHandle;
                }
                if (streamHandle && typeof streamHandle[Symbol.asyncIterator] === 'function') {
                  for await (const rawFrame of streamHandle) {
                    if (signal && signal.aborted) break;
                    if (isPlainObject(rawFrame) && rawFrame.ok === false) {
                      yield makeRemoteFailureFrame('dsh-swarm/stream-error', formatErrorMessage(rawFrame.error || rawFrame), { sessionId });
                      continue;
                    }
                    const snap = normalizeSwarmSnapshot(rawFrame, sessionId);
                    yield { ok: true, value: snap };
                    yieldedOnce = true;
                    backoffMs = 800;
                  }
                }
              } catch {
                // Transient stream disconnect: fall through to backoff reconnect loop
              } finally {
                if (signal && typeof signal.removeEventListener === 'function') {
                  signal.removeEventListener('abort', onCallerAbort);
                }
                streamAbort.abort();
                if (streamHandle && typeof streamHandle.dispose === 'function') {
                  try { streamHandle.dispose(); } catch {}
                }
              }
            } else {
              await sleepWithAbort(2000, signal);
              continue;
            }

            if (signal && signal.aborted) return;
            await sleepWithAbort(backoffMs, signal);
            backoffMs = Math.min(4000, Math.round(backoffMs * 1.6));
          }
        },
      });

      this.createSwarmResourceProvider = createSwarmResourceProvider;

      function useSwarmResourceSnapshot(props, sessionId) {
        const useResource = props && typeof props.useResource === 'function' ? props.useResource : null;
        const addr = sessionId ? swarmAddress(sessionId) : '';
        const res = useResource && addr ? useResource(addr) : null;

        const [fallbackSnap, setFallbackSnap] = useState(null);
        useEffect(() => {
          if (useResource || !sessionId || !active) return undefined;
          let cancelled = false;
          const controller = new AbortController();
          const poll = async () => {
            while (!cancelled && !controller.signal.aborted) {
              try {
                const snap = await fetchSnapshotOnce(sessionId, controller.signal);
                if (!cancelled) setFallbackSnap(snap);
              } catch {}
              await sleepWithAbort(2500, controller.signal);
            }
          };
          void poll();
          return () => {
            cancelled = true;
            controller.abort();
          };
        }, [Boolean(useResource), sessionId]);

        if (res) {
          return {
            status: res.status,
            snapshot: res.value ? normalizeSwarmSnapshot(res.value, sessionId) : null,
            failure: res.failure,
          };
        }
        return {
          status: fallbackSnap ? 'live' : 'loading',
          snapshot: fallbackSnap,
          failure: null,
        };
      }

      function StatusDot({ state }) {
        const meta = STATE_META[state] || STATE_META.waiting;
        return h('span', {
          className: 'dsh-swarm-dot dsh-swarm-dot-' + meta.tone,
          title: meta.label,
          'aria-label': meta.label,
        });
      }

      function FeedView({ snapshot, selectedChannel, setSelectedChannel, speakerFilter, setSpeakerFilter, highlightedSeq, onJumpSeq, onJumpMember }) {
        const feedEndRef = useRef(null);
        const msgRefs = useRef(new Map());
        // Auto-scroll only when the reader is already near the bottom (or on the
        // very first load), so reading history is never yanked away.
        const initialLoadRef = useRef(true);
        // Live sticky flag, refreshed by real scroll events. Comparing against
        // it (instead of a freshly grown scrollHeight) is what lets a very long
        // incoming message still follow the bottom.
        const stickToBottomRef = useRef(true);

        useEffect(() => {
          const endNode = feedEndRef.current;
          const container = endNode && endNode.parentElement ? endNode.parentElement : null;
          if (!container || typeof container.addEventListener !== 'function') return undefined;
          stickToBottomRef.current = isNearBottom(container);
          const onScroll = () => {
            applyStickToBottomOnScroll(stickToBottomRef, container);
          };
          container.addEventListener('scroll', onScroll, { passive: true });
          return () => container.removeEventListener('scroll', onScroll);
        }, []);

        const channelNames = useMemo(() => {
          const set = new Set(['main']);
          for (const ch of snapshot.channels) set.add(ch.name);
          for (const m of snapshot.messages) set.add(m.channel || 'main');
          return [...set];
        }, [snapshot.channels, snapshot.messages]);

        const filteredMessages = useMemo(() => {
          return snapshot.messages.filter((m) => {
            if (selectedChannel !== 'all' && m.channel !== selectedChannel) return false;
            if (speakerFilter && m.agent !== speakerFilter && !(Array.isArray(m.mentions) && m.mentions.includes(speakerFilter))) {
              const hitText = m.text.includes('@' + speakerFilter);
              if (!hitText) return false;
            }
            return true;
          });
        }, [snapshot.messages, selectedChannel, speakerFilter]);

        // Long-message folding: every message over the fold threshold renders a
        // truncated preview until the reader expands it (per-seq, in this view).
        const [expandedSeqs, setExpandedSeqs] = useState(() => new Set());
        const longSeqs = useMemo(
          () => filteredMessages.filter((m) => isLongSwarmMessage(m.text)).map((m) => m.seq),
          [filteredMessages]
        );

        const toggleExpanded = (seq) => {
          setExpandedSeqs((prev) => {
            const next = new Set(prev);
            if (next.has(seq)) next.delete(seq);
            else next.add(seq);
            return next;
          });
        };

        // A jump is a *request*, never a read of highlightedSeq: every click
        // bumps jumpTick, so re-clicking the SAME seq while its 2s highlight is
        // still on expands it again from a collapsed state.
        const [jumpTick, setJumpTick] = useState(0);
        const requestedSeqRef = useRef(null);
        const lastScrolledRef = useRef(null);
        const lastHighlightRef = useRef(null);

        const requestJump = (seq) => {
          requestedSeqRef.current = seq;
          setJumpTick((n) => n + 1);
          if (typeof onJumpSeq === 'function') onJumpSeq(seq);
        };

        // External jumps (topology node, dsh-resource deep link) arrive as
        // highlightedSeq values; each NEW value becomes exactly one request.
        useEffect(() => {
          if (!highlightedSeq) {
            lastHighlightRef.current = null;
            return;
          }
          if (lastHighlightRef.current === highlightedSeq) return;
          lastHighlightRef.current = highlightedSeq;
          requestedSeqRef.current = highlightedSeq;
          setJumpTick((n) => n + 1);
        }, [highlightedSeq]);

        // Phase 1 of a jump: request the expansion only. Scrolling is NOT done
        // here — this commit still holds the collapsed (preview) body.
        useEffect(() => {
          const target = requestedSeqRef.current;
          if (!target) return;
          setExpandedSeqs((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
        }, [jumpTick]);

        // Phase 2: scroll only once the expanded body is actually committed,
        // i.e. the rendered expandedSeqs contains the target. The marker keeps
        // manual expand/collapse of other messages from re-scrolling.
        useEffect(() => {
          const target = requestedSeqRef.current;
          if (!target) return;
          if (!expandedSeqs.has(target)) return;
          const marker = target + '@' + jumpTick;
          if (lastScrolledRef.current === marker) return;
          lastScrolledRef.current = marker;
          const node = msgRefs.current.get(target);
          if (node && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, [jumpTick, expandedSeqs]);

        useEffect(() => {
          if (highlightedSeq) return;
          const endNode = feedEndRef.current;
          const container = endNode && endNode.parentElement ? endNode.parentElement : null;
          if (!container) return;
          if (initialLoadRef.current) {
            // The first paint always sits at the bottom.
            initialLoadRef.current = false;
            stickToBottomRef.current = true;
          }
          followStickToBottom(stickToBottomRef, container);
        }, [filteredMessages.length, highlightedSeq]);

        const memberByName = useMemo(() => {
          const map = new Map();
          for (const m of snapshot.members) map.set(m.name, m);
          return map;
        }, [snapshot.members]);

        const renderBodyTokens = (text) => {
          const tokens = tokenizeSwarmText(text);
          return tokens.map((tok, idx) => {
            if (tok.type === 'text') return tok.text;
            if (tok.type === 'broadcast') {
              return h('span', { key: idx, className: 'dsh-swarm-tok-broadcast', title: '全员广播门铃' }, tok.raw);
            }
            if (tok.type === 'channel-mention') {
              return h('button', {
                key: idx,
                type: 'button',
                className: 'dsh-swarm-tok-mention',
                title: '筛选频道 #' + tok.channel,
                onClick: () => setSelectedChannel(tok.channel),
              }, tok.raw);
            }
            if (tok.type === 'mention') {
              return h('button', {
                key: idx,
                type: 'button',
                className: 'dsh-swarm-tok-mention',
                title: '点击按 ' + tok.raw + ' 筛选留言',
                onClick: () => setSpeakerFilter(speakerFilter === tok.target ? '' : tok.target),
              }, tok.raw);
            }
            if (tok.type === 'seq-ref') {
              return h('button', {
                key: idx,
                type: 'button',
                className: 'dsh-swarm-tok-seq',
                title: '跳转定位到消息 ' + tok.raw,
                onClick: () => requestJump(tok.seq),
              }, tok.raw);
            }
            if (tok.type === 'channel-tag') {
              if (channelNames.includes(tok.channel)) {
                return h('button', {
                  key: idx,
                  type: 'button',
                  className: 'dsh-swarm-tok-seq',
                  title: '切换到频道 #' + tok.channel,
                  onClick: () => setSelectedChannel(tok.channel),
                }, tok.raw);
              }
              return tok.raw;
            }
            if (tok.type === 'swarm-link') {
              return h('a', {
                key: idx,
                href: tok.raw,
                onClick: (e) => {
                  e.preventDefault();
                  openSwarmPane(tok.parsed.sessionId, tok.parsed.tab || 'feed', tok.parsed.focusSeq);
                },
              }, tok.parsed.tab === 'graph' ? '打开拓扑图' : (tok.parsed.tab === 'members' ? '打开成员列表' : '打开 Swarm 面板'));
            }
            return tok.raw;
          });
        };

        return h(React.Fragment, null,
          h('div', { className: 'dsh-swarm-filterbar', role: 'toolbar', 'aria-label': '留言流筛选' },
            h('button', {
              type: 'button',
              className: 'dsh-swarm-chip',
              'data-active': String(selectedChannel === 'all'),
              onClick: () => setSelectedChannel('all'),
            }, '全部频道'),
            ...channelNames.map((ch) => {
              const chInfo = snapshot.channels.find((item) => item.name === ch);
              return h('button', {
                key: ch,
                type: 'button',
                className: 'dsh-swarm-chip',
                'data-active': String(selectedChannel === ch),
                title: chInfo && chInfo.topic ? chInfo.topic : ('频道 #' + ch),
                onClick: () => setSelectedChannel(ch),
              }, '#' + ch + (chInfo && chInfo.archived ? ' (归档)' : ''));
            }),
            speakerFilter
              ? h('button', {
                  type: 'button',
                  className: 'dsh-swarm-chip',
                  'data-active': 'true',
                  title: '清除成员筛选',
                  onClick: () => setSpeakerFilter(''),
                }, '成员: @' + speakerFilter + ' ×')
              : null,
            longSeqs.length > 0
              ? h('button', {
                  type: 'button',
                  className: 'dsh-swarm-chip dsh-swarm-fold-chip',
                  'data-active': String(longSeqs.every((seq) => expandedSeqs.has(seq))),
                  title: '展开全部 ' + longSeqs.length + ' 条长留言',
                  onClick: () => setExpandedSeqs(new Set(longSeqs)),
                }, '全部展开')
              : null,
            longSeqs.length > 0
              ? h('button', {
                  type: 'button',
                  className: 'dsh-swarm-chip dsh-swarm-fold-chip',
                  title: '收起全部长留言，回到摘要视图',
                  onClick: () => setExpandedSeqs(new Set()),
                }, '全部收起')
              : null
          ),
          filteredMessages.length === 0
            ? h('div', { className: 'dsh-swarm-empty' }, snapshot.messages.length === 0 ? '留言板暂无消息，等待成员发帖…' : '当前筛选条件下没有匹配的留言。')
            : filteredMessages.map((msg) => {
                const senderInfo = memberByName.get(msg.agent);
                const isCoord = msg.agent === 'coordinator' || (senderInfo && senderInfo.role === 'coordinator');
                const roleLabel = isCoord
                  ? 'Coordinator'
                  : (senderInfo && senderInfo.role === 'monitor' ? 'Monitor' : (senderInfo && senderInfo.addedBy && senderInfo.addedBy !== 'coordinator' ? 'Helper' : 'Worker'));
                const timeStr = formatDisplayTime(msg.time);
                const isFoldable = isLongSwarmMessage(msg.text);
                const isExpanded = expandedSeqs.has(msg.seq);
                const bodyText = isFoldable && !isExpanded ? getCollapsedPreviewText(msg.text) : msg.text;
                const stats = isFoldable ? countSwarmMessageStats(msg.text) : null;

                return h('article', {
                  key: msg.seq,
                  'data-swarm-seq': String(msg.seq),
                  'data-highlighted': String(highlightedSeq === msg.seq),
                  className: 'dsh-swarm-msg',
                  ref: (el) => {
                    if (el) msgRefs.current.set(msg.seq, el);
                    else msgRefs.current.delete(msg.seq);
                  },
                },
                  h('div', { className: 'dsh-swarm-msg-head' },
                    h('button', {
                      type: 'button',
                      className: 'dsh-swarm-seq',
                      title: '定位 #' + msg.seq,
                      onClick: () => requestJump(msg.seq),
                    }, '#' + msg.seq),
                    senderInfo ? h(StatusDot, { state: senderInfo.state }) : null,
                    h('button', {
                      type: 'button',
                      className: 'dsh-swarm-speaker',
                      title: '点击查看成员 @' + msg.agent,
                      onClick: () => onJumpMember(msg.agent),
                    }, '@' + msg.agent),
                    h('span', { className: 'dsh-swarm-badge' + (isCoord ? ' dsh-swarm-badge-coord' : '') }, roleLabel),
                    msg.channel && (msg.channel !== 'main' || channelNames.length > 1)
                      ? h('span', { className: 'dsh-swarm-badge' }, '#' + msg.channel)
                      : null,
                    msg.broadcast ? h('span', { className: 'dsh-swarm-badge dsh-swarm-badge-warn' }, '@all 广播') : null,
                    timeStr ? h('span', { className: 'dsh-swarm-time' }, timeStr) : null
                  ),
                  h('div', {
                    className: 'dsh-swarm-msg-body' + (isFoldable && !isExpanded ? ' dsh-swarm-msg-body-collapsed' : ''),
                  }, ...renderBodyTokens(bodyText)),
                  isFoldable
                    ? h('button', {
                        type: 'button',
                        className: 'dsh-swarm-msg-toggle',
                        'data-expanded': String(isExpanded),
                        'aria-expanded': String(isExpanded),
                        title: isExpanded ? '收起这条长留言' : '展开完整留言',
                        onClick: () => toggleExpanded(msg.seq),
                      }, isExpanded
                        ? '收起 ▲'
                        : ('展开全文（共 ' + stats.chars + ' 字 / ' + stats.lines + ' 行）▼'))
                    : null
                );
              }),
          h('div', { ref: feedEndRef })
        );
      }

      function MembersView({ snapshot, navError, setNavError }) {
        const ordered = useMemo(() => orderMembersTree(snapshot.members), [snapshot.members]);
        const hasCoordInMembers = snapshot.members.some((m) => m.name === 'coordinator');

        const handleOpen = (member) => {
          const res = openMemberSession(ctx, snapshot, member);
          setNavError(res.ok ? '' : (res.error || '无法打开成员会话'));
        };

        // 外部 agy 队友没有原生轨迹，改为打开 dsh-agy-acp 的右侧栏监控面板。
        const handleAcpMonitor = (member) => {
          const res = openMemberAcpMonitor(ctx, snapshot, member);
          setNavError(res.ok ? '' : (res.error || '无法打开 ACP 监控面板'));
        };

        return h(React.Fragment, null,
          navError
            ? h('div', { className: 'dsh-swarm-member-error', role: 'alert' }, navError)
            : null,
          !hasCoordInMembers && snapshot.coordinatorSessionId
            ? h('button', {
                type: 'button',
                className: 'dsh-swarm-member',
                onClick: () => handleOpen({ name: 'coordinator', sessionId: snapshot.coordinatorSessionId }),
              },
                h('div', { className: 'dsh-swarm-member-top' },
                  h(StatusDot, { state: snapshot.done ? 'done' : 'waiting' }),
                  h('span', { className: 'dsh-swarm-member-name' }, '@coordinator'),
                  h('span', { className: 'dsh-swarm-badge dsh-swarm-badge-coord' }, snapshot.done ? 'Coordinator · 已结项' : 'Coordinator · 主控会话'),
                  h('span', { className: 'dsh-swarm-jump-hint' }, '查看会话轨迹 →')
                )
              )
            : null,
          ordered.length === 0
            ? h('div', { className: 'dsh-swarm-empty' }, '暂无已派生的 Worker 成员。')
            : ordered.map(({ member, depth }) => {
                const displayState =
                  snapshot.done && member.role === 'coordinator' && member.state !== 'working'
                    ? 'done'
                    : member.state;
                const stateMeta = STATE_META[displayState] || STATE_META.waiting;
                const wsLabel = WORKSPACE_LABELS[member.workspace] || member.workspace;
                const isExternalAgy = member.backend === 'agy-acp';
                const live = isExternalAgy ? member.agyLive : null;
                const usage = isExternalAgy ? member.agyUsage : null;
                const liveLabel = live ? (AGY_PHASE_TEXT[live.phase] || live.phase) : '';
                const tokenLabel = usage
                  ? '↑' + formatTokenCount(usage.totalInput) + ' ↓' + formatTokenCount(usage.totalOutput)
                  : '';
                const hitLabel = usage ? '缓存 ' + formatHitRate(usage.cacheHitRate) : '';
                return h(isExternalAgy ? 'div' : 'button', {
                  key: member.name,
                  ...(isExternalAgy ? { role: 'group', 'data-swarm-backend': 'agy-acp' } : { type: 'button' }),
                  className: 'dsh-swarm-member',
                  'data-swarm-member': member.name,
                  'data-killed': String(member.killed),
                  style: depth > 0 ? { marginLeft: String(Math.min(depth * 14, 42)) + 'px', width: `calc(100% - ${Math.min(depth * 14, 42)}px)` } : undefined,
                  title: (member.cwd ? ('工作目录: ' + member.cwd + '\n') : '') +
                    (isExternalAgy
                      ? '外部 agy ACP 队友：没有原生会话轨迹，唤醒与交互统一走 Swarm 留言板'
                      : '查看该成员原生会话轨迹（只读浏览历史；唤醒与交互统一走 Swarm 留言板）'),
                  ...(isExternalAgy ? {} : { onClick: () => handleOpen(member) }),
                },
                  h('div', { className: 'dsh-swarm-member-top' },
                    depth > 0 ? h('span', { style: { opacity: 0.55, fontSize: '12px' }, 'aria-hidden': true }, '↳') : null,
                    h(StatusDot, { state: displayState }),
                    h('span', { className: 'dsh-swarm-member-name' }, '@' + member.name),
                    h('span', { className: 'dsh-swarm-badge' + (member.role === 'coordinator' ? ' dsh-swarm-badge-coord' : '') }, stateMeta.label),
                    member.role && member.role !== 'worker'
                      ? h('span', { className: 'dsh-swarm-badge' }, member.role)
                      : null,
                    isExternalAgy
                      ? h('span', { className: 'dsh-swarm-badge', title: '外部 ACP 队友（dsh-agy-acp），通过留言板交互' }, 'ACP · 外部队友')
                      : h('span', { className: 'dsh-swarm-jump-hint' }, '查看会话轨迹 →'),
                    live
                      ? h('span', {
                          className: 'dsh-swarm-badge dsh-swarm-badge-live',
                          'data-agy-phase': live.phase,
                          title: '实时阶段（来源：dsh-agy-acp onProgress）',
                        }, '⚡ ' + liveLabel)
                      : null
                  ),
                  h('div', { className: 'dsh-swarm-member-meta' },
                    h('span', { className: 'dsh-swarm-badge', title: isExternalAgy ? '外部 agy 模型' : 'DSH 模型路由' },
                      member.modelDisplay + (member.reasoningEffort ? ' · ' + member.reasoningEffort : '')),
                    h('span', null, wsLabel),
                    member.addedBy
                      ? h('span', null, '上级: @' + member.addedBy)
                      : null,
                    h('span', null, '已读 #' + member.lastReadSeq + ' · 发帖 #' + member.lastPostSeq),
                    member.state === 'waiting' && Array.isArray(member.waitFor) && member.waitFor.length > 0
                      ? h('span', null, '等待: ' + member.waitFor.map((w) => '@' + w).join(', '))
                      : null,
                    member.channels && member.channels.length > 0
                      ? h('span', null, '频道: ' + member.channels.map((c) => '#' + c).join(', '))
                      : null
                  ),
                  isExternalAgy && (live || usage)
                    ? h('div', { className: 'dsh-swarm-member-meta', 'data-role': 'agy-live' },
                        live
                          ? h('span', {
                              className: 'dsh-swarm-badge',
                              'data-role': 'agy-pid',
                              title: live.pid > 0 ? 'agy.exe 进程 PID' : '宿主托管进程（未暴露 PID）',
                            }, live.pid > 0 ? 'PID ' + String(live.pid) : '宿主托管' + (live.runId ? ' · ' + live.runId : ''))
                          : null,
                        usage
                          ? h('span', { className: 'dsh-swarm-badge', 'data-role': 'agy-tokens', title: '累计输入 / 输出 Token' }, tokenLabel)
                          : null,
                        usage
                          ? h('span', { className: 'dsh-swarm-badge', 'data-role': 'agy-cache', title: '缓存命中率 = cacheRead / totalInput' }, hitLabel)
                          : null,
                        usage && usage.turns > 0
                          ? h('span', null, '累计 ' + String(usage.turns) + ' 轮 / ' + String(usage.stepCount) + ' 步')
                          : null
                      )
                    : null,
                  isExternalAgy
                    ? h('div', { className: 'dsh-swarm-member-actions' },
                        h('button', {
                          type: 'button',
                          className: 'dsh-swarm-card-btn',
                          'data-action': 'open-acp-monitor',
                          title: '打开右侧栏 ACP 实时监控（单步 Token 账单 / PID / 停止）',
                          onClick: () => handleAcpMonitor(member),
                        }, '查看 ACP 监控 →')
                      )
                    : null,
                  member.activity
                    ? h('div', { className: 'dsh-swarm-member-activity' }, '⚡ ' + member.activity)
                    : null,
                  member.lastError
                    ? h('div', { className: 'dsh-swarm-member-error' }, '⚠ ' + member.lastError)
                    : null
                );
              })
        );
      }

      function GraphView({ snapshot, onFilterFeedByMember, setNavError }) {
        const [selectedNode, setSelectedNode] = useState('');
        const [showBroadcast, setShowBroadcast] = useState(true);

        const graph = useMemo(
          () => buildMentionGraph(snapshot, { width: 560, height: 380, includeBroadcast: showBroadcast }),
          [snapshot, showBroadcast]
        );

        const selectedInfo = useMemo(
          () => graph.nodes.find((n) => n.name === selectedNode) || null,
          [graph.nodes, selectedNode]
        );

        const stateColor = (state) => {
          if (state === 'working' || state === 'done') return 'var(--dsw-alias-state-success-primary, #10b981)';
          if (state === 'stopped') return 'var(--dsw-alias-state-warn-primary, #f59e0b)';
          if (state === 'killed') return 'var(--dsw-alias-label-tertiary, #6b7280)';
          return 'var(--dsw-alias-state-business-primary, #3b82f6)';
        };

        const openSelected = (node) => {
          if (!node) return;
          const memberRecord = snapshot.members.find((m) => m.name === node.name) || {
            name: node.name,
            sessionId: node.sessionId || (node.name === 'coordinator' ? snapshot.coordinatorSessionId : ''),
          };
          const res = openMemberSession(ctx, snapshot, memberRecord);
          setNavError(res.ok ? '' : (res.error || '无法打开该节点会话'));
        };

        return h('div', { className: 'dsh-swarm-graph-wrap' },
          h('div', { className: 'dsh-swarm-filterbar' },
            h('span', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } },
              '节点 ' + graph.nodes.length + ' · 有向门铃边 ' + graph.edges.length + '（单击节点高亮，双击查看会话轨迹）'),
            h('button', {
              type: 'button',
              className: 'dsh-swarm-chip',
              style: { marginLeft: 'auto' },
              'data-active': String(showBroadcast),
              onClick: () => setShowBroadcast(!showBroadcast),
            }, showBroadcast ? '含 @all 广播边' : '仅点对点 @mention')
          ),
          h('svg', {
            className: 'dsh-swarm-svg',
            viewBox: `0 0 ${graph.width} ${graph.height}`,
            role: 'img',
            'aria-label': 'Swarm @mention 通信拓扑图',
          },
            h('defs', null,
              h('marker', {
                id: 'dsh-swarm-arrow-default',
                viewBox: '0 0 10 10',
                refX: '8',
                refY: '5',
                markerWidth: '6',
                markerHeight: '6',
                orient: 'auto-start-reverse',
              }, h('path', { d: 'M 0 1.5 L 9 5 L 0 8.5 z', fill: 'var(--dsw-alias-label-tertiary, #888)' })),
              h('marker', {
                id: 'dsh-swarm-arrow-active',
                viewBox: '0 0 10 10',
                refX: '8',
                refY: '5',
                markerWidth: '6.5',
                markerHeight: '6.5',
                orient: 'auto-start-reverse',
              }, h('path', { d: 'M 0 1.5 L 9 5 L 0 8.5 z', fill: 'var(--dsw-alias-state-business-primary, #3b82f6)' }))
            ),
            ...graph.lineageLinks.map((lnk) => h('line', {
              key: 'lin-' + lnk.id,
              x1: lnk.x1,
              y1: lnk.y1,
              x2: lnk.x2,
              y2: lnk.y2,
              stroke: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
              strokeWidth: 1,
              strokeDasharray: '3 4',
            })),
            ...graph.edges.map((edge) => {
              const isRelated = !selectedNode || edge.from === selectedNode || edge.to === selectedNode;
              const highlighted = Boolean(selectedNode && (edge.from === selectedNode || edge.to === selectedNode));
              const strokeWidth = Math.min(4, 1.35 + Math.log2(edge.count + 1) * 0.65);
              return h('g', {
                key: edge.id,
                style: { opacity: isRelated ? 1 : 0.22, transition: 'opacity .15s' },
              },
                h('path', {
                  d: edge.path,
                  fill: 'none',
                  stroke: highlighted
                    ? 'var(--dsw-alias-state-business-primary, #3b82f6)'
                    : 'var(--dsw-alias-label-tertiary, #888)',
                  strokeWidth,
                  strokeDasharray: edge.onlyBroadcast ? '4 3' : undefined,
                  markerEnd: highlighted ? 'url(#dsh-swarm-arrow-active)' : 'url(#dsh-swarm-arrow-default)',
                }),
                h('g', { transform: `translate(${edge.midX}, ${edge.midY})` },
                  h('title', null, `@${edge.from} → @${edge.to}：共 ${edge.count} 次提及（最新 #${edge.lastSeq}）`),
                  h('rect', {
                    x: -13,
                    y: -8,
                    width: 26,
                    height: 16,
                    rx: 8,
                    fill: 'var(--dsw-alias-bg-layer-3, #1f2937)',
                    stroke: highlighted
                      ? 'var(--dsw-alias-state-business-primary, #3b82f6)'
                      : 'var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
                    strokeWidth: 1,
                  }),
                  h('text', {
                    x: 0,
                    y: 3.5,
                    textAnchor: 'middle',
                    fontSize: '9.5',
                    fontWeight: '600',
                    fill: 'var(--dsw-alias-label-primary, currentColor)',
                  }, '×' + edge.count)
                )
              );
            }),
            ...graph.nodes.map((node) => {
              const isSelected = selectedNode === node.name;
              const color = stateColor(node.state);
              const shortName = node.name.length > 13 ? node.name.slice(0, 12) + '…' : node.name;
              return h('g', {
                key: node.name,
                className: 'dsh-swarm-node-group',
                transform: `translate(${node.x}, ${node.y})`,
                tabIndex: 0,
                role: 'button',
                'aria-label':
                  '@' + node.name + '（' + (STATE_META[node.state] || STATE_META.waiting).label +
                  '）：回车或空格选中，双击查看会话轨迹',
                'aria-pressed': isSelected,
                onClick: () => setSelectedNode(isSelected ? '' : node.name),
                onDoubleClick: () => openSelected(node),
                onKeyDown: (e) => {
                  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    setSelectedNode(isSelected ? '' : node.name);
                  }
                },
              },
                h('title', null, `@${node.name} (${(STATE_META[node.state] || STATE_META.waiting).label})\n发帖: ${node.postCount} · 被点名: ${node.mentionInCount}\n双击查看会话轨迹`),
                node.state === 'working'
                  ? h('circle', { cx: 0, cy: 0, r: 28, className: 'dsh-swarm-svg-halo' })
                  : null,
                h('circle', {
                  cx: 0,
                  cy: 0,
                  r: graph.nodeRadius,
                  fill: 'var(--dsw-alias-bg-layer-3, #1e293b)',
                  stroke: color,
                  strokeWidth: isSelected ? 3.2 : 2,
                }),
                h('text', {
                  x: 0,
                  y: 4,
                  textAnchor: 'middle',
                  fontSize: '10.5',
                  fontWeight: '700',
                  fill: 'var(--dsw-alias-label-primary, currentColor)',
                }, node.name === 'coordinator' ? 'COORD' : shortName.slice(0, 6).toUpperCase()),
                h('text', {
                  x: 0,
                  y: graph.nodeRadius + 14,
                  textAnchor: 'middle',
                  fontSize: '11',
                  fontWeight: isSelected ? '700' : '500',
                  fill: 'var(--dsw-alias-label-primary, currentColor)',
                }, '@' + shortName)
              );
            })
          ),
          selectedInfo
            ? h('div', { className: 'dsh-swarm-graph-inspector' },
                h(StatusDot, { state: selectedInfo.state }),
                h('strong', null, '@' + selectedInfo.name),
                h('span', { className: 'dsh-swarm-badge' }, (STATE_META[selectedInfo.state] || STATE_META.waiting).label),
                h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } },
                  `发帖 ${selectedInfo.postCount} · 被 @ 唤醒 ${selectedInfo.mentionInCount}`),
                h('div', { style: { marginLeft: 'auto', display: 'inline-flex', gap: '6px' } },
                  h('button', {
                    type: 'button',
                    className: 'dsh-swarm-card-btn',
                    onClick: () => onFilterFeedByMember(selectedInfo.name),
                  }, '在留言流查看'),
                  h('button', {
                    type: 'button',
                    className: 'dsh-swarm-card-btn',
                    onClick: () => openSelected(selectedInfo),
                  }, '查看会话轨迹 →')
                )
              )
            : null
        );
      }

      function SwarmPaneBody(props) {
        const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : { tab: props.tab || {} };
        const tabRecord = (info && info.tab) || {};
        const parsed = parseSwarmAddress(tabRecord.contentId || '');
        const navigation = isPlainObject(tabRecord.navigation) ? tabRecord.navigation : {};
        const navParams = isPlainObject(navigation.params) ? navigation.params : {};
        const navRevision = Number.isInteger(navigation.revision) ? navigation.revision : 0;

        const initialTab = normalizeTab(navParams.tab) || (parsed && parsed.tab) || 'feed';
        const [activeTab, setActiveTab] = useState(initialTab);
        const [selectedChannel, setSelectedChannel] = useState('all');
        const [speakerFilter, setSpeakerFilter] = useState('');
        const [highlightedSeq, setHighlightedSeq] = useState(
          normalizePositiveInt(navParams.focusSeq) || (parsed && parsed.focusSeq) || 0
        );
        const [navError, setNavError] = useState('');

        useEffect(() => {
          const requestedTab = normalizeTab(navParams.tab) || (parsed && parsed.tab);
          if (requestedTab) setActiveTab(requestedTab);
          const requestedSeq = normalizePositiveInt(navParams.focusSeq ?? navParams.seq) || (parsed && parsed.focusSeq);
          if (requestedSeq) {
            setActiveTab('feed');
            setSelectedChannel('all');
            setSpeakerFilter('');
            setHighlightedSeq(requestedSeq);
          }
        }, [navRevision, navParams.tab, navParams.focusSeq, navParams.seq]);

        useEffect(() => {
          if (!highlightedSeq) return undefined;
          const timer = setTimeout(() => setHighlightedSeq(0), 2000);
          return () => clearTimeout(timer);
        }, [highlightedSeq]);

        const resourceState = useSwarmResourceSnapshot(props, parsed ? parsed.sessionId : '');

        if (!parsed) {
          return h('div', { className: 'dsh-swarm-empty' }, '无法解析 Swarm 面板地址：' + String(tabRecord.contentId || ''));
        }
        if (resourceState.status === 'failed' && !resourceState.snapshot) {
          return h('div', { className: 'dsh-swarm-empty', role: 'alert' },
            '读取 Swarm 状态失败：' + formatErrorMessage(resourceState.failure));
        }
        if (!resourceState.snapshot) {
          return h('div', { className: 'dsh-swarm-empty', role: 'status' }, '正在连接 Swarm 实时流…');
        }

        const snapshot = resourceState.snapshot;
        if (!snapshot.hasSwarm) {
          return h('div', { className: 'dsh-swarm-empty' }, '当前会话尚未启动 Swarm 集群。可使用 /swarm 或调用 swarm 工具创建。');
        }

        const workingCount = snapshot.members.filter((m) => m.state === 'working').length;
        const waitingCount = snapshot.members.filter((m) => m.state === 'waiting').length;
        const isSettledDone = snapshot.done === true && workingCount === 0;

        const handleJumpSeq = (seq) => {
          setSelectedChannel('all');
          setSpeakerFilter('');
          setActiveTab('feed');
          setHighlightedSeq(seq);
        };

        const handleJumpMember = (agentName) => {
          if (agentName === 'coordinator' || snapshot.members.some((m) => m.name === agentName)) {
            setActiveTab('members');
          } else {
            setSpeakerFilter(agentName);
          }
        };

        return h('div', { className: 'dsh-swarm-pane', 'data-swarm-session': snapshot.coordinatorSessionId },
          h('div', { className: 'dsh-swarm-pane-top' },
            h('div', { className: 'dsh-swarm-title-row' },
              h(StatusDot, { state: workingCount > 0 ? 'working' : (isSettledDone ? 'done' : 'waiting') }),
              h('div', { className: 'dsh-swarm-title', title: snapshot.title || 'Swarm 协作集群' },
                snapshot.title || 'Swarm 协作集群'),
              snapshot.resolvedFromMember
                ? h('span', { className: 'dsh-swarm-badge' }, '视角: @' + snapshot.resolvedFromMember)
                : null,
              h('div', { className: 'dsh-swarm-stats' },
                isSettledDone
                  ? h('span', null, '已结项')
                  : h(React.Fragment, null,
                      h('span', null, workingCount + ' 运行'),
                      h('span', null, '·'),
                      h('span', null, waitingCount + ' 休眠')
                    ),
                h('span', null, '·'),
                h('span', null, '#' + snapshot.head)
              )
            ),
            h('div', { className: 'dsh-swarm-tabs', role: 'tablist', 'aria-label': 'Swarm 视图切换' },
              h('button', {
                type: 'button',
                role: 'tab',
                'aria-selected': activeTab === 'feed',
                'data-active': String(activeTab === 'feed'),
                className: 'dsh-swarm-tab',
                onClick: () => setActiveTab('feed'),
              }, '留言流', h('span', { className: 'dsh-swarm-tab-count' }, String(snapshot.messages.length))),
              h('button', {
                type: 'button',
                role: 'tab',
                'aria-selected': activeTab === 'members',
                'data-active': String(activeTab === 'members'),
                className: 'dsh-swarm-tab',
                onClick: () => setActiveTab('members'),
              }, '成员', h('span', { className: 'dsh-swarm-tab-count' }, String(snapshot.members.length))),
              h('button', {
                type: 'button',
                role: 'tab',
                'aria-selected': activeTab === 'graph',
                'data-active': String(activeTab === 'graph'),
                className: 'dsh-swarm-tab',
                onClick: () => setActiveTab('graph'),
              }, '拓扑图')
            )
          ),
          h('div', { className: 'dsh-swarm-content' },
            activeTab === 'feed'
              ? h(FeedView, {
                  snapshot,
                  selectedChannel,
                  setSelectedChannel,
                  speakerFilter,
                  setSpeakerFilter,
                  highlightedSeq,
                  onJumpSeq: handleJumpSeq,
                  onJumpMember: handleJumpMember,
                })
              : activeTab === 'members'
                ? h(MembersView, { snapshot, navError, setNavError })
                : h(GraphView, {
                    snapshot,
                    setNavError,
                    onFilterFeedByMember: (name) => {
                      setSpeakerFilter(name);
                      setSelectedChannel('all');
                      setActiveTab('feed');
                    },
                  })
          )
        );
      }

      function SwarmHeaderAction(props) {
        const rawSessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
        const parentSessionId = typeof props.useSession === 'function'
          ? (props.useSession((s) => s && s.subagent && s.subagent.address && s.subagent.address.parentSessionId) || rawSessionId)
          : rawSessionId;

        const { snapshot } = useSwarmResourceSnapshot(props, parentSessionId || rawSessionId);
        if (!snapshot || snapshot.hasSwarm !== true) return null;

        const workingCount = snapshot.members.filter((m) => m.state === 'working').length;
        const activeMembers = snapshot.members.filter((m) => !m.killed).length;
        const isSettledDone = snapshot.done === true && workingCount === 0;
        const targetSessionId = snapshot.coordinatorSessionId || parentSessionId || rawSessionId;
        const statusSummary = workingCount > 0
          ? `${workingCount} 运行中 / #${snapshot.head}`
          : isSettledDone
            ? `已结项 / #${snapshot.head}`
            : `${activeMembers} 在岗 / #${snapshot.head}`;

        return h('button', {
          type: 'button',
          className: 'dsh-swarm-hdr-btn',
          'data-dsh-swarm-header-btn': 'true',
          title: (snapshot.title ? snapshot.title + ' — ' : '') + '点击打开右侧 Swarm 实时面板',
          onClick: () => openSwarmPane(targetSessionId, 'feed'),
        },
          h(StatusDot, { state: workingCount > 0 ? 'working' : (isSettledDone ? 'done' : 'waiting') }),
          h('span', null, 'Swarm'),
          h('span', { className: 'dsh-swarm-hdr-meta' }, '· ' + statusSummary)
        );
      }

      function SwarmToolView(props) {
        const [errorMsg, setErrorMsg] = useState('');
        const block = props && props.block;
        const settled = isPlainObject(block) && 'kind' in block;
        const argsRaw = settled
          ? (block.call && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : '')
          : (isPlainObject(block) && typeof block.argsRaw === 'string' ? block.argsRaw : '');
        const isError = settled && block.isError === true;

        let bodyText = '';
        if (settled && Array.isArray(block.content)) {
          bodyText = block.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n')
            .trim();
        }

        const summary = summarizeSwarmToolCall(argsRaw, bodyText, isError);
        const metaCoordId = settled && isPlainObject(block.meta) && typeof block.meta.coordinatorSessionId === 'string'
          ? block.meta.coordinatorSessionId
          : '';
        const targetSessionId = metaCoordId || (typeof props.sessionId === 'string' ? props.sessionId : '');

        const openTab = (tab) => {
          const res = openSwarmPane(targetSessionId, tab);
          setErrorMsg(res.ok ? '' : (res.error || '右侧栏暂不可用'));
        };

        return h('div', { className: 'dsh-swarm-card', 'data-dsh-swarm-card': summary.action || 'swarm' },
          h('div', { className: 'dsh-swarm-card-head' },
            h('span', { 'aria-hidden': true }, '⬡'),
            h('span', {
              className: 'dsh-swarm-card-title',
              style: isError ? { color: 'var(--dsw-alias-state-error-primary, #ef4444)' } : undefined,
            }, settled ? summary.title : (summary.title + '…')),
            ...summary.chips.map((chipText, idx) => h('span', { key: idx, className: 'dsh-swarm-badge' }, chipText)),
            targetSessionId
              ? h('div', { className: 'dsh-swarm-card-actions' },
                  h('button', { type: 'button', className: 'dsh-swarm-card-btn', onClick: () => openTab('feed') }, '留言流'),
                  h('button', { type: 'button', className: 'dsh-swarm-card-btn', onClick: () => openTab('members') }, '成员'),
                  h('button', { type: 'button', className: 'dsh-swarm-card-btn', onClick: () => openTab('graph') }, '拓扑图')
                )
              : null
          ),
          summary.preview
            ? h('div', {
                className: 'dsh-swarm-card-preview',
                style: isError ? { color: 'var(--dsw-alias-state-error-primary, #ef4444)' } : undefined,
              }, summary.preview)
            : null,
          errorMsg
            ? h('div', { className: 'dsh-swarm-card-preview', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)' } }, errorMsg)
            : null
        );
      }

      function SwarmCommandView(props) {
        const [errorMsg, setErrorMsg] = useState('');
        const cmdNode = isPlainObject(props && props.node) ? props.node : {};
        const outcome = isPlainObject(cmdNode.outcome) ? cmdNode.outcome : null;
        const isError = Boolean(outcome && outcome.kind === 'error');
        const isRunning = outcome === null;
        const rawArgs = typeof cmdNode.args === 'string' ? cmdNode.args.trim() : '';
        const targetSessionId = typeof props.sessionId === 'string' ? props.sessionId : '';

        const openTab = (tab) => {
          const res = openSwarmPane(targetSessionId, tab);
          setErrorMsg(res.ok ? '' : (res.error || '右侧栏暂不可用'));
        };

        const previewText = outcome && typeof outcome.text === 'string' && outcome.text.trim()
          ? outcome.text.trim()
          : rawArgs;

        return h('div', { className: 'dsh-swarm-card', 'data-dsh-swarm-card': 'command' },
          h('div', { className: 'dsh-swarm-card-head' },
            h('span', { 'aria-hidden': true }, '⬡'),
            h('span', {
              className: 'dsh-swarm-card-title',
              style: isError ? { color: 'var(--dsw-alias-state-error-primary, #ef4444)' } : undefined,
            }, isRunning ? 'Swarm · 正在启动集群…' : (isError ? 'Swarm · 命令执行失败' : 'Swarm · 多智能体协作集群')),
            rawArgs ? h('span', { className: 'dsh-swarm-badge' }, '/swarm') : null,
            targetSessionId
              ? h('div', { className: 'dsh-swarm-card-actions' },
                  h('button', { type: 'button', className: 'dsh-swarm-card-btn', onClick: () => openTab('feed') }, '留言流'),
                  h('button', { type: 'button', className: 'dsh-swarm-card-btn', onClick: () => openTab('members') }, '成员'),
                  h('button', { type: 'button', className: 'dsh-swarm-card-btn', onClick: () => openTab('graph') }, '拓扑图')
                )
              : null
          ),
          previewText
            ? h('div', {
                className: 'dsh-swarm-card-preview',
                style: isError ? { color: 'var(--dsw-alias-state-error-primary, #ef4444)' } : undefined,
              }, previewText)
            : null,
          errorMsg
            ? h('div', { className: 'dsh-swarm-card-preview', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)' } }, errorMsg)
            : null
        );
      }

      // FeedView is exposed for offline component tests (folding + #seq jump
      // behaviour is otherwise only reachable through the live pane).
      this.components = { SwarmPaneBody, SwarmHeaderAction, SwarmToolView, SwarmCommandView, FeedView };

      const ownEffect = (label, setup) => {
        if (typeof ctx.effect === 'function') {
          const off = ctx.effect(() => {
            const cleanup = setup();
            return typeof cleanup === 'function' ? cleanup : () => {};
          }, label);
          if (typeof off === 'function') this._cleanups.push(off);
        } else {
          const cleanup = setup();
          if (typeof cleanup === 'function') this._cleanups.push(cleanup);
        }
      };

      ownEffect('dsh-swarm: styles & link interceptor', () => {
        const localDisposers = [];
        if (typeof document !== 'undefined' && document.head && typeof document.createElement === 'function') {
          const styleEl = document.createElement('style');
          styleEl.setAttribute('data-dsh-swarm-styles', 'true');
          styleEl.textContent = SWARM_CSS;
          document.head.appendChild(styleEl);
          localDisposers.push(() => styleEl.remove());
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          const onClickCapture = (event) => {
            if (!event || event.button !== undefined && event.button !== 0) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const target = event.target;
            const el = target && target.nodeType === 1 ? target : (target ? target.parentElement : null);
            const anchor = el && typeof el.closest === 'function' ? el.closest('a[href]') : null;
            if (!anchor) return;
            const href = anchor.getAttribute('href');
            const parsed = parseSwarmAddress(href || '');
            if (!parsed) return;
            event.preventDefault();
            event.stopPropagation();
            openSwarmPane(parsed.sessionId, parsed.tab || 'feed', parsed.focusSeq);
          };
          document.addEventListener('click', onClickCapture, true);
          localDisposers.push(() => document.removeEventListener('click', onClickCapture, true));
        }
        return () => {
          for (const off of localDisposers.reverse()) {
            try { off(); } catch {}
          }
        };
      });

      ownEffect('dsh-swarm: remote lifetime', () => {
        void ensureRemoteMounted().catch(() => {});
        const offReset = typeof ctx.on === 'function'
          ? ctx.on('connection/reset', () => {
              mountedRemoteIdentity = null;
              void ensureRemoteMounted().catch(() => {});
            })
          : null;
        return async () => {
          active = false;
          if (typeof offReset === 'function') offReset();
          if (pendingMount) {
            try { await pendingMount; } catch {}
          }
          const unmount = disposeMount;
          disposeMount = null;
          mountedRemoteIdentity = null;
          if (typeof unmount === 'function') {
            try { await unmount(); } catch {}
          }
        };
      });

      const slots = resolveService(ctx, 'slots');
      if (slots && typeof slots.register === 'function') {
        const registerSlot = (slotName, spec, component) => {
          if (typeof slots.inject === 'function') {
            return slots.inject(slotName, () => slots.register(spec, component));
          }
          return slots.register(spec, component);
        };

        ownEffect('dsh-swarm: header & tool slots', () => {
          const offs = [];
          offs.push(registerSlot(HEADER_ACTION_SLOT, {
            name: HEADER_ACTION_SLOT,
            id: 'dsh-swarm',
            order: -18,
          }, SwarmHeaderAction));
          offs.push(registerSlot(TOOL_VIEW_SLOT, {
            name: TOOL_VIEW_SLOT,
            key: 'swarm',
          }, SwarmToolView));
          offs.push(registerSlot(COMMAND_VIEW_SLOT, {
            name: COMMAND_VIEW_SLOT,
            key: 'swarm',
          }, SwarmCommandView));
          offs.push(registerSlot(SWARM_TAB_SLOT, {
            name: SWARM_TAB_SLOT,
            key: SWARM_TAB_ID,
          }, SwarmPaneBody));
          return () => {
            for (const off of offs.reverse()) {
              if (typeof off === 'function') {
                try { off(); } catch {}
              }
            }
          };
        });
      }


      // ── 专属设置页（settings.section id: 'dsh-agy-swarm', order: 39）────────
      const mountSettingsSection = (sctx) => {
        const configForms = resolveService(sctx, 'configForms');
        const localeSvc = resolveService(sctx, 'locale');
        const slotSvc = resolveService(sctx, 'slots');
        if (!configForms || typeof configForms.get !== 'function') return () => {};
        if (!localeSvc || typeof localeSvc.register !== 'function' || typeof localeSvc.bind !== 'function') return () => {};
        if (!slotSvc || typeof slotSvc.register !== 'function') return () => {};
        const offs = [];
        offs.push(localeSvc.register(SWARM_SETTINGS_NS, SETTINGS_DICTS));
        const bindLocale = () => localeSvc.bind(SWARM_SETTINGS_NS);
        /**
         * 宿主 `configForms.get(id)` 永远返回一个 controller（不会返回空值），
         * 所以「get(新) || get(旧)」这种探测是死代码。真正的存在性来自
         * `whileServed` 回调给出的 served 命名空间集合：按它挑选表单 id，
         * 升级前的旧 patch entry（local-dsh-swarm）同样能正常读写。
         */
        const pickSettingsId = (served) => {
          if (served && typeof served.has === 'function') {
            if (served.has(SWARM_SETTINGS_ID)) return SWARM_SETTINGS_ID;
            if (served.has(SWARM_SETTINGS_ID_LEGACY)) return SWARM_SETTINGS_ID_LEGACY;
          }
          return SWARM_SETTINGS_ID;
        };
        const Section = createSwarmSettingsSection(React, h);
        /**
         * 设置页拉取宿主已发现模型目录（Typert `getSwarmModels`）。
         * 拉取失败 / 远程未注入时抛错，由组件降级为「只用已保存规则 + 手动输入」，
         * 绝不阻塞设置页其它功能。
         */
        const loadSwarmModels = async () => {
          await ensureRemoteMounted();
          const api = getSwarmApi();
          if (!api || typeof api.getSwarmModels !== 'function') {
            throw new Error('Host 端 dsh-swarm.getSwarmModels 服务未就绪');
          }
          const response = await api.getSwarmModels({ probeAgy: false });
          if (isPlainObject(response) && response.ok === false) {
            throw new Error(formatErrorMessage(response.error || response));
          }
          return parseSwarmModelsResult(response).models;
        };
        const register = (...registerArgs) => {
          const served = registerArgs.find((arg) => arg && typeof arg.has === 'function');
          const form = configForms.get(pickSettingsId(served));
          return slotSvc.register({
            name: 'settings.section',
            id: SWARM_SETTINGS_ID,
            order: SWARM_SETTINGS_ORDER,
            label: () => bindLocale()('title'),
            locale: SWARM_SETTINGS_NS,
            inject: () => ({ form, t: bindLocale(), loadModels: loadSwarmModels }),
          }, Section);
        };
        if (typeof configForms.whileServed === 'function') {
          // whileServed 是「任一命名空间被服务即回调」，因此新/旧 id 可同时关注。
          offs.push(configForms.whileServed([SWARM_SETTINGS_ID, SWARM_SETTINGS_ID_LEGACY], (served) => {
            const inner = typeof slotSvc.inject === 'function'
              ? slotSvc.inject('settings.section', () => register(served))
              : register(served);
            return typeof inner === 'function' ? inner : () => {};
          }));
        } else if (typeof slotSvc.inject === 'function') {
          offs.push(slotSvc.inject('settings.section', register));
        } else {
          offs.push(register());
        }
        return () => {
          for (const off of offs.reverse()) {
            if (typeof off === 'function') {
              try { off(); } catch {}
            }
          }
        };
      };

      const configFormsDirect = resolveService(ctx, 'configForms');
      const localeDirect = resolveService(ctx, 'locale');
      if (configFormsDirect && localeDirect) {
        ownEffect('dsh-swarm: settings section', () => mountSettingsSection(ctx));
      } else if (typeof ctx.inject === 'function') {
        ctx.inject(['configForms', 'locale'], (sctx) => {
          ownEffect('dsh-swarm: settings section', () => mountSettingsSection(sctx));
        });
      }

      const mountSidebarServices = (sctx) => {
        const resources = resolveService(sctx, 'resources');
        const tabRegistry = resolveService(sctx, 'sidebarRightTabs');
        const offs = [];
        if (resources && typeof resources.register === 'function') {
          offs.push(resources.register(createSwarmResourceProvider()));
        }
        if (tabRegistry && typeof tabRegistry.register === 'function') {
          offs.push(tabRegistry.register({
            id: SWARM_TAB_ID,
            kind: SWARM_PROTOCOL,
            patterns: ['dsh-resource://swarm/**'],
            priority: 'extension',
            keepMounted: true,
            canOpen: (address) => parseSwarmAddress(address) !== null,
            title: (address) => {
              const parsed = parseSwarmAddress(address);
              if (!parsed) return 'Swarm';
              const cachedTitle = this._titleCache.get(parsed.sessionId);
              return cachedTitle ? ('Swarm · ' + cachedTitle) : 'Swarm 协作面板';
            },
          }));
        }
        const teardown = () => {
          for (const off of offs.reverse()) {
            if (typeof off === 'function') {
              try { off(); } catch {}
            }
          }
        };
        if (typeof sctx.effect === 'function') {
          sctx.effect(() => teardown, 'dsh-swarm: sidebar resources & tabs');
        } else {
          this._cleanups.push(teardown);
        }
      };

      if (resolveService(ctx, 'resources') && resolveService(ctx, 'sidebarRightTabs')) {
        ownEffect('dsh-swarm: direct sidebar services', () => {
          mountSidebarServices(ctx);
        });
      } else if (typeof ctx.inject === 'function') {
        ctx.inject(['resources', 'sidebarRightTabs'], (sctx) => {
          mountSidebarServices(sctx);
        });
      }
    }

    dispose() {
      if (this.disposed) return undefined;
      this.disposed = true;
      const pending = this._cleanups.splice(0).reverse();
      const asyncResults = [];
      for (const off of pending) {
        try {
          const result = off();
          if (result && typeof result.then === 'function') asyncResults.push(result);
        } catch {}
      }
      this._titleCache.clear();
      // Async teardowns are explicitly returned so the host can await them.
      return asyncResults.length > 0 ? Promise.allSettled(asyncResults) : undefined;
    }
  }

  // ── Browser ModuleLoader Registration ──────────────────────────────────

  const exportedApi = {
    PLUGIN_ID,
    SWARM_SERVICE,
    SWARM_SERVICE_NAME,
    SWARM_TYPERT_PACKAGE,
    SWARM_PROTOCOL,
    SWARM_RESOURCE_PROTOCOL,
    SWARM_RESOURCE_PREFIX,
    SWARM_TAB_ID,
    SWARM_PANE_ID,
    SWARM_TABS,
    SWARM_METHODS,
    SWARM_REMOTE,
    isValidSessionId,
    swarmAddress,
    swarmLinkHref,
    buildSwarmResourceUri: swarmLinkHref,
    parseSwarmAddress,
    parseSwarmResourceUri: parseSwarmAddress,
    parseSwarmRequest,
    normalizeSwarmSnapshot,
    tokenizeSwarmText,
    isLongSwarmMessage,
    getCollapsedPreviewText,
    countSwarmMessageStats,
    LONG_MESSAGE_MAX_CHARS,
    LONG_MESSAGE_MAX_LINES,
    isNearBottom,
    applyStickToBottomOnScroll,
    followStickToBottom,
    STICK_BOTTOM_THRESHOLD_PX,
    orderMembersTree,
    buildMentionGraph,
    summarizeSwarmToolCall,
    openMemberSession,
    openMemberTranscript: openMemberSession,
    openMemberAcpMonitor,
    createSwarmSettingsSection,
    parseSwarmModelsRequest,
    parseSwarmModelsResult,
    normalizeSwarmModelEntry,
    normalizeRuleList,
    modelEntryRuleKeys,
    modelEntryHitsRuleList,
    SWARM_MODELS_METHOD,
    SWARM_SETTINGS_ID,
    SWARM_SETTINGS_ORDER,
    SETTINGS_DEFAULTS,
    AGY_PHASE_TEXT,
    formatTokenCount,
    formatHitRate,
    SwarmClientPlugin,
  };

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: 'dsh-agy-swarm',
      factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        Object.assign(exports, exportedApi);
        exports.inject = ['slots', 'resources', 'sidebarRightTabs', 'sidebarRight', 'configForms', 'locale'];
        exports.apply = (ctx) => {
          const instance = new SwarmClientPlugin(ctx, { React });
          return () => instance.dispose();
        };
        return module.exports;
      },
    });
  }

  if (typeof exports !== 'undefined') {
    Object.assign(exports, exportedApi);
  }
})();
