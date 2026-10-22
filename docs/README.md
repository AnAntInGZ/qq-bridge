# 文档索引

本索引只列随仓库提供的文档。开发 agent 从 [AGENTS.md](../AGENTS.md) 和 [开发指南](guides/HARNESS.md) 开始；使用与安装从 [项目 README](../README.md) 开始。

| 文档 | 用途 |
| --- | --- |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 目录职责、脚本分类、源文件与生成物位置 |
| [guides/HARNESS.md](guides/HARNESS.md) | 开发入口、代码与测试导航、统一检查、隔离夹具、已知基线失败 |
| [guides/CHARACTER_RUNTIME.md](guides/CHARACTER_RUNTIME.md) | 角色存储、生产生活调度接入、心情兴趣、记忆删除更正与启用边界 |
| [plans/2026-10-21-character-life.md](plans/2026-10-21-character-life.md) | DSH 受限生活决策、预算作息、心情兴趣、记忆整理及删除更正的设计与验收 |
| [plans/2026-10-21-character-scheduler.md](plans/2026-10-21-character-scheduler.md) | P1 离线事件调度、持久有限重试、迁移与验收记录 |
| [plans/2026-10-19-character-foundation.md](plans/2026-10-19-character-foundation.md) | 第一批基础开发计划、当前 Windows 基线与实际验收结果 |
| [plans/2026-10-20-reserved2-deployment.md](plans/2026-10-20-reserved2-deployment.md) | 二代仿真本机部署、后台任务与实际验收结果 |
| [plans/2026-10-20-linux-deployment.md](plans/2026-10-20-linux-deployment.md) | Linux 二代仿真部署进度、资源限额与首次接入事项 |
| [plans/2026-10-19-autonomous-character-review.md](plans/2026-10-19-autonomous-character-review.md) | 自主角色最终评审入口：产品体验、设计决定、实施成果与上线前参数 |
| [guides/AUTONOMOUS_CHARACTER.md](guides/AUTONOMOUS_CHARACTER.md) | DeepSeek 自主角色详细设计：决策与调度契约、上下文隔离、媒体队列、游戏、P0—P5 验收 |
| [guides/CONTEXT.md](guides/CONTEXT.md) | 自主角色术语：角色、会话、意图、活动、经历、记忆、心情和信息范围 |
| [plans/2026-10-19-autonomous-character.md](plans/2026-10-19-autonomous-character.md) | 设计任务交接、已确认需求、待定事项与下一次对话入口 |
| [guides/VIDEO_RECEIVE.md](guides/VIDEO_RECEIVE.md) | 四种模式的 QQ 视频接收、附件权限、下载限制与验收 |
| [guides/VIDEO_ANALYSIS.md](guides/VIDEO_ANALYSIS.md) | Seed 视频画面与音轨分析、密钥配置、附件授权与清理 |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | 在目标设备安装预设、插件与 MCP；会修改真实 DSH 配置 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | DSH 0.2.0 适配依据、协议差异、升级检查与历史验证记录 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 威胁模型、权限和网络边界、残余风险；改安全相关代码前必读 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 隐私扫描和公开仓库脱敏说明 |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | token 账本、计价与控制台看板 |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览、浏览器回归与 API 基线 |
| [RULES.md](../RULES.md) | 运行模式、管理员与 QQ 会话权限、人设与提示词规则 |
| [roles/README.md](../roles/README.md) | 人格卡写法及分代规则 |

复杂开发任务的计划放在 `docs/plans/`，按任务命名，记录目标、决定、进度和验收结果。简单任务无需建立计划文件。

`docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/` 及旧的 `guides/PROJECT_GUIDE.md`、`guides/VOICE.md` 被 `.gitignore` 排除，不随 clone 提供，不作为开发前置条件。历史文档提到的 QSH 规划与 `../voice-tool/` 也属于仓库外资源；找不到时以已提交代码和实际验证为准。

- [安卓节点、B 站与 2048](guides/ANDROID_ACTIVITIES.md)：独立 Redroid/ADB 节点、云手机接入边界、校准与管理 API。
- [安卓活动实现计划](plans/2026-10-21-android-activities.md)：选型、设备执行和验证记录。
