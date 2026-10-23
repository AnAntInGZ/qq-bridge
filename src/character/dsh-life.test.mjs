import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCharacterRuntime } from './runtime.mjs';
import { createLifeDecisionAdapter, stopSessionAndConfirm } from './dsh-life.mjs';
import { createCharacterScheduler } from './scheduler.mjs';
import { registerCharacterTool } from '../../plugins/qq-agent-presets/character-tools.mjs';
import { apply as guard, Config as GuardConfig } from '../../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const success = value => ({ result: { ok: true, value } });
const flush = () => new Promise(resolve=>setImmediate(resolve));
async function fixture(fn, adapterOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-life-'));
  const runtime = await createCharacterRuntime({ root, config: { enabled: true, autonomy: { enabled: true, timezone: 'UTC', activeHours: [{ start: '00:00', end: '00:00' }], dailyDecisions: 1, dailyTokens: 1000, dailyCostMicros: 100, roundTokens: 1000, roundCostMicros: 100 } } });
  runtime.setPaused(false);
  const calls = { create: [], prompt: [], stop: [], archive: [], follows: [], forgotten: [] };
  const api = {
    agentPresets: { list: async ()=>success({ presets: [{ id: 'qq-life' }] }) },
    sessions: { list: async()=>success({ items: calls.create.map(item=>({sessionId:item.sessionId,running:false})) }), create: async params=>{ calls.create.push(params); return success({ sessionId: params.sessionId }); }, prompt: async params=>{ calls.prompt.push(params); return success({}); } },
    workspace: { archiveSession: async ({ sessionId })=>{ calls.archive.push(sessionId); return success({}); } },
    events: { follow: id=>{ calls.follows.push(id); adapter.handleSnapshot(id,{records:[]}); }, forget: id=>calls.forgotten.push(id) },
    stopSessionWork: async id=>{ calls.stop.push(id); },
  };
  const adapter = createLifeDecisionAdapter({ api, runtime, cwd: root, ...adapterOptions });
  let seq=0;
  const send = (type, data, id=calls.create.at(-1)?.sessionId) => adapter.handleEvent(id, { type, seq: ++seq, data });
  try { await fn({ runtime, api, adapter, calls, send }); }
  finally { adapter.close(); runtime.close(); fs.rmSync(root,{recursive:true,force:true}); }
}
function begin(runtime, id='event') {
  runtime.ingestEvent({ source:'fixture',sourceId:id,scope:'public',summary:'离线决策事件' });
  const round=runtime.beginRound({scope:'public',autonomous:true});
  return { ...round, state:runtime.project('public') };
}
async function started(calls) { for(let i=0;i<50&&!calls.prompt.length;i++)await new Promise(resolve=>setTimeout(resolve,1)); assert.equal(calls.prompt.length,1); }
function propose(send,snapshot,intent={action:'none',reason:'受限选择'}) {
  send('turn/start',{turn:'turn-one'});
  send('tool/call',{name:'character_propose',callId:'call-one'});
  send('character/proposal',{roundId:snapshot.id,expectedVersion:snapshot.version,intent});
}

test('生活守卫遮蔽全部继承工具并强制 native，仅允许本轮原生提案工具', async () => {
  let filter, mode, check, tool;
  guard({ tools: { presentAs(value){mode=value;}, restrict(value){filter=value;}, guard(fn){check=fn;} } },{profile:'life'});
  registerCharacterTool({tools:{register(spec){tool=spec;}}},spec=>spec);
  assert.deepEqual(filter,{allow:[]}); assert.equal(mode,'native'); assert.equal(check({name:'character_propose'}),undefined);
  for(const name of ['bash','read','run_code','mcp__snowluma__qq_send_message','mcp__web-search-safe__web_search','new_future_tool',''])assert.equal(typeof check({name}),'string');
  const appended=[]; let concluded=false;
  await tool.execute({roundId:'round',expectedVersion:1,intent:{action:'none',reason:'假选择'}},{agent:{session:{append:(...args)=>appended.push(args)}},concludeTurn(){concluded=true;}});
  assert.equal(appended[0][0],'character/proposal'); assert.equal(concluded,true);
  await assert.rejects(tool.execute({},{concludeTurn(){}}));
  assert.throws(()=>guard({tools:{presentAs(){},restrict(){throw new Error('unsupported');},guard(){}}},{profile:'life'}),/unsupported/);
});

test('仅接受已绑定的一次性会话实时提案，明确成功后才能提交，文本不会成为动作', async () => {
  await fixture(async ({runtime,adapter,calls,send})=>{
    const snapshot=begin(runtime);const task=adapter.decide({snapshot,stageIntent:intent=>runtime.stageIntent(snapshot.id,intent),signal:new AbortController().signal});
    await started(calls);assert.equal(calls.create[0].agentPreset,'qq-life');assert.equal(runtime.decisionSessions().length,1);
    assert.equal(send('character/proposal',{roundId:snapshot.id,expectedVersion:snapshot.version,intent:{action:'none',reason:'伪造'}},'other-session'),false);
    propose(send,snapshot);assert.equal(runtime.status().decision.status,'open');assert.equal(runtime.status().active,null);
    send('assistant/message',{turn:'turn-one',step:0,usage:{inputTokens:100,outputTokens:10},message:{content:[{type:'text',text:'这段文本不是执行指令'}]}});
    send('turn/end',{turn:'turn-one',reason:{kind:'completed'}});
    const result=await task;assert.equal(result.succeeded,true);assert.equal(result.usageTokens,110);
    assert.equal(runtime.finishRound(snapshot.id,{succeeded:result.succeeded}).committed,true);
    assert.equal(calls.stop.length,1);assert.equal(calls.archive.length,1);assert.equal(runtime.decisionSessions().length,0);
    assert.equal(runtime.status().active,null);
  });
});

test('真机 DSH 的回合号是数字，同样能走完一次提案而不是被立刻判无效', async () => {
  await fixture(async ({runtime,adapter,calls,send})=>{
    const snapshot=begin(runtime);
    const task=adapter.decide({snapshot,stageIntent:intent=>runtime.stageIntent(snapshot.id,intent),signal:new AbortController().signal});
    await started(calls);
    // 数值回合号是实际 DSH 的输出形态：此前按字符串校验，导致回合刚起就被中断。
    send('turn/start',{turn:1});
    send('tool/call',{name:'character_propose',callId:'call-one'});
    send('character/proposal',{roundId:snapshot.id,expectedVersion:snapshot.version,intent:{action:'none',reason:'受限选择'}});
    send('turn/end',{turn:1,reason:{kind:'completed'}});
    const result=await task;
    assert.equal(result.succeeded,true);
  });
});
test('预设缺失拒绝创建，不回退默认完整工具', async () => {
  await fixture(async ({runtime,api,adapter,calls})=>{
    api.agentPresets.list=async()=>success({presets:[{id:'standard'}]});const snapshot=begin(runtime);
    await assert.rejects(adapter.decide({snapshot,stageIntent(){},signal:new AbortController().signal}),/预设不可用/);
    assert.equal(calls.create.length,0);
  });
});

test('错误轮次、重复冲突和非成功结束均不提交已暂存的提案', async () => {
  for(const kind of ['stale','conflict','error'])await fixture(async ({runtime,adapter,calls,send})=>{
    const snapshot=begin(runtime);const task=adapter.decide({snapshot,stageIntent:intent=>runtime.stageIntent(snapshot.id,intent),signal:new AbortController().signal});await started(calls);
    propose(send,kind==='stale'?{...snapshot,id:'old-round'}:snapshot);
    if(kind==='conflict')send('character/proposal',{roundId:snapshot.id,expectedVersion:snapshot.version,intent:{action:'none',reason:'不同选择'}});
    send('turn/end',{turn:'turn-one',reason:{kind:kind==='error'?'error':'completed'}});
    const result=await task;assert.equal(result.succeeded,false);runtime.finishRound(snapshot.id,{succeeded:false});assert.equal(runtime.status().active,null);
  });
});

test('中止和断连撤销提案，旧完成回执不复活，停止未确认阻断新决策', async () => {
  await fixture(async ({runtime,api,adapter,calls,send})=>{
    const snapshot=begin(runtime);const controller=new AbortController();
    const task=adapter.decide({snapshot,stageIntent:intent=>runtime.stageIntent(snapshot.id,intent),signal:controller.signal});await started(calls);propose(send,snapshot);
    api.stopSessionWork=async()=>{throw new Error('fixture-stop-failed');};controller.abort();
    const result=await task;assert.equal(result.succeeded,false);assert.equal(adapter.status().fault,'session-stop-unconfirmed');assert.equal(runtime.decisionSessions().length,1);
    send('turn/end',{turn:'turn-one',reason:{kind:'completed'}});assert.equal(runtime.status().decision.status,'open');
    await assert.rejects(adapter.decide({snapshot,stageIntent(){},signal:new AbortController().signal}),/不可用/);
    runtime.finishRound(snapshot.id,{succeeded:false});assert.equal(runtime.status().active,null);
  });
});

test('生产调度使用额度预留，最后一个配额仍可成功提交并结算，不额外调用模型', async () => {
  await fixture(async ({runtime,adapter,calls,send})=>{
    const scheduler=createCharacterScheduler({runtime,decide:input=>adapter.decide(input),autonomous:true,mergeMs:0,
      canDecide:(_scope,phase)=>phase?.phase==='commit'?runtime.canContinueDecision(phase.roundId):runtime.canDecide()});
    try{
      scheduler.notify({source:'fixture',sourceId:'scheduler',scope:'public',summary:'假活动机会'});await started(calls);
      const snapshot=JSON.parse(calls.prompt[0].content[0].text.split('\n').at(-1));propose(send,snapshot);
      send('assistant/message',{turn:'turn-one',step:0,usage:{inputTokens:20,outputTokens:10},message:{content:[]}});
      send('turn/end',{turn:'turn-one',reason:{kind:'completed'}});await scheduler.settled();await flush();
      assert.equal(runtime.status().decision.status,'committed');assert.equal(runtime.status().budget.attempts,1);assert.equal(runtime.canDecide(),false);
      scheduler.notify();await flush();assert.equal(calls.prompt.length,1);
    }finally{scheduler.close();await scheduler.settled();}
  });
});


test('用量超出单轮预留时停止，不把未知价格记为零；已知模型只给出估价',async()=>{
  await fixture(async({runtime,adapter,calls,send})=>{
    const snapshot=begin(runtime);const task=adapter.decide({snapshot,stageIntent(){},signal:new AbortController().signal});await started(calls);
    send('turn/start',{turn:'turn-one'});
    send('assistant/message',{turn:'turn-one',step:0,provider:'deepseek',usage:{model:'deepseek-flash',inputTokens:100,outputTokens:10},message:{content:[]}});
    const result=await task;assert.equal(result.succeeded,false);assert.equal(result.usageTokens,110);assert.ok(result.usageCostMicros>0);assert.equal(calls.stop.length,1);
  },{limits:{roundTokens:50,roundCostMicros:1000000}});
});


test('当前轮次作息或准入失效时只取消本批，正常作息可再关注，用户暂停仍保持独立',async()=>{
  await fixture(async({runtime,adapter,calls,send})=>{
    let commitAllowed=true;
    const scheduler=createCharacterScheduler({runtime,decide:input=>adapter.decide(input),autonomous:true,mergeMs:0,
      canDecide:(_scope,phase)=>phase?.phase==='commit'?commitAllowed&&runtime.canContinueDecision(phase.roundId):runtime.canDecide()});
    try{
      scheduler.notify({source:'fixture',sourceId:'quiet-boundary',scope:'public',summary:'作息边界'});await started(calls);
      const snapshot=JSON.parse(calls.prompt[0].content[0].text.split('\n').at(-1));propose(send,snapshot);commitAllowed=false;
      send('turn/end',{turn:'turn-one',reason:{kind:'completed'}});await scheduler.settled();
      assert.equal(runtime.status().decision.failure,'cancelled');assert.equal(runtime.status().paused,false);
      scheduler.setPaused(true);assert.equal(runtime.status().paused,true);
    }finally{scheduler.close();await scheduler.settled();}
  });
});


test('取消受理不等于已退出，必须观察 running=false，缺少退出证据时保持拒绝',async()=>{
  let reads=0;
  const api={stopSessionWork:async()=>({removed:0}),sessions:{list:async()=>success({items:[{sessionId:'fixture',running:++reads===1}]})}};
  await stopSessionAndConfirm(api,'fixture',{timeoutMs:1000});assert.equal(reads,2);
  api.sessions.list=async()=>success({items:[{sessionId:'fixture',running:true}]});
  await assert.rejects(stopSessionAndConfirm(api,'fixture',{timeoutMs:20}));
});


test('事件订阅确认前不投递模型，历史提案快照不能作为新轮次输入或结束回执',async()=>{
  await fixture(async({runtime,api,adapter,calls})=>{
    api.events.follow=id=>calls.follows.push(id);const snapshot=begin(runtime);
    const task=adapter.decide({snapshot,stageIntent(){throw new Error('历史不应暂存');},signal:new AbortController().signal});
    for(let i=0;i<20&&!calls.follows.length;i++)await flush();assert.equal(calls.prompt.length,0);
    adapter.handleSnapshot(calls.create[0].sessionId,{records:[{type:'character/proposal',data:{roundId:snapshot.id}}]});
    const result=await task;assert.equal(result.succeeded,false);assert.equal(calls.prompt.length,0);
  });
});


test('配置默认值保持两代 QQ 聊天守卫可挂载，仍拒绝本地工具', () => {
  let check;
  const hidden = [];
  const tools = { restrict(value) { hidden.push(value); }, guard(fn) { check = fn; } };
  const config = GuardConfig({});
  assert.equal(config.profile, 'chat');
  assert.doesNotThrow(() => guard({ tools }, config));
  assert.ok(hidden.length);
  assert.equal(check({ name: 'todo_write' }), undefined);
  assert.equal(typeof check({ name: 'bash' }), 'string');
  assert.throws(() => guard({ tools }, { profile: 'unknown' }), /未知/);
});
