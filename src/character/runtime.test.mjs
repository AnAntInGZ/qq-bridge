import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCharacterRuntime } from './runtime.mjs';
import { intersectScopes, normalizeScope, visibleTo } from './policy.mjs';
import { DatabaseSync } from 'node:sqlite';

async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-character-'));
  let now = 1000;
  let runtime;
  const open = async () => {
    runtime = await createCharacterRuntime({ root, config: { enabled: true }, now: () => now });
    return runtime;
  };
  try { await fn({ root, open, advance(ms) { now += ms; } }); }
  finally { runtime?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

function plan(runtime, scope = 'public', sourceId = 'idle-1') {
  runtime.ingestEvent({ source: 'fixture', sourceId, scope, summary: '一次离线活动机会' });
  const round = runtime.beginRound({ scope, candidates: [{ id: 'candidate', kind: 'bilibili', scope: 'public', summary: '离线视频候选' }] });
  runtime.stageIntent(round.id, { action: 'start', candidateId: 'candidate', reason: '与已有兴趣相关' });
  return { round, result: runtime.finishRound(round.id, { succeeded: true }) };
}

function receipt(operation, overrides = {}) {
  return { id: 'receipt-' + operation.id, epoch: operation.epoch, outcome: 'completed', fact: '已分析片段的前一分钟', feeling: '想继续了解', evidence: ['fixture-observation-1'], ...overrides };
}

test('默认关闭时不创建状态目录，也不要求 SQLite 运行时', async () => {
  await fixture(async ({ root }) => {
    assert.equal(await createCharacterRuntime({ root }), null);
    assert.equal(fs.existsSync(path.join(root, 'state')), false);
    await assert.rejects(createCharacterRuntime({ root, config: { enabled: 'true' } }));
  });
});

test('范围交集不会把不同群的私人内容转为公开', () => {
  assert.equal(intersectScopes('public', 'group:1'), 'group:1');
  assert.equal(intersectScopes('group:1', 'group:2'), 'internal');
  assert.equal(visibleTo('private:1', 'group:1'), false);
  assert.equal(visibleTo('public', 'private:1'), true);
  for (const scope of [null, undefined, {}, ['public'], 'group:0', 'private:1/..']) assert.throws(() => normalizeScope(scope));
});

test('同一事件重复十次仅保留一项，相同编号不同内容拒绝', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open();
    const event = { source: 'fixture', sourceId: 'same', scope: 'public', summary: '同一事件' };
    const first = runtime.ingestEvent(event);
    for (let i = 0; i < 10; i++) assert.deepEqual(runtime.ingestEvent(event), { id: first.id, duplicate: true });
    assert.equal(runtime.status().pendingEvents, 1);
    assert.throws(() => runtime.ingestEvent({ ...event, scope: 'group:1' }));
  });
});

test('新启动先暂停，只有完整成功的决策才登记操作', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open();
    assert.equal(runtime.status().paused, true);
    assert.throws(() => runtime.beginRound({ scope: 'public' }));
    runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'one', scope: 'public', summary: '空闲事件' });
    const round = runtime.beginRound({ scope: 'public', candidates: [{ id: 'one', kind: 'rest', scope: 'public', summary: '休息' }] });
    runtime.stageIntent(round.id, { action: 'start', candidateId: 'one', reason: '稍作休息' });
    assert.equal(runtime.claimOperation(), null);
    assert.equal(runtime.finishRound(round.id, { succeeded: false }).committed, false);
    assert.equal(runtime.status().active, null);
    assert.equal(runtime.beginRound({ scope: 'public' }), null);
  });
});

test('工具重试可重复暂存相同提案，第二个选择及未知字段拒绝', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'one', scope: 'public', summary: '空闲事件' });
    const round = runtime.beginRound({ scope: 'public' });
    const intent = { action: 'none', reason: '暂不行动' };
    runtime.stageIntent(round.id, intent);
    runtime.stageIntent(round.id, intent);
    assert.throws(() => runtime.stageIntent(round.id, { ...intent, reason: '更改选择' }));
    assert.throws(() => runtime.stageIntent(round.id, { ...intent, shell: 'fixture' }));
    assert.equal(runtime.finishRound(round.id, { succeeded: true }).committed, true);
    assert.equal(runtime.status().active, null);
  });
});

test('过期决策不执行，过期批次不会阻塞后续新事件', async () => {
  await fixture(async ({ open, advance }) => {
    const runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'one', scope: 'public', summary: '旧事件' });
    const round = runtime.beginRound({ scope: 'public', ttlMs: 10 });
    runtime.stageIntent(round.id, { action: 'none', reason: '等待' });
    advance(11);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'two', scope: 'public', summary: '新事件' });
    const newer = runtime.beginRound({ scope: 'public' });
    assert.equal(newer.events.length, 1);
    assert.equal(newer.events[0].summary, '新事件');
    assert.throws(() => runtime.finishRound(round.id, { succeeded: true }));
  });
});

test('两个群同时提出活动仍只产生一个主要活动，重复提交不重放', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open(); runtime.setPaused(false);
    const first = plan(runtime, 'group:1', 'first');
    const second = plan(runtime, 'group:2', 'second');
    assert.equal(second.result.committed, false);
    assert.equal(runtime.status().active.id, first.result.activityId);
    assert.throws(() => runtime.finishRound(first.round.id, { succeeded: true }));
    const operation = runtime.claimOperation();
    assert.equal(operation.activityId, first.result.activityId);
    assert.equal(runtime.claimOperation(), null);
  });
});

test('私聊决策不读取其他群事件或候选，派生经历继承私聊范围', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'secret', scope: 'group:2', summary: '其他群独有内容' });
    plan(runtime, 'private:123', 'private');
    const operation = runtime.claimOperation();
    runtime.recordReceipt(operation.id, receipt(operation, { fact: '私聊唯一假数据' }));
    assert.equal(runtime.project('private:123').experiences[0].fact, '私聊唯一假数据');
    for (const scope of ['public', 'group:1', 'group:2', 'private:456']) {
      assert.equal(runtime.project(scope).experiences.length, 0);
      assert.equal(runtime.promptFor(scope).includes('私聊唯一假数据'), false);
    }
    const group = runtime.beginRound({ scope: 'group:2', candidates: [{ id: 'private', kind: 'rest', scope: 'private:123', summary: '私聊候选' }] });
    assert.equal(group.events.length, 1);
    assert.equal(group.candidates.length, 0);
  });
});

test('暂停即时阻止领取和后续执行，真实迟到回执仍可归档到原活动', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open(); runtime.setPaused(false); plan(runtime);
    runtime.setPaused(true);
    assert.equal(runtime.claimOperation(), null);
    runtime.setPaused(false);
    const operation = runtime.claimOperation();
    assert.equal(runtime.mayExecute(operation.id, operation.epoch), true);
    runtime.setPaused(true);
    assert.equal(runtime.mayExecute(operation.id, operation.epoch), false);
    runtime.setPaused(false);
    assert.equal(runtime.mayExecute(operation.id, operation.epoch), false);
    assert.equal(runtime.status().active.status, 'reconciling');
    runtime.setPaused(true);
    runtime.recordReceipt(operation.id, receipt(operation));
    assert.equal(runtime.project('public').experiences.length, 1);
    assert.equal(runtime.status().paused, true);
  });
});

test('完成必须有观察依据，回执重复不会增加经历或覆盖新活动', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open(); runtime.setPaused(false); plan(runtime);
    const operation = runtime.claimOperation();
    assert.throws(() => runtime.recordReceipt(operation.id, receipt(operation, { evidence: [] })));
    const result = receipt(operation);
    runtime.recordReceipt(operation.id, result);
    const next = plan(runtime, 'public', 'new');
    assert.equal(runtime.recordReceipt(operation.id, result).duplicate, true);
    assert.equal(runtime.status().experienceCount, 1);
    assert.equal(runtime.status().active.id, next.result.activityId);
    assert.throws(() => runtime.recordReceipt(operation.id, { ...result, fact: '改写结果' }));
  });
});

test('结果未知占用原活动，重启后不能领取或用旧代次提交完成', async () => {
  await fixture(async ({ open }) => {
    let runtime = await open(); runtime.setPaused(false); plan(runtime);
    const operation = runtime.claimOperation();
    runtime.close(); runtime = await open(); runtime.setPaused(false);
    assert.equal(runtime.status().active.status, 'reconciling');
    assert.equal(runtime.claimOperation(), null);
    assert.throws(() => runtime.recordReceipt(operation.id, receipt(operation)));
    runtime.recordReceipt(operation.id, receipt(operation, { id: 'new-observation', fact: '新截图证实已停止', outcome: 'cancelled' }), { reconcile: true });
    assert.equal(runtime.status().active, null);
    assert.equal(runtime.project('public').experiences[0].outcome, 'cancelled');
  });
});

test('进程在操作后直接退出，恢复不重复执行且保留可核对登记', async () => {
  await fixture(async ({ root, open }) => {
    const script = `import { createCharacterRuntime } from ${JSON.stringify(new URL('./runtime.mjs', import.meta.url).href)};
      const r = await createCharacterRuntime({root: ${JSON.stringify(root)}, config: {enabled: true}});
      r.setPaused(false);
      r.ingestEvent({source:'fixture',sourceId:'crash',scope:'public',summary:'崩溃窗口'});
      const round=r.beginRound({scope:'public',candidates:[{id:'one',kind:'rest',scope:'public',summary:'离线休息'}]});
      r.stageIntent(round.id,{action:'start',candidateId:'one',reason:'离线验证'});
      r.finishRound(round.id,{succeeded:true});
      r.claimOperation();
      process.exit(0);`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: 'pipe' });
    const runtime = await open(); runtime.setPaused(false);
    assert.equal(runtime.status().active.status, 'reconciling');
    assert.equal(runtime.claimOperation(), null);
    assert.equal(runtime.status().experienceCount, 0);
  });
});

test('第二个宿主不能取得相同数据库执行权，关闭后可重新取得', async () => {
  await fixture(async ({ root, open }) => {
    const runtime = await open();
    await assert.rejects(createCharacterRuntime({ root, config: { enabled: true } }), /已有操作者/);
    runtime.close();
    const next = await open();
    assert.equal(next.status().paused, true);
  });
});

test('一致备份可在另一临时目录恢复，经历保留且不继承执行权', async () => {
  await fixture(async ({ root, open }) => {
    const runtime = await open(); runtime.setPaused(false); plan(runtime);
    const operation = runtime.claimOperation(); runtime.recordReceipt(operation.id, receipt(operation));
    const backup = runtime.backup('fixture.sqlite');
    assert.throws(() => runtime.backup('../outside.sqlite'));
    assert.throws(() => runtime.backup('fixture.sqlite'));
    const restoredRoot = path.join(root, 'restored');
    fs.mkdirSync(path.join(restoredRoot, 'state/character'), { recursive: true });
    fs.copyFileSync(backup, path.join(restoredRoot, 'state/character/character.sqlite'));
    const restored = await createCharacterRuntime({ root: restoredRoot, config: { enabled: true } });
    try {
      assert.equal(restored.status().paused, true);
      assert.equal(restored.project('public').experiences[0].fact, '已分析片段的前一分钟');
      assert.equal(restored.ingestEvent({ source: 'fixture', sourceId: 'idle-1', scope: 'public', summary: '一次离线活动机会' }).duplicate, true);
    } finally { restored.close(); }
  });
});

test('提交中数据库失败会回滚事件消费、活动与操作登记', async () => {
  await fixture(async ({ root, open }) => {
    const runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'rollback', scope: 'public', summary: '事务回滚样本' });
    const round = runtime.beginRound({ scope: 'public', candidates: [{ id: 'one', kind: 'rest', scope: 'public', summary: '休息' }] });
    runtime.stageIntent(round.id, { action: 'start', candidateId: 'one', reason: '离线验证' });
    const database = new DatabaseSync(path.join(root, 'state/character/character.sqlite'));
    try {
      database.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'fixture-disk-error'); END");
      assert.throws(() => runtime.finishRound(round.id, { succeeded: true }), /fixture-disk-error/);
      assert.equal(runtime.status().active, null);
      assert.equal(runtime.status().pendingEvents, 1);
      database.exec('DROP TRIGGER fail_operation');
      assert.equal(runtime.finishRound(round.id, { succeeded: true }).committed, true);
      assert.ok(runtime.claimOperation());
    } finally { database.close(); }
  });
});

test('状态版本变化使旧提案失效，不能覆盖当前活动', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open(); runtime.setPaused(false); const first = plan(runtime);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'later', scope: 'public', summary: '后续事件' });
    const round = runtime.beginRound({ scope: 'public' });
    runtime.stageIntent(round.id, { action: 'none', reason: '等待' });
    runtime.claimOperation();
    assert.equal(runtime.finishRound(round.id, { succeeded: true }).committed, false);
    assert.equal(runtime.status().active.id, first.result.activityId);
  });
});

test('只有暂存提案时中断，不会在重启后补造操作', async () => {
  await fixture(async ({ open }) => {
    let runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'staged', scope: 'public', summary: '未提交轮次' });
    const round = runtime.beginRound({ scope: 'public', candidates: [{ id: 'one', kind: 'rest', scope: 'public', summary: '尚未执行的休息' }] });
    runtime.stageIntent(round.id, { action: 'start', candidateId: 'one', reason: '暂存但未完成' });
    runtime.close(); runtime = await open(); runtime.setPaused(false);
    assert.equal(runtime.claimOperation(), null);
    assert.equal(runtime.status().active, null);
    assert.equal(runtime.status().pendingEvents, 0);
    assert.throws(() => runtime.finishRound(round.id, { succeeded: true }));
  });
});

test('私人活动仅投影无细节占用状态，硬链接数据库拒绝打开', async () => {
  await fixture(async ({ root, open }) => {
    const runtime = await open(); runtime.setPaused(false); plan(runtime, 'private:123');
    assert.deepEqual(runtime.project('group:456').active, { status: 'busy' });
    assert.throws(() => runtime.project('internal'));
    runtime.close();
    fs.linkSync(path.join(root, 'state/character/character.sqlite'), path.join(root, 'outside.sqlite'));
    await assert.rejects(open(), /文件边界/);
  });
});


test('可重试批次失败后等待五秒，旧轮次失效且只在新轮次成功后提交', async () => {
  await fixture(async ({ open, advance }) => {
    const runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'retry', scope: 'public', summary: '重试样本' });
    const candidates = [{ id: 'one', kind: 'rest', scope: 'public', summary: '离线休息' }];
    const round = runtime.beginRound({ scope: 'public', candidates, maxRetries: 2 });
    runtime.stageIntent(round.id, { action: 'start', candidateId: 'one', reason: '只暂存' });
    const failed = runtime.finishRound(round.id, { succeeded: false });
    assert.equal(failed.retryAt, 6000);
    assert.equal(runtime.claimOperation(), null);
    assert.equal(runtime.beginRound({ scope: 'public', candidates }), null);
    assert.throws(() => runtime.stageIntent(round.id, { action: 'none', reason: '迟到提案' }));
    advance(5000);
    const retry = runtime.beginRound({ scope: 'public', candidates });
    assert.equal(retry.attempt, 2);
    assert.deepEqual(retry.events, round.events);
    assert.notEqual(retry.id, round.id);
    runtime.stageIntent(retry.id, { action: 'start', candidateId: 'one', reason: '新轮次选择' });
    assert.equal(runtime.finishRound(retry.id, { succeeded: true }).committed, true);
    assert.ok(runtime.claimOperation());
    assert.equal(runtime.claimOperation(), null);
  });
});


test('重试次数与退避跨重启保存，重启不重新发放尝试次数', async () => {
  await fixture(async ({ open, advance }) => {
    let runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'durable-retry', scope: 'public', summary: '重启样本' });
    const first = runtime.beginRound({ scope: 'public', maxRetries: 2 });
    runtime.finishRound(first.id, { succeeded: false });
    runtime.close(); runtime = await open();
    assert.equal(runtime.status().paused, true); runtime.setPaused(false);
    assert.equal(runtime.beginRound({ scope: 'public' }), null); advance(5000);
    const second = runtime.beginRound({ scope: 'public' }); assert.equal(second.attempt, 2);
    assert.equal(second.batchId, first.batchId);
    runtime.stageIntent(second.id, { action: 'none', reason: '仍未成功结束' });
    runtime.close(); runtime = await open(); runtime.setPaused(false);
    assert.equal(runtime.status().decision.failure, 'interrupted');
    advance(29999); assert.equal(runtime.beginRound({ scope: 'public' }), null); advance(1);
    const third = runtime.beginRound({ scope: 'public' }); assert.equal(third.attempt, 3);
    const last = runtime.finishRound(third.id, { succeeded: false }); assert.equal(last.retryAt, null);
    runtime.close(); runtime = await open(); runtime.setPaused(false); advance(60000);
    assert.equal(runtime.beginRound({ scope: 'public' }), null);
    assert.equal(runtime.status().pendingEvents, 0); assert.equal(runtime.claimOperation(), null);
  });
});

test('进程在暂存后直接退出，只重算未提交批次并拒绝旧轮次', async () => {
  await fixture(async ({ root, open, advance }) => {
    const script = `import { createCharacterRuntime } from ${JSON.stringify(new URL('./runtime.mjs', import.meta.url).href)};
      const r = await createCharacterRuntime({root: ${JSON.stringify(root)}, config: {enabled: true}, now:()=>1000});
      r.setPaused(false);
      r.ingestEvent({source:'fixture',sourceId:'crash-retry',scope:'public',summary:'决策崩溃窗口'});
      const round=r.beginRound({scope:'public',maxRetries:2,candidates:[{id:'one',kind:'rest',scope:'public',summary:'离线休息'}]});
      r.stageIntent(round.id,{action:'start',candidateId:'one',reason:'尚未成功'});
      console.log(round.id); process.exit(0);`;
    const oldId = execFileSync(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const runtime = await open(); runtime.setPaused(false);
    assert.equal(runtime.claimOperation(), null); assert.equal(runtime.status().active, null);
    assert.throws(() => runtime.finishRound(oldId, { succeeded: true })); advance(5000);
    const next = runtime.beginRound({ scope: 'public' }); assert.equal(next.attempt, 2);
    assert.equal(next.events.length, 1); assert.equal(next.candidates.length, 0);
  });
});

test('暂停取消等待重试，版本冲突不重算，内部诊断不进入调度队列', async () => {
  await fixture(async ({ open, advance }) => {
    const runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'internal', scope: 'internal', summary: '内部诊断' });
    assert.deepEqual(runtime.pendingDecisions(), []);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'pause-retry', scope: 'public', summary: '暂停样本' });
    const round = runtime.beginRound({ scope: 'public', maxRetries: 2 });
    runtime.finishRound(round.id, { succeeded: false }); runtime.setPaused(true); runtime.setPaused(false);
    advance(60000); assert.equal(runtime.beginRound({ scope: 'public' }), null);
    plan(runtime);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'version-retry', scope: 'public', summary: '版本样本' });
    const stale = runtime.beginRound({ scope: 'public', maxRetries: 2 });
    runtime.stageIntent(stale.id, { action: 'none', reason: '等待' }); runtime.claimOperation();
    assert.equal(runtime.finishRound(stale.id, { succeeded: true }).reason, 'version-conflict');
    assert.equal(runtime.beginRound({ scope: 'public' }), null);
  });
});

test('重试仅重算原批次，新事件留到后续，候选按当前授权重新过滤', async () => {
  await fixture(async ({ open, advance }) => {
    const runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'batch-old', scope: 'group:1', summary: '旧批次' });
    const first = runtime.beginRound({ scope: 'group:1', maxRetries: 2 }); runtime.finishRound(first.id, { succeeded: false });
    runtime.ingestEvent({ source: 'fixture', sourceId: 'batch-new', scope: 'group:1', summary: '新事件' }); advance(5000);
    const retry = runtime.beginRound({ scope: 'group:1', candidates: [{ id: 'hidden', kind: 'rest', scope: 'private:2', summary: '私聊候选' }] });
    assert.deepEqual(retry.events, first.events); assert.deepEqual(retry.candidates, []);
    runtime.stageIntent(retry.id, { action: 'none', reason: '无候选' }); runtime.finishRound(retry.id, { succeeded: true });
    assert.equal(runtime.beginRound({ scope: 'group:1' }).events[0].summary, '新事件');
  });
});

test('v1 数据库升级先保留一致快照，经历及旧批次保留并继续暂停', async () => {
  await fixture(async ({ root, open }) => {
    let runtime = await open(); runtime.setPaused(false); plan(runtime);
    const operation = runtime.claimOperation(); runtime.recordReceipt(operation.id, receipt(operation)); runtime.close();
    const file = path.join(root, 'state/character/character.sqlite');
    const legacy = new DatabaseSync(file);
    try {
      for (const table of ['android_steps','android_jobs','life_attempts','life_appraisals','life_memories','life_invalidations','life_mutations','life_origins','life_sessions','life_observations']) legacy.exec('DROP TABLE ' + table);
      legacy.exec('ALTER TABLE rounds DROP COLUMN memory_version');
      legacy.exec('ALTER TABLE rounds DROP COLUMN source_ids');
      for (const column of ['batch_id', 'attempt', 'retry_limit', 'retry_at', 'failure']) legacy.exec('ALTER TABLE rounds DROP COLUMN ' + column);
      legacy.exec('PRAGMA user_version=1');
    } finally { legacy.close(); }
    runtime = await open();
    assert.equal(runtime.status().paused, true); assert.equal(runtime.status().experienceCount, 1);
    const backups = fs.readdirSync(path.join(root, 'state/character/backups'));
    assert.equal(backups.length, 1); assert.match(backups[0], /^migration-v1-/);
    const backup = new DatabaseSync(path.join(root, 'state/character/backups', backups[0]));
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(backup.prepare('SELECT count(*) AS n FROM experiences').get().n, 1);
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key='owner'").get().value, '');
    } finally { backup.close(); }
    runtime.close(); runtime = await open();
    assert.equal(fs.readdirSync(path.join(root, 'state/character/backups')).length, 1);
    assert.equal(runtime.project('public').experiences[0].fact, '已分析片段的前一分钟');
  });
});


test('启动已暂停时再次明确暂停，取消保留的重试而非等待下次解除', async () => {
  await fixture(async ({ open, advance }) => {
    let runtime = await open(); runtime.setPaused(false);
    runtime.ingestEvent({ source: 'fixture', sourceId: 'explicit-pause', scope: 'public', summary: '显式暂停样本' });
    const round = runtime.beginRound({ scope: 'public', maxRetries: 2 }); runtime.finishRound(round.id, { succeeded: false });
    runtime.close(); runtime = await open(); assert.equal(runtime.status().paused, true);
    runtime.setPaused(true); runtime.setPaused(false); advance(60000);
    assert.equal(runtime.beginRound({ scope: 'public' }), null); assert.equal(runtime.status().decision.failure, 'cancelled');
  });
});


test('旧库迁移失败回滚所有结构变更，保留原库与迁移前快照', async () => {
  await fixture(async ({ root, open }) => {
    const runtime = await open(); runtime.close();
    const file = path.join(root, 'state/character/character.sqlite');
    const legacy = new DatabaseSync(file);
    try {
      for (const column of ['batch_id', 'attempt', 'retry_limit', 'retry_at']) legacy.exec('ALTER TABLE rounds DROP COLUMN ' + column);
      // 留下冲突字段，让迁移在部分 ALTER 之后失败，检查事务没有留下半套结构。
      legacy.exec('PRAGMA user_version=1');
    } finally { legacy.close(); }
    await assert.rejects(open(), /duplicate column/);
    const unchanged = new DatabaseSync(file);
    try {
      assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(unchanged.prepare('PRAGMA table_info(rounds)').all().some(column => column.name === 'batch_id'), false);
      assert.equal(unchanged.prepare("SELECT value FROM meta WHERE key='owner'").get().value, '');
    } finally { unchanged.close(); }
    assert.equal(fs.readdirSync(path.join(root, 'state/character/backups')).length, 1);
  });
});
