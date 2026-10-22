import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ANDROID_APPS, appConfig } from './android-policy.mjs';
import { decodeScreenshot } from './android-image.mjs';

function decodeEntity(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (_, entity) => {
    const named = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
    if (named[entity]) return named[entity];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    // 单个坏码点不该让整次观察失败：uiautomator 会把控制字符和截断的代理对
    // 也写成实体，B 站推广文本里实际出现过。替换成占位符，仍然只当数据看。
    if (!Number.isSafeInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code < 32) return '';
    return String.fromCodePoint(code);
  });
}
export function parseAndroidUI(xml, width, height) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1024*1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)
    || !/<hierarchy\b/.test(xml) || !/<\/hierarchy>\s*$/.test(xml)) throw new Error('安卓 UI 层次无效');
  const nodes = [], stack = [];
  for (const match of xml.matchAll(/<\/node\s*>|<node\b([^<>]*)>/g)) {
    if (match[1] === undefined) {if (!stack.length) throw new Error('安卓 UI 层次不平衡');stack.pop();continue;}
    const attrs = {};
    for (const pair of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (Object.hasOwn(attrs,pair[1])) throw new Error('安卓 UI 属性重复');
      attrs[pair[1]] = decodeEntity(pair[2]);
    }
    const rect = /^\[(\d+),(\d+)]\[(\d+),(\d+)]$/.exec(attrs.bounds || '');
    if (!rect) throw new Error('安卓 UI 坐标无效');
    const [left,top,right,bottom] = rect.slice(1).map(Number);
    if (left > right || top > bottom || right > width || bottom > height) throw new Error('安卓 UI 画面越界');
    nodes.push({ id: attrs['resource-id'] || '', text: (attrs.text || '').slice(0,500), description: (attrs['content-desc'] || '').slice(0,500),
      package: attrs.package || '', class: attrs.class || '', clickable: attrs.clickable === 'true', enabled: attrs.enabled === 'true',
      left,top,right,bottom,parent:stack.at(-1) ?? -1 });
    if (!/\/\s*$/.test(match[1])) stack.push(nodes.length-1);
    if (nodes.length > 3000) throw new Error('安卓 UI 节点过多');
  }
  if (!nodes.length || stack.length) throw new Error('安卓 UI 没有完整可观察节点');
  return nodes;
}
export function assertKnownUI(nodes, packageName) {
  if (nodes.some(node => node.package && ![packageName, 'com.android.systemui'].includes(node.package))
    || nodes.some(node => /EditText|Dialog/.test(node.class) || /(?:dialog|popup|captcha|login|purchase|payment|advert)/i.test(node.id)
      || /^(?:请先登录|登录后|验证码|立即支付|确认购买|同意并继续|青少年模式|跳过广告|允许.*权限)/.test(node.text))) throw new Error('安卓出现需人工处理的界面');
}
// B 站详情页的 resource-id=title 其实是合集名、UP 主名和推荐标题，真正的视频标题只在
// 媒体会话的 metadata 里。这里按包名取播放态和标题：state 判断在播，title 用来核对点开的是哪条。
export function parsePlaybackState(text, packageName) {
  if (typeof text !== 'string' || !text) return null;
  for (const block of text.split('package=').slice(1)) {
    const head = block.slice(0, block.indexOf('\n'));
    if (!head || head.trim() !== packageName) continue;
    const scope = block.slice(0, 4000);
    const state = /state=PlaybackState \{state=(\w+)\((-?\d+)\)/.exec(scope);
    if (!state) return null;
    const meta = /metadata: size=\d+, description=([^\n]*)/.exec(scope);
    // 描述形如「标题, 自动连播(61/61), null」，按英文逗号加空格切第一段。
    const title = meta ? meta[1].split(', ')[0].trim() : '';
    return { state: state[1], code: Number(state[2]), title };
  }
  return null;
}
function runAdb(executable, args, { signal, timeout = 10000, tolerateExit = [], maxBuffer = 8*1024*1024 } = {}) {
  return new Promise((resolve,reject) => {
    // execFile 不经过宿主 shell；等进程结束回执，不用定时器提前释放设备占用。
    execFile(executable,args,{ encoding:'buffer', windowsHide:true, timeout, maxBuffer, signal },(error,stdout,stderr) => {
      if (error && !(args.includes('pidof') && error.code === 1 && !stdout.length) && !tolerateExit.includes(error.code)) {
        const detail = Buffer.from(stderr ?? '').toString('utf8').replace(/\s+/g,' ').trim().slice(0,160);
        const reason = error.killed || error.signal ? '命令超时' : String(error.code ?? 'unknown');
        const failure = new Error('安卓命令失败或退出未确认（' + reason + (detail ? '：' + detail : '') + '）');
        // 保留原始退出码，调用方据此区分"可安全重试的模拟器崩溃"和真实失败。
        failure.adbExit = error.code;
        reject(failure);
      }
      else resolve(Buffer.from(stdout));
    });
  });
}
export function createAdbDevice({ config, execute = runAdb, now = Date.now }) {
  let busy = false;
  const call = async (args, { guard = () => {}, signal, tolerateExit, timeout, maxBuffer, retryExit = [] } = {}) => {
    guard(); signal?.throwIfAborted();
    if (busy) throw new Error('安卓命令仍在执行');
    busy = true;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await execute(config.adbPath,['-s',config.serial,...args],
            { signal, tolerateExit, ...(timeout ? { timeout } : {}), ...(maxBuffer ? { maxBuffer } : {}) });
          guard(); signal?.throwIfAborted(); return result;
        } catch (error) {
          // MuMu 的 adb shell 会偶发 SIGBUS(135)：只读命令和滚动重试一次没有副作用，
          // 点击和返回不在 retryExit 里，仍然一次失败就停，绝不重放有副作用的动作。
          if (attempt === 0 && error.adbExit !== undefined && retryExit.includes(error.adbExit)) continue;
          throw error;
        }
      }
    }
    finally { busy = false; }
  };
  // 只读观察命令统一容忍一次模拟器 SIGBUS(135)：重试不会改变屏幕或任何数据。
  const steady = options => ({ ...options, retryExit: [135] });
  const checkIdentity=async options=>{
    const id=(await call(['shell','settings','get','secure','android_id'],steady(options))).toString('utf8').trim();
    if (!config.deviceId || id!==config.deviceId) throw new Error('安卓设备身份不匹配');
  };
  const prepare=async options=>{
      if (config.serial.startsWith('127.0.0.1:')) {
        const connected=(await call(['connect',config.serial],options)).toString('utf8');
        if (!connected.includes('connected to '+config.serial)) throw new Error('安卓转发设备未连接');
      }
      if ((await call(['get-state'],options)).toString('utf8').trim() !== 'device') throw new Error('安卓设备未授权或离线');
    await checkIdentity(options);
  };
  const checkVersion = async (kind, options) => {
    const output = (await call(['shell','dumpsys','package',ANDROID_APPS[kind]],steady(options))).toString('utf8');
    const versions = [...output.matchAll(/\bversionName=([^\s]+)/g)].map(match=>match[1]);
    if (!versions.length || versions.some(value=>value !== appConfig(config,kind).version)) throw new Error('安卓应用版本不匹配');
  };
  const checkFocus = async (kind,options) => {
    // Android 15 起 dumpsys window windows 不再输出 mCurrentFocus，只有全量的 dumpsys window 有；
    // 两个版本的输出都在 40KB 以内，统一用全量输出，避免按版本分支。
    const output = (await call(['shell','dumpsys','window'],steady(options))).toString('utf8');
    const current = /mCurrentFocus=Window\{[^}]*\s([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+}/.exec(output);
    if (!current || current[1] !== ANDROID_APPS[kind]) throw new Error('安卓应用焦点已变化');
  };
  // 截图先落设备本地再 pull：同样 1.5MB，exec-out 经隧道要 29 秒，pull 只要 3.6 秒。
  // 瓶颈在流式回传的小包往返，不在设备编码，所以换传输方式就够了。
  const screenshot = async options => {
    const remote = '/data/local/tmp/qq-bridge-shot.png';
    const local = path.join(os.tmpdir(), 'qq-bridge-shot-' + process.pid + '-' + now() + '.png');
    try {
      await call(['shell','rm','-f',remote],steady(options));
      await call(['shell','screencap','-p',remote],{...steady(options),timeout:30000});
      await call(['pull',remote,local],{...steady(options),timeout:60000});
      return await fs.promises.readFile(local);
    } finally {
      // 清理不带中止信号，否则中断后就清不掉本地和远端临时文件。
      await fs.promises.rm(local,{force:true}).catch(()=>{});
      try { await call(['shell','rm','-f',remote]); } catch {}
    }
  };
  return {
    async launch(kind,options) {
      if (!appConfig(config,kind).enabled) throw new Error('安卓应用未启用');
      await prepare(options);
      await checkVersion(kind,options);
      const resolved=(await call(['shell','cmd','package','resolve-activity','--brief','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER',ANDROID_APPS[kind]],options)).toString('utf8');
      const components=resolved.split(/\r?\n/).map(line=>line.trim()).filter(line=>line.startsWith(ANDROID_APPS[kind]+'/') && /^[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.]+$/.test(line));
      if (components.length!==1) throw new Error('安卓启动入口无法唯一确认');
      options?.guard?.();options?.signal?.throwIfAborted();await options?.beforeSend?.();
      await call(['shell','am','start','-W','-n',components[0],'-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER'],options);
    },
    async observe(kind,options={}) {
      await checkIdentity(options);
      await checkVersion(kind,options); await checkFocus(kind,options);
      const observedAt=now();
      // 2048 靠像素读棋盘，必须截图；B 站只在判断"画面有没有推进"时需要，
      // 其余观察只看 UI 树和媒体会话，省下每次好几秒的传输。
      const png = options.screenshot===false ? null : await screenshot(options);
      const image = png ? decodeScreenshot(png,config.width,config.height) : null;
      const target = '/data/local/tmp/qq-bridge-window.xml';
      let xml;
      try {
        // 先删旧文件：MuMu 上的 Android 15 会在 dump 写完后段错误退出（139），
        // 文件其实已完整落盘。容忍该退出码，改用 XML 完整性校验作为唯一判据。
        await call(['shell','rm','-f',target],steady(options));
        await call(['shell','uiautomator','dump','--compressed',target],{...steady(options),tolerateExit:[139]});
        xml=(await call(['exec-out','cat',target],steady(options))).toString('utf8');
      } finally { await call(['shell','rm','-f',target]); }
      const nodes = parseAndroidUI(xml,config.width,config.height);
      assertKnownUI(nodes,ANDROID_APPS[kind]); await checkFocus(kind,options);
      // 阈值按隧道上实际拉一张 1080p 截图的时间放宽；再慢就说明链路异常。
      if (now()-observedAt>25000 || now()<observedAt) throw new Error('安卓观察耗时过长');
      const digest = createHash('sha256').update(xml);
      if (png) digest.update(png);
      return { image, nodes, at:now(), hash:digest.digest('hex') };
    },
    async playback(kind,options) {
      if (!ANDROID_APPS[kind]) throw new Error('安卓播放状态目标无效');
      const output = (await call(['shell','dumpsys','media_session'],options)).toString('utf8');
      const state = parsePlaybackState(output, ANDROID_APPS[kind]);
      if (!state) throw new Error('安卓媒体会话不可用');
      return state;
    },
    // 录一小段现场画面交给 Seed 做内容理解。screenrecord 会阻塞整个录制时长，
    // 期间 busy 锁一直被占着，这正好对应"人正盯着屏幕看"这件事本身。
    async record(kind, options = {}) {
      if (!ANDROID_APPS[kind]) throw new Error('安卓录屏目标无效');
      const seconds = options.seconds;
      if (!Number.isInteger(seconds) || seconds < 3 || seconds > 15) throw new Error('安卓录屏时长不在允许范围');
      const { guard, signal } = options;
      const remote = '/data/local/tmp/qq-bridge-clip.mp4';
      await call(['shell', 'rm', '-f', remote], { guard, signal });
      try {
        // 码率压到 3Mbps：这个清晰度足够判断内容类型，8 秒约 3MB，上传和费用都可控。
        await call(['shell', 'screenrecord', '--time-limit', String(seconds), '--bit-rate', '3000000', remote],
          { guard, signal, timeout: (seconds + 20) * 1000 });
        const bytes = await call(['exec-out', 'cat', remote], { guard, signal, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        // MP4 的 ftyp box 在偏移 4 处，和上传前的格式判定用同一条规则。
        if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') throw new Error('安卓录屏文件无效');
        return bytes;
      } finally {
        // 清理不沿用已中止的信号，否则中断后就清不掉远端临时文件。
        try { await call(['shell', 'rm', '-f', remote]); } catch {}
      }
    },
    async gesture(kind, frame, action, { guard, signal, verify, beforeSend } = {}) {
      if (!frame || now()-frame.at > 8000 || now() < frame.at) throw new Error('安卓观察已过期');
      const options = { guard, signal };
      // 动作前的复核只比对 UI 结构，不取截图；2048 的合法性要靠像素，仍会截。
      const fresh = await this.observe(kind,{...options, ...(kind==='game' ? {} : {screenshot:false})});
      if (typeof verify !== 'function' || verify(fresh) !== true) throw new Error('安卓动作前画面不再匹配');
      let args;
      if (action.type === 'direction' && kind === 'game' && ['up','down','left','right'].includes(action.direction)) {
        const board=config.game.board, x=Math.round(board.left+board.size/2), y=Math.round(board.top+board.size/2), length=Math.round(board.size/3);
        const vector={up:[0,-length],down:[0,length],left:[-length,0],right:[length,0]}[action.direction];
        args=['shell','input','swipe',String(x),String(y),String(x+vector[0]),String(y+vector[1]),'200'];
      } else if (action.type === 'tap' && kind === 'bilibili') {
        // 列表刷新会改变坐标，允许调用方按内容在最新画面上重新定位目标。
        const selectors=config.bilibili.selectors;
        const node=typeof action.resolve==='function'?action.resolve(fresh):action.node;
        // 比对可视属性而不是整个节点：parent 是父节点索引，列表刷新后会整体位移。
        const matches=item=>item.clickable && item.enabled && item.id===node?.id
          && item.left===node?.left && item.top===node?.top && item.right===node?.right && item.bottom===node?.bottom;
        if (!node || !node.clickable || !node.enabled || node.right <= node.left || node.bottom <= node.top
          || !fresh.nodes.some(matches)) throw new Error('B 站点击不属于已校准候选');
        // 卡片没有 resource-id 时按结构校验：命中区域不能过大，且范围内只能有一个已校准标题，
        // 避免点到整页容器或一次覆盖多条候选。配了 feedCard 时仍要求 id 一致。
        if ((node.right-node.left)*(node.bottom-node.top) > config.width*config.height*0.3) throw new Error('B 站点击目标区域过大');
        if (selectors.feedCard && node.id !== selectors.feedCard) throw new Error('B 站点击不属于已校准候选');
        const covered=fresh.nodes.filter(item=>item.id===selectors.feedTitle && item.left>=node.left && item.top>=node.top
          && item.right<=node.right && item.bottom<=node.bottom);
        if (covered.length !== 1) throw new Error('B 站点击目标标题不唯一');
        args=['shell','input','tap',String(Math.floor((node.left+node.right)/2)),String(Math.floor((node.top+node.bottom)/2))];
      } else if (action.type === 'back' && kind === 'bilibili') args=['shell','input','keyevent','4'];
      else if (action.type === 'scroll' && kind === 'bilibili') args=['shell','input','swipe',String(Math.round(config.width/2)),String(Math.round(config.height*0.7)),String(Math.round(config.width/2)),String(Math.round(config.height*0.3)),'350'];
      else throw new Error('安卓动作不在白名单');
      guard?.(); signal?.throwIfAborted(); await beforeSend?.(fresh);
      // 滚动是可重放的导航动作，模拟器崩溃时值得重试一次；点击和返回不重试。
      await call(args,action.type==='scroll'?{...options,retryExit:[135]}:options);
    },
    async stop(kind) {
      if (!ANDROID_APPS[kind]) throw new Error('安卓停止目标无效');
      await prepare();
      await call(['shell','am','force-stop',ANDROID_APPS[kind]]);
      const pids=(await call(['shell','pidof',ANDROID_APPS[kind]])).toString('utf8').trim();
      const processes=(await call(['shell','ps','-A','-o','NAME'])).toString('utf8').split(/\s+/);
      await call(['shell','rm','-f','/data/local/tmp/qq-bridge-window.xml']);
      if (pids || processes.some(name=>name===ANDROID_APPS[kind] || name.startsWith(ANDROID_APPS[kind]+':'))) throw new Error('安卓应用停止未确认');
    },
    status() { return { commandInFlight:busy }; },
  };
}
