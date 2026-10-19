# Seed 视频分析

主模型继续使用 DSH 原来的对话账号。独立的 `video-analysis` MCP 工具负责调用火山方舟 Seed，并返回带时间点的文字证据，由主模型回答 QQ 用户。

四种模式均可使用。`closed-agent` 仍只接收 owner 私聊；`chat`、`reserved`、`reserved2` 支持白名单私聊和群聊，仿真模式仍沿用原有唤醒、潜水和发送规则。需要分析时调用 `mcp__video-analysis__analyze_video`，参数为消息里的 `attachmentId` 和用户问题 `question`。工具不接受任意文件路径或 URL。

## 预置配置

在本机 `config.json` 添加以下配置，重启桥接；安装或升级 MCP 后运行 `node scripts/setup-dsh.mjs` 并重启 DSH。

```json
{
  "videoAnalysis": {
    "enabled": true,
    "model": "doubao-seed-2-1-lite-260915",
    "apiKeyEnv": "ARK_API_KEY",
    "apiKeyFile": "state/secrets/ark-api-key",
    "fps": 1,
    "maxBytes": 104857600,
    "timeoutMs": 300000
  }
}
```

在火山方舟控制台开通支持音视频理解的模型并创建 API Key。默认模型支持画面与内嵌音轨；其他 Seed 模型的能力需按具体版本确认。可用模型 ID 或自己的 `ep-...` 接入点 ID。豆包 App 的登录账号不能代替 API Key。

密钥优先从指定环境变量读取，其次从指定文件读取。密钥文件仅放本机 `state/secrets/ark-api-key`，不写入配置模板或 Git；macOS/Linux 将目录权限设为 `700`、文件权限设为 `600`。Windows 应用现有 `state/` ACL 收紧工具。密钥文件不允许符号链接或硬链接。填入文件后下一次调用生效，无需重新启动 MCP；环境变量则需在启动 DSH 前设置。

未配置 Key 时工具返回“方舟密钥未配置”，不会发请求，也不会返回伪造的视频分析结果。修改模型、开关或帧率后重启桥接，使消息提示同步。

若 Key 所属账号尚未开通配置的模型，工具会明确提示开通。Key 有效并不代表该账号能调用所有模型。

## 输入、费用和清理

工具流式上传原视频，保留内嵌音轨，并在 Files API 预处理时指定模型和帧率，再通过 Responses API 引用文件 ID。使用平台默认存储，不需要公开视频 URL 或自行配置对象存储桶。支持 MP4、MOV、M4V、WebM 和 AVI；桥接可接收的 MKV 目前需转格式后重发。

默认分析上限 100 MiB、总时限 300 秒；大小可调至最多 512 MiB。画面默认每秒采样 1 帧，`fps` 可设为 0.2 到 5。较快动作可能需要提高帧率，这会增加输入量和费用；采样分析不能保证发现每一个短暂事件。声音支持也不保证对白转写无误，验收时应使用有已知画面和对白的样本。

视频内容和问题会发送到火山方舟，模型调用按账号计费。工具设置 `store: false`，分析完成或失败后尝试删除已知 ID 的临时文件；删除失败时成功结果会带警告。上传时设置一天有效期，连接中断但服务端已接收的文件也可能暂时保留。此配置不代表提供商不保存任何服务日志；请按提供商的数据政策使用。

响应显式设置一小时有效期，视频文件设置一天加上传耗时缓冲；方舟即使关闭响应存储，仍会校验两者的有效期关系。

本机视频不会自动删除，仍受接收目录容量限制。附件编号有效期为一天，且绑定接收时的模式和会话白名单；模式改变、白名单撤销、closed-agent 的 owner 变化或文件删除后拒绝继续分析。编号是该视频的分析凭据，勿对外发布。它不能授权读取电脑上的其他文件。

## 验证

```bash
npm run test:video
npm run test:video-analysis
npm run test:mcp-servers
```

离线测试使用模拟响应，验证上传字节、参数、文件边界、权限与清理。真实模型能力需配置 Key 后，通过 QQ 发送一个含画面和对白的小视频，再核对回复和工具记录；只有离线测试通过不代表真实模型调用已经验收。

接口依据：[音频理解](https://docs.volcengine.com/docs/ark/audio-understanding?lang=zh)、[视频理解](https://docs.volcengine.com/docs/ark/video-understanding?lang=zh)、[Files API](https://docs.volcengine.com/docs/ark/file-api?lang=zh)。
