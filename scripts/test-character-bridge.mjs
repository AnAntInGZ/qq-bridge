import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(fn, options = {}) {
  const h = await bridgeHarness({ config: { character: { enabled: true } }, ...options });
  try { await fn(h); } finally { await h.close(); }
}

function experience(h, scope, marker) {
  const runtime = h.character;
  runtime.setPaused(false);
  runtime.ingestEvent({ source: 'fixture', sourceId: marker, scope, summary: '离线活动事件' });
  const round = runtime.beginRound({ scope, candidates: [{ id: marker, kind: 'bilibili', scope: 'public', summary: '离线内容' }] });
  runtime.stageIntent(round.id, { action: 'start', candidateId: marker, reason: '离线验证' });
  runtime.finishRound(round.id, { succeeded: true });
  const operation = runtime.claimOperation();
  runtime.recordReceipt(operation.id, { id: marker, epoch: operation.epoch, outcome: 'completed', fact: marker, evidence: ['fixture-video-observation'] });
}

async function serverFixture(h, fn) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, { body, headers = {} } = {}) => {
    const response = await fetch(url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await fn(request); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('默认关闭时不创建角色数据库，旧消息投递不增加角色上下文', async () => {
  await fixture(async h => {
    assert.equal(h.character, null);
    assert.equal(fs.existsSync(path.join(h.temp, 'state/character')), false);
    await h.deliverPrompt('group:456', '原有消息');
    assert.equal(h.calls.prompts.at(-1).content[0].text.includes('有依据的角色近况'), false);
  }, { config: {} });
});

test('真实队列投递按群过滤经历，公开经历可见、私聊经历不可见', async () => {
  await fixture(async h => {
    experience(h, 'private:123', 'private-only-fixture');
    experience(h, 'public', 'public-fixture');
    experience(h, 'group:456', 'group-only-fixture');
    await h.deliverPrompt('group:456', '最近怎么样');
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.ok(prompt.includes('public-fixture'));
    assert.ok(prompt.includes('group-only-fixture'));
    assert.ok(!prompt.includes('private-only-fixture'));
    assert.equal(h.calls.sent.length, 0);
  });
});

test('直接聊天入口也注入本会话近况，聊天重置不删除角色经历', async () => {
  await fixture(async h => {
    experience(h, 'private:123', 'owner-only-fixture');
    h.setMode('closed-agent');
    await h.handleIncoming('private', 123, { user_id: 123, message_id: 1, message: [{ type: 'text', data: { text: '最近怎么样' } }] }, h.cfg);
    assert.ok(h.calls.prompts.at(-1).content[0].text.includes('owner-only-fixture'));
    h.retireSession('private:123');
    assert.equal(h.character.status().experienceCount, 1);
  });
});

test('二代唤醒在实际投递时注入可见经历', async () => {
  await fixture(async h => {
    experience(h, 'public', 'wake-public-fixture');
    experience(h, 'private:123', 'wake-private-fixture');
    h.setMode('reserved2');
    await h.deliverPrompt('group:456', 'placeholder', { wakeReason: 'proactiveCheck' });
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.ok(prompt.includes('wake-public-fixture'));
    assert.ok(!prompt.includes('wake-private-fixture'));
  });
});

test('离线补投读取最新近况，白名单撤销后拒绝投递', async () => {
  await fixture(async h => {
    h.setReady(false);
    await h.deliverPrompt('group:456', '离线消息');
    experience(h, 'public', 'created-while-offline');
    h.setReady(true);
    await h.flushQueue();
    assert.ok(h.calls.prompts.at(-1).content[0].text.includes('created-while-offline'));
    h.cfg.allow.groups = [];
    const before = h.calls.prompts.length;
    await assert.rejects(h.deliverPrompt('group:456', '撤销后的消息'));
    assert.equal(h.calls.prompts.length, before);
  });
});

test('角色 API 只允许管理员，agent 不可读状态或解除暂停', async () => {
  await fixture(async h => {
    await serverFixture(h, async request => {
      const initial = await request('/api/character/status');
      assert.equal(initial.status, 200);
      assert.equal(initial.body.paused, true);
      assert.equal(initial.body.capabilities.autonomousDecision, false);
      assert.equal((await request('/api/character/pause', { body: { paused: false } })).status, 200);
      assert.equal(h.character.status().paused, false);
      const token = h.getSocialV2State('group:456').agentToken;
      for (const headers of [{ 'x-agent-token': token }, { 'x-agent-token': '' }]) {
        assert.equal((await request('/api/character/status', { headers })).status, 403);
        assert.equal((await request('/api/character/pause', { body: { paused: true }, headers })).status, 403);
      }
      assert.equal(h.character.status().paused, false);
      assert.equal((await request('/api/character/status', { headers: { 'x-console-token': '' } })).status, 401);
      assert.equal((await request('/api/character/pause', { body: { paused: 'false' } })).status, 400);
      assert.equal((await request('/api/character/pause', { body: { paused: true, enabled: true } })).status, 400);
      assert.equal((await request('/api/character/pause', { body: { paused: true }, headers: { origin: 'https://fixture.invalid' } })).status, 403);
    });
  });
});

test('存储初始化失败禁用角色模块，原有 QQ 投递继续', async () => {
  await fixture(async h => {
    assert.equal(h.character, null);
    assert.equal(h.characterSnapshot().available, false);
    await h.deliverPrompt('group:456', '继续原有聊天');
    assert.equal(h.calls.prompts.length, 1);
    await serverFixture(h, async request => {
      assert.equal((await request('/api/character/pause', { body: { paused: false } })).status, 409);
    });
  }, { config: { character: { enabled: true } }, globals: { createCharacterRuntime: async () => { throw new Error('fixture database failure'); } } });
});

test('读取近况异常后停用模块，错误正文和私有事实不进入 QQ prompt', async () => {
  await fixture(async h => {
    h.character.promptFor = () => { throw new Error('fixture-private-database-error'); };
    await h.deliverPrompt('group:456', '继续交流');
    const prompt = h.calls.prompts.at(-1).content[0].text;
    assert.ok(!prompt.includes('fixture-private-database-error'));
    assert.equal(h.characterSnapshot().available, false);
  });
});
