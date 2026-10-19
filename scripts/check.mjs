// 统一开发检查：只运行语法校验、生成物核对和隔离测试，不启动真实桥接。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const failures = [];

function run(label, args, { quiet = false } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.error || result.status !== 0) {
    failures.push(label);
    if (quiet) process.stderr.write(result.stderr || result.stdout || '');
    console.error(`[check] 失败：${label}（${result.error?.message || `exit ${result.status}, signal ${result.signal || 'none'}`}）`);
    return false;
  }
  return true;
}

function sourceFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(file);
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) ? [file] : [];
  });
}

// --check 只解析源文件，避免 import 桥接或 MCP 入口时触发连接与落盘。
const sources = ['src', 'scripts', 'plugins', 'dsh'].flatMap(sourceFiles).sort();
console.log(`[check] 语法检查：${sources.length} 个 JS/MJS 文件`);
for (const file of sources) run(`语法 ${file}`, ['--check', file], { quiet: true });

const checks = [
  ['预设产物一致性', ['scripts/build-agent-preset-patches.mjs', '--check']],
  ['会话路由测试', ['--test', 'src/core/session-router.test.mjs']],
  ['角色基础状态', ['--test', 'src/character/runtime.test.mjs']],
  ['审计回归', ['scripts/test-audit.mjs']],
  ['隐私扫描', ['scripts/privacy-scan.mjs']],
];
for (const [label, args] of checks) {
  console.log(`\n[check] ${label}`);
  run(label, args);
}

if (failures.length) {
  console.error(`\n[check] ${failures.length} 项失败：${failures.join('、')}`);
  process.exitCode = 1;
} else {
  console.log('\n[check] 所有检查命令通过；请同时核对各命令输出中的跳过项与告警。');
}
