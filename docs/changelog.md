# 变更日志

## 未发布

### 修复 · 严格白名单空名单的权限反转

- 新增持久化开关 `strictAllowlist`（默认 `false`）：白名单激活条件改为「`strictAllowlist === true` 或 `allowedModels` 非空」。此前「严格模式下取消最后一个勾选」会写入 `allowedModels: []`，被误判成「未启用白名单 → 全部放行」，权限方向反转；现在空名单一律**全禁**，报错明确提示「已启用严格白名单模式但允许列表为空」。
- 设置页开关改为先写 `strictAllowlist` 再写 `allowedModels`（关闭时相反），任一步保存失败即回滚开关并显示保存失败，绝不停留在未落盘的开关状态。
- 新增 4 项回归：取消最后一个勾选、移除最后一个白名单胶囊、空目录开启严格模式、保存失败不误显示。

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
