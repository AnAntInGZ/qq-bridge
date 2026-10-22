import path from 'node:path';
import { exact, integer, text } from './life-policy.mjs';
import { normalizeScope } from './policy.mjs';

export const ANDROID_APPS = Object.freeze({ game: 'com.uberspot.a2048', bilibili: 'tv.danmaku.bili' });
export const ANDROID_CANDIDATES = Object.freeze({ game: 'android:2048', bilibili: 'android:bilibili' });
export function normalizeAndroid(value = {}) {
  exact(value, ['enabled', 'adbPath', 'serial', 'deviceId', 'scope', 'width', 'height', 'dailySeconds', 'dailyActions', 'activitySeconds', 'maxActions', 'game', 'bilibili']);
  const config = { enabled: false, adbPath: 'adb', serial: '127.0.0.1:5555', deviceId: '', scope: 'internal',
    width: 720, height: 1280, dailySeconds: 0, dailyActions: 0, activitySeconds: 120, maxActions: 30, ...value };
  if (typeof config.enabled !== 'boolean' || typeof config.adbPath !== 'string'
    || (config.adbPath !== 'adb' && !path.isAbsolute(config.adbPath)) || config.adbPath.includes('\0')) throw new Error('安卓执行配置无效');
  if (typeof config.serial !== 'string' || !/^(127\.0\.0\.1:[1-9]\d{3,4}|emulator-[1-9]\d{3,4})$/.test(config.serial)
    || Number(config.serial.split(/[:-]/).at(-1)) > 65535) throw new Error('ADB 只能绑定本机固定设备');
  if (typeof config.deviceId!=='string' || (config.deviceId!=='' && !/^[a-f0-9]{16}$/.test(config.deviceId)) || (config.enabled && !config.deviceId)) throw new Error('启用安卓须绑定实际设备 Android ID');
  config.scope = normalizeScope(config.scope);
  integer(config.width, 320, 1440); integer(config.height, 480, 2560);
  integer(config.dailySeconds, 0, 86400); integer(config.dailyActions, 0, 10000);
  integer(config.activitySeconds, 10, 600); integer(config.maxActions, 1, 200);
  exact(config.game ?? {}, ['enabled', 'version', 'board']);
  config.game = { enabled: false, version: '', board: null, ...config.game };
  exact(config.bilibili ?? {}, ['enabled', 'version', 'selectors', 'watchSeconds', 'deepWatchSeconds', 'maxVideos', 'scrolls', 'analyze', 'clipSeconds']);
  // watchSeconds 是最短停留（划走也至少看这么久才能取证），deepWatchSeconds 是
  // 命中兴趣时的停留。留 0 表示未设置，跟随 watchSeconds，旧配置无需迁移。
  config.bilibili = { enabled: false, version: '', selectors: {}, watchSeconds: 20, deepWatchSeconds: 0, maxVideos: 1, scrolls: 1, analyze: false, clipSeconds: 8, ...config.bilibili };
  for (const app of [config.game, config.bilibili]) {
    if (typeof app.enabled !== 'boolean' || typeof app.version !== 'string' || app.version.length > 60 || /[\s;&|]/.test(app.version)) throw new Error('安卓应用版本无效');
    if (app.enabled && !app.version) throw new Error('启用应用必须固定实际版本');
  }
  if (config.game.board !== null) {
    exact(config.game.board, ['left', 'top', 'size', 'gap']);
    const board = config.game.board;
    integer(board.left, 0, config.width); integer(board.top, 0, config.height);
    integer(board.size, 160, config.width); integer(board.gap, 3, 60);
    if (board.left + board.size > config.width || board.top + board.size > config.height || board.size <= board.gap * 9) throw new Error('2048 棋盘校准越界');
  }
  if (config.game.enabled && !config.game.board) throw new Error('2048 必须先校准棋盘');
  // feedCard 允许留空：真机推荐流卡片是可点击 ViewGroup 且没有 resource-id，
  // 留空表示按"标题的最近可点击祖先"定位。详情页没有可靠的视频标题节点
  // （resource-id=title 是合集名/UP 主名），标题改由媒体会话提供，故不再校准 playerTitle。
  const names = ['feedReady', 'feedTitle', 'feedCard', 'playerReady'];
  exact(config.bilibili.selectors, names);
  for (const [key, id] of Object.entries(config.bilibili.selectors)) {
    if (key === 'feedCard' && id === '') continue;
    if (typeof id !== 'string' || !/^tv\.danmaku\.bili:id\/[a-zA-Z0-9_]+$/.test(id)) throw new Error('B 站选择器必须是本包资源编号');
  }
  if (config.bilibili.enabled && names.some(key => key !== 'feedCard' && !config.bilibili.selectors[key])) throw new Error('B 站必须先校准完整界面');
  if (!config.bilibili.deepWatchSeconds) config.bilibili.deepWatchSeconds = config.bilibili.watchSeconds;
  integer(config.bilibili.watchSeconds, 2, 120);
  // 单条最长停留受活动总预算约束，这里封顶 300 秒；实际上限由 activitySeconds 再收一次。
  integer(config.bilibili.deepWatchSeconds, config.bilibili.watchSeconds, 300);
  integer(config.bilibili.maxVideos, 1, 8); integer(config.bilibili.scrolls, 0, 6);
  // 录屏发生在停留时间内，比最短停留还长会把"看了多久"这个事实本身撑大，所以直接拒绝。
  if (typeof config.bilibili.analyze !== 'boolean') throw new Error('B 站录屏分析开关无效');
  integer(config.bilibili.clipSeconds, 4, 15);
  if (config.bilibili.analyze && config.bilibili.clipSeconds > config.bilibili.watchSeconds) throw new Error('B 站录屏时长不能超过最短停留');
  if (config.enabled && (config.scope === 'internal' || (!config.game.enabled && !config.bilibili.enabled)
    || config.dailySeconds < config.activitySeconds || config.dailyActions < config.maxActions)) throw new Error('启用安卓须指定范围、应用及足够的设备额度');
  return config;
}
export function appConfig(config, kind) { if (!ANDROID_APPS[kind]) throw new Error('不支持的安卓应用'); return kind === 'game' ? config.game : config.bilibili; }
export function versionText(value) { return text(value, 60); }
