import { createAndroidActivities } from './android-activities.mjs';
import { createCharacterScheduler } from './scheduler.mjs';
import { createLifeDecisionAdapter } from './dsh-life.mjs';

export function createCharacterCoordinator({ runtime, config, api, cwd, isReady, isAllowed,
  roleHint, selectModel, priceTable, invalidateChats, onPrivacyFence = () => {}, timers, now, androidDevice, androidOptions = {} }) {
  let closed = false;
  let recovered = false;
  let ticking = false;
  let fault = null;
  let invalidating = null;
  let mutating = false;
  const adapter = createLifeDecisionAdapter({ api, runtime, cwd, roleHint, selectModel, priceTable, limits: config.autonomy });
  const android = config.android?.enabled ? createAndroidActivities({runtime,config:config.android,isAllowed,
    ...(androidDevice ? {device:androidDevice} : {}),...androidOptions,
    onReceipt:event=>{if (!closed) {runtime.ingestEvent(event);scheduler?.notify();}}}) : null;
  const allowed = (scope, phase) => !closed && !fault && !invalidating && isReady() && !adapter.status().fault
    && (scope === 'public' || isAllowed(scope))
    && (phase?.phase === 'commit' ? runtime.canContinueDecision(phase.roundId) : runtime.canDecide());
  const scheduler = config.autonomy.enabled ? createCharacterScheduler({ runtime, decide: input => adapter.decide(input),
    candidates: scope => android?.candidates(scope) ?? [], canDecide: allowed, autonomous: true, ...(timers ? { timers } : {}), ...(now ? { now } : {}) }) : null;
  const invalidate = async () => {
    const pending = runtime.invalidations();
    if (!pending.length) return;
    onPrivacyFence(true);
    const paused = runtime.status().paused;
    scheduler?.setPaused(true); if (!scheduler) runtime.setPaused(true);
    adapter.disconnect();
    await android?.stop();
    if (android?.status().fault) throw new Error('安卓上下文停止未确认');
    await scheduler?.settled();
    await adapter.recover();
    if (adapter.status().fault) throw new Error('生活上下文停止未确认');
    await invalidateChats(pending);
    for (const item of pending) runtime.acknowledgeInvalidation(item.scope, item.version);
    onPrivacyFence(false);
    if (!paused) { if (scheduler) scheduler.setPaused(false); else runtime.setPaused(false); }
  };
  const drainInvalidations = () => {
    if (!invalidating) invalidating = invalidate().finally(() => { invalidating = null; });
    return invalidating;
  };
  return {
    ownsSession(id) { return adapter.ownsSession(id); },
    status() { return { enabled: config.autonomy.enabled, ready: recovered && !fault && !adapter.status().fault && !scheduler?.status().fault,
      fault: fault || adapter.status().fault || scheduler?.status().fault || null, scheduler: scheduler?.status() ?? null, android:android?.status() ?? null }; },
    handleSnapshot(sessionId, snapshot) { return adapter.handleSnapshot(sessionId, snapshot); },
    handleEvent(sessionId, event) { return adapter.handleEvent(sessionId, event); },
    disconnect() {
      adapter.disconnect(); recovered = false;
      try { if (scheduler) scheduler.setPaused(true); else runtime.setPaused(true); } catch { fault = 'life-disconnect-pause-failed'; }
      void android?.stop().catch(()=>{fault='android-disconnect-stop-failed';});
    },
    async tick() {
      if (closed || ticking || !isReady() || fault) return;
      ticking = true;
      try {
        if (!recovered) { await adapter.recover(); recovered = true; }
        await drainInvalidations();
        await android?.tick();
        if (adapter.status().fault || !scheduler || runtime.status().paused) return;
        const idle = runtime.idleEvent();
        if (idle) scheduler.notify(idle); else scheduler.notify();
      } catch { fault = 'life-coordination-failed'; try { scheduler?.setPaused(true); } catch {} }
      finally { ticking = false; }
    },
    notifyConversation(event) {
      if (scheduler && !closed && !fault) {
        try { runtime.recordConversationEvent(event); scheduler.notify(); }
        catch { fault = 'conversation-observation-failed'; scheduler.setPaused(true); throw new Error('角色来信观察登记失败'); }
      }
    },
    notify(event) { if (scheduler && !closed && !fault) scheduler.notify(event); },
    async setPaused(paused) {
      if (paused) {
        if (scheduler) scheduler.setPaused(true); else runtime.setPaused(true);
        await android?.stop();
        if (android?.status().fault) throw new Error('安卓停止待核对');
        return runtime.status();
      }
      await this.tick();
      if (fault || adapter.status().fault || android?.status().fault || runtime.invalidations().length || (config.autonomy.enabled && (!isReady() || !recovered))) throw new Error('生活调度尚未恢复');
      return scheduler ? scheduler.setPaused(false) : runtime.setPaused(false);
    },
    async startAndroid(kind) {if (!android) throw new Error('安卓未启用');return android.start(kind);},
    async reconcileAndroid() {
      if (!android) throw new Error('安卓未启用');
      if (scheduler) scheduler.setPaused(true); else runtime.setPaused(true);
      return android.reconcile();
    },
    async mutateExperience(id, replacement = null) {
      if (mutating || invalidating) throw new Error('记忆上下文正在更新');
      runtime.validateExperienceMutation(id, replacement);
      mutating = true;
      onPrivacyFence(true);
      try {
        const result = runtime.mutateExperience(id, replacement);
        await drainInvalidations();
        return { ...result, pendingInvalidations: runtime.invalidations(), chatContextsReset: true };
      } catch (error) { fault = 'memory-invalidation-failed'; adapter.disconnect(); throw error; }
      finally { mutating = false; }
    },
    async close() { closed = true; scheduler?.close(); adapter.close(); await android?.close(); await scheduler?.settled(); },
  };
}
