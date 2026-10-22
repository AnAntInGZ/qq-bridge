import { SENSITIVE_RE } from '../sensitive.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { visibleTo, intersectScopes, normalizeScope } from './policy.mjs';
import { exact, text, integer, localParts, awake } from './life-policy.mjs';

function modelText(value, max) {
  const result = text(value, max);
  if (SENSITIVE_RE.test(result)) throw new Error('角色感想包含不可投影的敏感文本');
  return result;
}

export const LIFE_SCHEMA = `
  CREATE TABLE life_attempts (round_id TEXT PRIMARY KEY, day TEXT NOT NULL, tokens INTEGER NOT NULL,
    cost INTEGER NOT NULL, actual_tokens INTEGER, status TEXT NOT NULL, estimated_cost INTEGER) STRICT;
  CREATE TABLE life_appraisals (source_id TEXT PRIMARY KEY, scope TEXT NOT NULL, mood TEXT NOT NULL,
    interests TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
  CREATE TABLE life_memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, sources TEXT NOT NULL,
    source_key TEXT NOT NULL, fact TEXT NOT NULL, reflection TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(scope, source_key)) STRICT;
  CREATE TABLE life_invalidations (scope TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
  CREATE TABLE life_mutations (id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE life_observations (event_id TEXT PRIMARY KEY, experience_id TEXT NOT NULL UNIQUE) STRICT;
  CREATE TABLE life_sessions (id TEXT PRIMARY KEY, round_id TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL) STRICT;
  CREATE TABLE life_origins (activity_id TEXT PRIMARY KEY, round_id TEXT NOT NULL) STRICT;
  ALTER TABLE rounds ADD COLUMN memory_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rounds ADD COLUMN source_ids TEXT NOT NULL DEFAULT '[]';
`;

export class LifeStore {
  #db; #now; #options; #directory; #get; #set;
  constructor({ db, now, options, directory, get, set }) {
    this.#db = db; this.#now = now; this.#options = options; this.#directory = directory; this.#get = get; this.#set = set;
  }
  clock() {
    const now = Math.max(this.#now(), Number(this.#get('life-clock') || 0));
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('角色时钟无效');
    this.#set('life-clock', String(now));
    return now;
  }
  memoryVersion() { return Number(this.#get('memory-version') || 0); }
  budget() {
    const config = this.#options.autonomy;
    const now = this.clock();
    const day = localParts(now, config.timezone).day;
    const row = this.#db.prepare("SELECT count(*) AS attempts, coalesce(sum(tokens),0) AS tokens, coalesce(sum(cost),0) AS cost, sum(CASE WHEN status!='settled' OR estimated_cost IS NULL THEN 1 ELSE 0 END) AS unknown FROM life_attempts WHERE day=?").get(day);
    const timezoneChanged = !!this.#get('budget-timezone') && this.#get('budget-timezone') !== config.timezone;
    const pendingInvalidation = Boolean(this.#db.prepare('SELECT scope FROM life_invalidations LIMIT 1').get());
    return { day, timezone: config.timezone, attempts: row.attempts, reservedTokens: row.tokens, reservedCostMicros: row.cost,
      unknown: row.unknown || 0, awake: awake(now, config), timezoneChanged,
      allowed: config.enabled && !timezoneChanged && !pendingInvalidation && awake(now, config)
        && row.attempts < config.dailyDecisions && row.tokens + config.roundTokens <= config.dailyTokens
        && row.cost + config.roundCostMicros <= config.dailyCostMicros };
  }
  reserve(roundId) {
    const budget = this.budget();
    if (!budget.allowed) throw new Error('角色作息或自主额度不允许决策');
    this.#set('budget-timezone', this.#options.autonomy.timezone);
    this.#db.prepare("INSERT INTO life_attempts(round_id, day, tokens, cost, actual_tokens, status) VALUES (?, ?, ?, ?, NULL, 'reserved')")
      .run(roundId, budget.day, this.#options.autonomy.roundTokens, this.#options.autonomy.roundCostMicros);
  }
  settle(roundId, tokens, costMicros = null) {
    const prior = this.#db.prepare('SELECT * FROM life_attempts WHERE round_id=?').get(roundId);
    if (!prior) return;
    if (tokens !== null) integer(tokens, 0, 1000000000);
    if (costMicros !== null) integer(costMicros, 0, 1000000000);
    if (prior.status === 'settled') {
      if (prior.actual_tokens !== tokens || prior.estimated_cost !== costMicros) throw new Error('角色用量结算冲突');
      return;
    }
    // 费用没有权威回执时保留全额预留；实际用量超出估计则提高占用，阻止后续透支。
    const charged = tokens === null ? prior.tokens : Math.max(tokens, prior.tokens);
    this.#db.prepare('UPDATE life_attempts SET tokens=?, cost=?, actual_tokens=?, status=?, estimated_cost=? WHERE round_id=?')
      .run(charged, costMicros === null ? prior.cost : Math.max(costMicros, prior.cost), tokens, tokens === null ? 'unknown' : 'settled', costMicros, roundId);
  }
  canContinue(roundId) {
    const budget = this.budget();
    return this.#options.autonomy.enabled && budget.awake && !budget.timezoneChanged && !this.invalidations().length
      && budget.reservedTokens <= this.#options.autonomy.dailyTokens && budget.reservedCostMicros <= this.#options.autonomy.dailyCostMicros
      && Boolean(this.#db.prepare('SELECT round_id FROM life_attempts WHERE round_id=?').get(roundId));
  }
  trackSession(id, roundId, scope) { this.#db.prepare("INSERT INTO life_sessions VALUES (?, ?, ?, 'running')").run(text(id,100),text(roundId,100),normalizeScope(scope)); }
  retireSession(id) { this.#db.prepare("UPDATE life_sessions SET status='closed' WHERE id=?").run(id); }
  sessions() { return this.#db.prepare("SELECT id, round_id AS roundId, scope FROM life_sessions WHERE status!='closed'").all(); }
  recover() { this.#db.exec("UPDATE life_attempts SET status='unknown' WHERE status='reserved'"); }
  sources(scope, eventIds = [], experienceIds = null) {
    const events = eventIds.map(id => this.#db.prepare('SELECT id, scope, source, summary AS fact FROM events WHERE id=?').get(id))
      .filter(item => item && visibleTo(item.scope, scope)).map(item => ({ ...item, type: 'event' }));
    const experiences = (experienceIds === null ? this.#db.prepare('SELECT id, scope, fact, feeling, evidence FROM experiences WHERE scope IN (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT 20').all('public', scope)
      : experienceIds.map(id => this.#db.prepare('SELECT id, scope, fact, feeling, evidence FROM experiences WHERE id=?').get(id)).filter(item => item && visibleTo(item.scope, scope)))
      .map(item => ({ ...item, type: 'experience' }));
    return [...events, ...experiences];
  }
  validate(round, input) {
    const sources = this.sources(round.scope, JSON.parse(round.event_ids), JSON.parse(round.source_ids));
    const byId = new Map(sources.map(item => [item.id, item]));
    const appraisals = input.appraisals ?? [];
    if (!Array.isArray(appraisals) || appraisals.length > 2) throw new Error('角色感受数量无效');
    const normalized = appraisals.map(item => {
      exact(item, ['sourceId', 'mood', 'interests', 'reason']);
      const source = byId.get(item.sourceId);
      if (!source || source.source === 'idle') throw new Error('角色感受缺少实际可见依据');
      exact(item.mood ?? {}, ['valence', 'arousal', 'control', 'energy']);
      const mood = Object.fromEntries(['valence', 'arousal', 'control', 'energy'].map(key => [key, integer(item.mood?.[key] ?? 0, -5, 5)]));
      const interests = item.interests ?? [];
      if (!Array.isArray(interests) || interests.length > 3 || (interests.length && source.type !== 'experience')) throw new Error('兴趣变化须有实际经历');
      const changes = interests.map(change => { exact(change, ['topic', 'delta']); return { topic: modelText(change.topic, 50), delta: integer(change.delta, -2, 2) }; });
      if (new Set(changes.map(change => change.topic)).size !== changes.length) throw new Error('兴趣主题重复');
      const observation = source.type === 'experience' ? this.#db.prepare('SELECT event_id FROM life_observations WHERE experience_id=?').get(source.id) : null;
      if (observation && changes.some(change => Math.abs(change.delta) > 1)) throw new Error('聊天接触的兴趣变化不得超过一');
      return { sourceId: observation?.event_id ?? source.id, scope: intersectScopes(round.scope, source.scope), mood, interests: changes, reason: modelText(item.reason, 300) };
    });
    if (new Set(normalized.map(item => item.sourceId)).size !== normalized.length) throw new Error('角色依据重复');
    let memory = null;
    if (input.memory !== undefined) {
      exact(input.memory, ['sourceIds', 'reflection']);
      if (!Array.isArray(input.memory.sourceIds) || !input.memory.sourceIds.length || input.memory.sourceIds.length > 5
        || new Set(input.memory.sourceIds).size !== input.memory.sourceIds.length) throw new Error('整理记忆的来源无效');
      const entries = input.memory.sourceIds.map(id => byId.get(id));
      if (entries.some(item => !item || item.type !== 'experience')) throw new Error('整理记忆须引用可见经历');
      memory = { sourceIds: entries.map(item => item.id).sort(), scope: intersectScopes(round.scope, ...entries.map(item => item.scope)),
        fact: entries.map(item => item.fact).join('；'), reflection: modelText(input.memory.reflection, 500) };
    }
    const nextAttentionMs = input.nextAttentionMs === undefined ? null : integer(input.nextAttentionMs, 60000, 86400000);
    return { appraisals: normalized, memory, nextAttentionMs };
  }
  apply(round, proposal) {
    const at = this.clock();
    for (const item of proposal.appraisals ?? []) {
      this.#db.prepare('INSERT OR IGNORE INTO life_appraisals VALUES (?, ?, ?, ?, ?, ?)')
        .run(item.sourceId, item.scope, JSON.stringify(item.mood), JSON.stringify(item.interests), item.reason, at);
    }
    const memory = proposal.memory;
    if (memory) {
      const key = createHash('sha256').update(JSON.stringify(memory.sourceIds)).digest('hex');
      this.#db.prepare('INSERT OR IGNORE INTO life_memories VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), memory.scope, JSON.stringify(memory.sourceIds), key, memory.fact, memory.reflection, at);
    }
    if (proposal.nextAttentionMs !== null && proposal.nextAttentionMs !== undefined) this.#set('next-attention', String(at + proposal.nextAttentionMs));
  }
  psychology(scope) {
    const at = this.clock();
    const mood = { valence: 50, arousal: 50, control: 50, energy: 70 };
    const interests = new Map();
    for (const seed of this.#options.interestSeeds) if (visibleTo(seed.scope, scope)) interests.set(seed.topic, seed.score);
    const reasons = [];
    for (const item of this.#db.prepare('SELECT * FROM life_appraisals WHERE scope IN (?, ?) ORDER BY created_at, rowid').all('public', scope)) {
      const elapsed = Math.max(0, at - item.created_at);
      const recovery = Math.pow(0.5, elapsed / 21600000);
      for (const [key, delta] of Object.entries(JSON.parse(item.mood))) mood[key] += delta * recovery;
      for (const change of JSON.parse(item.interests)) interests.set(change.topic, (interests.get(change.topic) || 0) + change.delta * Math.pow(0.5, elapsed / 2592000000));
      if (recovery > 0.01) reasons.push({ sourceId: item.source_id, reason: item.reason });
    }
    for (const key of Object.keys(mood)) mood[key] = Math.round(Math.min(100, Math.max(0, mood[key])) * 100) / 100;
    return { mood, interests: [...interests].map(([topic, score]) => ({ topic, score: Math.round(Math.min(100, Math.max(-100, score)) * 100) / 100 })).sort((a,b) => b.score-a.score), reasons: reasons.slice(-3) };
  }
  memories(scope, query = '') {
    normalizeScope(scope); if (scope === 'internal') throw new Error('内部记忆不可用于聊天');
    if (typeof query !== 'string' || query.length > 100) throw new Error('记忆查询无效');
    return this.#db.prepare('SELECT id, fact, reflection, sources, created_at AS createdAt FROM life_memories WHERE scope IN (?, ?) ORDER BY created_at DESC, rowid DESC').all('public', scope)
      .filter(item => !query || (item.fact + item.reflection).toLowerCase().includes(query.toLowerCase())).slice(0, 10)
      .map(item => ({ ...item, sourceIds: JSON.parse(item.sources), sources: undefined }));
  }
  invalidations() { return this.#db.prepare('SELECT scope, version FROM life_invalidations').all(); }
  acknowledge(scope, version) { this.#db.prepare('DELETE FROM life_invalidations WHERE scope=? AND version=?').run(scope, version); }
  journal() {
    const file = path.join(this.#directory, 'memory-mutations.json');
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('记忆删除清单边界无效');
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(entries) || entries.length > 10000) throw new Error('记忆删除清单无效');
    for (const entry of entries) {
      exact(entry, ['id', 'experienceId']);
      for (const id of [entry.id, entry.experienceId]) if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('记忆删除标识无效');
    }
    return entries;
  }
  prepareMutation(experienceId) {
    const entry = { id: randomUUID(), experienceId };
    const entries = [...this.journal(), entry];
    if (entries.length > 10000) throw new Error('记忆删除清单已满');
    const file = path.join(this.#directory, 'memory-mutations.json');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(handle, JSON.stringify(entries)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(temporary, file);
      if (process.platform !== 'win32') {
        const directoryHandle = fs.openSync(this.#directory, 'r');
        try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
      }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return entry;
  }
  redact(entry, replacement = null) {
    if (this.#db.prepare('SELECT id FROM life_mutations WHERE id=?').get(entry.id)) return;
    const experience = this.#db.prepare('SELECT * FROM experiences WHERE id=?').get(entry.experienceId);
    if (experience) {
      const scope = experience.scope;
      const operation = this.#db.prepare('SELECT id FROM operations WHERE activity_id=?').get(experience.activity_id);
      if (operation) {
        this.#db.prepare('DELETE FROM receipts WHERE operation_id=?').run(operation.id);
        this.#db.prepare('UPDATE operations SET receipt=NULL WHERE id=?').run(operation.id);
      }
      this.#db.prepare("UPDATE activities SET summary='内容已移除' WHERE id=?").run(experience.activity_id);
      // 旧版没有活动来源索引；清除同范围的输入归档，避免私人原文留在提案或重试中。
      const scopes = scope === 'public' ? this.#db.prepare('SELECT DISTINCT scope FROM events').all().map(item=>item.scope) : [scope];
      for (const sourceScope of scopes) {
        const ids = this.#db.prepare('SELECT id FROM events WHERE scope=?').all(sourceScope).map(item=>item.id);
        for (const id of ids) this.#db.prepare('DELETE FROM life_appraisals WHERE source_id=?').run(id);
        this.#db.prepare("UPDATE events SET summary='内容已移除', processed=1 WHERE scope=?").run(sourceScope);
        this.#db.prepare("UPDATE rounds SET proposal=NULL, candidates='[]', event_ids='[]', status=CASE WHEN status IN ('open','retry') THEN 'aborted' ELSE status END WHERE scope=?").run(sourceScope);
      }
      this.#db.prepare('DELETE FROM life_appraisals WHERE source_id=?').run(experience.id);
      for (const memory of this.#db.prepare('SELECT id, sources FROM life_memories').all()) if (JSON.parse(memory.sources).includes(experience.id)) this.#db.prepare('DELETE FROM life_memories WHERE id=?').run(memory.id);
      if (replacement) this.#db.prepare('UPDATE experiences SET fact=?, feeling=?, evidence=? WHERE id=?').run(replacement.fact, replacement.feeling, JSON.stringify(replacement.evidence), experience.id);
      else this.#db.prepare('DELETE FROM experiences WHERE id=?').run(experience.id);
      const version = this.memoryVersion() + 1; this.#set('memory-version', String(version));
      this.#db.prepare('INSERT INTO life_invalidations VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET version=excluded.version').run(scope, version);
    }
    this.#db.prepare('INSERT INTO life_mutations VALUES (?)').run(entry.id);
  }
  purgeBackups() {
    const directory = path.join(this.#directory, 'backups');
    if (!fs.existsSync(directory)) return;
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== path.join(fs.realpathSync(this.#directory), 'backups')) throw new Error('记忆备份目录边界无效');
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-z0-9-]{1,60}\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)) throw new Error('记忆备份文件无效');
      const file = path.join(directory, name); const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('记忆备份文件边界无效');
      fs.unlinkSync(file);
    }
  }
}
