const schedulers = new WeakMap();

// 宿主提供决策与准入函数，离线夹具和生产协调器共用调度约束。
export function createCharacterScheduler(options) {
  if (schedulers.has(options.runtime)) throw new Error('角色已有决策调度器');
  const scheduler = new CharacterScheduler(options);
  schedulers.set(options.runtime, scheduler);
  return scheduler;
}

class CharacterScheduler {
  #runtime;
  #decide;
  #candidates;
  #canDecide;
  #now;
  #timers;
  #mergeMs;
  #roundMs;
  #timer = null;
  #wakeAt = null;
  #deadline = null;
  #controller = null;
  #round = null;
  #inflight = null;
  #closed = false;
  #fault = null;
  #autonomous;

  constructor({ runtime, decide, candidates = () => [], canDecide, now = Date.now,
    timers = { setTimeout, clearTimeout }, mergeMs = 2000, roundMs = 60000, autonomous = false }) {
    if (!runtime || typeof decide !== 'function' || typeof candidates !== 'function'
      || typeof canDecide !== 'function' || !Number.isInteger(mergeMs) || mergeMs < 0 || mergeMs > 2000
      || !Number.isInteger(roundMs) || roundMs < 1 || roundMs > 60000) throw new Error('角色调度参数无效');
    this.#autonomous = autonomous;
    this.#runtime = runtime;
    this.#decide = decide;
    this.#candidates = candidates;
    this.#canDecide = canDecide;
    this.#now = now;
    this.#timers = timers;
    this.#mergeMs = mergeMs;
    this.#roundMs = roundMs;
  }

  notify(event) {
    if (this.#closed || this.#fault) throw new Error('角色调度已停止');
    let receipt = null;
    try { if (event !== undefined) receipt = this.#runtime.ingestEvent(event); }
    catch { this.#stopOnFault(); throw new Error('角色事件登记失败'); }
    try { this.#schedule(); } catch { this.#stopOnFault(); }
    return receipt;
  }

  #clearTimer() {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#wakeAt = null;
  }

  #schedule() {
    if (this.#closed || this.#fault || this.#inflight || this.#runtime.status().paused) return;
    // 准入由可信宿主核对权限、作息和额度；拒绝时等待新的显式通知。
    const queue = this.#runtime.pendingDecisions().filter(item => this.#canDecide(item.scope) === true);
    if (!queue.length) return;
    const wakeAt = Math.max(this.#now() + this.#mergeMs, Math.min(...queue.map(item => item.readyAt)));
    if (this.#timer !== null && this.#wakeAt <= wakeAt) return;
    this.#clearTimer();
    this.#wakeAt = wakeAt;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      this.#wakeAt = null;
      this.#inflight = this.#run();
      this.#inflight.finally(() => {
        this.#inflight = null;
        if (this.#closed) schedulers.delete(this.#runtime);
        try { this.#schedule(); } catch { this.#stopOnFault(); }
      });
    }, Math.max(0, wakeAt - this.#now()));
  }

  #stopOnFault() {
    this.#fault = 'storage-or-policy-error';
    this.#clearTimer();
    this.#controller?.abort();
    // 存储异常不冒充已取消成功；保留固定诊断，立即关闭本调度器的入口。
    try { this.#runtime.setPaused(true); } catch { /* 数据库可能已经不可写，关闭闸门仍在进程内生效。 */ }
  }

  #finish(succeeded, failure = 'model-error') {
    if (!this.#round) return null;
    const round = this.#round;
    this.#round = null;
    return this.#runtime.finishRound(round.id, { succeeded, failure });
  }

  async #run() {
    let invalid = false;
    let toolCalls = 0;
    try {
      if (this.#closed || this.#fault || this.#runtime.status().paused) return;
      const next = this.#runtime.pendingDecisions().find(item => item.readyAt <= this.#now() && this.#canDecide(item.scope) === true);
      if (!next) return;
      const candidates = this.#candidates(next.scope);
      if (this.#canDecide(next.scope) !== true) return;
      const round = this.#runtime.beginRound({ scope: next.scope, candidates, ttlMs: this.#roundMs, maxRetries: 2, autonomous: this.#autonomous });
      if (!round) return;
      this.#round = round;
      const controller = new AbortController();
      this.#controller = controller;
      this.#deadline = this.#timers.setTimeout(() => {
        try { this.#finish(false, 'timeout'); } catch { this.#stopOnFault(); }
        controller.abort();
      }, this.#roundMs);
      const stageIntent = intent => {
        try {
          if (this.#closed || this.#fault || controller.signal.aborted || this.#round?.id !== round.id
            || this.#runtime.status().paused || this.#canDecide(round.scope, { phase: 'commit', roundId: round.id }) !== true) throw new Error('角色决策权限已失效');
          if (++toolCalls > 6) throw new Error('角色决策工具调用超限');
          return this.#runtime.stageIntent(round.id, intent);
        } catch (error) { invalid = true; throw error; }
      };
      let succeeded = false;
      let usageTokens = null;
      let usageCostMicros = null;
      try {
        const snapshot = structuredClone({ ...round, state: this.#runtime.project(round.scope) });
        const result = await this.#decide({ snapshot, stageIntent, signal: controller.signal });
        usageTokens = result?.usageTokens ?? null;
        usageCostMicros = result?.usageCostMicros ?? null;
        succeeded = result?.succeeded === true && !invalid;
      } catch { /* 不保存适配器原始错误，防止凭据或私人正文进入诊断。 */ }
      if (this.#autonomous) this.#runtime.settleDecision(round.id, usageTokens, usageCostMicros);
      if (this.#round?.id === round.id) {
        if (this.#closed || this.#fault || controller.signal.aborted
          || this.#runtime.status().paused || this.#canDecide(round.scope, { phase: 'commit', roundId: round.id }) !== true) {
          if (this.#autonomous && !this.#closed && !this.#fault && !controller.signal.aborted && !this.#runtime.status().paused) {
            // 作息结束或范围撤销只结束本批，下一正常关注仍由宿主重新准入。
            this.#runtime.cancelRound(round.id);
          } else this.#runtime.setPaused(true);
          this.#round = null;
        } else {
          this.#finish(succeeded, invalid ? 'invalid-intent' : 'model-error');
        }
      }
    } catch { this.#stopOnFault(); }
    finally {
      if (this.#deadline !== null) this.#timers.clearTimeout(this.#deadline);
      this.#deadline = null;
      this.#controller?.abort();
      this.#controller = null;
    }
  }

  setPaused(paused) {
    if (this.#closed || this.#fault) throw new Error('角色调度已停止');
    if (typeof paused !== 'boolean') throw new Error('暂停状态必须为布尔值');
    if (paused) {
      this.#clearTimer();
      this.#controller?.abort();
    }
    try {
      const status = this.#runtime.setPaused(paused);
      if (paused) this.#round = null;
      else this.#schedule();
      return status;
    } catch { this.#stopOnFault(); throw new Error('角色暂停状态更新失败'); }
  }

  status() {
    return { closed: this.#closed, fault: this.#fault, inFlight: this.#inflight !== null };
  }

  async settled() { await this.#inflight; }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    try { this.#finish(false, 'interrupted'); }
    catch { this.#stopOnFault(); }
    this.#controller?.abort();
    if (this.#deadline !== null) this.#timers.clearTimeout(this.#deadline);
    this.#deadline = null;
    if (!this.#inflight) schedulers.delete(this.#runtime);
  }
}
