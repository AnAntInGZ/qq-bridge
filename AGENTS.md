# Agent 开发约定

本文件适用于整个仓库。面向开发 agent；运行中的 QQ 会话权限见 [RULES.md](RULES.md)，两者不要混用。

## 仓库与分支

- 本项目以 `AnAntInGZ/qq-bridge` 为开发基线，远程名为 `origin`；`Derpyu520/qq-bridge` 保留为 `upstream`，仅供核对上游更新。
- 按 owner 要求，后续默认在本仓库的 `main` 分支开发，并跟踪 `origin/main`。不要自动切到上游基线、创建任务分支或 worktree；需要改变流程时按用户当前指令执行。
- 拉取前先核对 `git remote -v`、当前分支及跟踪关系。通常使用 `git pull --ff-only origin main`，分叉时先说明差异，不自动合并或覆盖。

## 开始工作

1. 先读本文件和 [开发指南](docs/guides/HARNESS.md)，按任务查阅其中的代码与测试入口。
2. 执行 `git status --short --branch`，保留已有改动。不要自动 stash、reset、清理文件或覆盖其他人的工作。
3. 明确目标、影响范围和验收方式。多步骤任务先写简短计划；复杂或跨轮次的任务将计划放在 `docs/plans/`，持续记录决定、进度和验证结果，不记录凭据或私人数据。
4. 修改前运行相关检查，区分原有失败和本次回归。基线问题见开发指南；复现后再判断，不把历史记录当作当前结果。

## 安装与验证

要求 Node.js >= 22.13.0，使用 npm 和 `package-lock.json`。

```sh
npm ci
npm run check
```

`npm ci` 的 postinstall 会修补 SnowLuma SDK 的 ESM 相对导入，不要随意跳过。开发验证不需要创建真实 `config.json` 或启动桥接。

`npm run check` 依次执行 JS/MJS 语法检查、预设产物一致性、会话路由测试、现有审计回归和隐私扫描；某阶段失败后继续其他阶段，最终返回非零。**已有审计套件尚有跨平台和外部依赖问题，不能承诺全新 clone 全绿**，详见开发指南。

- 修改业务行为时，先用已有夹具复现问题，再补最小的行为回归。文档和低风险配置改动不必机械补测试。
- 控制台改动还需 `npm run test:console-ui`；未安装 Playwright/浏览器时明确报告未运行，静态检查不能冒充浏览器通过。
- 新增审计回归登记到 `scripts/test-audit.mjs`；新增其他测试或检查时同步维护 `scripts/check.mjs` 与开发指南。
- 失败、跳过、未运行分别报告。不得删断言、扩大白名单或把异常吞掉来获得绿色结果。

## 实现边界

- 使用现有 ESM JavaScript、Node 内置能力和项目风格。没有明确收益时不引入框架、构建层或通用抽象。
- 只修改任务需要的代码；不借功能开发大范围重排 `src/bridge.js`。提取模块时保持外部行为，并同时检查 VM 测试夹具的导入注入与清理逻辑。
- `src/core/session-router.mjs` 目前是独立模块，**尚未接入 `src/bridge.js`**。不要将其中的逐会话策略描述成已上线能力，也不要仅改它就声称修复了主链路。
- 预设的源是 `dsh/agent-presets/`；修改后运行 `node scripts/build-agent-preset-patches.mjs`，同时提交 `plugins/qq-agent-presets/presets/` 的生成结果，不手改产物。
- 工具守卫只有 `plugins/qq-agent-presets/qq-tool-restrict.mjs` 一份实现；两个预设里的同名文件保留为 re-export。
- 人格写在 `roles/*.md`，工具协议写在预设里；不要把两代不同的协议混进共享人格。
- 代码注释使用自然、简洁的中文，解释设计原因、业务语义或约束，不复述代码。

## 安全与副作用

涉及权限、发送、文件路径、网络、令牌或会话生命周期时，先读 [安全基线](docs/guides/SECURITY_BASELINE.md)。至少保住以下约束：

- 未授权会话拒绝访问；受限预设不可用时拒绝创建仿真会话，不回退到完整工具预设。`closed-agent` 仅允许 owner 私聊。
- 控制台令牌与会话 agent token 分层，管理接口默认拒绝 agent；读取和发送均检查会话绑定及当前权限。
- 发送在实际执行时复核白名单、内容审计和额度。会话退役清理 token、队列、监听器和定时器，防止旧任务继续发送。
- 文件路径做目录包含性与 realpath 校验；联网复用 `safe-fetch.js` 的地址校验、重定向和大小限制，不另开绕过路径。
- `config.json`、`state/`、`audio/`、本机隐私规则和外部 DSH/SnowLuma 安装属于运行环境，默认不修改、不读取其中的凭据、不入库。测试使用系统临时目录与假数据。
- 普通开发验证只运行离线测试或 fixture。启动 `npm start`、`self-test`、setup、live 测试、发送脚本或真实服务探针前，确认用户已授权其具体副作用；脚本名含 `test` 不代表离线。
- 不为测试放宽 `state/` ACL，不自动安装、打包或启停 SnowLuma。

## 维护与交付

- 保持 `AGENTS.md` 简短，细节放 `docs/guides/`，从 [文档索引](docs/README.md) 登记。只引用随仓库提供的文件；本机规划文档不能成为开发前置条件。
- 修改 API、模式、安全语义或生成流程时，同步更新相应指南、配置模板、fixture 和行为测试。
- 完成前检查 `git diff --check`、`git diff` 和 `git status`，说明改动、实际运行的验证、原有失败及尚未覆盖的部分。
- 默认不 push、开 MR/PR 或合并；按用户指令执行。commit 与 push 不携带 `Co-Authored-By` 行。
