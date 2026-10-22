import { randomUUID } from 'node:crypto';
import { awake, localParts } from './life-policy.mjs';
import { appConfig } from './android-policy.mjs';

export const ANDROID_SCHEMA = [
  'CREATE TABLE android_jobs (operation_id TEXT PRIMARY KEY REFERENCES operations(id), kind TEXT NOT NULL, scope TEXT NOT NULL,',
  'device_id TEXT NOT NULL, app_version TEXT NOT NULL, memory_version INTEGER NOT NULL, status TEXT NOT NULL, day TEXT, seconds INTEGER NOT NULL DEFAULT 0, actions INTEGER NOT NULL DEFAULT 0) STRICT;',
  'CREATE TABLE android_steps (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES android_jobs(operation_id),',
  'kind TEXT NOT NULL, before_hash TEXT NOT NULL, status TEXT NOT NULL) STRICT;',
].join('\n');
export class AndroidStore {
  #db; #config; #autonomy; #clock; #get; #set; #memoryVersion;
  constructor({ db, config, autonomy, clock, get, set, memoryVersion }) { this.#db=db; this.#config=config; this.#autonomy=autonomy; this.#clock=clock; this.#get=get; this.#set=set; this.#memoryVersion=memoryVersion; }
  budget() {
    const day=localParts(this.#clock(),this.#autonomy.timezone).day;
    const usage=this.#db.prepare('SELECT coalesce(sum(seconds),0) AS seconds, coalesce(sum(actions),0) AS actions FROM android_jobs WHERE day=?').get(day);
    const timezoneChanged=Boolean(this.#get('android-timezone')) && this.#get('android-timezone') !== this.#autonomy.timezone;
    const awakeNow=!this.#autonomy.enabled || awake(this.#clock(),this.#autonomy);
    return { day,...usage,timezoneChanged,awake:awakeNow,allowed:this.#config.enabled && !timezoneChanged && awakeNow
      && usage.seconds+this.#config.activitySeconds <= this.#config.dailySeconds && usage.actions+this.#config.maxActions <= this.#config.dailyActions };
  }
  configured(kind,scope) { return this.#config.enabled && scope === this.#config.scope && appConfig(this.#config,kind).enabled; }
  plan(operationId,kind,scope) {
    if (!this.configured(kind,scope)) throw new Error('安卓活动未按配置绑定');
    this.#db.prepare("INSERT INTO android_jobs(operation_id,kind,scope,device_id,app_version,memory_version,status) VALUES (?,?,?,?,?,?,'prepared')").run(operationId,kind,scope,this.#config.deviceId,appConfig(this.#config,kind).version,this.#memoryVersion());
  }
  reserve(operationId) {
    const budget=this.budget(), job=this.#db.prepare('SELECT * FROM android_jobs WHERE operation_id=?').get(operationId);
    if (!budget.allowed || !job || job.status !== 'prepared' || job.memory_version !== this.#memoryVersion() || job.device_id !== this.#config.deviceId || job.app_version !== appConfig(this.#config,job.kind).version || !this.configured(job.kind,job.scope)) throw new Error('安卓作息、额度或任务绑定已失效');
    this.#set('android-timezone',this.#autonomy.timezone);
    this.#db.prepare("UPDATE android_jobs SET status='running',day=?,seconds=?,actions=? WHERE operation_id=?")
      .run(budget.day,this.#config.activitySeconds,this.#config.maxActions,operationId);
  }
  jobs() { return this.#db.prepare("SELECT operation_id AS id,kind,scope,status,device_id AS deviceId,app_version AS appVersion FROM android_jobs WHERE status!='closed'").all(); }
  step(operationId,kind,hash) {
    if (!['move','open','back','scroll','launch'].includes(kind) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('安卓动作登记无效');
    const job=this.#db.prepare("SELECT * FROM android_jobs WHERE operation_id=? AND status='running'").get(operationId);
    const count=this.#db.prepare('SELECT count(*) AS n FROM android_steps WHERE operation_id=?').get(operationId).n;
    const pending=this.#db.prepare("SELECT id FROM android_steps WHERE operation_id=? AND status='sent'").get(operationId);
    if (!job || pending || count >= job.actions) throw new Error('安卓动作槽或额度不可用');
    const id=randomUUID();
    this.#db.prepare("INSERT INTO android_steps VALUES (?,?,?,?,'sent')").run(id,operationId,kind,hash);
    return id;
  }
  confirm(id) {
    const result=this.#db.prepare("UPDATE android_steps SET status='confirmed' WHERE id=? AND status='sent'").run(id);
    if (result.changes !== 1) throw new Error('安卓动作无法确认');
  }
  finish(operationId,stopped,seconds = null) {
    if (seconds !== null) this.#db.prepare('UPDATE android_jobs SET seconds=max(seconds,?) WHERE operation_id=?').run(seconds,operationId);
    this.#db.prepare("UPDATE android_jobs SET status=? WHERE operation_id=?").run(stopped?'closed':'unknown',operationId);
    this.#db.prepare("UPDATE android_steps SET status='unknown' WHERE operation_id=? AND status='sent'").run(operationId);
  }
  recover() { this.#db.exec("UPDATE android_jobs SET status='unknown' WHERE status='running'; UPDATE android_steps SET status='unknown' WHERE status='sent';"); }
}
