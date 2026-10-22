import { z } from 'zod';

export const name = 'character-tools';
export const inject = ['tools'];
const text = max => z.string().trim().min(1).max(max);
const mood = z.object(Object.fromEntries(['valence', 'arousal', 'control', 'energy'].map(key => [key, z.number().int().min(-5).max(5).optional()]))).strict();
const input = z.object({
  roundId: text(100), expectedVersion: z.number().int().nonnegative(),
  intent: z.object({
    action: z.enum(['none', 'start']), candidateId: text(100).optional(), reason: text(300),
    nextAttentionMs: z.number().int().min(60000).max(86400000).optional(),
    appraisals: z.array(z.object({ sourceId: text(100), reason: text(300), mood: mood.optional(),
      interests: z.array(z.object({ topic: text(50), delta: z.number().int().min(-2).max(2) }).strict()).max(3).optional(),
    }).strict()).max(2).optional(),
    memory: z.object({ sourceIds: z.array(text(100)).min(1).max(5), reflection: text(500) }).strict().optional(),
  }).strict(),
}).strict();

// 使用公开的 ToolDefinition 契约，避免裸链接插件向仓库外解析 DSH 内部包。
export function registerCharacterTool(ctx) {
  const { $schema, ...parameters } = z.toJSONSchema(input);
  ctx.tools.register({
    name: 'character_propose',
    description: '暂存本轮选择、感受和记忆整理；成功回合后由宿主校验提交，不代表已经执行或完成活动。',
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { queued: { type: 'boolean' }, committed: { type: 'boolean' } }, required: ['queued', 'committed'] },
      render: () => [{ type: 'text', text: '提案已进入本轮会话记录，尚未提交；宿主将在回合结束后复核。' }],
    },
    async execute(raw, exec) {
      const args = input.parse(raw);
      if (!exec.agent?.session || exec.signal?.aborted) throw new Error('生活决策缺少有效会话');
      // 只能向执行方自己的会话追加事件；身份和执行代次不接受模型参数。
      exec.agent.session.append('character/proposal', args);
      exec.concludeTurn();
      return { queued: true, committed: false };
    },
  });
}
export function apply(ctx) { registerCharacterTool(ctx); }
