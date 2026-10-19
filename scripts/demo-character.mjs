// 仅演示假活动的持久化与桥接投影，不创建真实配置或连接账号。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCharacterRuntime } from '../src/character/runtime.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-character-demo-'));
let runtime;
try {
  runtime = await createCharacterRuntime({ root, config: { enabled: true } });
  runtime.setPaused(false);
  const event = { source: 'fixture', sourceId: 'demo-idle', scope: 'public', summary: '离线演示：空闲活动机会' };
  runtime.ingestEvent(event);
  console.log('1. 重复事件去重：', runtime.ingestEvent(event).duplicate);
  const round = runtime.beginRound({ scope: 'public', candidates: [{ id: 'demo-clip', kind: 'bilibili', scope: 'public', summary: '离线演示视频片段' }] });
  runtime.stageIntent(round.id, { action: 'start', candidateId: 'demo-clip', reason: '离线演示的预设选择，没有调用模型' });
  console.log('2. 暂存提案不会执行：', runtime.claimOperation() === null);
  runtime.finishRound(round.id, { succeeded: true });
  const operation = runtime.claimOperation();
  console.log('3. 领取一次操作：', operation.kind, '，重复领取：', runtime.claimOperation());
  runtime.close();
  runtime = await createCharacterRuntime({ root, config: { enabled: true } });
  console.log('4. 重启后的未确认操作：', runtime.status().active.status, '，自动暂停：', runtime.status().paused);
  runtime.recordReceipt(operation.id, {
    id: 'demo-new-observation', outcome: 'cancelled',
    fact: '离线演示：假执行器已停止，未观看真实视频',
    evidence: ['fixture-observation-after-restart'],
  }, { reconcile: true });
  console.log('5. QQ 可见的事实投影：', JSON.stringify(runtime.project('group:456')));
  console.log('演示结束；未调用 DSH、QQ、Seed、B 站或模拟器。');
} finally {
  runtime?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
