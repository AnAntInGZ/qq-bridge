import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createCharacterCoordinator } from '../src/character/coordinator.mjs';

async function fixture(fn, options = {}) {
  const h = await bridgeHarness({ config: { character: { enabled: true } }, ...options });
  try { await fn(h); } finally { await h.close(); }
}

function experience(h, scope, marker) {
  const runtime = h.character;
  runtime.setPaused(false);
  runtime.ingestEvent({ source: 'fixture', sourceId: marker, scope, summary: '离线活动事件' });
  const round = runtime.beginRound({ scope, candidates: [{ id: marker, kind: 'bilibili', scope: 'public', summary: '离线内容' }] });
  runtime.stageIntent(round.id, { action: 'start', candidateId: marker, reason: '离线验证' });
  runtime.finishRound(round.id, { succeeded: true });
  const operation = runtime.claimOperation();
  runtime.recordReceipt(operation.id, { id: marker, epoch: operation.epoch, outcome: 'completed', fact: marker, evidence: ['fixture-video-observation'] });
}

async function serverFixture(h, fn) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, { body, headers = {} } = {}) => {
    const response = await fetch(url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await fn(request); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('默认关闭时不创建角色数据库，旧消息投递不增加角色上下文', async () => {
  await fixture(async h => {
    assert.equal(h.character, null);
    assert.equal(fs.existsSync(path.join(h.temp, 'state/character')), false);
    await h.deliverPrompt('group:456', '原有消息');
    assert.equal(h.calls.prompts.at(-1).content[0].text.includes('有依据的角色近况'), false);
  }, { config: {} });
});

test('真实队列投递按群过滤经历，公开经历可见、私聊经历不可见', async () => {
  await fixture(async h => {
    experience(h, 'private:123', 'private-only-fixture');
    experience(h, 'public', 'public-fixture');
    experience(h, 'group:456', 'group-only-fixture');
    await h.deliverPrompt('group:456', '最近怎么样');
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.ok(prompt.includes('public-fixture'));
    assert.ok(prompt.includes('group-only-fixture'));
    assert.ok(!prompt.includes('private-only-fixture'));
    assert.equal(h.calls.sent.length, 0);
  });
});

test('直接聊天入口也注入本会话近况，聊天重置不删除角色经历', async () => {
  await fixture(async h => {
    experience(h, 'private:123', 'owner-only-fixture');
    h.setMode('closed-agent');
    await h.handleIncoming('private', 123, { user_id: 123, message_id: 1, message: [{ type: 'text', data: { text: '最近怎么样' } }] }, h.cfg);
    assert.ok(h.calls.prompts.at(-1).content[0].text.includes('owner-only-fixture'));
    h.retireSession('private:123');
    assert.equal(h.character.status().experienceCount, 1);
  });
});

test('二代唤醒在实际投递时注入可见经历', async () => {
  await fixture(async h => {
    experience(h, 'public', 'wake-public-fixture');
    experience(h, 'private:123', 'wake-private-fixture');
    h.setMode('reserved2');
    await h.deliverPrompt('group:456', 'placeholder', { wakeReason: 'proactiveCheck' });
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.ok(prompt.includes('wake-public-fixture'));
    assert.ok(!prompt.includes('wake-private-fixture'));
  });
});

test('离线补投读取最新近况，白名单撤销后拒绝投递', async () => {
  await fixture(async h => {
    h.setReady(false);
    await h.deliverPrompt('group:456', '离线消息');
    experience(h, 'public', 'created-while-offline');
    h.setReady(true);
    await h.flushQueue();
    assert.ok(h.calls.prompts.at(-1).content[0].text.includes('created-while-offline'));
    h.cfg.allow.groups = [];
    const before = h.calls.prompts.length;
    await assert.rejects(h.deliverPrompt('group:456', '撤销后的消息'));
    assert.equal(h.calls.prompts.length, before);
  });
});

test('角色 API 只允许管理员，agent 不可读状态或解除暂停', async () => {
  await fixture(async h => {
    await serverFixture(h, async request => {
      const initial = await request('/api/character/status');
      assert.equal(initial.status, 200);
      assert.equal(initial.body.paused, true);
      assert.equal(initial.body.capabilities.autonomousDecision, false);
      assert.equal((await request('/api/character/pause', { body: { paused: false } })).status, 200);
      assert.equal(h.character.status().paused, false);
      const token = h.getSocialV2State('group:456').agentToken;
      for (const headers of [{ 'x-agent-token': token }, { 'x-agent-token': '' }]) {
        assert.equal((await request('/api/character/status', { headers })).status, 403);
        assert.equal((await request('/api/character/pause', { body: { paused: true }, headers })).status, 403);
      }
      assert.equal(h.character.status().paused, false);
      assert.equal((await request('/api/character/status', { headers: { 'x-console-token': '' } })).status, 401);
      assert.equal((await request('/api/character/pause', { body: { paused: 'false' } })).status, 400);
      assert.equal((await request('/api/character/pause', { body: { paused: true, enabled: true } })).status, 400);
      assert.equal((await request('/api/character/pause', { body: { paused: true }, headers: { origin: 'https://fixture.invalid' } })).status, 403);
    });
  });
});

test('存储初始化失败禁用角色模块，原有 QQ 投递继续', async () => {
  await fixture(async h => {
    assert.equal(h.character, null);
    assert.equal(h.characterSnapshot().available, false);
    await h.deliverPrompt('group:456', '继续原有聊天');
    assert.equal(h.calls.prompts.length, 1);
    await serverFixture(h, async request => {
      assert.equal((await request('/api/character/pause', { body: { paused: false } })).status, 409);
    });
  }, { config: { character: { enabled: true } }, globals: { createCharacterRuntime: async () => { throw new Error('fixture database failure'); } } });
});

test('读取近况异常后停用模块，错误正文和私有事实不进入 QQ prompt', async () => {
  await fixture(async h => {
    h.character.promptFor = () => { throw new Error('fixture-private-database-error'); };
    await h.deliverPrompt('group:456', '继续交流');
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.ok(!prompt.includes('fixture-private-database-error'));
    assert.equal(h.characterSnapshot().available, false);
  });
});


test('管理员删除同时失效旧上下文、旧令牌和排队发送，新上下文不再注入旧事实', async () => {
  await fixture(async h => {
    h.setMode('reserved2');
    experience(h, 'public', 'delete-fixture-fact');
    await h.deliverPrompt('group:456', '最近怎么样');
    const oldSession = h.state.sessions['group:456'];
    const oldToken = h.getSocialV2State('group:456').agentToken;
    const id = h.character.experiences('public')[0].id;
    const sending = h.sendToQQ('group:456', 'delete-fixture-fact');
    await h.characterLife.mutateExperience(id); await sending;
    assert.equal(h.calls.sent.some(item => item.text.includes('delete-fixture-fact')), false);
    assert.equal(h.state.sessions['group:456'], undefined);
    assert.ok(h.calls.cancelled.includes(oldSession)); assert.ok(h.calls.archived.includes(oldSession));
    assert.equal(h.character.invalidations().length, 0); assert.equal(h.character.decisionSessions().length, 0);
    await serverFixture(h, async request => {
      assert.equal((await request('/api/character/experiences')).body.data.length, 0);
      assert.equal((await request('/api/socialV2/recent?key=group:456', { headers: { 'x-agent-token': oldToken } })).status, 403);
    });
    await h.deliverPrompt('group:456', '重新问近况');
    assert.equal(h.calls.prompts.at(-1).content[0].text.includes('delete-fixture-fact'), false);
  });
});

test('记忆更正删除 API 保持管理权限，错误参数不会打开执行权限或冻结正常聊天', async () => {
  await fixture(async h => {
    experience(h, 'private:123', 'wrong-fixture-fact'); const id = h.character.experiences('private:123')[0].id;
    await serverFixture(h, async request => {
      const headers = { 'x-agent-token': h.getSocialV2State('group:456').agentToken };
      for (const route of ['/api/character/experiences', '/api/character/memory']) assert.equal((await request(route, { headers })).status, 403);
      for (const route of ['/api/character/experience/delete', '/api/character/experience/correct']) assert.equal((await request(route, { headers, body: { id } })).status, 403);
      assert.equal((await request('/api/character/experience/delete', { body: { id, scope: 'public' } })).status, 400);
      assert.equal((await request('/api/character/experience/correct', { body: { id, replacement: { fact: '缺依据' } } })).status, 409);
      assert.equal(h.characterLife.status().fault, null);
      const corrected = await request('/api/character/experience/correct', { body: { id, replacement: { fact: 'correct-fixture-fact', evidence: ['fixture-new-observation'] } } });
      assert.equal(corrected.status, 200); assert.equal(corrected.body.chatContextsReset, true);
      const records = await request('/api/character/experiences?scope=private:123');
      assert.equal(records.body.data[0].fact, 'correct-fixture-fact');
      assert.equal((await request('/api/character/experiences?scope=group:456')).body.data.length, 0);
    });
  });
});

test('旧上下文停止失败保留待核对登记，拒绝后续读取和发送，不回报删除完成', async () => {
  await fixture(async h => {
    experience(h, 'public', 'stop-failed-fact'); await h.deliverPrompt('group:456', '形成旧上下文');
    const id=h.character.experiences('public')[0].id;
    h.api.stopSessionWork=async()=>{throw new Error('fixture-stop-failed');};
    await assert.rejects(h.characterLife.mutateExperience(id));
    assert.equal(h.character.invalidations().length, 1); assert.equal(h.character.decisionSessions().length, 1);
    assert.equal(h.characterLife.status().fault, 'memory-invalidation-failed');
    await h.sendToQQ('group:456','禁止继续的旧内容'); assert.equal(h.calls.sent.length,0);
    await assert.rejects(h.deliverPrompt('group:456','不能向旧上下文补投'));
  });
});

test('真实桥接角色事件接入独立生活会话，只有实时提案及成功结束更新本范围心情', async () => {
  const config = { ackMessage: '', character: { enabled:true, autonomy: { enabled:true, timezone:'UTC',activeHours:[{start:'00:00',end:'00:00'}],
    dailyDecisions:2,dailyTokens:20000,dailyCostMicros:200,roundTokens:10000,roundCostMicros:100 } } };
  await fixture(async h => {
    await h.characterLife.setPaused(false);
    await h.handleIncoming('private',123,{user_id:123,message_id:99,message:[{type:'text',data:{text:'今天心情怎么样'}}]},h.cfg);
    let prompt;
    for(let i=0;i<100&&!prompt;i++){await new Promise(resolve=>setTimeout(resolve,2));prompt=h.calls.prompts.find(item=>h.calls.created.some(created=>created.agentPreset==='qq-life'&&created.sessionId===item.sessionId));}
    assert.ok(prompt);const snapshot=JSON.parse(prompt.content[0].text.split('\n').at(-1));
    const send=(seq,type,data)=>h.routeCharacterEvent({type:'session/event',sessionId:prompt.sessionId,event:{seq,type,data}});
    send(1,'turn/start',{turn:'life-turn'});send(2,'tool/call',{name:'character_propose',callId:'proposal-call'});
    send(3,'character/proposal',{roundId:snapshot.id,expectedVersion:snapshot.version,intent:{action:'none',reason:'回应近况机会',appraisals:[{sourceId:snapshot.events[0].id,mood:{valence:4},reason:'这次私聊的感受'}],memory:{sourceIds:[snapshot.state.experiences[0].id],reflection:'记得这次近况交流'}}});
    assert.equal(h.character.project('private:123').psychology.mood.valence,50);
    send(4,'assistant/message',{turn:'life-turn',step:0,usage:{inputTokens:100,outputTokens:10},message:{content:[]}});
    send(5,'turn/end',{turn:'life-turn',reason:{kind:'completed'}});
    for(let i=0;i<100&&h.characterLife.status().scheduler.inFlight;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(h.character.status().decision.status,'committed');
    assert.equal(Math.round(h.character.project('private:123').psychology.mood.valence),54);
    assert.equal(h.character.project('group:456').psychology.mood.valence,50);
    assert.equal(h.character.memories('private:123').length,1);
    assert.equal(h.calls.sent.length,0); assert.equal(h.character.status().budget.attempts,1);
  },{config,globals:{createCharacterCoordinator:options=>createCharacterCoordinator({...options,timers:{setTimeout:(fn,ms)=>setTimeout(fn,ms<=2000?0:ms),clearTimeout}})}});
});


test('记忆删除与建会话竞态时，迟到的旧投递不会作为 reset 重试重新入队', async () => {
  await fixture(async h => {
    experience(h,'public','old-prompt-fact');const id=h.character.experiences('public')[0].id;
    const original=h.api.sessions.create;let release;
    h.api.sessions.create=params=>new Promise(resolve=>{release=async()=>resolve(await original(params));});
    const pending=h.deliverPrompt('group:456','old-prompt-fact').catch(error=>error);
    for(let i=0;i<30&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(release);await h.characterLife.mutateExperience(id);await release();
    const result=await pending;assert.ok(result instanceof Error || typeof result?.message==='string');
    assert.equal(h.queued.size,0);assert.equal(h.calls.prompts.some(item=>item.content[0].text.includes('old-prompt-fact')),false);
  });
});


test('离线补投请求晚到的失败不会把已删除版本重新放回离线队列', async () => {
  await fixture(async h=>{
    experience(h,'public','old-offline-fact');const id=h.character.experiences('public')[0].id;
    h.setReady(false);await h.deliverPrompt('group:456','old-offline-fact');h.setReady(true);
    let release;h.api.sessions.prompt=()=>new Promise(resolve=>{release=()=>resolve({result:{ok:false,error:{code:'fixture-failed',message:'fixture'}}});});
    const flushing=h.flushQueue();for(let i=0;i<30&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
    await h.characterLife.mutateExperience(id);release();await flushing;assert.equal(h.queued.size,0);
  });
});


test('存在删除历史而初始化未能完成隐私恢复时，不能降级继续向旧上下文投递或发送',async()=>{
  await fixture(async h=>{
    assert.equal(h.characterSnapshot().privacyBlocked,true);
    await assert.rejects(h.deliverPrompt('group:456','不得继续旧上下文'));
    await h.sendToQQ('group:456','不得继续旧发送');assert.equal(h.calls.sent.length,0);
  },{config:{character:{enabled:true}},globals:{createCharacterRuntime:async()=>{const error=new Error('fixture-private-recovery');error.code='CHARACTER_PRIVACY_BLOCKED';throw error;}}});
});


test('删除完成后迟到的命令正文不能借新版本发送到 QQ', async () => {
  for (const direct of [false, true]) await fixture(async h => {
    experience(h, 'public', 'late-command-fact');
    const id = h.character.experiences('public')[0].id;
    let release;
    h.api.sessions.prompt = () => new Promise(resolve => { release = () => resolve({ result: { ok: true, value: { command: { text: 'late-command-fact' } } } }); });
    const pending = (direct
      ? h.handleIncoming('private', 123, { user_id: 123, message_id: 100, message: [{ type: 'text', data: { text: '近况' } }] }, h.cfg)
      : h.deliverPrompt('group:456', '近况')).catch(error => error);
    for (let i = 0; i < 40 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(release);
    await h.characterLife.mutateExperience(id);
    release(); await pending;
    assert.equal(h.calls.sent.some(item => item.text.includes('late-command-fact')), false);
  }, { config: { ackMessage: '', character: { enabled: true } } });
});

test('安卓管理接口仅允许管理员，显式单次启动不调用模型，游戏事实回到原范围',async()=>{
  const {androidConfig,fakeDevice}=await import('./fixtures/android-fixture.mjs');
  const config=androidConfig(),time={value:0},device=fakeDevice(config.android,time);
  await fixture(async h=>{
    await h.characterLife.setPaused(false);
    await serverFixture(h,async request=>{
      const headers={'x-agent-token':h.getSocialV2State('private:123').agentToken};
      assert.equal((await request('/api/character/android/status',{headers})).status,403);
      for(const route of ['start','stop','reconcile'])assert.equal((await request('/api/character/android/'+route,{headers,body:route==='start'?{kind:'game'}:{}})).status,403);
      assert.equal((await request('/api/character/android/start',{body:{kind:'game',x:100}})).status,400);
      assert.equal((await request('/api/character/android/start',{body:{kind:'shell'}})).status,400);
      assert.equal((await request('/api/character/android/start',{body:{kind:'game'}})).status,200);
      for(let i=0;i<100&&h.characterLife.status().android.inFlight;i++)await new Promise(resolve=>setImmediate(resolve));
      const status=await request('/api/character/android/status');
      assert.equal(status.body.budget.seconds,10);assert.equal(status.body.jobs.length,0);
      assert.equal(h.calls.prompts.length,0);assert.equal(device.calls.gesture.length,1);
      assert.match(h.character.promptFor('private:123'),/已确认 1 次合法移动/);
      assert.equal(h.character.project('group:456').experiences.length,0);
      assert.equal((await request('/api/character/android/stop',{body:{}})).status,200);
      assert.equal(h.character.status().paused,true);
    });
  },{config:{character:config},globals:{createCharacterCoordinator:options=>createCharacterCoordinator({...options,androidDevice:device,androidOptions:{clock:()=>time.value,sleep:async(ms,signal)=>{signal.throwIfAborted();time.value+=ms;}}})}});
});
test('真实生产生活轮次只能选择宿主提供的安卓候选，成功提交后才领取设备动作',async()=>{
  const {androidConfig,fakeDevice}=await import('./fixtures/android-fixture.mjs');
  const config=androidConfig(),time={value:0},device=fakeDevice(config.android,time);
  config.autonomy={enabled:true,timezone:'UTC',activeHours:[{start:'00:00',end:'00:00'}],idleMs:900000,dailyDecisions:2,dailyTokens:20000,dailyCostMicros:200,roundTokens:10000,roundCostMicros:100};
  await fixture(async h=>{
    await h.characterLife.setPaused(false);
    h.characterLife.notify({source:'fixture',sourceId:'android-choice',scope:'private:123',summary:'有一段可支配的游戏时间'});
    let prompt;
    for(let i=0;i<100&&!prompt;i++){await new Promise(resolve=>setTimeout(resolve,2));prompt=h.calls.prompts.find(item=>h.calls.created.some(created=>created.agentPreset==='qq-life'&&created.sessionId===item.sessionId));}
    assert.ok(prompt);const snapshot=JSON.parse(prompt.content[0].text.split('\n').at(-1));
    assert.ok(snapshot.candidates.some(item=>item.id==='android:2048'));assert.equal(device.calls.launch.length,0);
    const send=(seq,type,data)=>h.routeCharacterEvent({type:'session/event',sessionId:prompt.sessionId,event:{seq,type,data}});
    send(1,'turn/start',{turn:'android-choice-turn'});send(2,'tool/call',{name:'character_propose'});
    send(3,'character/proposal',{roundId:snapshot.id,expectedVersion:snapshot.version,intent:{action:'start',candidateId:'android:2048',reason:'试一段 2048'}});
    assert.equal(device.calls.launch.length,0);assert.equal(h.character.status().active,null);
    send(4,'turn/end',{turn:'android-choice-turn',reason:{kind:'completed'}});
    for(let i=0;i<100&&h.characterLife.status().scheduler.inFlight;i++)await new Promise(resolve=>setImmediate(resolve));
    await h.characterLife.tick();
    for(let i=0;i<100&&h.characterLife.status().android.inFlight;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(device.calls.gesture.length,1);assert.match(h.character.experiences('private:123')[0].fact,/合法移动/);
    assert.equal(h.calls.sent.length,0);
  },{config:{character:config},globals:{createCharacterCoordinator:options=>createCharacterCoordinator({...options,timers:{setTimeout:(fn,ms)=>setTimeout(fn,ms<=2000?0:ms),clearTimeout},androidDevice:device,androidOptions:{clock:()=>time.value,sleep:async(ms,signal)=>{signal.throwIfAborted();time.value+=ms;}}})}});
});
test('删除经历立即封住安卓动作并等待退出，迟到的设备结果不重新提交旧正文',async()=>{
  const {androidConfig,fakeDevice}=await import('./fixtures/android-fixture.mjs');
  const config=androidConfig(),time={value:0},device=fakeDevice(config.android,time);
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});
  device.gesture=async(kind,frame,action,options)=>{await options.beforeSend(frame);entered();await new Promise(resolve=>{release=resolve;});options.guard();};
  await fixture(async h=>{
    experience(h,'private:123','erase-during-android');const id=h.character.experiences('private:123')[0].id;
    await h.characterLife.startAndroid('game');await waiting;
    let completed=false;const mutation=h.characterLife.mutateExperience(id).then(()=>{completed=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(completed,false);assert.equal(device.calls.stop.length,0);
    await assert.rejects(h.deliverPrompt('private:123','不得继续旧上下文'));
    release();await mutation;
    assert.equal(device.calls.stop.length,1);assert.equal(h.character.invalidations().length,0);
    assert.ok(h.character.experiences('private:123').every(item=>!item.fact.includes('erase-during-android')));
    assert.equal(h.characterLife.status().android.fault,null);
  },{config:{character:config},globals:{createCharacterCoordinator:options=>createCharacterCoordinator({...options,androidDevice:device,androidOptions:{clock:()=>time.value,sleep:async(ms,signal)=>{signal.throwIfAborted();time.value+=ms;}}})}});
});
