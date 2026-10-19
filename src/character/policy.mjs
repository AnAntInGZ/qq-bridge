// 信息范围由宿主登记，模型不能通过提案扩大可见范围。
export function normalizeScope(value) {
  if (typeof value === 'string' && (value === 'public' || value === 'internal' || /^(group|private):[1-9]\d*$/.test(value))) return value;
  throw new Error('角色信息范围无效');
}

export function visibleTo(source, target) {
  normalizeScope(source);
  normalizeScope(target);
  return target !== 'internal' && source !== 'internal' && (source === 'public' || source === target);
}

export function intersectScopes(...scopes) {
  return scopes.map(normalizeScope).reduce((left, right) => {
    if (left === 'public') return right;
    if (right === 'public' || left === right) return left;
    return 'internal';
  }, 'public');
}

export function normalizeCharacterConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('character 配置必须为对象');
  const allowed = ['enabled', 'recentLimit'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('character 配置包含不支持的字段');
  const config = { enabled: false, recentLimit: 3, ...value };
  if (typeof config.enabled !== 'boolean') throw new Error('character.enabled 必须为布尔值');
  if (!Number.isInteger(config.recentLimit) || config.recentLimit < 1 || config.recentLimit > 5) {
    throw new Error('character.recentLimit 必须为 1 到 5 的整数');
  }
  return config;
}
