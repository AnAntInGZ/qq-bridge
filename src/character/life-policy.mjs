import { normalizeScope } from './policy.mjs';

export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('角色请求字段无效');
}
export function text(value, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('角色记录文本无效');
  return value.trim();
}
export function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('角色数值超出范围');
  return value;
}
export function normalizeAutonomy(value = {}) {
  exact(value, ['enabled', 'timezone', 'activeHours', 'idleMs', 'dailyDecisions', 'dailyTokens', 'dailyCostMicros', 'roundTokens', 'roundCostMicros']);
  const config = { enabled: false, timezone: 'Asia/Shanghai', activeHours: [], idleMs: 900000,
    dailyDecisions: 0, dailyTokens: 0, dailyCostMicros: 0, roundTokens: 0, roundCostMicros: 0, ...value };
  if (typeof config.enabled !== 'boolean' || typeof config.timezone !== 'string') throw new Error('自主配置无效');
  config.timezone = new Intl.DateTimeFormat('en', { timeZone: config.timezone }).resolvedOptions().timeZone;
  if (!Array.isArray(config.activeHours) || config.activeHours.length > 4) throw new Error('角色作息无效');
  config.activeHours = config.activeHours.map(window => {
    exact(window, ['start', 'end']);
    for (const time of [window.start, window.end]) if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('角色作息时间无效');
    return { start: window.start, end: window.end };
  });
  integer(config.idleMs, 60000, 86400000);
  for (const key of ['dailyDecisions', 'dailyTokens', 'dailyCostMicros', 'roundTokens', 'roundCostMicros']) integer(config[key], 0, 1000000000);
  if (config.enabled && (!config.activeHours.length || !config.dailyDecisions || !config.roundTokens || !config.roundCostMicros
    || config.roundTokens > config.dailyTokens || config.roundCostMicros > config.dailyCostMicros)) throw new Error('启用自主决策须配置作息和完整额度');
  return config;
}
export function localParts(at, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]));
  return { day: parts.year + '-' + parts.month + '-' + parts.day, clock: parts.hour + ':' + parts.minute };
}
export function awake(at, config) {
  const { clock } = localParts(at, config.timezone);
  return config.activeHours.some(({ start, end }) => start === end || (start < end ? clock >= start && clock < end : clock >= start || clock < end));
}
export function normalizeSeeds(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('初始兴趣无效');
  const result = value.map(item => { exact(item, ['topic', 'score', 'scope']); return { topic: text(item.topic, 50), score: integer(item.score, -20, 20), scope: normalizeScope(item.scope) }; });
  if (new Set(result.map(item => item.scope + ':' + item.topic)).size !== result.length) throw new Error('初始兴趣重复');
  return result;
}
