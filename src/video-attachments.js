import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const VIDEO_NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(mp4|mov|m4v|webm|mkv|avi)$/;

function permitted(record, config, mode) {
  if (!['chat', 'closed-agent', 'reserved', 'reserved2'].includes(mode) || record.mode !== mode || config.video?.enabled === false || config.videoAnalysis?.enabled === false) return false;
  if (mode === 'closed-agent') return record.kind === 'private' && record.id === String(config.ownerQQ || '') && record.owner === String(config.ownerQQ || '');
  const deny = config.deny?.[record.kind] ?? config.deny?.[record.kind + 's'] ?? [];
  const allow = config.allow?.[record.kind] ?? config.allow?.[record.kind + 's'] ?? [];
  return !deny.map(String).includes(record.id) && (allow.length ? allow.map(String).includes(record.id) : config.allowAllWhenEmpty === true);
}

export function registerVideoAttachment({ root, filePath, kind, id, mode, ownerQQ }) {
  if (!['group', 'private'].includes(kind) || !/^\d+$/.test(String(id)) || !VIDEO_NAME.test(path.basename(filePath))
    || path.dirname(filePath) !== path.join(root, 'state/incoming-videos')) throw new Error('视频附件来源无效');
  const attachmentId = randomUUID();
  const directory = path.join(root, 'state/video-attachments');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = { filename: path.basename(filePath), kind, id: String(id), mode, owner: String(ownerQQ || ''), expiresAt: Date.now() + 86400000 };
  fs.writeFileSync(path.join(directory, attachmentId + '.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  return attachmentId;
}

export function resolveVideoAttachment({ root, attachmentId, config, mode }) {
  // 编号只授权分析这一个附件，模型不能提交任意路径或下载地址。
  if (typeof attachmentId !== 'string' || !UUID.test(attachmentId)) throw new Error('视频附件编号无效');
  let fd;
  let record;
  try {
    fd = fs.openSync(path.join(root, 'state/video-attachments', attachmentId + '.json'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048) throw new Error();
    record = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { throw new Error('视频附件不存在或已失效，请重新发送'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  if (!['group', 'private'].includes(record.kind) || !/^\d+$/.test(record.id) || !VIDEO_NAME.test(record.filename)
    || !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now() || !permitted(record, config, mode)) throw new Error('视频附件已过期或当前模式、白名单不允许分析，请重新发送');
  return { filePath: path.join(root, 'state/incoming-videos', record.filename), authorization: JSON.stringify(record) };
}
