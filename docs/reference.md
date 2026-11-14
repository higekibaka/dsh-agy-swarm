# 参考

## 工具

四个工具按会话**动态暴露**：未建群时只暴露 `swarm`；集群建立后才出现 `post_message`、`read_board`、`swarm_wait`。

### `swarm`

管理集群生命周期。

| action | 参数 | 说明 |
| --- | --- | --- |
| `title` | `title` | 设置侧边栏集群标题（仅协调员） |
| `add` | `name`、`brief`、`workspace?`、`fork?`、`model?`、`channels?`、`n?`、`tasks?`、`wait?`、`agy_mode?` | 拉起成员并在留言板发布 `@<name> <brief>` 唤醒它 |
| `status` | — | 成员状态表（`waiting` / `working` / `stopped` / `killed`） |
| `models` | `all?` | 列出当前 DSH 已配置**且允许派发**的模型路由（被 `allowedModels` / `blockedModels` 禁用的条目不会出现）；`all: true` 时对可选 ACP 后端做真探测 |
| `model` | `name`、`model` | 对 `waiting`/`stopped` 成员无损保留历史热切模型 |
| `kill` | `name` | 永久销毁成员（暂停等待是零成本的，不要把 `kill` 当暂停） |
| `channel` | `channel_action`、`channel`、`topic?`、`member?` | 频道的 `create` / `subscribe` / `unsubscribe` / `list` / `archive` |

关于 `add`：

- `workspace: "share"` 直接委托宿主 `ctx.worktrees.create`，由宿主在会话归档且无未提交改动时回收；并行改代码的多作者必须用它，并且**严禁写同一文件**。
- `fork: true`（或 `"coordinator"`）从当前协调员会话分叉，继承完整历史与推理脉络；跨成员分叉不受支持。
- `wait: true` 在派发完成后立即对调用方执行等效 `swarm_wait`，一步建群并休眠。
- `model` 留空即继承协调员当前的 DSH 路由。本插件**不内置任何模型白名单或禁令**，以你自己的 DSH 配置为准。
- 若你在设置页「模型派发权限控制」里勾选了允许 / 禁用清单，被禁模型（含继承来的默认路由）会在入口直接被拒绝并给出明确错误，**绝不静默降级**；详见 [配置](./configuration.md#模型派发权限allowedmodels--blockedmodels)。
- `agy_mode` 仅对 `model: "agy/…"` 的成员有效，见下文「可选 ACP 后端」。

### `post_message`

向留言板发帖。正文里**必须**出现 `@name`（或 `@组前缀`、`@#channel`、`@all`）才会唤醒对方。

- 只提某人不存在的名字不会产生任何唤醒，也不会报错——门铃靠词边界精确匹配。
- 代码块与非行首位置的 `@` 仍会被解析为门铃；如果只是说明文字，用反引号包裹。
- 避免滥用 `@all`。

### `read_board`

增量读板。

| 参数 | 说明 |
| --- | --- |
| `since` | 只返回 `seq > since` 的消息（传上次已读的最大序号） |
| `limit` | 本次最大条数 |
| `seqs` | 按精确序号取消息（忽略 `since`/`limit`） |
| `channel` | 只读某个频道 |
| `status` | 返回成员名册与游标状态而非消息 |
| `inbox_only` | 只返回命中我这条门铃的消息（外部 ACP 队友用） |

### `swarm_wait`

结束当前轮次并零消耗休眠，直到 `seq > since` 出现命中门铃的消息。

- `isConcurrencySafe: () => false`：排他屏障，先等前序 `post_message` 全部落盘。
- `wait_for: ["m1", "m2"]`：等这些成员全部发帖后一次性唤醒。
- **严禁**在 `run_code` 里用 `setTimeout` / `sleep` 轮询留言板。
- 直接回复用户时轮次自然结束即进入休眠监听，无需再调用它。

## 面板与资源 URI

| URI | 内容 |
| --- | --- |
| `dsh-resource://swarm/<sessionId>` | 面板默认页（留言流） |
| `dsh-resource://swarm/<sessionId>?tab=graph` | `@mention` 拓扑图 |
| `dsh-resource://swarm/<sessionId>?tab=members` | 成员花名册 |

面板基于 Typert 服务 `dsh-swarm` 的 `getSwarmSnapshot` / `watchSwarm`（快照与流式推送），设置页另外使用 `getSwarmModels`（模型派发权限面板的模型目录，零子进程启动）。快照字段包括：

```
head            当前最大 #seq
messages[]      { seq, agent, text, mentions[], channelMentions[], broadcast, channel, time }
members[]       { name, state, wakeMode, waitSince, lastReadSeq, lastPostSeq, backend,
                  model, modelDisplay, workspace, agyLive, agyUsage, lastError, activity }
membership      频道订阅关系
metadata        标题 / 结项标记 / 创建时间
```

长留言（> 280 字符或 > 6 行）默认折叠，点击 `#seq`、正文胶囊或拓扑节点时自动展开。

## 模型派发权限面板

设置页的「模型派发权限控制」卡片通过 `getSwarmModels({ probeAgy: false })` 拉取宿主已发现模型（含可选扩展贡献的条目）：

```
{ models: [ { key, provider, model, name, backend, allowed, blocked } ] }
```

- `probeAgy` 仅为前向兼容保留，宿主永远按 `probeAgy: false` 查询，因此**不会拉起任何子进程**。
- 拉取失败或远程服务未就绪时，卡片退化为「只展示已保存规则 + 手动输入」，不阻塞设置页其它功能。
- **黑名单模式（默认）**：默认全部允许，取消勾选即把该模型写进 `blockedModels`，重新勾选即移出。
- **严格白名单模式**：开关打开时先落 `strictAllowlist: true`，再把当前允许的模型全部写进 `allowedModels`，之后只有勾选的模型可被派发；关闭即先落 `strictAllowlist: false` 再清空 `allowedModels`。
- **空名单 = 全禁**：严格模式下列表被清空（取消最后一个勾选、移除最后一个白名单胶囊、或目录为空就开启）时，`strictAllowlist` 仍为 `true`，Host 会拒绝**所有**模型——权限方向绝不反转成放行，界面同时提示「当前禁止所有模型」。
- **保存失败不误显示**：任一步写入失败即回滚开关到已持久化快照并显示保存失败，不会出现「界面已开启但实际没保存」。
- 手动输入支持直接加入禁用或允许列表；「恢复默认」同时清空两个数组。
- 若使用 `agy/...` 外部队友，`dsh-agy-acp` 自己的禁用 / 仅 Plan 规则会与此处叠加生效——两侧都放行才真正派发。

## 留言板 MCP 桥（可选 ACP 后端）

只有存在外部 ACP 队友时才会启动。

1. 宿主在 `127.0.0.1` 的随机端口惰性启动 HTTP 桥（`unref`，不阻止宿主退出）。
2. 每轮通过 ACP `mcpServers` 注入零依赖 Stdio MCP 子进程 `dsh_swarm_bridge`（`src/mcp-stdio-entry.js`），只暴露 `read_board` 与 `post_message`，帧格式在 NDJSON 与 `Content-Length` 之间自适应。
3. 子进程以 `agent: false` 直连桥，携带 `--auth-file <path>`。

**每轮签发一次性 Bearer Token**：32 字节随机，内存只存 SHA-256，比对使用 `crypto.timingSafeEqual`；落盘到 `<state>/tokens/<member>.json`，轮次结束即吊销并删除文件。每次请求做五重校验：

1. Token 有效且未过期；
2. 控制器与留言板未关闭；
3. 成员存在且未被 `kill`；
4. `activationEpoch` 与签发时一致；
5. 未结项，且本轮发帖数未超 `maxAgyPostsPerTurn`。

作者身份**一律**取自服务端绑定的 `grant.memberName`，客户端载荷里的任何身份字段都被忽略。错误回包统一脱敏后返回。

## 可选 ACP 后端（`dsh-agy-acp`）

安装后可用 `model: "agy/<model>"` 把成员交给本机 Antigravity CLI（ACP）执行，不创建 DSH 子会话，成员以 `backend: "agy-acp"` 持久化（含 `agySessionId`、`agyWorkerName`、`agyMode`、激活代次与熔断计数），重启后可续聊。

**可用模型与思考档位以 `swarm{action:"models"}` 的实际输出为准**——条目由该扩展提供，未知模型或锁档冲突会在解析阶段当场报错，不启动任何进程。

模式与权限：

- 父会话可写时默认 `accept-edits`；
- 父会话处于 Plan 或只读沙盒时强制 `plan`，显式传 `accept-edits` 报越权；
- 只有父会话为 `danger-full-access` 且非 plan 时才给完全权限；
- `plan` 模式下审查员仍可通过 MCP 桥读板与发帖汇报。

能力边界（显式拒绝，不静默降级）：

- 不支持 `fork`；
- 不支持 `workspace: "share"`；
- 不能担任 `monitor`；
- `agy_mode` 传给非 agy 成员会报错；
- `swarm{action:"model"}` 只允许在 `agy/…` 之间切换（并重置熔断计数，作为协调员的人工恢复入口），拒绝与 DSH 原生模型互切。

轮次结局有四象限：

| 情况 | 处理 |
| --- | --- |
| 已调用 `post_message` | 直接休眠，不重复代发尾段文本 |
| 未发帖但有纯文本 | 自动补 `@触发者` 归档到 `#main`（正文含非法门铃时用代码围栏包裹） |
| 输出空白 | 置 `stopped` |
| 失败 / 取消 | 绝不代发残缺文本，原因脱敏后写入 `lastError` |

每次轮次会传入 `source: "swarm"`、`swarmMeta` 与 `onProgress`，成员的瞬态 `agyLive: { runId, phase, pid, activity }` 实时同步到面板；结束（含从 ACP 面板取消）即清空，并把 `turnUsageSummary` 累加进 `agyUsage`（旧版扩展无该字段时安全跳过，账单保持 `null`）。

## 错误语义

| 场景 | 行为 |
| --- | --- |
| 未安装 `dsh-agy-acp` 却传 `agy/...` | 明确提示「当前宿主未启用 dsh-agy-acp 插件」，不静默降级到原生模型 |
| 模型命中 `blockedModels` 或不在 `allowedModels` 内 | 在工具入口直接报错（含命中规则与调整入口），不创建成员、不改花名册；继承来的默认模型被禁时额外提示「请显式指定允许的模型」 |
| `strictAllowlist: true` 且 `allowedModels` 为空 | 拒绝所有模型，错误文案明确指出「已启用严格白名单模式但允许列表为空」，并提示先勾选至少一个允许的模型（或关闭严格模式） |
| `nodeExecutable` 路径无效 | 抛明确错误（不存在 / 是目录），绝不盲目透传 |
| 桥 Token 失效 / 过期 / epoch 不符 | `4xx` + 结构化错误码，不泄露内部状态 |
| 成员被 `kill` 后仍有在途门铃 | 丢弃该轮，零副作用 |

## 设置页与旧命名空间兼容

宿主 `configForms` 有两条容易误判的语义（见 `@deepseek-ai/dsh-client-ui-settings` 的 `src/client/config-form.ts`）：

1. **`get(entryId)` 永远返回一个 controller**，从不为 `undefined`/`null`。
   因此 `get(newId) || get(legacyId)` 这类写法是死代码，无法用来探测某个命名空间是否真的存在。
2. **`whileServed(namespaces, register)` 是「任一命中即回调」**：
   `watched = namespaces.some(ns => served.has(ns))`，命中时把已服务的命名空间集合传进
   `register(served)`；一个都没服务时不回调、不注册任何东西。

插件的挂载逻辑因此是：

- 用 `whileServed([SWARM_SETTINGS_ID, SWARM_SETTINGS_ID_LEGACY])` 同时关注新命名空间
  `dsh-agy-swarm` 与升级前的 `local-dsh-swarm`；
- 在回调里按实际被服务的命名空间挑选表单 id（`pickSettingsId(served)`），
  保证旧安装也能正常读写自己的配置，而不是拿到一个空命名空间的 controller；
- 两个命名空间都未被服务时（插件未组合进 Profile）**不注册设置页**。

回归用例覆盖三种部署形态：仅新命名空间、仅旧命名空间、两者皆无。
