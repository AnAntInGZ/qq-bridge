import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SENSITIVE_RE } from '../sensitive.js';

// 固定问法：不把推荐标题或画面里的文字拼进 prompt，避免视频内容影响提问本身。
// 三行结构化输出是为了让解析稳定，失败时整条作废而不是猜。
const QUESTION = [
  '这是安卓手机上视频播放界面的录屏片段。请严格按下面三行回答，不要写别的：',
  '类型：<内容品类，不超过 8 个字，例如 游戏/动画/数码/美食/音乐/知识科普/影视解说/生活记录>',
  '主题：<这条视频在讲什么，不超过 20 个字>',
  '细节：<画面里最具体、可核对的一个细节，不超过 40 个字>',
  '看不清或听不清就写"无法判断"。',
].join('\n');

const UNKNOWN = /^(?:无法判断|看不清|听不清|不确定|未知|无)$/;

function field(text, name) {
  const match = new RegExp(`^\\s*${name}\\s*[：:]\\s*(.+)$`, 'm').exec(text);
  return match ? match[1].trim().slice(0, 80) : '';
}

// Seed 的回答会进入给用户看的叙述，所以按同一套内容审计再过一遍：
// 命中路径或凭据特征时整条作废，不裁掉半句继续用。
export function parseClipAnswer(answer) {
  const text = String(answer ?? '').replace(/\r/g, '').trim();
  if (!text || SENSITIVE_RE.test(text)) return null;
  const usable = value => value && !UNKNOWN.test(value);
  const kind = field(text, '类型'), topic = field(text, '主题'), detail = field(text, '细节');
  // 主题是唯一必需项：没有主题就没有可用于叙述和兴趣匹配的内容。
  if (!usable(topic)) return null;
  return { kind: usable(kind) ? kind : '', topic, detail: usable(detail) ? detail : '' };
}

export function clipSummary(clip) {
  if (!clip) return '';
  const head = clip.kind ? `${clip.kind}，${clip.topic}` : clip.topic;
  return clip.detail ? `${head}；${clip.detail}` : head;
}

// 录屏片段只在分析期间存在于磁盘，用完立刻删除，不进入附件目录，也不产生可复用的编号。
// 超时比视频分析默认上限短得多：内容理解是补充层，不值得为它牺牲整次活动的预算。
export function createClipAnalyzer({ root, analyze, analysisConfig, question = QUESTION, timeoutMs = 45000 }) {
  const directory = path.resolve(root, 'state/activity-clips');
  return async function inspect(bytes, { guard = () => {} } = {}) {
    if (!analysisConfig?.enabled || typeof analyze !== 'function') return null;
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `${randomUUID()}.mp4`);
    await fs.promises.writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' });
    let timer;
    try {
      const pending = analyze({ filePath, question, config: analysisConfig, source: 'activity',
        // 分析期间持续复核活动准入，返回值固定，供内部比对权限是否被撤销。
        permission: () => { guard(); return 'activity-clip'; } });
      // 底层请求不认活动信号，用超时兜住它，避免方舟慢响应把活动预算拖穿。
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('安卓录屏分析超时')), timeoutMs); });
      const result = await Promise.race([pending, timeout]);
      return parseClipAnswer(result?.answer);
    } finally {
      clearTimeout(timer);
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
    }
  };
}
