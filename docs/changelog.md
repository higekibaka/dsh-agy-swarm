# 变更日志

## [0.2.0] - 2026-11-15

### 重构 · 收敛为纯原生 DSH 多智能体集群

- **彻底移除外部 Antigravity ACP 队友后端**：删除 `src/mcp-bridge-server.js`（Loopback HTTP 桥）、`src/mcp-stdio-entry.js`（Stdio MCP 子进程入口），以及该后端对应的两份集成测试与内置替身；`dsh-agy-acp` 的 peer 依赖、相关 `exports`、`keywords` 与 npm 脚本一并移除。`swarm` 工具不再有 `agy_mode` 参数。
- **成员生命周期全面原生化**：创建 / 冷态唤醒 / 热切模型 / 隔离工作树 / 销毁全部只走宿主原生契约（`ctx.agents.create`、`ctx.agents.resume`、`agent.model.select`、`ctx.worktrees.create`、`agent.cancel`）。成员快照与共享协议不再包含外部队友专属字段（后端标记、外部会话 ID 与 worker 名、运行模式、访问模式、实时阶段、用量账单、激活代次与熔断计数）。
- **配置与设置页收敛**：Config 只保留模型派发权限三项（`strictAllowlist`、`allowedModels`、`blockedModels`）；设置页删除外部桥运行时、同伴唤醒 / 成员轮次 / 单轮发帖上限与 Node 可执行文件配置，只留「集群说明 + 模型派发权限控制 + 恢复默认」。`getSwarmModels` 请求收敛为严格空对象（原探测开关随该后端能力一并移除），依旧零子进程。
- **提示词去分支**：删除外部队友技能段落与逐轮提示词信封；协调员规范与 Worker 简报不再提任何外部后端，自治内循环直接说明「在留言板闭环返工直到 100% 实测全绿再唤醒 `@coordinator`」。
- **向后兼容**：`board-store` 反序列化 0.1.x 落盘数据时按前缀丢弃已移除的后端字段，旧会话历史照常读取，不抛错、也不会把脏字段写回磁盘；被归一化的旧成员按普通原生成员继续可用。
- **未配置 provider 一律拒绝**：宿主模型目录非空时，`model: "some-provider/x"` 中目录里不存在的 provider 会按「宿主未配置 provider」当场报错，而不是把一个宿主不认识的 provider 静默塞给子代理；显式禁用优先，先命中黑名单文案。

### 兼容性

- 包名与插件身份完全不变：`dsh-agy-swarm`、设置页 `dsh-agy-swarm`、locale 命名空间 `settings.dshAgySwarm`、旧表单只读兜底 `local-dsh-swarm`、Typert 服务 `dsh-swarm`（`getSwarmSnapshot` / `watchSwarm` / `getSwarmModels`）与 `dsh-resource://swarm/...` 资源协议全部保留，已有用户配置与设置页 ID 无需迁移。
- 四个模型工具（`swarm` / `post_message` / `read_board` / `swarm_wait`）、`/swarm` 命令与 `swarm` / `swarm-monitor` 技能、门铃唤醒与零 Token 休眠语义均零回归。
## [0.1.2] - 2026-11-15

### 改进 · 外部 `agy` 空轮次权限拒绝诊断（`deniedActions`）

- 新增 `formatAgyEmptyTurnError(result)`：当外部 `agy` 轮次以 `completed` 结束但未调用 `post_message` 且无正文输出（象限 3）时，若 `result.deniedActions`（兼容 `denied_actions`）非空，自动提取被拒绝的工具名与原因追加到 `lastError`，不再一律只显示笼统的「未调用 `post_message` 且未输出任何文本」。
- 严格有界与隐私脱敏：优先读取纯工具名 `name`（避免把可能带参数片段的 `tool` 摘要优先放入错误栏），对工具名与原因先经 `redactSensitiveText` 脱敏再分别限长（80 / 120 字符），按展示内容去重后最多保留 3 类并标注总次数；写入 `lastError` 时继续经 `redactErrorText` 统一限长 400 字符。
- 零调度副作用：不改动 `dsh-agy-acp` 的终态成功判定契约，不触发隐式自动重跑；带 `deniedActions` 但正常输出文本或已发帖的轮次、以及 `failed` / `cancelled` 分支均保持原有行为不变。

### 改进 · 外部 `agy` 队友信封与协调员派单边界提示

- `buildAgyWorkerPromptEnvelope` 同时覆盖首轮与续聊信封，并按 `plan` 与非 `plan` 模式区分描述：`plan` 明确只读锁死，非 `plan` 保留分配范围内的工作区编辑说明；统一说明后台无交互子进程无法弹出额外权限审批（如 `run_command`、工作区外路径访问或用户全局挂载的其他第三方 MCP 工具请求审批时会被拒绝并可能中断当轮，被拒后应直接放弃而非换工具绕过），并说明独立进程无法把宿主 `.asar` 归档当目录读取且默认过滤 `.tmp/` 等点号隐藏目录，需通过 `post_message` `@` 原生队友代查。
- `AGY_ACP_SKILL_SECTION` 补充协调员侧派单边界说明，避免将命令执行、外网检索或 `.asar` / `.tmp/` 读取任务误分派给后台外部 `agy` 队友。

## [0.1.1] - 2026-11-15

### 修复 · 设置页「未能读取宿主模型列表」

- 真实宿主 `@deepseek-ai/dsh-api-gateway` 的一元 Remote 调用在**成功**时返回 `{ ok: true, value: <payload> }` 信封（失败时 `{ ok: false, error }`）。此前设置页把整封响应当载荷直接交给 `parseSwarmModelsResult`，`Array.isArray(response.models)` 恒为假，于是永远报「未能读取宿主模型列表」并且只留下一句 `models must be an array` 的内部错误。
- 新增 `unwrapRemoteResult(res)`：`isPlainObject(res) && res.ok === true && 'value' in res && res.value !== undefined` 时取 `res.value`，否则原样透传（插件自带的 `SwarmRemoteServiceFallback` 与离线单测替身返回裸结果，必须同样可用）。`loadSwarmModels` 与 `fetchSnapshotOnce` 统一先解包再交给校验 / 归一化函数。
- 设置页仍拉取失败时保留简化可读的错误摘要（`modelsError`）：状态行文字维持本地化提示，真实原因（截断为单行 240 字内）挂在 `title` 与 `data-models-error` 上，便于区分「宿主流未挂载」与「协议校验失败」；拉取成功或重试成功即清空。
- 新增回归：注入真实 `{ ok: true, value: { models: [...] } }` 信封给 `api.getSwarmModels`，设置页 `loadModels()` 必须解包返回全量模型；同时覆盖「裸结果透传」「失败信封不被误解包」与错误 tooltip 的出现 / 清空。

### 修复 · Host 依赖加载脱节（`MODULE_NOT_FOUND` 退回 Fallback）

- 桌面 Profile 里 `require('@deepseek-ai/dsh-typert-protocol')` / `dsh-tools` / `dsh-scope` / `dsh-llm` / `dsh-session` 全部 `MODULE_NOT_FOUND`：这些包只在 `<resourcesPath>/app.asar/dsh/node_modules` 里，插件目录解析不到，于是 `index.js` 静默退回手写 Fallback（工具定义、fork 种子、中继消息、Typert 远程服务全部降级）。
- `runtime.js` 的宿主锚点升级：除环境变量与 `require.main` / `process.argv[1]` 外，新增 `<resourcesPath>/app.asar/{dsh,lib}` 锚点，并把入口文件所在目录的若干层祖先一并当锚点，覆盖桌面版 / CLI / 便携包布局，仍然零硬编码安装路径。
- 新增 `runtime.requireHostModule(specifier)`：先普通 `require`（依赖被提升到 profile 的布局），失败则 `resolveHostModule` 定位宿主 `app.asar` 入口再 `require(entry)`；`ERR_REQUIRE_ESM`、asar 读取失败等一律返回 `null`（结果含失败一并缓存），调用方继续走兜底，**绝不因为可选依赖缺失而崩溃**。`index.js` 的 `tryRequire` 改为委托它；`loadSchemastery` 复用同一条链路。
- `mountSwarmRemoteService` 加固：真实 `typertProto.Remote` 装饰器失败时退回手写 `remote-methods` 描述符；`new SwarmRemoteService(ctx)` 抛错（宿主 Cordis / Typert 契约漂移）时退回 `SwarmRemoteServiceFallback`；描述符定义失败也不再影响服务本身。
- 纯 Node 离线单测零依赖兜底 100% 保留：无 `resourcesPath`、无 `@deepseek-ai/*` 时所有解析都返回 `null`，全部用例仍跑在兜底实现上。

### 修复 · GitHub Actions 在 Node 22 报 `exit code 9`

- `npm test` 里的 `--test-isolation=none` 是为 Windows 沙盒（命名管道 `spawn EPERM`）准备的；Linux/macOS 并不需要，而 Node 22.13 之前的版本不认这个参数，会以 `exit code 9`（Invalid Argument）直接失败。
- `package.json` 新增 `"test:ci"`（不带 `--test-isolation`），保留 `"test"` 兼容 Windows 沙盒；`ci.yml` 与 `publish.yml` 的测试步改调 `npm run test:ci`。
- Matrix 的 `22` 改为 `22.19`，对齐 `engines.node` 的 `^22.19.0`，避免 setup-node 拉到 22.13 以下的小版本。

### 修复 · 严格白名单空名单的权限反转

- 新增持久化开关 `strictAllowlist`（默认 `false`）：白名单激活条件改为「`strictAllowlist === true` 或 `allowedModels` 非空」。此前「严格模式下取消最后一个勾选」会写入 `allowedModels: []`，被误判成「未启用白名单 → 全部放行」，权限方向反转；现在空名单一律**全禁**，报错明确提示「已启用严格白名单模式但允许列表为空」。
- 设置页开关与白名单写入路径均改为先持久化 `strictAllowlist` 再更新 `allowedModels`（包括 legacy 仅非空名单激活时清空最后一项，也会先钉住 `strictAllowlist: true`；关闭时先写 `strictAllowlist: false` 再清空），任一步保存失败即回滚到已持久化快照并显示保存失败，绝不停留在未落盘的开关状态。
- 新增 5 项设置页回归（含取消最后一个勾选、移除最后一个白名单胶囊、空目录开启严格模式、legacy 仅非空名单清空、保存失败不误显示）以及对应 Host / 协议回归。

### 新增 · 可视化模型派发权限

- 新增三个 volatile 配置字段：`strictAllowlist`（严格白名单开关，默认 `false`）、`allowedModels`（白名单，`[]` 且未开严格模式 = 不启用）与 `blockedModels`（黑名单，优先拦截），**默认完全放行**，仓库内不硬编码任何模型名。
- 新增纯校验函数 `normalizeModelRuleList` / `isSwarmModelAllowed` / `assertSwarmModelAllowed`：匹配大小写不敏感，同时检查 `provider/model` 与裸 `model` 名；`agy/<alias>` 先归一化为 `agy/<规范名>` 再判定。
- 全链路硬拦截：显式 `model`、省略 `model` 继承协调员默认路由、`swarm{action:"model"}` 热切（原生与 `agy/…` 两个分支）都会被拒绝并给出清晰错误；继承来的默认模型被禁时额外提示「请显式指定允许的模型」。绝不静默降级。
- `listAvailableModels` 默认过滤被禁条目（`swarm{action:"models"}` 只列出可派发候选），`includeBlocked: true` 时保留全量并附带 `{ allowed, blocked }` 标记。
- Typert 服务新增 `getSwarmModels`（`SWARM_METHODS` 同步扩展为三项）：请求 `{}` / `{ probeAgy?: boolean }`，结果 `{ models: [{ key, provider, model, name, backend, allowed, blocked }] }`，零子进程启动。
- 设置页新增「模型派发权限控制」卡片：黑名单模式勾选、严格白名单模式开关、手动添加 `provider/model` 规则、ACP 规则叠加提示；`resetDefaults` 同时清空两个数组。
- `applyVolatileConfig` 支持局部补丁：只更新传入的运行期字段，不再把未提到的字段回落成默认值。
- 文档与离线单测补齐：Config 校验与热更新、显式 / 继承 / 白名单 / `agy` 别名拦截、模型清单过滤、`getSwarmModels` 协议、设置页勾选与恢复默认、零私人模型硬编码。

## 0.1.0

首个开源发布版本。

### 新增

- 共享 `#seq` 留言板与频道系统，`board.jsonl` 追加写 + `state.json` 原子替换 + 单写者互斥，半截尾行自愈。
- 门铃路由：`@name`、`@组前缀`、`@#channel`、`@all`，词边界精确匹配。
- `swarm_wait` 排他结轮休眠，休眠期零 Token 消耗；冷态成员经 `ctx.agents.resume` 精准唤醒。
- 四工具按会话动态暴露；`/swarm` 采用原样用户输入 + 独立上下文注入，用户气泡与会话标题零篡改。
- 右侧栏实时面板：留言流 / 成员花名册 / `@mention` 拓扑图，长留言折叠与深链跳转。
- `workspace: "share"` 隔离工作区（委托宿主 `ctx.worktrees.create`）、`fork` 热分叉、无损热切模型。
- 专属设置页与四个 volatile 配置字段，保存即热更新。
- 可选 `dsh-agy-acp` 集成：`agy/<model>` 外部队友、`agy_mode` 权限夹逼、MCP 留言板桥（一次性 Token + 五重校验）、`agyLive` / `agyUsage` 面板指标。

### 开源发布版改造

- 包名与插件身份统一为 `dsh-agy-swarm`（设置页 `dsh-agy-swarm`，locale 命名空间 `settings.dshAgySwarm`），保留对旧表单 id 的只读兼容。
- 清除全部个人路径与私有模型白名单/禁令，改为「默认继承当前 DSH 路由、以 `swarm{action:"models"}` 为准」的中立表述。
- 新增 `src/redaction.js`：`lastError`、`activity` 与桥接报错统一脱敏（凭据、Token、个人主目录路径）。
- 未安装 `dsh-agy-acp` 时不再向协调员或成员注入任何 `agy/<model>` 派发说明；显式指定时给出明确安装提示。
- Node 可执行探测改为基于 `process.resourcesPath` 与 `execPath` 的跨平台候选，删除硬编码安装路径；`nodeExecutable` 增加 `trim()` 与存在性/非目录校验。
- 测试改为自包含：主套件使用内置契约级 ACP 替身，真实 ACP 端到端降级为可选集成套件（`npm run test:acp-integration`）。
- 补齐 `LICENSE`（MIT）、`.gitignore`、发布 workflow 与四篇分层文档。
