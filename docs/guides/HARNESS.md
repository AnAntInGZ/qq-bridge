# Agent 开发指南

本项目是 Node.js ESM 应用，没有前端构建步骤。`npm start` 直接运行 `src/bridge.js`，控制台是原生 HTML/JS。这里的开发 harness 指代码导航、隔离夹具、可复现检查和交付规则；产品依赖的 DeepSeek Harness 简称 DSH。

开发约定入口是 [AGENTS.md](../../AGENTS.md)，运行权限规则是 [RULES.md](../../RULES.md)。本文描述已提交的实现，不依赖作者本机的 QSH 规划、审计笔记或独立语音工具。

## 仓库基线

开发仓库是 [AnAntInGZ/qq-bridge](https://github.com/AnAntInGZ/qq-bridge)，默认在 `main` 开发并跟踪 `origin/main`；原项目 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 使用远程名 `upstream`。更新前核对远程与跟踪关系，不能把上游最新版本等同于本项目最新版本。

本次基线为 `29f5885`，已合入 QQ 视频接收和 Seed 分析。上游 `a56164e` 的 r4 更新尚未整合，不将其新增功能或回归脚本计为本项目已有能力。

## 从干净 clone 开始

```sh
node --version
npm ci
npm run check
```

Node.js 要求 >= 22.13.0。保留 lockfile；`npm ci` 会运行 `patch-snowluma-sdk.mjs`，修补依赖的 ESM 扩展名。无需复制 `config.example.json`，无需启动 DSH、SnowLuma 或 QQ。

`npm run check` 依次执行以下检查，任一失败最终返回非零，后续阶段仍执行：

| 阶段 | 实现 | 覆盖范围 |
| --- | --- | --- |
| 语法 | `scripts/check.mjs` 中的 `node --check` | 递归检查 `src/`、`scripts/`、`plugins/`、`dsh/` 中的 JS/MJS，不执行被检查文件 |
| 预设一致性 | `scripts/build-agent-preset-patches.mjs --check` | 比较预设源与已提交的 bundle patch，不写文件 |
| 会话路由 | `node --test src/core/session-router.test.mjs` | 独立模块的模式、preset、owner 边界与迁移；不代表主程序已接入 |
| 审计回归 | `scripts/test-audit.mjs` | 真实业务代码配合 VM、假网关、临时文件和回环 HTTP fixture；仍有下文记录的外部依赖缺口 |
| 隐私扫描 | `scripts/privacy-scan.mjs` | 已跟踪和未忽略的未跟踪文件；结果受放行规则和匹配限额约束 |

统一命令设置 `QQ_BRIDGE_TEST_LIVE=0`，不会主动启动生产桥接或发送真实 QQ。不要将它扩展为 setup、真实链路探针或发送命令的聚合器。该环境变量不是进程级网络隔离，新增测试仍须审查实际 I/O。

## 先沿主链路定位

```text
QQ 消息 → SnowLuma OneBot WS → bridge.js / handleIncoming
  → 准入、模式、管理命令、人格与媒体整理
  → ensureSession / deliverPrompt / sendWakePromptV2
  → dsh-client.js / Cookie 鉴权、斜杠 RPC、remote.mux + session/follow
  → 回合事件处理或 MCP 工具
  → bridge.js / 权限、内容审计、限流、发送队列
  → SnowLuma OneBot → QQ
```

`chat`、`reserved` 和 `closed-agent` 会转发 agent 的回合输出；`reserved2` 不自动转发文本，由工具发送。桥接把输入别名 `simulation` 归一为 `reserved2`，模式判断仍主要使用进程级 `currentMode`。

控制台 `public/console.html` 调用 `bridge.js` 的本地 HTTP API。`mcp-snowluma-safe.js` 的二代工具也调用这个 API，带控制台凭据与绑定会话的 agent token。管理端和会话端的权限必须分别校验，不能因为都走回环接口就信任调用者。

| 任务 | 首先阅读的代码 | 相关检查 |
| --- | --- | --- |
| 准入、模式、会话、队列、唤醒 | `src/bridge.js` 的 `modeAllowed`、`ensureSession`、`retireSession`、`handleIncoming` 和二代状态 | `test-audit-bridge.mjs`、`test-token-economy.mjs`、`test-reply-wait.mjs` |
| DSH 鉴权、协议与事件流 | `src/dsh-client.js` | `test-audit-protocol.mjs`、`test-dsh-inbox-projection.mjs`、`test-mux-reconnect.mjs` |
| QQ 工具与 API 权限 | `src/mcp-snowluma-safe.js`、`bridge.js` 的 `startConsoleServer` | `test-audit-security.mjs`、`test-audit-security-mcp.mjs`、`test-hardening.mjs` |
| 预设、工具守卫、安装 | `dsh/agent-presets/`、`plugins/qq-agent-presets/qq-tool-restrict.mjs`、`scripts/setup-dsh.mjs` | `npm run check:presets`、`test-agent-preset-patches.mjs`、`test-audit-setup.mjs`、`test-audit-setup-guards.mjs`、`test-preset-local-tools.mjs` |
| DSH 模式设置 | `plugins/qq-mode-console/lib/index.js` | `test-qq-mode-plugin.mjs`；命名空间由 entry id + Config 的 volatile 字段推导，不使用已删除的 `settings.register` |
| 联网与 SSRF | `src/safe-fetch.js`、`src/mcp-web-search-safe.js` | `test-audit-security.mjs`、`test-audit-security-mcp.mjs`，使用 mock |
| 图片、表情、合并转发 | `src/sticker-lib.js`、`src/forward.js`、桥接媒体解析与发送 | `test-audit-protocol-helpers.mjs`、`test-audit-bridge.mjs`；另有未纳入完整套件的 `test-stickers.mjs`、`test-forward.mjs` |
| QQ 视频接收与理解 | `src/receive-video.js`、`src/video-attachments.js`、`src/analyze-video.js`、`src/mcp-video-analysis.js` | `npm run test:video`、`npm run test:video-analysis`，均已纳入审计；见 [视频接收](VIDEO_RECEIVE.md) 和 [视频分析](VIDEO_ANALYSIS.md) |
| 人格与提示词 | `src/role-card.js`、`src/preset-prompt.js`、`roles/`、预设源 | `test-role-card.mjs`、`test-preset-prompt.mjs`、`test-qq-preset-contract.mjs` |
| 黑话学习 | `src/slang-learner.js` 与桥接学习会话 | `test-slang-learn.mjs`、审计回归；结果需管理员确认后注入 |
| token 与费用 | `src/token-ledger.js`、`src/model-prices.js`、`src/qq-model-view.js` | `npm run test:tokens`、`test-qq-model-view.mjs`；见 [看板指南](TOKEN_USAGE_CONSOLE.md) |
| 语音与连接发现 | `src/voice-core.js`、`src/send-voice-lib.js`、`src/snowluma-conn.js` | 审计中的 `test-voice*.mjs`、`test-snowluma-conn.mjs`；独立工具缺失时核对跳过项 |
| 控制台界面 | `public/console.html`、`scripts/console-ui-fixture.mjs` | `npm run preview:console`、`npm run test:console-ui`、`test-console-static.mjs`；见 [UI 测试指南](CONSOLE-UI-TESTING.md) |
| 逐会话策略模块 | `src/core/session-router.mjs` | `npm run test:router`；主程序尚未导入，接入需另验真实消息与退役链路 |

表中 `test-*.mjs` 位于 `scripts/`，可用 `node scripts/<文件名>` 单独执行。完整审计清单以 `scripts/test-audit.mjs` 的 `tests` 数组为准，不能凭文件名判断是否已覆盖。

视频主链路已接入四种模式。桥接接收授权视频、登记附件编号，`video-analysis` MCP 调用独立方舟 Seed 账号分析画面与内嵌音轨，将文字证据交给原有对话模型。视频分析默认关闭，需要配置密钥；接收附件和真实理解须分别验证，不能因为通用消息文本包含 `[视频]` 就判定没有视频能力。

## 正确使用夹具

`scripts/audit-bridge-harness.mjs` 的 `bridgeHarness()` 在系统临时目录创建假配置和状态，通过 VM 执行真实桥接的初始化与内部函数。它替换 DSH、SnowLuma、定时器、fetch、ACL 和音频处理等边界，返回 `calls`、业务函数和 `close()`。

业务回归优先使用已有夹具触发输入，断言可观察行为与副作用；用 `try/finally` 关闭 HTTP server 并调用 `await h.close()`。失败路径覆盖对应 mock，不连接本机服务。

夹具通过源码标记裁剪入口并注入导入绑定，不是通用安全沙箱。调整 `main()`、事件注册标记、顶层 import，或新增依赖和网络调用时，必须同步检查夹具。纯模块直接 import 测试，生产入口不要直接 import 来“只看看函数”。

控制台使用 `console-ui-fixture.mjs`，新 API 要同步增加 mock。只有明确改变后端契约时才更新 `console-ui-contracts.json` 和 DOM 基线，不能重录基线来掩盖回归。

测试、探针临时产物统一放系统临时目录。`state/` 保存真实凭据和聊天数据，Windows ACL 会有意阻止沙箱写入；不要通过恢复继承权限让测试通过。

## 预设只有一个修改源

```sh
# 修改 dsh/agent-presets/ 中的源后生成
node scripts/build-agent-preset-patches.mjs

# 验证生成结果，开发检查只使用只读模式
npm run check:presets
node scripts/test-agent-preset-patches.mjs
```

生成物位于 `plugins/qq-agent-presets/presets/`，应随源提交。守卫实现位于 bundle 内，预设目录仅 re-export。人格卡不承载工具协议。部署安装与开发生成分开，普通验证不运行 `setup-dsh.mjs` 写入用户 DSH。

## 真实环境验证单独执行

| 命令 | 环境与副作用 |
| --- | --- |
| `npm run test:console-ui` | 离线浏览器与临时回环服务；需 Playwright/Chromium，静态检查不能替代 |
| `npm run scan:tool-names` | 读取已安装 DSH 的真实工具包，与守卫名单对账；升级时需要，可设置 `DSH_INSTALL_MODULES` |
| `npm run verify:adaptation` | 包含真实 DSH 验证，需可用安装与服务 |
| `npm run self-test`、`npm run test:session-retire:e2e` | 连接真实 DSH，创建、驱动、归档测试会话，可能消耗模型额度 |
| `node scripts/setup-dsh.mjs` | 修改目标 DSH 预设、插件与 profile 配置，属于部署 |
| `npm start`、`npm run test-console`、`scripts/send-*.mjs`、live 测试 | 可能连接真实账号、发送 QQ 或修改状态，需要确认目标及授权 |
| `npm run harden-acl` | 修改真实权限，普通开发验证不运行 |

`../voice-tool/` 是仓库外独立工具，不是 npm 依赖。不要为了全绿而伪造它或复制实现；需要相关验证时由使用者提供工具位置，支持 `QQ_BRIDGE_VOICE_TOOL_DIR`。

## 当前基线问题

2026-10-19 在本仓库 `29f5885`、macOS、Node.js 22.17.0、未配置 DSH/voice-tool 的干净工作区，运行 `npm ci` 后：原有 `test:audit` 为 **26/33 个脚本通过**，其中视频接收与视频分析两组回归均通过。以下失败均早于开发 harness 的迁入；尚未修复，统一检查仍会因此退出非零。

| 失败脚本 | 复现原因 / 后续修复方向 |
| --- | --- |
| `test-audit-bridge.mjs` | 临时目录 `/var` 与 realpath 返回的 `/private/var` 字符串不同；应比较规范化路径，保留语音库边界断言 |
| `test-audit-setup-guards.mjs` | 已提交 `start.bat` 本次 checkout 为 LF，测试要求 CRLF；应明确 Git 行尾约定，不放宽启动器约束 |
| `test-preset-prompt.mjs` | 直接把 checkout 的预设当作 CRLF 样本；应分别构造 LF/CRLF 输入验证行尾保持 |
| `test-voice.mjs` | 同样受临时目录 realpath 差异影响，合法路径被错误判为失败 |
| `test-voice-system.mjs` | 无条件读取被忽略且未发布的 `docs/guides/VOICE.md`；需补可发布指南或改用随仓库提供的契约 |
| `test-console-encoding.mjs` | macOS 无 Windows `chcp` 命令；平台专有段需单独标记，保留跨平台字节解码检查 |
| `test-preset-local-tools.mjs` | 离线套件调用真实 DSH 安装目录发现，缺少安装时抛错；应分离本地声明校验和实际安装对账 |

额外验证：会话路由 **33/33 个用例通过**，预设源与产物一致。隐私扫描返回 0，但原有扫描器对部分规则报“匹配过多/过慢、结果可能不完整”，不能将退出码 0 解读为已证明没有秘密。

修复后更新这一节，保留复现条件与实际结果。不要把它做成自动忽略失败的名单，也不要改变生产权限来迁就测试。

## 持续维护

按“目标与验收 → 最小改动 → 相关验证 → 完整检查 → 交付”推进。复杂任务在 `docs/plans/` 保存计划，包含目标、非目标、相关入口、步骤、验收命令、风险及待确认项，完成后记录实际结果。简单修复无需创建空计划。

交付说明包含改动及原因、执行过的检查、失败/跳过/未执行项和真实环境影响。新约束更新到相应指南，并从 [文档索引](../README.md) 可达，不把聊天过程全部塞进 `AGENTS.md`。
