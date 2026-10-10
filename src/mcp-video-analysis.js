import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createVideoAnalyzer } from './analyze-video.js';
import { resolveVideoAttachment } from './video-attachments.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const analyze = createVideoAnalyzer({ root });
const server = new McpServer({ name: 'video-analysis', version: '0.2.0-r3' });
server.tool('analyze_video',
  '使用独立火山方舟 Seed 账号分析已接收的 QQ 视频画面和声音，需要支持音视频理解的模型。全部 QQ 模式可用，仍受白名单约束。attachmentId 使用消息中的视频附件编号，question 写明用户问题；无文字时概述画面和声音。视频上传到火山方舟，分析后尝试删除远端临时文件。返回带时间点的中文证据，不代表逐帧验证。工具失败时不能声称已经理解视频。',
  { attachmentId: z.string().uuid(), question: z.string().min(1).max(6000) },
  async ({ attachmentId, question }) => {
    try {
      const resolve = () => resolveVideoAttachment({ root, attachmentId, config: read('config.json'), mode: read('state/mode.json').mode });
      const { filePath } = resolve();
      const permission = () => { try { return resolve().authorization; } catch { return false; } };
      const result = await analyze({ filePath, question, config: read('config.json').videoAnalysis, permission });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      // 不返回底层异常、完整路径或带签名的上传地址。
      const message = error instanceof SyntaxError || error.code ? '视频分析配置不可用，请在本机检查配置' : error.message;
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  },
);
await server.connect(new StdioServerTransport());
