import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { SENSITIVE_RE } from '../sensitive.js';
import { createAdbDevice } from './android-adb.mjs';
import { read2048, frameChange } from './android-image.mjs';
import { choose2048, legalSuccessor } from './game-2048.mjs';
import { clipSummary } from './android-watch.mjs';

// 只接受普通横版视频卡。竖版视频走 StoryVideoActivity、直播和会员购是另一套页面，
// 卡片类型的判定看 content-desc 的第一段（真机格式如 "视频,标题,播放量"），
// 比在子节点里找文本更稳，因为竖版卡并没有写着"竖版视频"的文本节点。
const CARD_KINDS = new Set(['视频']);
// 播放中相隔数秒的画面变化率实测约 18%，暂停时为 0；留 0.2% 容忍静态镜头。
const MIN_FRAME_CHANGE = 0.002;
// 点开才发现不是那一条时可以退出来换一条，但连续几条都不对说明页面结构变了，
// 再点只是白花动作额度，所以有上限。
const MAX_MISSES = 3;

export function playerState(frame, selectors) {
  const nodes=frame.nodes.filter(node=>node.id===selectors.playerReady);
  if (nodes.length !== 1) throw new Error('B 站播放器标记不明确');
  // 播放器就绪但仍能读到推荐列表，说明点开没成功或已经退回。
  if (frame.nodes.some(node=>node.id===selectors.feedReady)) throw new Error('B 站仍在推荐列表');
  return { ready: true };
}
// 媒体会话标题可能被截断，允许一方是另一方的前缀，但过短的标题不足以区分条目。
export function sameTitle(a,b) {
  const left=String(a ?? '').replace(/\s+/g,' ').trim(), right=String(b ?? '').replace(/\s+/g,' ').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const [short,long] = left.length <= right.length ? [left,right] : [right,left];
  return short.length >= 10 && long.startsWith(short);
}
export function feedItems(frame,selectors) {
  if (!frame.nodes.some(node=>node.id===selectors.feedReady) || frame.nodes.some(node=>node.id===selectors.playerReady)) throw new Error('B 站不在已校准推荐列表');
  const items=[];
  for (const title of frame.nodes.filter(node=>node.id===selectors.feedTitle && node.text.trim() && !SENSITIVE_RE.test(node.text))) {
    // 卡片可能是没有 resource-id 的可点击 ViewGroup，往上找最近的可点击祖先，
    // 配了 feedCard 时才额外要求 id 一致。
    let target=null,cursor=title;
    for (let depth=0;depth<8;depth++) {
      if (!Number.isInteger(cursor.parent) || cursor.parent<0) break;
      cursor=frame.nodes[cursor.parent];
      if (cursor.clickable && cursor.enabled) {target=cursor;break;}
    }
    if (!target || (selectors.feedCard && target.id!==selectors.feedCard)) continue;
    const contains=node=>node.left>=target.left && node.top>=target.top && node.right<=target.right && node.bottom<=target.bottom;
    const kind=(target.description || '').split(',')[0].trim();
    const titles=frame.nodes.filter(node=>node.id===selectors.feedTitle && contains(node));
    const prohibited=frame.nodes.some(node=>contains(node) && /^(广告|推广|直播|付费|充电专属)$/.test(node.text.trim()));
    if (!prohibited && CARD_KINDS.has(kind) && contains(title) && titles.length===1
      && target.right>target.left && target.bottom>target.top) items.push({node:target,title:title.text.trim()});
  }
  return items;
}

export function createAndroidActivities({ runtime, config, isAllowed, device = createAdbDevice({config}),
  sleep = (ms,signal)=>delay(ms,undefined,{signal}), clock = ()=>performance.now(), onReceipt = ()=>{},
  clipAnalyzer = null }) {
  let worker=null, aborter=null, fault=null, closed=false, reconciling=false, progress=null;
  const allowedScope=scope=>scope==='public' || isAllowed(scope)===true;
  const execute = async operation => {
    const controller=new AbortController(); aborter=controller;
    const signal=controller.signal, started=clock(), day=runtime.androidBudget().day;
    let outcome='failed', fact='安卓活动已停止，未确认有效进展', stopped=false, result=null;
    const evidence=[];
    // 致命条件（权限、范围、额度、内存版本）一旦失效必须中止；时间预算不足则交给
    // 各活动自己收尾，否则"待够了自然离开"会被记成取消。
    const fatal=()=>{
      signal.throwIfAborted();
      const budget=runtime.androidBudget();
      if (closed || !runtime.mayExecute(operation.id,operation.epoch) || runtime.memoryVersion()!==operation.memoryVersion
        || !allowedScope(operation.scope) || !budget.awake || budget.timezoneChanged || budget.day!==day
        || clock()<started) throw new Error('安卓执行准入已失效');
    };
    const guard=()=>{fatal();if (clock()-started>=config.activitySeconds*1000) throw new Error('安卓执行准入已失效');};
    const options={guard,signal};
    const observe=async(shot=true)=>{guard();const frame=await device.observe(operation.kind,{...options,screenshot:shot});evidence.push('android-frame:'+frame.hash);return frame;};
    let actions=0;
    const gesture=async(frame,action,verify,kind)=>{
      if (actions >= config.maxActions) throw new Error('安卓活动动作额度已用完');
      let step;
      await device.gesture(operation.kind,frame,action,{...options,verify,
        beforeSend:fresh=>{guard();step=runtime.registerAndroidStep(operation.id,operation.epoch,kind,fresh.hash);actions++;}});
      return ()=>runtime.confirmAndroidStep(step);
    };
    let budgetExpired=false;
    const timer=setTimeout(()=>{budgetExpired=true;controller.abort();},config.activitySeconds*1000);
    try {
      guard();
      let launchStep;
      await device.launch(operation.kind,{...options,beforeSend:()=>{
        guard();launchStep=runtime.registerAndroidStep(operation.id,operation.epoch,'launch','0'.repeat(64));actions++;
      }});
      await sleep(500,signal);
      // 2048 一上来就要读棋盘像素；B 站这一步只看推荐列表结构。
      let frame=await observe(operation.kind==='game');
      runtime.confirmAndroidStep(launchStep);
      if (operation.kind==='game') {
        const stable=async first=>{
          const grid=read2048(first.image,config.game.board);
          await sleep(350,signal);
          const next=await observe(), checked=read2048(next.image,config.game.board);
          if (JSON.stringify(grid)!==JSON.stringify(checked)) throw new Error('2048 棋盘尚不稳定');
          return { frame:next,grid:checked };
        };
        let state=await stable(frame), moves=0, max=Math.max(...state.grid);
        while (actions<config.maxActions) {
          guard();const choice=choose2048(state.grid);
          if (!choice || max>=2048) break;
          const before=state.grid;
          const confirm=await gesture(state.frame,{type:'direction',direction:choice.direction},
            fresh=>JSON.stringify(read2048(fresh.image,config.game.board))===JSON.stringify(before),'move');
          await sleep(400,signal);
          state=await stable(await observe());
          if (!legalSuccessor(before,state.grid,choice.direction)) throw new Error('2048 未观察到合法后继，动作不得重放');
          confirm();moves++;max=Math.max(max,...state.grid);
          progress={kind:'game',confirmedMoves:moves,maxTile:max};
        }
        result={kind:'game',moves,maxTile:max,terminal:max>=2048?'reached-2048':choose2048(state.grid)?'bounded-stop':'no-legal-move'};
        if (!moves && result.terminal==='bounded-stop') throw new Error('2048 没有确认有效移动');
        fact='安卓 2048 已确认 '+moves+' 次合法移动，观察到最大方块 '+max+'；'+(max>=2048?'实际达到 2048':result.terminal==='no-legal-move'?'实际棋盘已无合法移动':'按本次活动上限停止，未声称通关');
      } else {
        const settings=config.bilibili, selectors=settings.selectors;
        let scrolls=0,waits=0,misses=0,skipped=0;const seen=[],seenTitles=[];
        const interests=runtime.project(operation.scope).psychology.interests.map(item=>item.topic.toLowerCase());
        // 命中兴趣越多的标题停得越久：真人也是感兴趣的看进去、没兴趣的瞄一眼就走。
        const planStay=topic=>{
          const score=interests.filter(word=>topic.toLowerCase().includes(word)).length;
          return score>=2?settings.deepWatchSeconds:score===1?Math.round((settings.watchSeconds+settings.deepWatchSeconds)/2):settings.watchSeconds;
        };
        const remainingMs=()=>config.activitySeconds*1000-(clock()-started);
        // 收尾还要 back、抓帧和复核播放态，不能把预算全花在观看上；短活动按比例留，避免预留吃掉全部预算。
        const RESERVE_MS=Math.min(15000,Math.round(config.activitySeconds*250));
        // 滚动只要求"不在播放器"：列表重载期间 recycler_view 会短暂消失，
        // 拿它当前置条件会把一次正常的等加载判成失败。
        const notInPlayer=fresh=>!fresh.nodes.some(node=>node.id===selectors.playerReady);
        const narrate=()=>{
          const total=seen.reduce((sum,item)=>sum+item.seconds,0);
          const detail=seen.map(item=>{
            const line='《'+item.title.slice(0,60)+'》停留 '+item.seconds+' 秒';
            return item.clip?line+'（画面内容：'+clipSummary(item.clip)+'）':line;
          }).join('；');
          // 有多少条真的看过画面要如实说，不能让"看了标题"冒充"看懂了内容"。
          const analyzed=seen.filter(item=>item.clip).length;
          const tail=analyzed
            ? '；其中 '+analyzed+' 条用 Seed 看过画面，其余只有播放态证据，都不代表完整看完'
            : '；媒体会话确认持续播放、画面持续变化，未分析画面或音轨，不代表完整看完';
          return '在安卓 B 站连续看了 '+seen.length+' 条、共 '+total+' 秒：'+detail+tail
            +(skipped?'；另有 '+skipped+' 条点开后不是列表里的那一条，已退出来换一条':'');
        };
        for (;;) {
          let items=[];
          // 返回列表后 B 站会短暂重载，此时既没有候选也不是错误；先等几轮再看，等不到才滚动。
          try {items=feedItems(frame,selectors);} catch {items=[];}
          if (!items.length) {
            if (waits<1 && remainingMs()>RESERVE_MS) {waits++;await sleep(1200,signal);frame=await observe(false);continue;}
            if (scrolls<settings.scrolls && actions<config.maxActions) {
              waits=0;
              const confirm=await gesture(frame,{type:'scroll'},notInPlayer,'scroll');
              await sleep(1500,signal);frame=await observe(false);confirm();scrolls++;continue;
            }
            break;
          }
          waits=0;
          items=items.filter(node=>!seenTitles.includes(node.title));
          if (!items.length) {
            // 这一屏都看过了：往下找新的，滚动额度用完才算真的到这儿。
            if (scrolls<settings.scrolls && actions<config.maxActions) {
              const confirm=await gesture(frame,{type:'scroll'},notInPlayer,'scroll');
              await sleep(1500,signal);frame=await observe(false);confirm();scrolls++;continue;
            }
            break;
          }
          if (seen.length>=settings.maxVideos || actions>=config.maxActions) break;
          items.sort((a,b)=>planStay(b.title)-planStay(a.title));
          const target=items[0];
          // 剩余预算不够一条完整观察时不再开新的，直接收尾，不把这次判成失败。
          const stay=Math.min(planStay(target.title),Math.floor((remainingMs()-RESERVE_MS)/1000));
          if (stay<settings.watchSeconds) break;
          // 点开之后到确认看完之间都可能"开错门"：广告跳转、直播、列表漂移。
          // 真人遇到这种情况是退出来换一条，所以这里只把硬条件当终止，其余都当跳过。
          let opened=null;
          try {
            // 复核只认"这一条还在列表里且标题一致"：列表会动态加载，节点索引和坐标
            // 都可能变，拿整个节点做全等比较会把正常刷新误判成画面不匹配。
            opened=await gesture(frame,{type:'tap',node:target.node,
              resolve:fresh=>feedItems(fresh,selectors).find(item=>sameTitle(item.title,target.title))?.node},
              fresh=>feedItems(fresh,selectors).some(node=>sameTitle(node.title,target.title)),'open');
            await sleep(1000,signal);frame=await observe(true);
            playerState(frame,selectors);
            // 真机播放器是自绘的，进度不可读；改用媒体会话的播放态与标题，加画面帧差和墙钟互证。
            const first=await device.playback('bilibili',options);
            if (first.state!=='PLAYING') throw new Error('B 站未确认在播放');
            if (!sameTitle(first.title,target.title)) throw new Error('B 站打开内容与推荐候选不匹配');
            opened();const watchStarted=clock(),startFrame=frame;
            // 录屏本身就是"正在看"：录制与分析的时间计入这次停留，剩下的时间继续安静看完。
            // 内容理解是补充层，拿不到就退回只有播放证据，不因此判定这次观看失败。
            let clip=null;
            const clipSeconds=clipAnalyzer&&settings.analyze?Math.min(settings.clipSeconds,stay):0;
            if (clipSeconds) {
              try {
                const bytes=await device.record('bilibili',{seconds:clipSeconds,guard,signal});
                clip=await clipAnalyzer(bytes,{guard});
                if (clip) evidence.push('android-clip:'+clip.topic.slice(0,24));
              } catch (error) {
                // 预算到点或准入失效必须照原样抛出，只有"内容没拿到"才降级。
                if (signal.aborted || /准入已失效/.test(error?.message ?? '')) throw error;
                // 降级要留原因，否则事后只能看到"没分析"而不知道卡在哪。
                evidence.push('android-clip-error:'+String(error?.message ?? 'unknown').slice(0,120));
                clip=null;
              }
            }
            // 观看途中只查致命条件：预算到点属于收尾，不是故障。
            for (let second=Math.round((clock()-watchStarted)/1000);second<stay;second++) {await sleep(1000,signal);fatal();}
            frame=await observe(true);
            playerState(frame,selectors);
            const last=await device.playback('bilibili',options);
            if (last.state!=='PLAYING') throw new Error('B 站播放已中断');
            if (!sameTitle(last.title,first.title)) throw new Error('B 站播放内容发生变化');
            const elapsed=Math.round((clock()-watchStarted)/1000), change=frameChange(startFrame.image,frame.image);
            if (change < MIN_FRAME_CHANGE) throw new Error('B 站画面未观察到推进');
            seen.push({title:target.title,seconds:elapsed,clip});seenTitles.push(target.title);
            result={kind:'bilibili',videos:seen.length,totalSeconds:seen.reduce((sum,item)=>sum+item.seconds,0),items:seen,
              frameChange:Math.round(change*1000)/1000,analyzed:seen.filter(item=>item.clip).length};
            progress={kind:'bilibili',confirmedVideos:seen.length,observedSeconds:result.totalSeconds};
            fact=narrate();misses=0;
            if (seen.length>=settings.maxVideos || actions>=config.maxActions) break;
            const returned=await gesture(frame,{type:'back'},fresh=>{playerState(fresh,selectors);return true;},'back');
            // 返回后列表会重载，不在这里断言候选；下一轮会自己等待并重试。
            await sleep(1200,signal);frame=await observe(false);returned();
          } catch (error) {
            const message=String(error?.message ?? 'unknown');
            // 点出去的这一步已经落到设备上了，必须先结清：留着未决记录会让后面退出列表
            // 的 back 注册不进去，反倒把"换一条"变成"整场结束"。
            try {opened?.();} catch {}
            // 预算到点、准入失效、动作额度用完：这些不是"这一条没看成"，是整场结束。
            if (signal.aborted || budgetExpired || /准入已失效|动作额度/.test(message)) throw error;
            misses++;skipped++;
            evidence.push('android-skip:'+target.title.slice(0,24)+'@'+message.slice(0,40));
            seenTitles.push(target.title);
            // 连续开错说明页面已经不是我认得的那个结构了，再点只是白花额度。
            if (misses>MAX_MISSES) throw error;
            await sleep(800,signal);frame=await observe(false);
            // 还在播放器里就先退出来，下一轮继续从列表里挑；退不回去会自己抛错收尾。
            if (frame.nodes.some(node=>node.id===selectors.playerReady)) {
              const back=await gesture(frame,{type:'back'},fresh=>{playerState(fresh,selectors);return true;},'back');
              await sleep(1200,signal);frame=await observe(false);back();
            }
          }
        }
        if (!seen.length) throw new Error('B 站没有已确认的播放观察');
      }
      guard();outcome='completed';
    } catch (error) {
      let invalid=true;try {invalid=runtime.status().paused || runtime.memoryVersion()!==operation.memoryVersion;} catch {}
      // 预算自然耗尽不是故障：已确认的观看仍然成立，保留已写好的叙述，只是提前收尾。
      // 用墙钟判断而不只靠 abort 标志，设备变慢导致的越界也走同一条路径。
      const bounded=(budgetExpired || clock()-started>=config.activitySeconds*1000) && result!==null;
      if (bounded) outcome='completed';
      else if (result!==null && !signal.aborted && !invalid) {
        // 已经确认的观看不会因为之后的滚动或收尾失败而作废：
        // 记成完成并如实标注提前结束的原因，而不是把看过的东西丢掉。
        outcome='completed';
        fact=fact+'（活动提前结束：'+String(error?.message ?? '未知原因').slice(0,60)+'；此前已确认的观看仍然成立）';
      }
      else {
        outcome=signal.aborted || invalid ? 'cancelled':'failed';
        fact='安卓活动已停止；取消前或异常界面的内容未作为完成事实提交';
        result=null;
        if (outcome==='failed') {
          fault='android-observation-or-action-failed';
          // 失败原因必须落进证据，否则事后只剩一个无法复盘的故障码。
          evidence.push('android-error:'+String(error?.message ?? 'unknown').slice(0,120));
        }
      }
    } finally {
      clearTimeout(timer);
      // 清理不沿用已中止的动作信号；只有应用退出证据才释放持久任务。
      try { await device.stop(operation.kind); stopped=true; }
      catch { fault='android-stop-unconfirmed'; outcome='unknown'; fact='安卓应用停止未确认，保留设备占用等待人工核对'; }
      try {
        runtime.recordReceipt(operation.id,{id:randomUUID(),epoch:operation.epoch,outcome,fact,
          evidence:[...new Set(evidence)].slice(-8).concat(stopped?'android-app-stopped':'android-stop-unconfirmed')},
          {androidStopped:stopped,androidSeconds:Math.max(0,Math.ceil((clock()-started)/1000))});
        if (stopped) onReceipt({source:'android-result',sourceId:operation.id,scope:operation.scope,summary:fact});
      } catch { fault='android-receipt-unconfirmed'; }
      aborter=null;
    }
    return {outcome,stopped,result};
  };
  return {
    status() { return {enabled:config.enabled,inFlight:worker!==null,reconciling,fault,progress,device:device.status?.() ?? null}; },
    candidates(scope) { return !closed && !fault && !worker && !reconciling && allowedScope(config.scope) ? runtime.androidCandidates(scope):[]; },
    async tick() {
      if (closed || fault || worker || reconciling || !config.enabled || runtime.status().paused || !allowedScope(config.scope)) return;
      if (runtime.androidJobs().some(job=>job.status==='unknown')) {fault='android-reconcile-required';return;}
      const operation=runtime.claimAndroidOperation();
      if (operation) { progress=null;worker=execute(operation).catch(()=>{fault='android-executor-unconfirmed';return {outcome:'unknown',stopped:false};}).finally(()=>{worker=null;}); }
    },
    async start(kind) {
      if (closed || fault || worker || reconciling || !allowedScope(config.scope)) throw new Error('安卓设备不可用');
      const operation=runtime.requestAndroidActivity(kind);await this.tick();return operation;
    },
    async stop() {
      aborter?.abort();await worker;
      for (const job of runtime.androidJobs()) if (job.status==='prepared') runtime.discardPlannedAndroid(job.id);
      return this.status();
    },
    async reconcile() {
      if (reconciling) throw new Error('安卓正在核对');
      reconciling=true;
      try {
        await this.stop();
        for (const job of runtime.androidJobs()) {
          if (job.status==='prepared') {runtime.discardPlannedAndroid(job.id);continue;}
          if (job.deviceId!==config.deviceId) throw new Error('旧任务设备绑定与当前配置不同');
          await device.stop(job.kind);
          runtime.recordReceipt(job.id,{id:randomUUID(),epoch:'reconcile',outcome:'cancelled',
            fact:'中断后已确认安卓应用停止；此前动作结果没有重放或补造',evidence:['android-app-stopped-after-reconcile']},
            {reconcile:true,androidStopped:true});
        }
        fault=null;progress=null;return this.status();
      } catch {fault='android-reconcile-unconfirmed';throw new Error('安卓停止核对未完成');}
      finally {reconciling=false;}
    },
    async settled() {await worker;},
    async close() {closed=true;await this.stop();},
  };
}
