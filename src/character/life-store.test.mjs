import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCharacterRuntime } from './runtime.mjs';
import { normalizeCharacterConfig } from './policy.mjs';

const autonomy = { enabled: true, timezone: 'Asia/Shanghai', activeHours: [{ start: '08:00', end: '23:00' }],
  idleMs: 60000, dailyDecisions: 2, dailyTokens: 200, dailyCostMicros: 100, roundTokens: 100, roundCostMicros: 50 };
const event = (id, scope = 'public') => ({ source: 'fixture', sourceId: id, scope, summary: '来源 ' + id });
async function fixture(fn, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-life-store-'));
  let now = Date.parse('2026-10-21T04:00:00Z');
  let runtime;
  const open = async (extra = {}) => { runtime = await createCharacterRuntime({ root, config: { enabled: true, ...config, ...extra }, now: () => now }); return runtime; };
  try { await fn({ root, open, advance(ms) { now += ms; }, setNow(at) { now = at; } }); }
  finally { runtime?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
function round(runtime, id, scope = 'public', extra = {}) { runtime.ingestEvent(event(id, scope)); return runtime.beginRound({ scope, ...extra }); }
function experience(runtime, scope = 'public', fact = '实际观察的假片段') {
  const batch = round(runtime, fact, scope, { candidates: [{ id: 'one', kind: 'bilibili', scope: 'public', summary: '假候选' }] });
  runtime.stageIntent(batch.id, { action: 'start', candidateId: 'one', reason: '离线建立实际回执' }); runtime.finishRound(batch.id, { succeeded: true });
  const operation = runtime.claimOperation();
  runtime.recordReceipt(operation.id, { id: 'receipt-' + operation.id, epoch: operation.epoch, outcome: 'completed', fact, evidence: ['fixture-observation'] });
  return runtime.experiences(scope)[0].id;
}
function reflect(runtime, sourceId, id = 'reflect', scope = 'public') {
  const batch = round(runtime, id, scope);
  runtime.stageIntent(batch.id, { action: 'none', reason: '整理感受', appraisals: [{ sourceId, mood: { valence: 5, energy: -2 }, interests: [{ topic: '假主题', delta: 2 }], reason: '来源支持的感想' }],
    memory: { sourceIds: [sourceId], reflection: '想继续了解这段内容' } });
  runtime.finishRound(batch.id, { succeeded: true });
}

test('自主默认关闭，启用必须显式提供作息和额度，未知字段及越界值拒绝', () => {
  assert.equal(normalizeCharacterConfig().autonomy.enabled, false);
  assert.throws(() => normalizeCharacterConfig({ autonomy: { enabled: true } }));
  assert.throws(() => normalizeCharacterConfig({ autonomy: { ...autonomy, dailyTokens: -1 } }));
  assert.throws(() => normalizeCharacterConfig({ autonomy: { ...autonomy, timezone: 'Invalid/Zone' } }));
  assert.throws(() => normalizeCharacterConfig({ autonomy: { ...autonomy, activeHours: [{ start: '25:00', end: '08:00' }] } }));
  assert.throws(() => normalizeCharacterConfig({ interestSeeds: [{ topic: '种子', scope: 'public', score: 30 }] }));
});

test('每次尝试先原子预留，失败及重试计入日限额，最后一次已预留的成功仍可提交', async () => {
  await fixture(async ({ open, advance }) => {
    const runtime = await open(); runtime.setPaused(false);
    const first = round(runtime, 'quota', 'public', { autonomous: true, maxRetries: 2 });
    assert.equal(runtime.status().budget.attempts, 1); runtime.finishRound(first.id, { succeeded: false });
    advance(5000);
    const second = runtime.beginRound({ scope: 'public', autonomous: true });
    assert.equal(runtime.status().budget.attempts, 2); assert.equal(runtime.canDecide(), false);
    assert.equal(runtime.canContinueDecision(second.id), true);
    runtime.stageIntent(second.id, { action: 'none', reason: '最后一次有效预留' }); runtime.settleDecision(second.id, 10);
    assert.equal(runtime.finishRound(second.id, { succeeded: true }).committed, true);
    runtime.ingestEvent(event('exhausted'));
    assert.throws(() => runtime.beginRound({ scope: 'public', autonomous: true }), /额度/);
    assert.equal(runtime.status().pendingEvents, 1); assert.equal(runtime.status().budget.reservedTokens, 200);
  }, { autonomy });
});

test('额度跨重启保存、时钟回拨不重发，切换时区拒绝新增额度，作息关闭时不决策', async () => {
  await fixture(async ({ open, advance, setNow }) => {
    let runtime = await open(); runtime.setPaused(false);
    const first = round(runtime, 'durable-quota', 'public', { autonomous: true }); runtime.finishRound(first.id, { succeeded: false });
    runtime.close(); runtime = await open(); runtime.setPaused(false);
    assert.equal(runtime.status().budget.attempts, 1); assert.equal(runtime.status().budget.unknown, 1);
    setNow(Date.parse('2026-10-20T04:00:00Z')); assert.equal(runtime.status().budget.day, '2026-10-21');
    runtime.close(); runtime = await open({ autonomy: { ...autonomy, timezone: 'UTC' } }); runtime.setPaused(false);
    assert.equal(runtime.status().budget.timezoneChanged, true); assert.equal(runtime.canDecide(), false);
    runtime.close(); runtime = await open(); runtime.setPaused(false);
    setNow(Date.parse('2026-10-21T16:00:00Z')); assert.equal(runtime.status().budget.awake, false); assert.equal(runtime.canDecide(), false);
    advance(12 * 3600000); assert.equal(runtime.status().budget.attempts, 0); assert.equal(runtime.canDecide(), true);
  }, { autonomy });
});

test('有来源的情绪、精力和兴趣一次生效，跨重启按真实时间衰减且范围不扩大', async () => {
  await fixture(async ({ open, advance }) => {
    let runtime = await open(); runtime.setPaused(false);
    const sourceId = experience(runtime, 'private:123'); reflect(runtime, sourceId, 'one', 'private:123');
    assert.equal(runtime.project('private:123').psychology.mood.valence, 55);
    assert.equal(runtime.project('group:456').psychology.mood.valence, 50);
    assert.equal(runtime.project('group:456').psychology.interests.length, 0);
    reflect(runtime, sourceId, 'two', 'private:123'); assert.equal(runtime.project('private:123').psychology.mood.valence, 55);
    assert.equal(runtime.memories('private:123').length, 1); assert.equal(runtime.memories('group:456').length, 0);
    assert.equal(runtime.memories('private:123')[0].fact, '实际观察的假片段');
    runtime.close(); advance(6 * 3600000); runtime = await open();
    assert.equal(runtime.project('private:123').psychology.mood.valence, 52.5);
    assert.equal(runtime.project('private:123').psychology.mood.energy, 69);
  });
});

test('不存在、其他范围、幅度超限的感受及仅凭聊天修改兴趣都拒绝', async () => {
  await fixture(async ({ open }) => {
    const runtime = await open(); runtime.setPaused(false); const hidden = experience(runtime, 'private:123');
    const batch = round(runtime, 'invalid', 'group:456');
    const proposal = { action: 'none', reason: '假提案', appraisals: [{ sourceId: batch.events[0].id, reason: '假感受', mood: { valence: 6 } }] };
    assert.throws(() => runtime.stageIntent(batch.id, proposal));
    assert.throws(() => runtime.stageIntent(batch.id, { ...proposal, appraisals: [{ sourceId: hidden, reason: '跨范围', mood: {} }] }));
    assert.throws(() => runtime.stageIntent(batch.id, { ...proposal, appraisals: [{ sourceId: batch.events[0].id, reason: '仅聊天无实际经历', interests: [{ topic: '无依据', delta: 1 }] }] }));
    assert.throws(() => runtime.stageIntent(batch.id, { action: 'none', reason: '跨范围整理', memory: { sourceIds: [hidden], reflection: '不允许' } }));
    assert.equal(runtime.project('group:456').psychology.mood.valence, 50);
  });
});

test('更正失效摘要和感受，删除清理回执正文、输入归档及托管备份，保留无正文清单', async () => {
  await fixture(async ({ root, open }) => {
    const runtime = await open(); runtime.setPaused(false); const id = experience(runtime, 'public', '错误事实标记'); reflect(runtime, id);
    runtime.backup('before.sqlite');
    const correction = runtime.mutateExperience(id, { fact: '更正后的事实', feeling: '更正感想', evidence: ['new-observation'] });
    assert.equal(correction.memoryVersion, 1); assert.equal(runtime.memories('public').length, 0);
    assert.equal(runtime.project('public').psychology.mood.valence, 50);
    assert.equal(runtime.experiences('public')[0].fact, '更正后的事实');
    assert.equal(fs.readdirSync(path.join(root, 'state/character/backups')).length, 0);
    runtime.acknowledgeInvalidation('public', 1); runtime.mutateExperience(id);
    assert.equal(runtime.experiences('public').length, 0); assert.equal(runtime.memoryVersion(), 2);
    const journal = fs.readFileSync(path.join(root, 'state/character/memory-mutations.json'), 'utf8');
    assert.equal(journal.includes('错误事实标记'), false); assert.equal(journal.includes('更正后的事实'), false);
    const database = new DatabaseSync(path.join(root, 'state/character/character.sqlite'));
    try {
      assert.equal(database.prepare('SELECT count(*) AS n FROM receipts').get().n, 0);
      assert.equal(database.prepare('SELECT count(*) AS n FROM rounds WHERE proposal IS NOT NULL').get().n, 0);
      assert.equal(database.prepare("SELECT count(*) AS n FROM events WHERE summary LIKE '%错误事实标记%'").get().n, 0);
    } finally { database.close(); }
  });
});

test('恢复删除前的旧快照仍应用清单，不能让旧私人经历和派生记忆复活', async () => {
  await fixture(async ({ root, open }) => {
    let runtime = await open(); runtime.setPaused(false); const id = experience(runtime, 'private:123', '旧私人事实'); reflect(runtime, id, 'reflection', 'private:123');
    const copy = path.join(root, 'old-copy.sqlite'); fs.copyFileSync(runtime.backup('old.sqlite'), copy);
    runtime.mutateExperience(id); runtime.close();
    fs.copyFileSync(copy, path.join(root, 'state/character/character.sqlite'));
    runtime = await open();
    assert.equal(runtime.project('private:123').experiences.length, 0); assert.equal(runtime.memories('private:123').length, 0);
    assert.equal(runtime.invalidations().length, 1); assert.equal(runtime.status().paused, true);
  });
});

test('备份清理失败阻止读取，重启继续清理并保留上下文失效任务', async () => {
  await fixture(async ({ root, open }) => {
    let runtime = await open(); runtime.setPaused(false); const id = experience(runtime);
    runtime.backup('blocked.sqlite'); const blocked = path.join(root, 'state/character/backups/unexpected.txt'); fs.writeFileSync(blocked, 'fixture');
    assert.throws(() => runtime.mutateExperience(id)); assert.throws(() => runtime.project('public'), /清理未完成/);
    runtime.close(); fs.unlinkSync(blocked); runtime = await open();
    assert.equal(runtime.experiences('public').length, 0); assert.equal(runtime.invalidations().length, 1);
    assert.equal(fs.readdirSync(path.join(root, 'state/character/backups')).length, 0);
  });
});


test('空闲到期只产生一次关注事件，重启不补跑错过的间隔，空闲本身不能制造感受', async () => {
  await fixture(async ({ open, advance }) => {
    let runtime=await open();runtime.setPaused(false);assert.equal(runtime.idleEvent(),null);advance(60000);
    const idle=runtime.idleEvent();assert.ok(idle);assert.equal(runtime.idleEvent(),null);
    runtime.ingestEvent(idle);const batch=runtime.beginRound({scope:'public'});
    assert.throws(()=>runtime.stageIntent(batch.id,{action:'none',reason:'空闲不是经历',appraisals:[{sourceId:batch.events[0].id,mood:{valence:1},reason:'无实际依据'}]}));
    runtime.close();advance(3600000);runtime=await open();runtime.setPaused(false);assert.equal(runtime.idleEvent(),null);
  },{autonomy});
});

test('轮次只可引用本轮提供的经历集合，不能猜旧编号绕过快照边界', async () => {
  await fixture(async ({open})=>{
    const runtime=await open();runtime.setPaused(false);const old=experience(runtime,'public','older-source');
    for(let i=0;i<3;i++)experience(runtime,'public','newer-source-'+i);
    const batch=round(runtime,'captured-sources');
    assert.throws(()=>runtime.stageIntent(batch.id,{action:'none',reason:'不能借旧编号追加来源',memory:{sourceIds:[old],reflection:'不在本轮快照'}}));
  });
});

test('v2 到 v3 升级保留经历并先快照，待停止会话跨重启保留', async () => {
  await fixture(async ({root,open})=>{
    let runtime=await open();runtime.setPaused(false);experience(runtime);runtime.close();
    const file=path.join(root,'state/character/character.sqlite');const old=new DatabaseSync(file);
    try{for(const table of ['android_steps','android_jobs','life_attempts','life_appraisals','life_memories','life_invalidations','life_mutations','life_origins','life_sessions','life_observations'])old.exec('DROP TABLE '+table);
      old.exec('ALTER TABLE rounds DROP COLUMN memory_version; ALTER TABLE rounds DROP COLUMN source_ids; PRAGMA user_version=2');}finally{old.close();}
    runtime=await open();assert.equal(runtime.status().experienceCount,1);
    assert.ok(fs.readdirSync(path.join(root,'state/character/backups')).some(name=>name.startsWith('migration-v2-')));
    runtime.trackDecisionSession('fixture-pending-session','fixture-round','public');runtime.close();runtime=await open();
    assert.equal(runtime.decisionSessions()[0].id,'fixture-pending-session');
  });
});


test('真实来信观察去重、保留陈述来源，事件和经历不能重复刺激，聊天兴趣只允许慢变',async()=>{
  await fixture(async({open})=>{
    const runtime=await open();runtime.setPaused(false);
    const input={sourceId:'private:123:99',scope:'private:123',summary:'最近喜欢聊假主题'};
    const first=runtime.recordConversationEvent(input);const version=runtime.status().version;
    for(let i=0;i<10;i++)assert.equal(runtime.recordConversationEvent(input).duplicate,true);
    assert.equal(runtime.status().experienceCount,1);assert.equal(runtime.status().version,version);
    const source=runtime.experiences('private:123')[0];assert.ok(source.fact.includes('仅证明对方这样说'));
    const batch=runtime.beginRound({scope:'private:123'});
    assert.throws(()=>runtime.stageIntent(batch.id,{action:'none',reason:'重复刺激',appraisals:[
      {sourceId:first.id,mood:{valence:1},reason:'同一来信'},{sourceId:source.id,mood:{valence:1},reason:'还是同一来信'}]}));
    assert.throws(()=>runtime.stageIntent(batch.id,{action:'none',reason:'过快变化',appraisals:[{sourceId:source.id,reason:'聊天',interests:[{topic:'假主题',delta:2}]}]}));
    runtime.stageIntent(batch.id,{action:'none',reason:'根据实际接触整理',appraisals:[{sourceId:source.id,mood:{valence:4},reason:'交流中的感受',interests:[{topic:'假主题',delta:1}]}],memory:{sourceIds:[source.id],reflection:'记得这次话题'}});
    runtime.finishRound(batch.id,{succeeded:true});
    assert.equal(runtime.project('private:123').psychology.mood.valence,54);
    assert.equal(runtime.memories('private:123').length,1);assert.equal(runtime.memories('group:456').length,0);
  });
});


test('模型不能把本机路径写入可投影的感想、兴趣或整理记忆',async()=>{
  await fixture(async({open})=>{
    const runtime=await open();runtime.setPaused(false);const source=experience(runtime);const batch=round(runtime,'sensitive-reflection');
    const secretPath=['C:', 'Users', 'fixture', 'secret.txt'].join(String.fromCharCode(92));
    assert.throws(()=>runtime.stageIntent(batch.id,{action:'none',reason:'无敏感正文',memory:{sourceIds:[source],reflection:secretPath}}));
    assert.throws(()=>runtime.stageIntent(batch.id,{action:'none',reason:'无敏感正文',appraisals:[{sourceId:source,mood:{valence:1},reason:secretPath}]}));
    assert.equal(runtime.memories('public').length,0);
  });
});


test('删除历史存在时数据库边界校验失败也标记隐私阻断，不能走普通初始化降级',async()=>{
  await fixture(async({root,open})=>{
    const runtime=await open();runtime.setPaused(false);const id=experience(runtime);runtime.mutateExperience(id);runtime.close();
    fs.linkSync(path.join(root,'state/character/character.sqlite'),path.join(root,'linked.sqlite'));
    await assert.rejects(open(),error=>error.code==='CHARACTER_PRIVACY_BLOCKED');
  });
});
