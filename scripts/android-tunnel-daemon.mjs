#!/usr/bin/env node
// 让「本机模拟器 → 服务器」的反向隧道长期可用。
// ssh -R 只能从模拟器所在的那台机器发起，所以这个守护必须跑在本机，而不是服务器。
// 连接断开、模拟器重启、SSH 抖动都只重连转发，不重放任何安卓动作。
import { setTimeout as delay } from 'node:timers/promises';
import { openAndroidTunnel, argumentsFrom } from './android-reverse-tunnel.mjs';

const log = message => console.log(new Date().toISOString() + ' ' + message);
const options = { ...argumentsFrom(process.argv.slice(2)), apply: true };

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

let attempts = 0;
for (;;) {
  if (controller.signal.aborted) break;
  try {
    const tunnel = await openAndroidTunnel({ ...options, signal: controller.signal });
    attempts = 0;
    log('隧道已建立并核对为服务器回环监听：' + tunnel.serverSerial);
    const ended = await tunnel.closed;
    if (controller.signal.aborted) break;
    log('隧道断开（code=' + ended.code + '），开始重连');
  } catch (error) {
    if (controller.signal.aborted) break;
    log('建立失败：' + error.message);
  }
  attempts++;
  // 退避到 60 秒封顶：模拟器没启动时不必每 5 秒刷一次错误。
  const wait = Math.min(60000, 5000 * 2 ** Math.min(attempts, 4));
  log(Math.round(wait / 1000) + ' 秒后重试');
  await delay(wait, undefined, { signal: controller.signal }).catch(() => {});
}
log('隧道守护已退出');
