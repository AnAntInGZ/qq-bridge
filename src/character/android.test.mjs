import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeCharacterConfig } from './policy.mjs';
import { createCharacterRuntime } from './runtime.mjs';
import { createAdbDevice, parseAndroidUI, assertKnownUI, parsePlaybackState } from './android-adb.mjs';
import { decodeScreenshot, read2048, suggest2048Board, frameChange } from './android-image.mjs';
import { move2048, legalSuccessor, choose2048 } from './game-2048.mjs';
import { createAndroidActivities, playerState, feedItems, sameTitle } from './android-activities.mjs';
import { parseClipAnswer, clipSummary } from './android-watch.mjs';
import { androidConfig, boardImage, screenImage, png, fakeDevice, INITIAL_BOARD } from '../../scripts/fixtures/android-fixture.mjs';

async function fixture(fn,overrides={},extras={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-android-'));
  const config=androidConfig(overrides,extras.character);let now=Date.UTC(2026,9,21,10);
  let runtime=await createCharacterRuntime({root,config,now:()=>now});runtime.setPaused(false);
  const time={value:0}, deviceOptions=extras.titles?{titles:extras.titles}:{};
  if (extras.misreport) deviceOptions.misreport=extras.misreport;
  const device=fakeDevice(config.android,time,deviceOptions);
  const options=()=>({runtime,config:config.android,isAllowed:()=>true,device,clock:()=>time.value,
    sleep:async(ms,signal)=>{signal.throwIfAborted();time.value+=ms;},
    ...(extras.clipAnalyzer?{clipAnalyzer:extras.clipAnalyzer}:{})});
  let service=createAndroidActivities(options());
  const db=()=>new DatabaseSync(path.join(root,'state/character/character.sqlite'),{readOnly:true});
  try {await fn({root,config,time,device,db,get runtime(){return runtime;},get service(){return service;},
    advance(ms){now+=ms;},async reopen(){await service.close();runtime.close();runtime=await createCharacterRuntime({root,config,now:()=>now});service=createAndroidActivities(options());}});}
  finally {await service.close();runtime.close();fs.rmSync(root,{recursive:true,force:true});}
}

test('安卓默认关闭，启用要求固定本地设备、范围、版本、棋盘和额度',()=>{
  assert.equal(normalizeCharacterConfig().android.enabled,false);
  for(const change of [{serial:'host:5555'},{serial:'127.0.0.1:5555;id'},{serial:'127.0.0.1:99999'},{scope:'internal'},{dailySeconds:0},{adbPath:'../adb'},{game:{enabled:true,version:''}},{bilibili:{enabled:true,version:'1',selectors:{}}}])
    assert.throws(()=>androidConfig(change));
  assert.throws(()=>normalizeCharacterConfig({android:{enabled:true}}));
});
test('2048 规则每块只合并一次，求解仅选择合法方向，后继必须恰好新增一个 2 或 4',()=>{
  const before=[2,2,2,2,4,4,8,0,0,0,0,0,0,0,0,0];
  const moved=move2048(before,'left');
  assert.deepEqual(moved.board.slice(0,8),[4,4,0,0,8,8,0,0]);assert.equal(moved.gained,16);
  const after=[...moved.board];after[15]=2;
  assert.equal(legalSuccessor(before,after,'left'),true);
  after[14]=2;assert.equal(legalSuccessor(before,after,'left'),false);
  assert.ok(move2048(before,choose2048(before).direction).changed);
  assert.equal(choose2048([2,4,2,4,4,2,4,2,2,4,2,4,4,2,4,2]),null);
});
test('真实 PNG 像素往返识别棋盘，CRC、尺寸和未知颜色均拒绝，不静默补格',()=>{
  const config=androidConfig().android,image=boardImage(config),bytes=png(image);
  assert.deepEqual(read2048(decodeScreenshot(bytes,720,1280),config.game.board),INITIAL_BOARD);
  assert.deepEqual(suggest2048Board(image).board,config.game.board);
  const corrupt=Buffer.from(bytes);corrupt[40]^=1;assert.throws(()=>decodeScreenshot(corrupt,720,1280));
  assert.throws(()=>decodeScreenshot(bytes,720,1281));
  image.pixels.fill(0);assert.throws(()=>read2048(image,config.game.board));
});
test('画面帧差能区分推进与定格，媒体会话按包名读播放态与标题',()=>{
  const config=androidConfig().android;
  const still=screenImage(config,INITIAL_BOARD,'player',0),moved=screenImage(config,INITIAL_BOARD,'player',3000);
  assert.equal(frameChange(still,still),0);
  assert.ok(frameChange(still,moved)>0.002);
  assert.throws(()=>frameChange(still,{...moved,width:moved.width+1}));
  assert.throws(()=>frameChange(null,still));
  const dump='MediaSessionService\n    package=com.android.server.telecom\n    state=null\n  Session tv.danmaku.bili\n      package=tv.danmaku.bili\n'
    +'      state=PlaybackState {state=PLAYING(3), position=200, speed=1.0}\n'
    +'      metadata: size=9, description=离线夹具视频, 自动连播(1/1), null';
  assert.deepEqual(parsePlaybackState(dump,'tv.danmaku.bili'),{state:'PLAYING',code:3,title:'离线夹具视频'});
  assert.equal(parsePlaybackState(dump,'com.other.pkg'),null);
  assert.equal(parsePlaybackState('',  'tv.danmaku.bili'),null);
});
test('播放标题允许媒体会话截断，但过短或无关标题不算同一内容',()=>{
  assert.equal(sameTitle('日本百强拉面！真实评分店铺，到底好吃吗？？','日本百强拉面！真实评分店铺，到底好吃吗？？'),true);
  assert.equal(sameTitle('日本百强拉面！真实评分店铺，到底好吃吗？？','日本百强拉面！真实评分店铺'),true);
  assert.equal(sameTitle('短标题',  '短标题加长版'),false);
  assert.equal(sameTitle('另外一条完全不同的视频','日本百强拉面！真实评分店铺'),false);
  assert.equal(sameTitle('',''),false);
});
test('UI 解析拒绝外部实体、越界、支付弹窗和其他包，保留数据文本而不当指令',()=>{
  const xml='<hierarchy><node resource-id="tv.danmaku.bili:id/title" text="数据 &amp; 标题" content-desc="" package="tv.danmaku.bili" class="android.widget.TextView" clickable="true" enabled="true" bounds="[10,20][300,80]" /></hierarchy>';
  const nodes=parseAndroidUI(xml,720,1280);assert.equal(nodes[0].text,'数据 & 标题');assert.doesNotThrow(()=>assertKnownUI(nodes,'tv.danmaku.bili'));
  // 坏码点只影响那一个字符，不能让整次观察失败；控制字符直接丢掉。
  assert.equal(parseAndroidUI(xml.replace('数据 &amp; 标题','坏&#xD800;码'),720,1280)[0].text,'坏\uFFFD码');
  assert.equal(parseAndroidUI(xml.replace('数据 &amp; 标题','a&#0;b'),720,1280)[0].text,'ab');
  assert.throws(()=>parseAndroidUI('<!DOCTYPE x>'+xml,720,1280));
  assert.throws(()=>parseAndroidUI(xml.replace('[300,80]','[3000,80]'),720,1280));
  assert.throws(()=>assertKnownUI([{...nodes[0],class:'android.app.Dialog'}],'tv.danmaku.bili'));
  assert.throws(()=>assertKnownUI([{...nodes[0],package:'com.android.settings'}],'tv.danmaku.bili'));
  const selectors=androidConfig().android.bilibili.selectors;
  const item=(id,text,clickable=false,desc='')=>'<node resource-id="'+id+'" text="'+text+'" content-desc="'+desc+'" package="tv.danmaku.bili" class="android.widget.TextView" enabled="true" clickable="'+clickable+'" bounds="[10,20][300,80]" />';
  const card='<node resource-id="'+selectors.feedCard+'" content-desc="视频,公开视频,1万播放" package="tv.danmaku.bili" clickable="true" enabled="true" bounds="[0,0][400,200]">';
  const nested='<hierarchy>'+item(selectors.feedReady,'')+card+item(selectors.feedTitle,'公开视频')+'</node></hierarchy>';
  const candidates=feedItems({nodes:parseAndroidUI(nested,720,1280)},selectors);
  assert.equal(candidates.length,1);assert.equal(candidates[0].node.id,selectors.feedCard);
  assert.equal(feedItems({nodes:parseAndroidUI(nested.replace('视频,公开视频','竖版视频,公开视频'),720,1280)},selectors).length,0);
  assert.equal(feedItems({nodes:parseAndroidUI(nested.replace('</node>',item('tv.danmaku.bili:id/ad_label','广告')+'</node>'),720,1280)},selectors).length,0);
});
test('ADB 每次绑定固定 serial，错误版本或失焦时不截图不点击，过期观察拒绝动作',async()=>{
  const config=androidConfig().android,calls=[],bytes=png(boardImage(config));
  let focus='com.android.settings',version='fixture-1';
  const execute=async(executable,args)=>{
    calls.push(args);assert.equal(args[0],'-s');assert.equal(args[1],config.serial);
    if(args.includes('android_id'))return Buffer.from(config.deviceId);
    if(args.includes('connect'))return Buffer.from('connected to '+config.serial);
    if(args.includes('get-state'))return Buffer.from('device');
    if(args.includes('resolve-activity'))return Buffer.from('com.uberspot.a2048/com.uberspot.a2048.MainActivity');
    if(args.includes('package'))return Buffer.from('versionName='+version);
    if(args.includes('windows')||args.includes('window'))return Buffer.from('mCurrentFocus=Window{aaa u0 '+focus+'/'+focus+'.Main}');
    if(args.includes('screencap'))return Buffer.from('');
    // 截图改为先落设备再 pull，桩要把字节写到 pull 的目标路径上。
    if(args[2]==='pull'){fs.writeFileSync(args.at(-1),bytes);return Buffer.from('');}
    if(args.includes('cat'))return Buffer.from('<hierarchy><node package="com.uberspot.a2048" bounds="[0,0][720,1280]" /></hierarchy>');
    return Buffer.from('');
  };
  const driver=createAdbDevice({config,execute,now:()=>10000});
  await assert.rejects(driver.observe('game'),/焦点/);assert.equal(calls.some(args=>args.includes('screencap')),false);
  version='different';await assert.rejects(driver.launch('game'),/版本/);assert.equal(calls.some(args=>args.includes('start')),false);
  await assert.rejects(driver.gesture('game',{at:0},{type:'direction',direction:'left'},{verify:()=>true}),/过期/);
  focus='com.uberspot.a2048';version='fixture-1';
  let registered=false;await driver.launch('game',{beforeSend:()=>{registered=true;}});assert.equal(registered,true);
  assert.ok(calls.some(args=>args.includes('start') && args.includes('com.uberspot.a2048/com.uberspot.a2048.MainActivity')));
  assert.equal(calls.some(args=>args.includes('monkey')),false);
  const frame=await driver.observe('game');assert.deepEqual(read2048(frame.image,config.game.board),INITIAL_BOARD);
  await driver.gesture('game',frame,{type:'direction',direction:'left'},{verify:fresh=>read2048(fresh.image,config.game.board)[0]===2});
  const input=calls.find(args=>args.includes('swipe'));assert.ok(input);assert.ok(input.slice(-5).every(item=>/^\d+$/.test(item)));
  await assert.rejects(driver.gesture('game',frame,{type:'shell',command:'id'},{verify:()=>true}),/白名单/);
});
test('模拟器偶发 SIGBUS 时只读命令重试一次，重试仍失败照常报错',async()=>{
  const config=androidConfig().android,bytes=png(boardImage(config));
  let screencapFails=1;
  const crash=()=>Object.assign(new Error('安卓命令失败或退出未确认（135）'),{adbExit:135});
  const execute=async(executable,args)=>{
    if(args.includes('android_id'))return Buffer.from(config.deviceId);
    if(args.includes('connect'))return Buffer.from('connected to '+config.serial);
    if(args.includes('get-state'))return Buffer.from('device');
    if(args.includes('package'))return Buffer.from('versionName=fixture-1');
    if(args.includes('window'))return Buffer.from('mCurrentFocus=Window{aaa u0 tv.danmaku.bili/tv.danmaku.bili.MainActivityV2}');
    if(args.includes('screencap')){if(screencapFails-- > 0)throw crash();return Buffer.from('');}
    if(args[2]==='pull'){fs.writeFileSync(args.at(-1),bytes);return Buffer.from('');}
    if(args.includes('cat'))return Buffer.from('<hierarchy><node package="tv.danmaku.bili" bounds="[0,0][720,1280]" /></hierarchy>');
    return Buffer.from('');
  };
  const driver=createAdbDevice({config,execute,now:()=>10000});
  const frame=await driver.observe('bilibili',{});assert.ok(frame.image,'崩溃一次后应重试成功');
  // 只重试一次：持续崩溃就如实失败，不无限重试。
  screencapFails=5;
  await assert.rejects(driver.observe('bilibili',{}),/135/);
});
test('2048 只有实际合法后继形成完成经历，最后预留额度仍可执行且不能重复领取',async()=>{
  await fixture(async h=>{
    const operation=await h.service.start('game');await h.service.settled();
    assert.equal(h.device.calls.gesture.length,1);assert.equal(h.device.calls.stop.length,1);
    assert.equal(h.runtime.androidJobs().length,0);assert.equal(h.runtime.status().active,null);
    const experience=h.runtime.experiences('private:123')[0];assert.match(experience.fact,/已确认 1 次合法移动/);
    assert.equal(h.runtime.experiences('group:456').length,0);
    const db=h.db();try{assert.equal(db.prepare("SELECT count(*) AS n FROM android_steps WHERE status='confirmed'").get().n,2);}finally{db.close();}
    assert.equal(h.runtime.claimAndroidOperation(),null);
    assert.equal(h.runtime.androidBudget().seconds,10);assert.ok(operation.id);
  },{dailySeconds:10,dailyActions:2});
});
test('无变化不能记作成功或重试点击，停止未确认保留占用，重新核对不重放动作',async()=>{
  await fixture(async h=>{
    h.device.invalidMove=true;h.device.stopFails=true;
    await h.service.start('game');await h.service.settled();
    assert.equal(h.device.calls.gesture.length,1);assert.equal(h.runtime.status().experienceCount,0);
    assert.equal(h.runtime.androidJobs()[0].status,'unknown');assert.equal(h.service.status().fault,'android-stop-unconfirmed');
    await assert.rejects(h.service.start('game'));
    h.device.stopFails=false;await h.service.reconcile();
    assert.equal(h.runtime.androidJobs().length,0);assert.equal(h.device.calls.gesture.length,1);
    assert.match(h.runtime.experiences('private:123')[0].fact,/没有重放/);
  });
});
test('设备额度跨重启、回拨保持，未知任务重启后必须核对，不能恢复旧点击',async()=>{
  await fixture(async h=>{
    h.runtime.requestAndroidActivity('game');const op=h.runtime.claimAndroidOperation();
    h.runtime.registerAndroidStep(op.id,op.epoch,'move','a'.repeat(64));
    await h.reopen();h.runtime.setPaused(false);await h.service.tick();
    assert.equal(h.service.status().fault,'android-reconcile-required');assert.equal(h.device.calls.launch.length,0);
    assert.equal(h.runtime.androidBudget().seconds,10);h.advance(-86400000);assert.equal(h.runtime.androidBudget().seconds,10);
    await h.service.reconcile();assert.equal(h.runtime.androidJobs().length,0);assert.equal(h.device.calls.gesture.length,0);
    assert.equal(h.runtime.androidBudget().allowed,false);
  },{dailySeconds:10,dailyActions:2});
});
test('人工暂停等待在途命令结束和应用停止，不因取消信号提前交出设备',async()=>{
  await fixture(async h=>{
    let release,entered;
    const waiting=new Promise(resolve=>{entered=resolve;});
    h.device.gesture=async(kind,frame,action,options)=>{await options.beforeSend(frame);entered();await new Promise(resolve=>{release=resolve;});options.guard();};
    await h.service.start('game');await waiting;
    h.runtime.setPaused(true);let finished=false;const stopping=h.service.stop().then(()=>{finished=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);assert.equal(h.device.calls.stop.length,0);
    await assert.rejects(h.service.start('game'));release();await stopping;
    assert.equal(h.device.calls.stop.length,1);assert.equal(h.runtime.androidJobs().length,0);
    assert.match(h.runtime.experiences('private:123')[0].fact,/取消前/);
  });
});
test('B 站只按实际标题、播放态与画面推进形成有限经历，不凭打开或经过时间记作看完',async()=>{
  await fixture(async h=>{
    await h.service.start('bilibili');await h.service.settled();
    assert.equal(h.service.status().fault,null);
    assert.equal(h.device.calls.gesture[0].type,'tap');
    const fact=h.runtime.experiences('private:123')[0].fact;
    assert.match(fact,/媒体会话确认持续播放/);assert.match(fact,/画面持续变化/);
    assert.match(fact,/不代表完整看完/);
    assert.equal(h.device.calls.stop.at(-1),'bilibili');
  });
});
test('B 站画面定格或媒体会话不在播放时拒绝作为观看结果',async()=>{
  assert.throws(()=>playerState({nodes:[]},androidConfig().android.bilibili.selectors));
  for(const setup of [h=>{h.device.frozen=true;},h=>{h.device.playState='PAUSED';}]){
    await fixture(async h=>{
      setup(h);
      await h.service.start('bilibili');await h.service.settled();
      assert.equal(h.service.status().fault,'android-observation-or-action-failed');
      assert.equal(h.runtime.status().active,null);
      assert.match(h.runtime.experiences('private:123')[0].fact,/未作为完成事实/);
      assert.equal(h.device.calls.stop.length,1);
    });
  }
});
test('B 站在一次活动里连续看多条，命中兴趣的停留更久',async()=>{
  const selectors={feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'};
  await fixture(async h=>{
    await h.service.start('bilibili');await h.service.settled();
    assert.equal(h.service.status().fault,null);
    assert.equal(h.device.calls.gesture.filter(item=>item.type==='tap').length,3,'一次活动应连续打开三条');
    assert.equal(h.device.calls.gesture.filter(item=>item.type==='back').length,2,'最后一条不必再返回列表');
    const fact=h.runtime.experiences('private:123')[0].fact;
    assert.match(fact,/在安卓 B 站连续看了 3 条、共 12 秒/);
    const seconds=topic=>Number(new RegExp('《'+topic+'》停留 (\\d+) 秒').exec(fact)?.[1]);
    // 兴趣越集中停得越久：两个词都命中的看满 deepWatchSeconds，完全无关的只看最短时长。
    assert.equal(seconds('拉面与汤头'),6);
    assert.equal(seconds('拉面历史考据'),4);
    assert.equal(seconds('装机开箱'),2);
    assert.equal(h.runtime.status().active,null);
  },{dailySeconds:600,dailyActions:60,maxActions:20,activitySeconds:120,
    bilibili:{enabled:true,version:'fixture-1',watchSeconds:2,deepWatchSeconds:6,maxVideos:3,scrolls:1,selectors}},
  {character:{interestSeeds:[{topic:'拉面',score:8,scope:'public'},{topic:'汤头',score:6,scope:'public'}]},
    titles:['拉面与汤头','装机开箱','拉面历史考据']});
});
test('B 站预算见底时正常收尾，不把已确认的观看判成失败',async()=>{
  const selectors={feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'};
  await fixture(async h=>{
    await h.service.start('bilibili');await h.service.settled();
    // 10 秒预算够看两条、不够第三条：应保留前两条并按完成收尾，而不是超时失败。
    assert.equal(h.service.status().fault,null);
    assert.equal(h.runtime.status().active,null);
    const fact=h.runtime.experiences('private:123')[0].fact;
    assert.match(fact,/在安卓 B 站连续看了 2 条、共 4 秒/);
    assert.match(fact,/不代表完整看完/);
  },{dailyActions:60,maxActions:20,activitySeconds:10,
    bilibili:{enabled:true,version:'fixture-1',watchSeconds:2,deepWatchSeconds:2,maxVideos:3,scrolls:1,selectors}},
  {titles:['甲 视频','乙 视频','丙 视频']});
});
test('B 站点开发现不是那一条时退出来换一条，不因此结束整场活动',async()=>{
  const selectors={feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'};
  await fixture(async h=>{
    await h.service.start('bilibili');await h.service.settled();
    assert.equal(h.service.status().fault,null);
    // 第一条点开是广告/推荐漂移：退出列表再选，后两条照常看完，而不是整场收尾。
    assert.equal(h.device.calls.gesture.filter(item=>item.type==='tap').length,3);
    const fact=h.runtime.experiences('private:123')[0].fact;
    assert.match(fact,/在安卓 B 站连续看了 2 条/);
    assert.doesNotMatch(fact,/《甲 视频》停留/);
    assert.match(fact,/另有 1 条点开后不是列表里的那一条/);
    assert.doesNotMatch(fact,/活动提前结束/);
  },{dailySeconds:600,dailyActions:60,maxActions:20,activitySeconds:120,
    bilibili:{enabled:true,version:'fixture-1',watchSeconds:2,deepWatchSeconds:2,maxVideos:3,scrolls:1,selectors}},
  {titles:['甲 视频','乙 视频','丙 视频'],misreport:[0]});
});
test('B 站连续开错太多次时收尾，不无限重试也不丢掉已确认的观看',async()=>{
  const selectors={feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'};
  await fixture(async h=>{
    await h.service.start('bilibili');await h.service.settled();
    assert.equal(h.runtime.status().active,null);
    // 全部错位时按跳过上限停下：不能编出一条"看完了"的经历来凑数。
    const fact=h.runtime.experiences('private:123')[0].fact;
    assert.match(fact,/未作为完成事实提交/);
    assert.doesNotMatch(fact,/停留 \d+ 秒/);
  },{dailySeconds:600,dailyActions:60,maxActions:20,activitySeconds:120,
    bilibili:{enabled:true,version:'fixture-1',watchSeconds:2,deepWatchSeconds:2,maxVideos:3,scrolls:1,selectors}},
  {titles:['甲 视频','乙 视频','丙 视频'],misreport:[0,1,2]});
});
test('Seed 录屏回答按三行解析，缺主题或含路径特征时整条作废',()=>{
  assert.deepEqual(parseClipAnswer('类型：游戏\n主题：雪山滑雪跳跃\n细节：角色在雪坡上翻滚'),
    {kind:'游戏',topic:'雪山滑雪跳跃',detail:'角色在雪坡上翻滚'});
  assert.deepEqual(parseClipAnswer('主题：拉面测评'),{kind:'',topic:'拉面测评',detail:''});
  // 没有主题就既不能叙述也不能参与兴趣匹配，宁可整条作废。
  assert.equal(parseClipAnswer('类型：游戏\n主题：无法判断'),null);
  assert.equal(parseClipAnswer('类型：游戏\n主题：看这个 C:\\Users\\alex\\clip.mp4'),null);
  assert.equal(parseClipAnswer(''),null);
  assert.equal(clipSummary({kind:'',topic:'拉面测评',detail:''}),'拉面测评');
  assert.equal(clipSummary({kind:'美食',topic:'拉面测评',detail:'一碗豚骨拉面'}),'美食，拉面测评；一碗豚骨拉面');
  assert.equal(clipSummary(null),'');
});
test('录屏分析要求停留足够长，开关只接受布尔值且录制时长有下限',()=>{
  const selectors={feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'};
  const base={enabled:true,version:'1',selectors};
  // 录制发生在停留时间里，比最短停留还长会把"看了多久"这个事实本身撑大。
  assert.throws(()=>androidConfig({bilibili:{...base,watchSeconds:3,analyze:true,clipSeconds:8}}),/录屏时长不能超过最短停留/);
  assert.throws(()=>androidConfig({bilibili:{...base,analyze:'yes'}}),/开关无效/);
  assert.throws(()=>androidConfig({bilibili:{...base,analyze:true,clipSeconds:2}}),/角色数值超出范围/);
  assert.equal(androidConfig({bilibili:{...base,watchSeconds:8,analyze:true,clipSeconds:8}}).android.bilibili.analyze,true);
});
test('开启录屏分析后，叙述带上画面内容并如实区分看过画面的条数',async()=>{
  const selectors={feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'};
  const answers=['类型：美食\n主题：拉面测评\n细节：一碗豚骨拉面','类型：数码\n主题：装机开箱\n细节：机箱里三把风扇'];
  let index=0;
  await fixture(async h=>{
    await h.service.start('bilibili');await h.service.settled();
    assert.equal(h.service.status().fault,null);
    // 每条视频录一段，录屏时长计入停留，不会被额外拉长。
    assert.equal(h.device.calls.record,2);
    const fact=h.runtime.experiences('private:123')[0].fact;
    assert.match(fact,/画面内容：美食，拉面测评；一碗豚骨拉面/);
    assert.match(fact,/画面内容：数码，装机开箱；机箱里三把风扇/);
    assert.match(fact,/在安卓 B 站连续看了 2 条、共 12 秒/);
    assert.match(fact,/其中 2 条用 Seed 看过画面/);
    assert.match(fact,/不代表完整看完/);
  },{dailySeconds:600,dailyActions:60,maxActions:20,activitySeconds:120,
    bilibili:{enabled:true,version:'fixture-1',watchSeconds:6,clipSeconds:4,maxVideos:2,scrolls:1,analyze:true,selectors}},
  {titles:['拉面测评','装机开箱'],clipAnalyzer:async()=>parseClipAnswer(answers[index++])});
});
test('Seed 失败或录屏失败时只降级内容证据，观看本身仍然成立',async()=>{
  const selectors={feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'};
  const cases=[{clipAnalyzer:async()=>{throw new Error('方舟请求失败（HTTP 500）');}},{recordFails:true}];
  for(const setup of cases){
    await fixture(async h=>{
      if(setup.recordFails)h.device.recordFails=true;
      await h.service.start('bilibili');await h.service.settled();
      assert.equal(h.service.status().fault,null,'内容理解失败不应让观看判失败');
      const fact=h.runtime.experiences('private:123')[0].fact;
      assert.doesNotMatch(fact,/画面内容：/);
      assert.match(fact,/媒体会话确认持续播放/);
      assert.match(fact,/不代表完整看完/);
    },{dailySeconds:600,dailyActions:60,maxActions:20,activitySeconds:120,
      bilibili:{enabled:true,version:'fixture-1',watchSeconds:6,clipSeconds:4,maxVideos:1,scrolls:1,analyze:true,selectors}},
    {titles:['拉面测评'],...(setup.clipAnalyzer?{clipAnalyzer:setup.clipAnalyzer}:{})});
  }
});
test('后续滚动失败时保留已确认的观看，记为完成而不是把整条经历作废',async()=>{
  const selectors={feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'};
  await fixture(async h=>{
    h.device.scrollFails=true;
    await h.service.start('bilibili');await h.service.settled();
    // 设备偶发崩溃不该抹掉已经取证过的那一条。
    assert.equal(h.service.status().fault,null);
    const fact=h.runtime.experiences('private:123')[0].fact;
    assert.match(fact,/在安卓 B 站连续看了 1 条/);
    assert.match(fact,/活动提前结束/);
    assert.match(fact,/已确认的观看仍然成立/);
  },{dailySeconds:600,dailyActions:60,maxActions:20,activitySeconds:120,
    bilibili:{enabled:true,version:'fixture-1',watchSeconds:2,deepWatchSeconds:2,maxVideos:2,scrolls:1,selectors}},
  {titles:['甲 视频']});
});
test('v3 到 v4 先快照迁移，保留记忆版本和经历，安卓仍默认关闭',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-android-v3-'));
  try {
    const runtime=await createCharacterRuntime({root,config:{enabled:true}});runtime.close();
    const file=path.join(root,'state/character/character.sqlite'),old=new DatabaseSync(file);
    old.exec('DROP TABLE android_steps;DROP TABLE android_jobs;PRAGMA user_version=3');old.close();
    const upgraded=await createCharacterRuntime({root,config:{enabled:true}});
    assert.equal(upgraded.status().android.enabled,false);assert.equal(upgraded.status().paused,true);
    assert.equal(upgraded.memoryVersion(),0);upgraded.close();
    assert.equal(fs.readdirSync(path.join(root,'state/character/backups')).filter(name=>name.startsWith('migration-v3-')).length,1);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('新记忆版本拒绝旧安卓计划领取，暂停取消尚未执行的设备意图',async()=>{
  await fixture(async h=>{
    h.runtime.recordConversationEvent({sourceId:'fixture-memory',scope:'private:123',summary:'待更正的私聊依据'});
    h.runtime.requestAndroidActivity('game');
    h.runtime.mutateExperience(h.runtime.experiences('private:123')[0].id);
    assert.throws(()=>h.runtime.claimAndroidOperation(),/失效/);
    await h.service.stop();
    assert.equal(h.runtime.androidJobs().length,0);assert.equal(h.runtime.status().active,null);assert.equal(h.device.calls.launch.length,0);
  });
});
test('独立安卓节点的前置检查拒绝 2GB 内存、未就绪 Binder 和浮动镜像，不执行部署',async()=>{
  const {evaluateAndroidHost}=await import('../../scripts/check-android-host.mjs');
  const {startAndroid}=await import('../../scripts/start-android.mjs');
  const facts={platform:'linux',arch:'x64',pageSize:4096,ipv6:true,cpus:4,availableMiB:4096,freeGiB:20,binderReady:true,docker:true,adb:true,image:'redroid/redroid:13.0.0-latest@sha256:'+'a'.repeat(64)};
  assert.equal(evaluateAndroidHost(facts).ready,true);
  for(const overrides of [{availableMiB:300},{pageSize:65536},{ipv6:false},{binderReady:false},{image:'redroid/redroid:13.0.0-latest'}]){
    let called=false;
    await assert.rejects(startAndroid({apply:true,facts:{...facts,...overrides},command:async()=>{called=true;return '';}}),/前置检查/);
    assert.equal(called,false);
  }
  await assert.rejects(startAndroid({facts}),/--apply/);
});
test('取消命令回执和主进程消失都不足以释放应用，仍需排除同包子进程',async()=>{
  const config=androidConfig().android;let child=true;
  const driver=createAdbDevice({config,execute:async(executable,args)=>Buffer.from(args.includes('android_id')?config.deviceId:args.includes('connect')?'connected to '+config.serial:args.includes('get-state')?'device':args.includes('ps')&&child?'NAME\ntv.danmaku.bili:remote\n':'')});
  await assert.rejects(driver.stop('bilibili'),/停止未确认/);
  child=false;await driver.stop('bilibili');
});

test('v3 安卓迁移中途冲突回滚结构并保留升级前快照',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-android-migration-fail-'));
  try{
    const runtime=await createCharacterRuntime({root,config:{enabled:true}});runtime.close();
    const file=path.join(root,'state/character/character.sqlite'),old=new DatabaseSync(file);
    old.exec('DROP TABLE android_steps;DROP TABLE android_jobs;CREATE TABLE android_steps(id TEXT);PRAGMA user_version=3');old.close();
    await assert.rejects(createCharacterRuntime({root,config:{enabled:true}}),/already exists/);
    const check=new DatabaseSync(file);
    try{assert.equal(check.prepare('PRAGMA user_version').get().user_version,3);assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='android_jobs'").get(),undefined);}
    finally{check.close();}
    assert.equal(fs.readdirSync(path.join(root,'state/character/backups')).length,1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('应用清理实际耗时超出预留时提高日占用，不把停止请求当免费时间',async()=>{
  await fixture(async h=>{
    const stop=h.device.stop;h.device.stop=async kind=>{h.time.value+=15000;await stop(kind);};
    await h.service.start('game');await h.service.settled();
    assert.ok(h.runtime.androidBudget().seconds>=15);assert.equal(h.runtime.androidBudget().allowed,false);
    await assert.rejects(h.service.start('game'));
  });
});

test('设备身份变化时启动、观察和停止均拒绝，不能操作另一部转发设备',async()=>{
  const config=androidConfig().android,calls=[];
  const driver=createAdbDevice({config,execute:async(_,args)=>{
    calls.push(args);
    return Buffer.from(args.includes('connect')?'connected to '+config.serial:args.includes('get-state')?'device':'ffffffffffffffff');
  }});
  for(const action of [()=>driver.launch('game'),()=>driver.observe('game'),()=>driver.stop('game')])
    await assert.rejects(action(),/身份/);
  assert.equal(calls.some(args=>args.includes('start')||args.includes('screencap')||args.includes('force-stop')),false);
});
test('Windows 反向隧道固定两端回环，拒绝 ADB 服务端口、公网监听和占用端口',async()=>{
  const {tunnelPlan,assertLoopbackListener,checkTunnelDevice}=await import('../../scripts/android-reverse-tunnel.mjs');
  const plan=tunnelPlan({server:'qq-bridge',localPort:16384});
  assert.ok(plan.args.includes('127.0.0.1:15555:127.0.0.1:16384'));
  assert.ok(plan.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(plan.args.includes('ExitOnForwardFailure=yes'));
  for(const options of [{localPort:5037},{remotePort:5037},{localPort:65536},{server:'host;id'},{server:'-oProxyCommand=x'}])
    assert.throws(()=>tunnelPlan({server:'qq-bridge',localPort:16384,...options}));
  assert.doesNotThrow(()=>assertLoopbackListener('LISTEN 0 128 127.0.0.1:15555 0.0.0.0:*',15555));
  for(const output of ['LISTEN 0 128 0.0.0.0:15555 0.0.0.0:*','LISTEN 0 128 [::]:15555 [::]:*',''])
    assert.throws(()=>assertLoopbackListener(output,15555));
  assert.throws(()=>assertLoopbackListener('LISTEN 0 128 127.0.0.1:15555 0.0.0.0:*',15555,{vacant:true}));
  const calls=[];
  await assert.rejects(checkTunnelDevice(plan,'0123456789abcdef',async(executable,args)=>{
    calls.push(args);
    return args.includes('connect')?'connected to '+plan.serial:args.includes('get-state')?'device':'ffffffffffffffff';
  }),/身份/);
  assert.equal(calls.length,3);
});
test('隧道仅显式 apply 建立；实际监听扩大为公网时关闭进程，不重试转发',async()=>{
  const {openAndroidTunnel}=await import('../../scripts/android-reverse-tunnel.mjs');
  const {EventEmitter}=await import('node:events');
  let launched=0,stopped=0,probes=0;
  const options={server:'qq-bridge',localPort:16384,deviceId:'0123456789abcdef'};
  const execute=async(executable,args)=>{
    if(args.includes('connect'))return 'connected to 127.0.0.1:16384';
    if(args.includes('get-state'))return 'device';
    if(args.includes('android_id'))return options.deviceId;
    return ++probes===1?'':'LISTEN 0 128 0.0.0.0:15555 0.0.0.0:*';
  };
  const launch=()=>{
    launched++;const child=new EventEmitter();
    child.kill=()=>{stopped++;queueMicrotask(()=>child.emit('close',null,'SIGTERM'));};
    return child;
  };
  assert.equal((await openAndroidTunnel(options,{execute,launch})).requested,false);
  assert.equal(launched,0);assert.equal(probes,0);
  await assert.rejects(openAndroidTunnel({...options,apply:true},{execute,launch}),/回环/);
  assert.equal(launched,1);assert.equal(stopped,1);
});
