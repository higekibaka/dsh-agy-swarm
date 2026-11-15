# 开发

## 环境

- Node `^22.19.0 || >=24.0.0`
- DSH 宿主（`engines.dsh: >=0.2.2-rc.1`）
- Windows 沙盒下跑 `node --test` **必须**带 `--test-isolation=none`：受限令牌下子进程命名管道会 `spawn EPERM`
- 反之 Linux / macOS（CI）不需要该参数，且 Node 22.13 之前不认它（`exit code 9`），所以 CI 统一用 `npm run test:ci`

## 本地检查

```bash
npm run check    # node --check 全量源码
npm test         # 离线主套件（Windows 沙盒：含 --test-isolation=none）
npm run test:ci  # 同上但不带 --test-isolation，供 Linux / macOS CI 使用
npm pack --dry-run --json
```

## 测试策略

两套并存，职责分明：

| 套件 | 命令 | 依赖 | 覆盖 |
| --- | --- | --- | --- |
| 主套件 | `npm test` | 仅 Node 标准库 + 内置替身 | 留言板、门铃、休眠、唤醒、权限、提示词、面板、脱敏 |
| 开源友好度 | `npm test`（同上） | 同上 | 提示词与 Schema 零外部后端残留、脱敏、插件身份与旧表兼容读取、旧落盘 JSON 容错、设置页只管理模型派发权限 |
**测试不启动真实模型推理、不访问网络，纯 Node 即可运行**（宿主 `@deepseek-ai/*` 依赖存在时自动复用，缺失时 `runtime.js` 回退到内置的零依赖 Standard Schema，因此不需要 `DSH_SWARM_HOST_MODULES` 也能全绿）。但它不是「零磁盘依赖」：两个套件都会创建临时目录与临时文件（用完即删）。



## 代码约定

- **零运行时依赖**：只 require Node 标准库与宿主服务；宿主模块一律惰性加载并带兜底。
- **隐私红线**：任何进入快照、事件流、日志或模型上下文的文本（`lastError`、`activity`、桥报错）都必须先过 `src/redaction.js`。
- **纯原生**：成员生命周期只走宿主原生契约（`ctx.agents.create` / `resume` / `agent.model.select` / `ctx.worktrees.create`），不得引入第二个后端或旁路消息通道。
- **跨平台**：禁止写出盘符 / 用户名 / 安装路径字面量；路径一律现算。
- **持久化**：`board.jsonl` 先追加再更新内存；`state.json` 走临时文件原子替换并对 `EPERM/EBUSY` 有限重试；半截 JSONL 尾行自愈重写。

## 目录

```
index.js                   Host 插件：Config、工具、Typert 服务、成员生命周期
client.js                  Desktop 面板（classic script 浏览器 bundle + CJS 导出）
runtime.js                 宿主模块惰性加载器
src/protocol.js            共享协议与快照归一化
src/board-store.js         留言板存储与门铃路由
src/prompts.js             技能正文与提示词
src/redaction.js           脱敏


test/                      主套件与开源友好度套件
```

## 发布

`.github/workflows/publish.yml` 支持推送版本标签（`v*`，例如 `git tag v0.2.0 && git push origin v0.2.0`）自动发布到 npm，并保留 `workflow_dispatch`（含 `dry_run` 选项）手动触发：

1. `actions/checkout@v4` → `actions/setup-node@v4`（Node 22.19，对齐 `engines.node`，registry `https://registry.npmjs.org`）→ 升级 `npm@11`；
2. 若由标签触发，校验标签 `vX.Y.Z` 与 `package.json` 的 `version` 一致；
3. `npm run check` + `npm run test:ci` + `npm pack --dry-run` 作为门禁；
4. 发布前检查 npm 是否已存在同版本（404 才上传），兼容 `secrets.NPM_TOKEN` 与 OIDC Trusted Publishing，正式发布走 `npm publish --provenance --access public`。

包内容由 `package.json#files` 白名单控制，`test/` 与 `.github/` 不进入 tarball。
