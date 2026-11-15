# 配置

`dsh-agy-swarm` 的运行时配置全部是 **volatile 字段**：保存后通过 `loader/volatile-update` 热更新进正在运行的 `SwarmHostController`，不中断正在执行的成员轮次，也不需要重启宿主。

配置入口在宿主的 **设置 → 插件 → Swarm Collaboration Cluster**（`settings.section`，`order: 39`）。宿主自动生成的重复表单已通过 `settings.configure({ auto: false })` 关闭。

## 字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `strictAllowlist` | 布尔 | `false` | **严格白名单开关**。`true` 时白名单恒为激活态：即使 `allowedModels` 为空也**拒绝所有模型**（空名单 = 全部禁止，绝不放行） |
| `allowedModels` | 字符串数组 | `[]` | **白名单**。`strictAllowlist=false` 且为空 = 不启用白名单（完全放行）；非空 = 仅允许列表内模型被派发 |
| `blockedModels` | 字符串数组 | `[]` | **黑名单**。命中即一律禁止派发，优先级高于白名单 |

> 0.2.0 起配置只保留这三项。早期版本里的外部后端相关字段（外部队友轮次 / 单轮发帖上限 / 桥使用的 Node 可执行文件）已随该后端一并移除；旧配置里残留的键会被忽略，不会报错。
## 模型派发权限（`allowedModels` / `blockedModels`）

开源默认**完全放行**：两个数组都是空，本插件不内置任何模型白名单或禁令。你可以在设置页「模型派发权限控制」里可视化勾选，Host 会在工具入口硬拦截。

### 规则写法与匹配口径

- 规则是 `provider/model` 或裸 `model` 名，例如 `vendor/some-model`、`some-model`。
- **大小写不敏感**：`Vendor/Some-Model` 与 `vendor/some-model` 等价；写入时会 `trim()` 并按大小写不敏感去重（保留首次写法）。
- 判定一个候选模型时，会同时检查它的**完整 `provider/model` 键**与**裸 `model` 名**，任一命中即算命中。

- **黑名单优先**：同一个模型同时出现在两个列表里时，一律拒绝。
- **白名单激活条件 = `strictAllowlist === true` 或 `allowedModels` 非空**：激活后列表外的模型全部拒绝。
- **严格模式下的空名单是「全禁」而不是「放行」**：`strictAllowlist: true` + `allowedModels: []` 会拒绝**任何**模型，并在报错里提示「已启用严格白名单模式但允许列表为空」。这样取消最后一个勾选、或移除最后一个白名单胶囊，都不会把权限方向反转成放行。
- **未配置的 provider 一律拒绝**：宿主已发现模型目录非空时，`model: "some-provider/x"` 里目录根本没有的 provider 会按「宿主未配置 provider」当场报错，绝不会把一个不存在的后端静默塞给子代理。显式禁用优先于这一步——被禁模型先命中黑名单文案。

### 拦截范围（全链路，绝不静默降级）

| 入口 | 行为 |
| --- | --- |
| `swarm{action:"add", model:"…"}` 显式指定 | 被禁 / 不在白名单 → 当场报错，不创建任何子会话 |
| `swarm{action:"add"}` **省略 `model`**（继承协调员当前路由） | 继承来的默认模型被禁 → 明确提示「请显式指定允许的模型或调整 Swarm 模型设置」 |
| `swarm{action:"model", name, model:"…"}` 热切 | 在写盘与调用 `agent.model.select` 之前拦截 |
| `swarm{action:"models"}` 清单 | 默认过滤掉被禁条目，模型看不到不可派发的候选 |
| 设置页 `getSwarmModels` | 保留全量目录并附带 `allowed` / `blocked` 标记（零子进程启动）；严格模式空名单时全部标记为 `allowed: false` |

### 热更新语义

三个字段都是 `.volatile()`：保存后经 `loader/volatile-update` 直接替换运行中的 `SwarmHostController.config`，不中断在跑的轮次。`applyVolatileConfig` 支持局部补丁——只传 `allowedModels` 时不会顺手把 `blockedModels` 或 `strictAllowlist` 清掉。

### 设置页写入顺序（防权限反转）

- 开启严格模式：先落 `strictAllowlist: true`，再写 `allowedModels`（目录为空就写 `[]`，此时语义是「全禁」）。
- 关闭严格模式：先落 `strictAllowlist: false`，再清空 `allowedModels`。
- 任一步保存失败：丢弃本地草稿、开关回落到已持久化快照并显示保存失败，绝不显示一个没真正落盘的开关状态。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `DSH_SWARM_HOST_MODULES` | 可选覆盖：指向包含 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 的目录。通常**不需要**设置——`runtime.js` 的零依赖兜底足以让纯 Node 单测全绿 |
| `SWARM_TEST_TMP` | 测试临时目录根，默认为 `os.tmpdir()` |


## 依赖关系

宿主侧依赖全部声明为 **optional peer**，由 DSH 自身提供，插件不会硬依赖任何一条：

```
@deepseek-ai/cordis            @deepseek-ai/schemastery
@deepseek-ai/dsh-tools         @deepseek-ai/dsh-typert-protocol
@deepseek-ai/dsh-llm           @deepseek-ai/dsh-scope
@deepseek-ai/dsh-session       react
```

`runtime.js` 按「环境变量锚点 → `require.main.filename` → `process.argv[1]` → 插件自身目录」依次尝试加载 `@deepseek-ai/schemastery`；全部落空时退回内置的零依赖 Standard Schema 实现，因此插件在纯 Node 环境下也能正常挂载。
