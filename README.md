# dsh-agy-swarm

[![npm](https://img.shields.io/badge/npm-dsh--agy--swarm-cb3837?logo=npm)](https://www.npmjs.com/package/dsh-agy-swarm)
[![license](https://img.shields.io/badge/license-MIT-3da639)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-offline%20%2B%20deterministic-2f6fed)](#测试)

> 给 **DeepSeek Harness (DSH)** 装一块多智能体公共留言板：共享 `#seq` 公告栏、按 `@name` 门铃精准唤醒、零 Token 消耗排他休眠、右侧栏实时留言流与 `@mention` 拓扑图。

`dsh-agy-swarm` 是一个 DSH 双端插件（Host Cordis 服务 + Desktop WebUI 右侧栏面板）。它把「多个智能体围绕同一块黑板协作」变成一套真正可落地的机制：**谁都不许轮询，谁也不许空转**——每条消息都有序号，每个成员只有被点名时才醒来一轮，干完活立刻贴结论然后睡回去。

---

## 为什么不是「再写一个编排框架」

大多数多智能体方案把注意力花在拓扑上，真正吃掉预算的是**等待**：轮询留言、等待子任务、把上下文反复灌进每个成员。Swarm 用三个约束把它压掉：

1. **留言板是唯一事实源**：单调递增 `#seq`，增量读板 `read_board{since}`，不需要任何成员记住全局状态。
2. **门铃即调度**：只有帖子正文里出现 `@name` / `@组前缀` / `@#channel` / `@all` 才会唤醒对应成员；中间交接只 `@` 下一棒。
3. **排他结轮休眠**：`swarm_wait` 是排他屏障，先把前序发帖落盘，再检查 `seq > since`，没有新门铃就 `concludeTurn()` 立即结束轮次——休眠期间零 Token 消耗。

## 核心特性

| 能力 | 说明 |
| --- | --- |
| 共享留言板与频道 | `#main` 默认频道 + 按领域划分的 `#channel`；`board.jsonl` 追加写 + `state.json` 原子替换 + `writer.lock` 单写者互斥，半截尾行自愈 |
| 门铃路由 | `@name`、`@组前缀`（展开 `prefix-1..k`）、`@#channel`（显式拒绝 `@#main`）、`@all`；正文代码块内的 `@` 不算门铃 |
| 零轮询休眠 | `swarm_wait` 排他屏障 + `concludeTurn`；被唤醒时用 `agent.followup`（冷态先 `ctx.agents.resume`）精准唤醒 |
| 动态工具暴露 | 未建群时只暴露 `swarm`；建群后才暴露 `post_message` / `read_board` / `swarm_wait` |
| 右侧栏面板 | `dsh-resource://swarm/<sessionId>` 实时渲染 **留言流 / 成员花名册 / @mention 拓扑图**，长留言折叠，顶栏快捷入口与聊天内深链胶囊 |
| 隔离工作区 | `workspace: "inherit" \| "share"`，`share` 直接委托宿主 `ctx.worktrees.create`，由宿主在会话归档时回收 |
| 无损热切模型 | `swarm{action:"model"}` 在保留完整对话历史的前提下切换已配置且被允许派发的路由 |
| 防死循环阈值 | `maxConsecutivePeerWakes` / `maxAgyTurnsPerMember` 默认 **`0` = 无限不熔断**；显式设正整数才按阈值拦截并置 `stopped` |
| 可视化模型派发权限 | 设置页勾选白名单 / 黑名单（`allowedModels` / `blockedModels`），Host 在工具入口硬拦截：被禁模型与「继承来的默认路由」都会被拒绝并给出明确错误，绝不静默降级；**开源默认两个列表都为空 = 完全放行** |
| 可选 ACP 后端 | 装 `dsh-agy-acp` 后可用 `model: "agy/<model>"` 把成员交给本机 Antigravity CLI；**未安装时自动隐藏 `agy` 技能说明与模型条目（设置页标注为可选扩展）** |

## 架构

```
                       ┌────────────────────────────────────────────┐
   用户 /swarm ───────▶ │  Coordinator 会话                          │
                       │  swarm / post_message / read_board /        │
                       │  swarm_wait 四工具按需暴露                  │
                       └───────────────┬────────────────────────────┘
                                       │ 门铃 @name
                 ┌─────────────────────┼─────────────────────┐
                 ▼                     ▼                     ▼
          ┌────────────┐        ┌────────────┐        ┌────────────┐
          │ Worker A   │        │ Worker B   │        │ agy 队友   │ (可选 dsh-agy-acp)
          │ DSH 子会话 │        │ DSH 子会话 │        │ ACP 进程   │
          └─────┬──────┘        └─────┬──────┘        └─────┬──────┘
                │  post_message       │                     │ MCP Stdio
                ▼                     ▼                     ▼
        ╔═══════════════════════════════════════════════════════════╗
        ║  BoardStore：board.jsonl（#seq 单调）+ state.json（原子）  ║
        ╚═══════════════════════════════════════════════════════════╝
                ▲                                            ▲
                │ 快照 / 事件流                                │ Loopback HTTP 桥
        ┌───────┴────────┐                    ┌──────────────┴─────────────┐
        │ 右侧栏面板      │                    │ 127.0.0.1 随机端口         │
        │ Feed/Members/  │                    │ 一次性 Bearer Token        │
        │ Graph          │                    │ 五重校验 + 身份服务端绑定   │
        └────────────────┘                    └────────────────────────────┘
```

## 快速开始

```bash
# 1. 安装（宿主 @deepseek-ai/* 依赖由 DSH 提供，均为 optional peer）
npm install dsh-agy-swarm

# 2. 可选：需要跨模型家族的 ACP 队友时再装
npm install dsh-agy-acp
```

在 DSH 会话里输入：

```
/swarm 把这批文件的类型注解补齐，并让 @reviewer 独立跑一遍单测
```

协调员会拉起成员并在右侧栏生成面板。之后你什么都不用做——同伴之间通过 `@` 直接交接，返工在集群内闭环，只有在**最终成果就绪**或**需要你拍板**时才会回头找你。

## 模型派发权限（可视化勾选）

默认**完全放行**：`allowedModels: []`、`blockedModels: []`，本仓库里没有任何具体模型名或私人偏好硬编码。

在 **设置 → 插件 → Swarm 协作集群 → 模型派发权限控制** 里：

- 卡片会异步拉取宿主已发现模型（`getSwarmModels`，零子进程启动），拉取失败也不影响其它设置，仍可手写规则；
- **黑名单模式（默认）**：每个模型一个「允许」勾选，取消勾选即加入 `blockedModels`，重新勾选即移出；
- **严格白名单模式**：打开开关会先落 `strictAllowlist: true`，再把当前勾选允许的模型全部写进 `allowedModels`，此后只有白名单内的模型能被派发；关掉即回退到 `strictAllowlist: false` + `allowedModels: []`；
- **空名单 = 全禁**：严格模式取消最后一个勾选（或移除最后一个白名单胶囊、或目录为空就开启）时，开关仍是开的、名单为空，此时**所有模型一律拒绝**——绝不会反转成放行；保存失败时开关回滚到已保存状态并提示错误；
- 手动输入支持直接加入禁用或允许列表；「恢复默认」同时清空两个数组。

拦截发生在所有入口：显式 `model`、**省略 `model` 继承协调员当前路由**、以及 `swarm{action:"model"}` 热切。匹配大小写不敏感，`provider/model` 与裸 `model` 名都参与判定，`agy/<alias>` 会先归一化成 `agy/<规范名>` 再判定。详见 [配置](./docs/configuration.md#模型派发权限allowedmodels--blockedmodels)。

## 可选扩展 `dsh-agy-acp`

本插件对未安装该扩展的用户**完全可用**：

- 协调员技能与成员简报里**不注入**任何 `agy/<model>` 派发说明（工具参数 schema 同样保持通用）；
- `swarm{action:"models"}` 不会拼入 `agy/…` 条目；
- 显式传 `model: "agy/..."` 会得到一条明确的「请先安装 `dsh-agy-acp`」错误，而不是静默降级。

设置页里与 ACP 相关的三项（`maxAgyTurnsPerMember` / `maxAgyPostsPerTurn` / `nodeExecutable`）始终保留，但都会标注为「可选 ACP 扩展项」。装上之后才会动态拼接外部 ACP 队友段落，并启用 `agy_mode`（`plan` / `accept-edits`）、MCP 留言板桥与 `agyLive` / `agyUsage` 面板指标。

模型派发权限会与 `dsh-agy-acp` 自己的禁用 / 仅 Plan 规则**叠加生效**：两侧都放行才能真正派发。

## 诚实边界

| 项目 | 事实 |
| --- | --- |
| 测试依赖 | 离线单测**不启动真实模型推理、不访问网络**，**纯 Node 即可运行**（宿主 `@deepseek-ai/*` 存在时自动复用，缺失时 `runtime.js` 回退到内置 Standard Schema）。不是「零磁盘依赖」：会创建临时文件，集成套件还会读写临时 SQLite 账单库 |
| 真实 ACP 联合 | 需要真实 `dsh-agy-acp` 包，属于**可选集成套件**（`npm run test:acp-integration`，通过 `DSH_AGY_ACP_ROOT` 或包名解析）。它跑真实 `AgyWorkerService` + `MockAcpServer`：桥工具闭环、运行中 `stopAcpRun` 取消 + Token 吊销、`node:sqlite` 账单累计；未安装时带原因 skip。默认主套件用内置契约级替身覆盖 swarm 侧逻辑 |
| 频道隔离 | `#channel` 只是注意力路由，**不是权限或保密边界**：任何成员都可能被 `@#频道` 拉进讨论 |
| 熔断默认值 | 默认 `0` = 无限轮次。这是刻意选择；需要硬上限时必须自己显式配置正整数 |
| 模型派发权限默认值 | 两个列表默认空 = 完全放行。开源版**不预置任何模型白名单或禁令**；限制完全是你自己在设置页勾出来的，且对原生与 `agy/…` 两侧同时生效 |
| 设置页兼容 | 升级前安装在旧 patch entry（`local-dsh-swarm`）下的用户：设置页按宿主 `whileServed` 实际服务的命名空间选择表单，新旧任一存在即可正常读写；两者都不存在则不显示设置页 |
| 平台 | 只依赖 Node 标准库与 DSH 宿主服务；Windows / macOS / Linux 同一套代码，Node 可执行探测按 `process.resourcesPath` 与 `execPath` 现算，无任何盘符硬编码 |

## 目录结构

```
index.js                  Host Cordis 插件：Config、四工具、Typert 服务、agy 调度
client.js                 Desktop 右侧栏面板 / 顶栏按钮 / 工具卡片渲染
runtime.js                宿主 @deepseek-ai/schemastery 惰性加载（缺省回退零依赖 Schema）
src/protocol.js           前后端共享快照协议与 Typert 描述符
src/board-store.js        留言板存储引擎、门铃路由、权限状态机
src/prompts.js            协调员技能 / Worker 简报 / agy 信封（可选段落动态拼接）
src/redaction.js          凭据、Token、个人主目录路径脱敏
src/mcp-bridge-server.js  Loopback HTTP 桥（一次性 Token + 五重校验）
src/mcp-stdio-entry.js    零依赖 Stdio MCP Server（agy 侧子进程入口）
docs/                     配置、参考、开发与变更日志
```

## 测试

```bash
npm run check                                   # 全量 node --check
npm test                                        # 离线主套件（含内置 ACP 替身）
npm run test:acp-integration                    # 可选：真实 dsh-agy-acp 端到端
npm pack --dry-run --json                       # 打包清单预演
```

Windows 沙盒环境跑 `node --test` 必须带 `--test-isolation=none`（子进程命名管道在受限令牌下会 `spawn EPERM`）。

## 许可

[MIT](./LICENSE) © 2026 higekibaka
