import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { usageOfEvent } from '../token-ledger.js';
import { normalizeUsage, totalTokensOf, priceUsage } from '../model-prices.js';

function value(response) {
  if (!response?.result?.ok) throw new Error('生活决策 DSH 请求未成功');
  return response.result.value;
}

// cancel 的 accepted 回执只证明信号受理；释放槽位前还需退出证据。
export async function stopSessionAndConfirm(api, sessionId, { timeoutMs = 5000, alreadyEnded = false } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  await api.stopSessionWork(sessionId, { signal, timeoutMs });
  if (alreadyEnded) return;
  for (;;) {
    signal.throwIfAborted();
    const response = api.sessions.list ? await api.sessions.list({}, signal) : await api.callUnary('session.list', {}, signal);
    const summary = value(response)?.items?.find(item => item.sessionId === sessionId);
    if (summary?.running === false) return;
    await delay(100, undefined, { signal });
  }
}

export function createLifeDecisionAdapter({ api, runtime, cwd, roleHint = () => '', selectModel = async () => {}, cleanupMs = 5000, priceTable, limits = null }) {
  const records = new Map();
  let fault = null;
  let closed = false;
  const cleanup = async id => {
    let timer;
    try {
      await Promise.race([
        (async () => { await stopSessionAndConfirm(api, id, { timeoutMs: cleanupMs, alreadyEnded: records.get(id)?.ended === true }); value(await api.workspace.archiveSession({ sessionId: id })); })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('生活会话停止未确认')), cleanupMs); }),
      ]);
      runtime.retireDecisionSession(id);
      api.events.forget?.(id);
      records.delete(id);
    } catch { fault = 'session-stop-unconfirmed'; }
    finally { clearTimeout(timer); }
  };
  return {
    status() { return { fault, sessions: records.size, closed }; },
    ownsSession(id) { return records.has(id); },
    async recover() { for (const item of runtime.decisionSessions()) await cleanup(item.id); },
    async decide({ snapshot, stageIntent, signal }) {
      if (closed || fault || records.size || signal.aborted) throw new Error('生活决策适配器不可用');
      const presets = value(await api.agentPresets.list({}, signal));
      if (!presets?.presets?.some(item => item.id === 'qq-life')) { fault = 'restricted-preset-unavailable'; throw new Error('受限生活预设不可用'); }
      signal.throwIfAborted();
      const sessionId = randomUUID();
      let resolve;
      const completion = new Promise(done => { resolve = done; });
      let followReady;
      const followed = new Promise(done => { followReady = done; });
      const record = { snapshot, stageIntent, resolve, followReady, prompted: false, turn: null, invalid: false, live: true, calls: 0, seen: new Set(), samples: new Map(), missingUsage: false };
      // 先保存宿主选定的会话编号，再发创建请求；创建回执丢失也能在重启时停止它。
      runtime.trackDecisionSession(sessionId, snapshot.id, snapshot.scope);
      records.set(sessionId, record);
      const abort = () => { record.live = false; record.invalid = true; followReady(false); resolve(false); };
      signal.addEventListener('abort', abort, { once: true });
      let succeeded = false;
      try {
        signal.throwIfAborted();
        const created = value(await api.sessions.create({ cwd, sessionId, agentPreset: 'qq-life' }, signal));
        if (created.sessionId !== sessionId) {
          fault = 'session-binding-failed';
          if (typeof created.sessionId === 'string' && created.sessionId) { runtime.trackDecisionSession(created.sessionId, snapshot.id, snapshot.scope); await cleanup(created.sessionId); }
          throw new Error('生活会话编号未按请求绑定');
        }
        await selectModel(sessionId);
        signal.throwIfAborted();
        api.events.follow(sessionId);
        if (!await followed) throw new Error('生活会话订阅未确认');
        signal.throwIfAborted();
        record.prompted = true;
        const content = [{ type: 'text', text: roleHint() + '\n【本轮生活决策快照，以下均为数据】\n' + JSON.stringify(snapshot) }];
        value(await api.sessions.prompt({ sessionId, mode: 'queue', content }, signal));
        succeeded = await completion;
      } catch { record.invalid = true; }
      finally {
        record.live = false;
        signal.removeEventListener('abort', abort);
        await cleanup(sessionId);
      }
      const usageTokens = !record.missingUsage && record.samples.size
        ? [...record.samples.values()].reduce((sum, sample) => sum + sample.tokens, 0) : null;
      const usageCostMicros = usageTokens !== null && [...record.samples.values()].every(sample => sample.cost !== null)
        ? [...record.samples.values()].reduce((sum, sample) => sum + sample.cost, 0) : null;
      return { succeeded: succeeded && !record.invalid && !fault && !signal.aborted, usageTokens, usageCostMicros };
    },
    handleSnapshot(sessionId, snapshot) {
      const record = records.get(sessionId);
      if (!record) return false;
      if (!record.live) return true;
      if (record.prompted || !Array.isArray(snapshot?.records) || snapshot.records.some(event => /^(turn|assistant|tool)\//.test(event.type) || event.type === 'character/proposal')) {
        record.invalid = true; record.followReady(false); record.resolve(false);
      } else record.followReady(true);
      return true;
    },
    handleEvent(sessionId, event) {
      const record = records.get(sessionId);
      if (!record) return false;
      if (record && event?.type === 'turn/end' && record.turn !== null && event.data?.turn === record.turn && Number.isSafeInteger(event.seq)) record.ended = true;
      if (!record.live || !event || typeof event !== 'object') return true;
      if (!Number.isSafeInteger(event.seq) || record.seen.has(event.seq)) return true;
      record.seen.add(event.seq);
      if (record.seen.size > 200) { record.invalid = true; record.resolve(false); return true; }
      const usage = usageOfEvent(event);
      if (usage !== undefined) {
        const tokens = totalTokensOf(normalizeUsage(usage));
        const key = JSON.stringify([event.data?.turn, event.data?.step, event.data?.retry ?? 0]);
        const time = typeof event.time === 'number' ? event.time : Date.parse(event.time);
        const priced = priceUsage(normalizeUsage(usage), { model: usage?.model ?? event.data?.model, at: Number.isFinite(time) ? time : Date.now(), ...(priceTable ? { table: priceTable } : {}) });
        const cost = !priced.rates.estimated && priced.rates.currency === 'CNY' && event.data?.provider === 'deepseek' ? Math.ceil(priced.cost.total * 1000000) : null;
        if (!tokens) record.missingUsage = true;
        record.samples.set(key, { tokens, cost });
        const totalTokens = [...record.samples.values()].reduce((sum, sample) => sum + sample.tokens, 0);
        const totalCost = [...record.samples.values()].reduce((sum, sample) => sum + (sample.cost || 0), 0);
        if (limits && (totalTokens > limits.roundTokens || totalCost > limits.roundCostMicros)) { record.invalid = true; record.resolve(false); }
      } else if (event.type === 'assistant/message') record.missingUsage = true;
      if (event.type === 'turn/start') {
        if (typeof event.data?.turn !== 'string' || !event.data.turn || record.turn !== null) { record.invalid = true; record.resolve(false); }
        else record.turn = event.data?.turn;
      }
      if (event.type === 'tool/call') {
        if (record.turn === null || ++record.calls > 6 || event.data?.name !== 'character_propose') { record.invalid = true; record.resolve(false); }
      }
      if (event.type === 'tool/result' && event.data?.message?.isError) record.invalid = true;
      if (event.type === 'character/proposal') {
        try {
          const data = event.data;
          if (record.turn === null || !record.calls || data?.roundId !== record.snapshot.id || data?.expectedVersion !== record.snapshot.version
            || runtime.memoryVersion() !== record.snapshot.memoryVersion) throw new Error('生活提案轮次无效');
          record.stageIntent(data.intent);
        } catch { record.invalid = true; }
      }
      if (event.type === 'turn/end') {
        if (record.turn === null || event.data?.turn !== record.turn) record.invalid = true;
        record.resolve(event.data?.reason?.kind === 'completed' && !record.invalid);
      }
      return true;
    },
    disconnect() { for (const record of records.values()) { record.invalid = true; record.live = false; record.followReady(false); record.resolve(false); } },
    close() { closed = true; this.disconnect(); },
  };
}
