#!/usr/bin/env node
// 校验方舟密钥是否可用于 Seed 视频分析。
// 只做只读的文件列表探测，不触发任何推理计费；任何情况下都不打印密钥本身。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVideoAnalysisConfig, readArkKey } from '../src/analyze-video.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let config;
try {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  config = normalizeVideoAnalysisConfig(raw.videoAnalysis ?? {});
} catch (error) {
  console.error(`✗ 读取配置失败：${error.message}`);
  process.exit(1);
}

const fromEnv = Boolean(process.env[config.apiKeyEnv]);
let key;
try {
  key = readArkKey(config, root);
} catch (error) {
  console.error(`✗ ${error.message}`);
  console.error(`  期望位置：${config.apiKeyEnv} 环境变量，或 ${config.apiKeyFile}（权限 600，非符号链接）`);
  process.exit(1);
}

console.log(`来源：${fromEnv ? `环境变量 ${config.apiKeyEnv}` : `文件 ${config.apiKeyFile}`}`);
console.log(`长度：${key.length} 字符，前缀 ${key.slice(0, 3)}***`);

let response;
try {
  response = await fetch('https://ark.cn-beijing.volces.com/api/v3/files?limit=1', {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
} catch {
  console.error('✗ 无法连接火山方舟，检查服务器出网和 DNS');
  process.exit(1);
}
await response.body?.cancel();

if (response.status === 401) {
  console.error('✗ 方舟拒绝该密钥（HTTP 401）：密钥无效或已被删除');
  process.exit(1);
}
if (response.status === 403) {
  console.error('✗ 密钥有效但无访问权限（HTTP 403）：检查账号状态与密钥归属');
  process.exit(1);
}
if (response.status >= 500) {
  console.error(`✗ 方舟服务暂不可用（HTTP ${response.status}），稍后重试`);
  process.exit(1);
}

// 401/403 之外的状态都说明鉴权已通过，差异只在于接口参数或资源。
console.log(`方舟鉴权：通过（HTTP ${response.status}）`);
console.log(`模型：${config.model}`);
if (!config.enabled) console.log('提示：videoAnalysis.enabled 仍为 false，工具调用会拒绝执行');
