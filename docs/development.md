# 开发

## 环境

- Node `^22.19.0 || >=24.0.0`
- DSH 宿主（`engines.dsh: >=0.2.2-rc.1`）
- Windows 沙盒下跑 `node --test` **必须**带 `--test-isolation=none`：受限令牌下子进程命名管道会 `spawn EPERM`

## 本地检查

```bash
npm run check    # node --check 全量源码
npm test         # 离线主套件
npm pack --dry-run --json
```

## 测试策略

三套并存，职责分明：

| 套件 | 命令 | 依赖 | 覆盖 |
| --- | --- | --- | --- |
| 主套件 | `npm test` | 仅 Node 标准库 + 内置替身 | 留言板、门铃、休眠、桥、权限、提示词、面板、脱敏、开源友好度 |
| 开源友好度 | `npm test`（同上） | 同上 | 未装 ACP 扩展时隐藏 `agy` 段落、脱敏、`nodeExecutable` 校验、插件身份与旧表兼容读取 |
| 可选 ACP 集成 | `npm run test:acp-integration` | 真实 `dsh-agy-acp` 包（`DSH_AGY_ACP_ROOT` 或包名解析） | 真实 `AgyWorkerService` + `MockAcpServer`：桥工具闭环、`source/swarmMeta` 透传、运行中 `getAcpSnapshot` → `stopAcpRun` 取消并吊销 MCP Token、`node:sqlite` 账单 `turnUsageSummary` → `agyUsage` 累计（续聊不重复计费）。未安装时整文件带原因 skip |

**测试不启动真实模型推理、不访问网络，纯 Node 即可运行**（宿主 `@deepseek-ai/*` 依赖存在时自动复用，缺失时 `runtime.js` 回退到内置的零依赖 Standard Schema，因此不需要 `DSH_SWARM_HOST_MODULES` 也能全绿）。但它不是「零磁盘依赖」：主套件会创建临时文件，集成套件还会读写临时 SQLite 账单库。

主套件对 ACP 后端使用**内置契约级替身**（`test/support/agy-service-stub.mjs`）：替身实现 swarm 实际调用的最小接口（`config`、`runDirectTurn`、`peekModels`、`listModels`、`normalizeModelSpec`、`stopWorker`、`registry`），因此本包不需要复制整个 `dsh-agy-acp` 就能验证自己与它的契约。真实进程链的验证留在可选套件里，避免主套件隐式依赖兄弟目录。

## 代码约定

- **零运行时依赖**：只 require Node 标准库与宿主服务；宿主模块一律惰性加载并带兜底。
- **隐私红线**：任何进入快照、事件流、日志或模型上下文的文本（`lastError`、`activity`、桥报错）都必须先过 `src/redaction.js`。
- **可选能力必须可探测**：外部 ACP 后端的存在性统一走 `_isAgyAcpAvailable()`，未挂载时既不能注入相关提示词，也不能渲染相关 UI 文案。
- **跨平台**：禁止写出盘符 / 用户名 / 安装路径字面量；路径一律现算。
- **持久化**：`board.jsonl` 先追加再更新内存；`state.json` 走临时文件原子替换并对 `EPERM/EBUSY` 有限重试；半截 JSONL 尾行自愈重写。

## 目录

```
index.js                   Host 插件：Config、工具、Typert 服务、agy 调度
client.js                  Desktop 面板（classic script 浏览器 bundle + CJS 导出）
runtime.js                 宿主模块惰性加载器
src/protocol.js            共享协议与快照归一化
src/board-store.js         留言板存储与门铃路由
src/prompts.js             技能正文与提示词（ACP 段落按可用性拼接）
src/redaction.js           脱敏
src/mcp-bridge-server.js   Loopback HTTP 桥
src/mcp-stdio-entry.js     Stdio MCP Server
test/                      主套件、开源友好度套件、可选集成套件与内置替身
```

## 发布

`.github/workflows/publish.yml` 是 `workflow_dispatch` 触发，带 `dry_run` 布尔输入：

1. `actions/checkout@v4` → `actions/setup-node@v4`（Node 22，registry `https://registry.npmjs.org`）；
2. `npm run check` + `npm pack --dry-run` 作为门禁；
3. 正式发布走 `npm publish --provenance --access public`。

包内容由 `package.json#files` 白名单控制，`test/` 与 `.github/` 不进入 tarball。
