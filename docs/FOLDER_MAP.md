# 仓库目录地图

开发约定见 [AGENTS.md](../AGENTS.md)，代码与测试的任务导航见 [开发指南](guides/HARNESS.md)，全部公开文档见 [文档索引](README.md)。

## 顶层职责

| 路径 | 职责与修改约束 |
| --- | --- |
| `AGENTS.md` | 开发 agent 的统一约定，细节通过链接指向指南 |
| `README.md` / `README.en.md` | 面向使用者的安装、配置和功能说明 |
| `RULES.md` | 运行权限、管理员边界、模式与提示词语义 |
| `src/bridge.js` | 运行入口；消息接入、模式与会话、唤醒、发送队列、HTTP API 和启动/清理 |
| `src/dsh-client.js` | DSH 鉴权、斜杠 RPC、事件流、回合收集与退役协议 |
| `src/mcp-*.js` | 四个 stdio MCP server：QQ 安全动作、只读宿主状态、受限联网、Seed 视频分析 |
| `src/receive-video.js` / `src/video-attachments.js` / `src/analyze-video.js` | 视频下载、附件登记授权与独立 Seed 分析；主对话模型使用分析结果回复 |
| `src/core/` | 逐会话策略纯模块与独立测试；当前尚未接入主程序 |
| `src/` 其他模块 | 媒体、语音、表情、黑话、人格、提示词、网络防护、token 与 ACL；按职责复用 |
| `dsh/agent-presets/` | 两个预设的权威源：元信息、persona 和插件行；工具守卫文件只是 re-export |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs` | 唯一工具守卫实现 |
| `plugins/qq-agent-presets/presets/` | 从预设源生成的 bundle patch，随源提交，不手改 |
| `plugins/qq-mode-console/` | DSH host 插件，暴露 `qq-mode` 设置命名空间；没有浏览器设置卡片 |
| `public/console.html` | 原生 HTML/JS 控制台，由桥接提供；开发使用离线 fixture 预览 |
| `scripts/` | 检查、测试、夹具、生成、部署与探针；副作用不能只按名字判断 |
| `roles/` | 人格卡与写作规范；不混入工具协议，不覆盖用户内容 |
| `assets/` | 公开静态资源；大视频由 Release 托管 |
| `docs/guides/` | 随仓库发布的使用、开发和安全指南 |
| `docs/plans/` | 复杂开发任务的计划与结果，按需创建，不保存私人数据 |
| `config.example.json` | 可发布配置模板，不填真实账号或凭据 |
| `config.json` / `state/` / `audio/` | 忽略的真实配置、状态与个人音频；默认不修改、不清理、不提交 |
| `node_modules/` / `.npm-cache/` | 忽略的依赖和缓存，不提交 |

## 脚本入口

| 入口或类型 | 用途 |
| --- | --- |
| `check.mjs` | `npm run check`：语法、预设一致性、独立路由测试、审计回归、隐私扫描；保留失败退出码 |
| `test-audit.mjs` | 既有审计回归的清单与执行器，新审计脚本需登记；当前环境缺口见开发指南 |
| `audit-bridge-harness.mjs` | VM 桥接夹具：临时目录、假 DSH/OneBot、调用记录与清理 |
| `test-*.mjs` | 测试或手工验证；部分依赖活 DSH、QQ 或仓库外工具，先看脚本 |
| `console-ui-fixture.mjs` | 离线控制台预览与测试 API，不读真实运行状态 |
| `test-console-ui.mjs` / `console-ui-*.json` / `fixtures/` | 浏览器回归、API/DOM 基线和旧版界面对照 |
| `build-agent-preset-patches.mjs` | 预设源到 bundle 的唯一生成器，`--check` 只读核对 |
| `setup-dsh.mjs` | 幂等安装到真实 DSH，属于部署；不用于普通开发验证 |
| `probe-*.mjs` / `verify-*.mjs` | 能力探测、协议或配置验证；可能读取凭据、连接服务、写入设置或创建会话，逐个确认 |
| `dsh-modules.mjs` / `dsh-tool-names.mjs` / `scan-dsh-tool-names.mjs` | 定位 DSH 安装、抽取工具名、与守卫名单对账 |
| `send-*.mjs` / `check-onebot-status.mjs` | 真实发送或连接排查，需要明确目标和授权 |
| `privacy-scan.mjs` / `privacy-rules.example.json` | 提交前的只读脱敏扫描与规则模板；真实规则文件不入库 |
| `patch-snowluma-sdk.mjs` | postinstall 必需的 ESM 打包修补，不作为一次性脚本删除 |
| `diagnose-acl.mjs` / `harden-state-acl.mjs` | 分别只读诊断和修改 ACL；开发测试不修改真实 ACL |
| `voice-tool-locator.mjs` | 仓库外独立语音工具定位与明确的跳过提示 |

`../voice-tool/` 不在本仓库，复用 `src/voice-core.js` 和 `src/snowluma-conn.js`；缺失时不能声称相关能力已验证。

## 文档归属

根目录保留项目 README、`RULES.md` 与供 agent 自动发现的 `AGENTS.md`，其他新文档放 `docs/` 并维护索引。`docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/` 和部分旧指南被 `.gitignore` 排除，公开开发文档应放 `docs/guides/`，不要依赖本机才有的文件。
