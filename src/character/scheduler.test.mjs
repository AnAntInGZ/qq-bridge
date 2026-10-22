import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCharacterRuntime } from './runtime.mjs';
import { createCharacterScheduler } from './scheduler.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const event = (id, scope = 'public') => ({ source: 'fixture', sourceId: id, scope, summary: '假活动机会 ' + id });
const candidate = { id: 'rest', kind: 'rest', scope: 'public', summary: '离线休息' };

async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-scheduler-'));
  let now = 1000;
  let sequence = 0;
  const tasks = new Map();
  const timers = {
    setTimeout(fn, delay) { const id = ++sequence; tasks.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { tasks.delete(id); },
  };
  const runtime = await createCharacterRuntime({ root, config: { enabled: true }, now: () => now });
  runtime.setPaused(false);
  const schedulers = [];
  const create = overrides => {
    const scheduler = createCharacterScheduler({ runtime, now: () => now, timers,
      canDecide: () => true, candidates: () => [candidate], ...overrides });
    schedulers.push(scheduler);
    return scheduler;
  };
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; tasks.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  };
  try { await fn({ runtime, create, advance, tasks }); }
  finally {
    for (const scheduler of schedulers) scheduler.close();
    runtime.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}

test('无事件不调用决策器，同范围事件两秒合批且暂存期间不能领取操作', async () => {
  await fixture(async ({ runtime, create, advance, tasks }) => {
    const snapshots = [];
    const scheduler = create({ decide: async ({ snapshot, stageIntent }) => {
      snapshots.push(snapshot);
      stageIntent({ action: 'start', candidateId: 'rest', reason: '假选择' });
      assert.equal(runtime.claimOperation(), null);
      return { succeeded: true };
    } });
    scheduler.notify(); await advance(60000); assert.equal(snapshots.length, 0); assert.equal(tasks.size, 0);
    const input = event('one'); scheduler.notify(input);
    for (let i = 0; i < 10; i++) scheduler.notify(input);
    await advance(1000); scheduler.notify(event('two')); await advance(999);
    assert.equal(snapshots.length, 0); await advance(1);
    assert.equal(snapshots.length, 1); assert.equal(snapshots[0].events.length, 2);
    assert.ok(runtime.claimOperation()); assert.equal(runtime.claimOperation(), null);
    assert.equal(tasks.size, 0);
  });
});

test('不同群事件分轮，单决策运行且派生活动保留原群范围', async () => {
  await fixture(async ({ runtime, create, advance }) => {
    let release; const snapshots = [];
    const scheduler = create({ decide: async ({ snapshot, stageIntent }) => {
      snapshots.push(snapshot);
      if (snapshots.length === 1) await new Promise(resolve => { release = resolve; });
      stageIntent({ action: 'start', candidateId: 'rest', reason: '假选择' });
      return { succeeded: true };
    } });
    scheduler.notify(event('a', 'group:1')); scheduler.notify(event('b', 'group:2'));
    await advance(2000); assert.equal(snapshots.length, 1);
    await advance(2000); assert.equal(snapshots.length, 1);
    release(); await flush(); await advance(2000);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].scope, 'group:1'); assert.equal(snapshots[1].scope, 'group:2');
    assert.equal(snapshots[1].events.some(item => item.summary.includes(' a')), false);
    assert.deepEqual(snapshots[1].state.active, { status: 'busy' });
    assert.equal(runtime.status().active.scope, 'group:1');
    assert.equal(runtime.status().decision.failure, 'activity-busy');
  });
});

test('失败仅重试两次，五秒及三十秒退避后耗尽，不因通知或重复事件重开', async () => {
  await fixture(async ({ runtime, create, advance, tasks }) => {
    const attempts = [];
    const scheduler = create({ decide: async ({ snapshot }) => { attempts.push(snapshot.attempt); throw new Error('假错误正文不入库'); } });
    const input = event('fail'); scheduler.notify(input); await advance(2000);
    assert.deepEqual(attempts, [1]); await advance(4999); assert.deepEqual(attempts, [1]);
    await advance(1); assert.deepEqual(attempts, [1, 2]);
    await advance(29999); assert.deepEqual(attempts, [1, 2]); await advance(1);
    assert.deepEqual(attempts, [1, 2, 3]); assert.equal(runtime.status().pendingEvents, 0);
    assert.equal(runtime.status().decision.failure, 'model-error');
    scheduler.notify(input); scheduler.notify(); await advance(600000);
    assert.equal(attempts.length, 3); assert.equal(tasks.size, 0); assert.equal(runtime.status().active, null);
  });
});

test('暂停撤销提案、重试及迟到请求，解除暂停不恢复旧轮次', async () => {
  await fixture(async ({ runtime, create, advance }) => {
    let release; let lateStage; let signal;
    const scheduler = create({ decide: async input => {
      lateStage = input.stageIntent; signal = input.signal;
      lateStage({ action: 'start', candidateId: 'rest', reason: '只暂存' });
      await new Promise(resolve => { release = resolve; }); return { succeeded: true };
    } });
    scheduler.notify(event('pause')); await advance(2000);
    scheduler.setPaused(true); assert.equal(signal.aborted, true);
    assert.throws(() => lateStage({ action: 'none', reason: '迟到请求' }));
    scheduler.setPaused(false); release(); await flush(); await advance(60000);
    assert.equal(runtime.status().active, null); assert.equal(runtime.status().pendingEvents, 0);
    scheduler.close(); assert.throws(() => scheduler.notify(event('closed')));
  });
});

test('超时先失效轮次，适配器未确认返回时不并发重试', async () => {
  await fixture(async ({ runtime, create, advance }) => {
    let release; let lateStage; let signal; let calls = 0;
    const scheduler = create({ roundMs: 10, decide: async input => {
      calls++; lateStage = input.stageIntent; signal = input.signal;
      if (calls === 1) await new Promise(resolve => { release = resolve; });
      return { succeeded: true };
    } });
    scheduler.notify(event('timeout')); await advance(2000); await advance(10);
    assert.equal(signal.aborted, true); assert.equal(runtime.status().decision.failure, 'timeout');
    assert.throws(() => lateStage({ action: 'start', candidateId: 'rest', reason: '迟到提案' }));
    await advance(30000); assert.equal(calls, 1); assert.equal(scheduler.status().inFlight, true);
    release(); await flush(); await advance(2000); assert.equal(calls, 2);
    assert.equal(runtime.status().active, null);
  });
});

test('超过六次工具调用或吞掉无效提案错误的成功回合都不能提交', async () => {
  await fixture(async ({ runtime, create, advance }) => {
    const scheduler = create({ decide: async ({ stageIntent }) => {
      for (let i = 0; i < 7; i++) {
        try { stageIntent({ action: 'start', candidateId: 'rest', reason: '相同提案' }); } catch { /* 模拟适配器吞掉错误。 */ }
      }
      return { succeeded: true };
    } });
    scheduler.notify(event('limit')); await advance(2000);
    assert.equal(runtime.status().active, null); assert.equal(runtime.status().decision.failure, 'invalid-intent');
  });
});

test('宿主拒绝准入时不轮询，执行期间撤权使提案作废并暂停', async () => {
  await fixture(async ({ runtime, create, advance, tasks }) => {
    let allowed = false; let calls = 0; let release;
    const scheduler = create({ canDecide: () => allowed, decide: async ({ stageIntent }) => {
      calls++; stageIntent({ action: 'start', candidateId: 'rest', reason: '假选择' });
      await new Promise(resolve => { release = resolve; }); return { succeeded: true };
    } });
    scheduler.notify(event('policy')); await advance(60000); assert.equal(calls, 0); assert.equal(tasks.size, 0);
    allowed = true; scheduler.notify(); await advance(2000); allowed = false;
    release(); await flush(); assert.equal(runtime.status().paused, true); assert.equal(runtime.status().active, null);
  });
});

test('关闭调度器撤销旧提案并保留有限重试，重新创建后仅新轮次可提交', async () => {
  await fixture(async ({ runtime, create, advance }) => {
    let release; let oldStage;
    const first = create({ decide: async ({ stageIntent }) => {
      oldStage = stageIntent; stageIntent({ action: 'start', candidateId: 'rest', reason: '旧选择' });
      await new Promise(resolve => { release = resolve; }); return { succeeded: true };
    } });
    first.notify(event('restart')); await advance(2000); first.close(); release(); await flush();
    assert.throws(() => oldStage({ action: 'none', reason: '旧请求' })); assert.equal(runtime.status().active, null);
    const second = create({ decide: async ({ snapshot, stageIntent }) => {
      assert.equal(snapshot.attempt, 2); stageIntent({ action: 'start', candidateId: 'rest', reason: '新选择' }); return { succeeded: true };
    } });
    second.notify(); await advance(5000); assert.equal(runtime.status().active.status, 'planned');
  });
});


test('同一运行时只允许一个调度器，关闭后仍等待旧适配器退出', async () => {
  await fixture(async ({ create, advance }) => {
    let release;
    const first = create({ decide: async () => { await new Promise(resolve => { release = resolve; }); return { succeeded: true }; } });
    assert.throws(() => create({ decide: async () => ({ succeeded: true }) }), /已有决策调度器/);
    first.notify(event('one-scheduler')); await advance(2000); first.close();
    assert.throws(() => create({ decide: async () => ({ succeeded: true }) }), /已有决策调度器/);
    release(); await flush(); assert.doesNotThrow(() => create({ decide: async () => ({ succeeded: true }) }));
  });
});

test('宿主策略异常关闭调度闸门，失败原因不保存异常原文', async () => {
  await fixture(async ({ runtime, create }) => {
    const scheduler = create({ canDecide: () => { throw new Error('假私人错误'); }, decide: async () => ({ succeeded: true }) });
    scheduler.notify(event('fault'));
    assert.equal(scheduler.status().fault, 'storage-or-policy-error'); assert.equal(runtime.status().paused, true);
    assert.throws(() => scheduler.notify());
  });
});


test('其他范围的新事件能提前唤醒，不被三十秒重试定时器拖延', async () => {
  await fixture(async ({ create, advance }) => {
    const scopes = [];
    const scheduler = create({ decide: async ({ snapshot, stageIntent }) => {
      scopes.push(snapshot.scope);
      if (snapshot.scope === 'group:1') return { succeeded: false };
      stageIntent({ action: 'none', reason: '已响应新事件' }); return { succeeded: true };
    } });
    scheduler.notify(event('retry-scope', 'group:1')); await advance(7000);
    assert.deepEqual(scopes, ['group:1', 'group:1']);
    scheduler.notify(event('ready-scope', 'group:2')); await advance(1999);
    assert.equal(scopes.length, 2); await advance(1);
    assert.deepEqual(scopes, ['group:1', 'group:1', 'group:2']);
  });
});


test('事件登记失败立即关闭本地闸门，迟到的成功提案也不能提交', async () => {
  await fixture(async ({ runtime, create, advance }) => {
    let release; let signal;
    const scheduler = create({ decide: async input => {
      signal = input.signal; input.stageIntent({ action: 'start', candidateId: 'rest', reason: '旧提案' });
      await new Promise(resolve => { release = resolve; }); return { succeeded: true };
    } });
    scheduler.notify(event('before-fault')); await advance(2000);
    const original = runtime.ingestEvent;
    runtime.ingestEvent = () => { throw new Error('假磁盘异常'); };
    assert.throws(() => scheduler.notify(event('write-fault')), /事件登记失败/);
    runtime.ingestEvent = original;
    assert.equal(signal.aborted, true); assert.equal(scheduler.status().fault, 'storage-or-policy-error');
    release(); await flush(); assert.equal(runtime.status().active, null);
  });
});

test('暂停落盘失败也先中止本地轮次，不能因数据库状态未更新而提交', async () => {
  await fixture(async ({ runtime, create, advance }) => {
    let release; let signal;
    const scheduler = create({ decide: async input => {
      signal = input.signal; input.stageIntent({ action: 'start', candidateId: 'rest', reason: '旧提案' });
      await new Promise(resolve => { release = resolve; }); return { succeeded: true };
    } });
    scheduler.notify(event('pause-write-fault')); await advance(2000);
    const original = runtime.setPaused;
    runtime.setPaused = () => { throw new Error('假磁盘异常'); };
    assert.throws(() => scheduler.setPaused(true), /暂停状态更新失败/); assert.equal(signal.aborted, true);
    release(); await flush(); assert.equal(runtime.status().active, null);
    assert.equal(scheduler.status().fault, 'storage-or-policy-error');
    runtime.setPaused = original;
  });
});
