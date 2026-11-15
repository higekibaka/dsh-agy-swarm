# 参考

## 工具

四个工具按会话**动态暴露**：未建群时只暴露 `swarm`；集群建立后才出现 `post_message`、`read_board`、`swarm_wait`。

### `swarm`

管理集群生命周期。

| action | 参数 | 说明 |
| --- | --- | --- |
| `title` | `title` | 设置侧边栏集群标题（仅协调员） |
| `add` | `name`、`brief`、`workspace?`、`fork?`、`model?`、`channels?`、`n?`、`tasks?`、`wait?` | 拉起成员并在留言板发布 `@<name> <brief>` 唤醒它 |
| `status` | — | 成员状态表（`waiting` / `working` / `stopped` / `killed`） |
| `models` | `all?` | 列出当前 DSH 已配置**且允许派发**的模型路由（被 `allowedModels` / `blockedModels` 禁用的条目不会出现）；`all: true` 时列出全部已放行条目而不做截断 |
| `model` | `name`、`model` | 对 `waiting`/`stopped` 成员无损保留历史热切模型 |
| `kill` | `name` | 永久销毁成员（暂停等待是零成本的，不要把 `kill` 当暂停） |
| `channel` | `channel_action`、`channel`、`topic?`、`member?` | 频道的 `create` / `subscribe` / `unsubscribe` / `list` / `archive` |

关于 `add`：

- `workspace: "share"` 直接委托宿主 `ctx.worktrees.create`，由宿主在会话归档且无未提交改动时回收；并行改代码的多作者必须用它，并且**严禁写同一文件**。
- `fork: true`（或 `"coordinator"`）从当前协调员会话分叉，继承完整历史与推理脉络；跨成员分叉不受支持。
- `wait: true` 在派发完成后立即对调用方执行等效 `swarm_wait`，一步建群并休眠。
- `model` 留空即继承协调员当前的 DSH 路由。本插件**不内置任何模型白名单或禁令**，以你自己的 DSH 配置为准。
- 若你在设置页「模型派发权限控制」里勾选了允许 / 禁用清单，被禁模型（含继承来的默认路由）会在入口直接被拒绝并给出明确错误，**绝不静默降级**；详见 [配置](./configuration.md#模型派发权限allowedmodels--blockedmodels)。


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
| `inbox_only` | 只返回命中我这条门铃的消息 |

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
members[]       { name, state, wakeMode, waitSince, lastReadSeq, lastPostSeq,
                  model, modelDisplay, workspace, lastError, activity }
membership      频道订阅关系
metadata        标题 / 结项标记 / 创建时间
```

长留言（> 280 字符或 > 6 行）默认折叠，点击 `#seq`、正文胶囊或拓扑节点时自动展开。

## 模型派发权限面板

设置页的「模型派发权限控制」卡片通过 `getSwarmModels({})` 拉取宿主已发现的模型目录：

```
{ models: [ { key, provider, model, name, backend, allowed, blocked } ] }
```

- 请求体是**严格空对象**，任何额外字段都会以协议错误被拒绝；服务端只读取宿主已有的模型目录，**不会拉起任何子进程**。
- 拉取失败或远程服务未就绪时，卡片退化为「只展示已保存规则 + 手动输入」，不阻塞设置页其它功能。
- **黑名单模式（默认）**：默认全部允许，取消勾选即把该模型写进 `blockedModels`，重新勾选即移出。
- **严格白名单模式**：开关打开时先落 `strictAllowlist: true`，再把当前允许的模型全部写进 `allowedModels`，之后只有勾选的模型可被派发；关闭即先落 `strictAllowlist: false` 再清空 `allowedModels`。
- **空名单 = 全禁**：严格模式下列表被清空（取消最后一个勾选、移除最后一个白名单胶囊、或目录为空就开启）时，`strictAllowlist` 仍为 `true`，Host 会拒绝**所有**模型——权限方向绝不反转成放行，界面同时提示「当前禁止所有模型」。
- **保存失败不误显示**：任一步写入失败即回滚开关到已持久化快照并显示保存失败，不会出现「界面已开启但实际没保存」。
- 手动输入支持直接加入禁用或允许列表；「恢复默认」同时清空两个数组。

## 原生成员生命周期

每位成员都是一条真实的 DSH 子会话，插件只通过宿主契约驱动它们：

| 阶段 | 宿主契约 | 说明 |
| --- | --- | --- |
| 创建 | `ctx.agents.create({ sessionId, meta, seed?, agentOptions, setup })` | `meta.origin = "subagent"` + `parentSession = coordinator`，v3 `subagent/descriptor` 与 `subagent/catalog` 让原生 Subagent 面板按真实名字列出成员 |
| 唤醒 | `agent.followup(message)` | 冷态成员先 `ctx.agents.resume({ resumeSessionId })` 再投递；忙碌成员走 `agent.inject` 在下一步提醒 |
| 休眠 | `exec.concludeTurn()` | 由 `swarm_wait` 的排他结轮屏障触发，休眠期间零 Token |
| 热切模型 | `agent.model.select({ provider, model, reasoningEffort? })` | 冷态成员把意图写进 `pendingModelSync`，resume 之后立刻套用 |
| 隔离工作区 | `ctx.worktrees.create(childAgent, { name })` | 必须传**子**代理句柄（它才是被切 cwd 的对象）；回收交给宿主 |
| 销毁 | `kill` → `agent.cancel({ kind: 'hook' })` + `handle.dispose()` | 成员行标记 `killed` 留痕，`share` 工作树由宿主在归档时安全回收 |

安全策略在创建时随 `session.append` 持久化：`sandbox/mode`、`approval/policy`、`permission/preset`、`agent-preset/selected`。缺 `session.append` 的宿主会**拒绝**创建可能继承宽权限的子会话，而不是「先跑起来再说」。

## 错误语义

| 场景 | 行为 |
| --- | --- |
| 模型命中 `blockedModels` 或不在 `allowedModels` 内 | 在工具入口直接报错（含命中规则与调整入口），不创建成员、不改花名册；继承来的默认模型被禁时额外提示「请显式指定允许的模型」 |
| `strictAllowlist: true` 且 `allowedModels` 为空 | 拒绝所有模型，错误文案明确指出「已启用严格白名单模式但允许列表为空」，并提示先勾选至少一个允许的模型（或关闭严格模式） |
| `model` 里的 provider 不在宿主模型目录 | 按「宿主未配置 provider」当场报错，提示用 `swarm{action:"models"}` 查看已配置模型（显式禁用优先，先命中黑名单文案） |
| `workspace: "branch"`（已移除模式） | 明确报错并建议改用 `share` 或 `inherit`，不静默降级 |
| `fork` 指向非协调员 | 明确报错：只支持从当前协调员会话分叉 |
| 成员被 `kill` 后仍有在途门铃 | 丢弃该轮，零副作用 |
| `swarm_wait` 缺少 `exec.concludeTurn` | 硬报错，绝不做假休眠 |

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
