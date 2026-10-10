// 用模拟 QQ 网关和 HTTP 响应走真实落盘、排队与 Harness 投递，不接触真实账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { safeFetchFile } from '../src/safe-fetch.js';
import { createVideoReceiver, normalizeVideoConfig } from '../src/receive-video.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const VIDEO = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const PUBLIC = 'http://93.184.216.34/video.mp4';
const videoEvent = (data = {}, extra = {}) => ({
  user_id: 123, message_id: 9001, message: [{ type: 'video', data: { file: 'clip.mp4', url: PUBLIC, ...data } }], ...extra,
});

function transport(t, scripts) {
  const requests = [];
  t.mock.method(http, 'request', (options, callback) => {
    const script = scripts[requests.length];
    assert.ok(script, '不能产生未预期的网络请求');
    requests.push(options);
    const req = new EventEmitter();
    req.destroy = (error) => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough();
      res.statusCode = script.status ?? 200;
      res.headers = script.headers ?? {};
      res.complete = false;
      callback(res);
      if (res.destroyed) return;
      script.beforeBody?.();
      if (script.hang) return;
      if (script.abort) { res.write(VIDEO.subarray(0, 4)); queueMicrotask(() => res.destroy(new Error('连接中断'))); return; }
      res.complete = true;
      res.end(script.body ?? VIDEO);
    });
    return req;
  });
  return requests;
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function harness(t, config = {}) {
  const h = await bridgeHarness({ config });
  h.setMode('closed-agent');
  t.after(() => h.close());
  return h;
}

function attachment(prompt) {
  const text = prompt.content[0].text;
  const line = text.split('\n').find((s) => s.startsWith('{"name":'));
  return JSON.parse(line);
}

await test('owner 单独发视频：不点击接收也能落盘，完整路径进入 Harness', async (t) => {
  const requests = transport(t, [{}]);
  const h = await harness(t);
  await h.handleIncoming('private', 123, videoEvent({ url: PUBLIC + '?rkey=fixture-secret' }), h.cfg);
  assert.equal(h.calls.prompts.length, 1);
  const file = attachment(h.calls.prompts[0]);
  assert.equal(file.size, VIDEO.length);
  assert.deepEqual(fs.readFileSync(file.path), VIDEO);
  assert.equal(path.dirname(file.path), path.join(h.temp, 'state', 'incoming-videos'));
  assert.doesNotMatch(h.calls.prompts[0].content[0].text, /fixture-secret|93\.184/);
  assert.equal(requests[0].hostname, '93.184.216.34');
  assert.equal(requests[0].headers.host, '93.184.216.34');
  assert.equal(fs.readdirSync(path.dirname(file.path)).length, 1);
});

await test('作为文件发送的视频：用私聊文件 ID 和 hash 获取下载地址', async (t) => {
  transport(t, [{}]);
  const h = await harness(t);
  const requests = [];
  h.bot.request = async (action, params) => {
    requests.push({ action, params });
    return { status: 'ok', retcode: 0, data: { url: PUBLIC } };
  };
  const event = videoEvent({}, { message: [{ type: 'file', data: { name: '测试.MP4', file_id: 'file-1', file_hash: 'hash-1' } }] });
  await h.handleIncoming('private', 123, event, h.cfg);
  assert.deepEqual(requests, [{ action: 'get_private_file_url', params: { user_id: 123, file_id: 'file-1', file_hash: 'hash-1' } }]);
  assert.deepEqual(fs.readFileSync(attachment(h.calls.prompts[0]).path), VIDEO);
});

await test('用视频回答 agent 的提问时，也接收附件并提交文件路径', async (t) => {
  transport(t, [{}]);
  const h = await harness(t);
  h.pending.set('private:123', { kind: 'question', clientId: 'fixture', eventId: 'question-1', questions: [{ id: 'video', options: [] }] });
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  assert.equal(h.calls.prompts.length, 0);
  const answer = h.calls.responses[0].outcome.value.answers[0].custom;
  assert.ok(fs.existsSync(JSON.parse(answer.split('\n').find((s) => s.startsWith('{"name":'))).path));
  assert.equal(h.pending.size, 0);
});

await test('视频不能代替工具审批，提问期间权限变化也不提交附件', async (t) => {
  const h = await harness(t);
  const requests = transport(t, [{ beforeBody: () => h.setMode('chat') }]);
  h.pending.set('private:123', { kind: 'approval', clientId: 'fixture', eventId: 'approval-1' });
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  assert.equal(requests.length, 0);
  assert.equal(h.calls.responses.length, 0);
  h.pending.set('private:123', { kind: 'question', clientId: 'fixture', eventId: 'question-1', questions: [{ id: 'video', options: [] }] });
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  assert.equal(h.calls.responses.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.temp, 'state', 'incoming-videos')), []);
});

await test('视频消息缺少 URL：刷新原消息后下载，不调用 get_file', async (t) => {
  transport(t, [{}]);
  const h = await harness(t);
  const actions = [];
  h.bot.request = async (action, params) => {
    actions.push({ action, params });
    return { status: 'ok', retcode: 0, data: videoEvent() };
  };
  await h.handleIncoming('private', 123, videoEvent({ url: '' }), h.cfg);
  assert.deepEqual(actions, [{ action: 'get_msg', params: { message_id: 9001 } }]);
  assert.ok(fs.existsSync(attachment(h.calls.prompts[0]).path));
});

await test('过期地址只刷新一次，失败不会被报告成已下载', async (t) => {
  transport(t, [{ status: 403 }, { status: 404 }]);
  const h = await harness(t);
  let refreshes = 0;
  h.bot.request = async () => {
    refreshes++;
    return { status: 'ok', retcode: 0, data: videoEvent({ url: PUBLIC + '?new=1' }) };
  };
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  assert.equal(refreshes, 1);
  const file = attachment(h.calls.prompts[0]);
  assert.match(file.error, /HTTP 404/);
  assert.equal(file.path, undefined);
  assert.deepEqual(fs.readdirSync(path.join(h.temp, 'state', 'incoming-videos')), []);
});

await test('同名视频使用独立路径，文件名不能穿越目录', async (t) => {
  transport(t, [{}, {}]);
  const h = await harness(t);
  for (let i = 0; i < 2; i++) await h.handleIncoming('private', 123, videoEvent({ file: '../../clip.mp4' }), h.cfg);
  const [a, b] = h.calls.prompts.map(attachment);
  assert.notEqual(a.path, b.path);
  assert.equal(a.name, 'clip.mp4');
  assert.equal(path.dirname(a.path), path.dirname(b.path));
});

await test('closed-agent 仍拒绝非 owner 和群聊视频', async (t) => {
  const requests = transport(t, []);
  const h = await harness(t);
  await h.handleIncoming('private', 124, videoEvent({}, { user_id: 124 }), h.cfg);
  await h.handleIncoming('group', 456, videoEvent({}, { group_id: 456 }), h.cfg);
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(requests.length, 0);
  assert.ok(!fs.existsSync(path.join(h.temp, 'state', 'incoming-videos')));
  assert.ok(h.calls.prompts.every((p) => !p.content[0].text.includes('收到的视频附件')));
});

await test('聊天和两代仿真都接收视频；群聊、非 owner 白名单私聊不暴露本机路径', async (t) => {
  const requests = transport(t, [{}, {}, {}, {}, {}]);
  const h = await harness(t, { allow: { private: ['123', '124'], groups: ['456'] }, videoAnalysis: { enabled: true } });
  for (const mode of ['chat', 'reserved', 'reserved2']) {
    h.setMode(mode);
    await h.handleIncoming('private', 124, videoEvent({}, { user_id: 124 }), h.cfg);
    let text;
    if (mode === 'reserved2') text = h.buildWakeSnapshotV2('private:124').messages.at(-1).videoHint;
    else if (mode === 'reserved') text = h.buildContextBlock('private:124');
    else text = h.calls.prompts.at(-1).content[0].text;
    assert.match(text, /attachmentId/);
    assert.match(text, /mcp__video-analysis__analyze_video/);
    assert.doesNotMatch(text, /"path"|incoming-videos|\/Users\//);
  }
  h.setMode('chat');
  await h.handleIncoming('group', 456, videoEvent({}, { group_id: 456, user_id: 124 }), h.cfg);
  const file = attachment(h.calls.prompts.at(-1));
  assert.ok(file.attachmentId);
  assert.equal(file.path, undefined);
  await h.handleIncoming('group', 789, videoEvent({}, { group_id: 789 }), h.cfg);
  assert.equal(requests.length, 4);
});

await test('群聊视频文件使用群文件下载接口，刷新原生视频检查群归属', async (t) => {
  transport(t, [{}]);
  const h = await harness(t);
  h.setMode('chat');
  const actions = [];
  h.bot.request = async (action, params) => {
    actions.push({ action, params });
    return { status: 'ok', retcode: 0, data: { url: PUBLIC } };
  };
  await h.handleIncoming('group', 456, videoEvent({}, { group_id: 456, message: [{ type: 'file', data: { name: 'clip.mp4', file_id: 'group-file' } }] }), h.cfg);
  assert.deepEqual(actions, [{ action: 'get_group_file_url', params: { group_id: 456, file_id: 'group-file' } }]);
  h.bot.request = async () => ({ status: 'ok', retcode: 0, data: videoEvent({}, { group_id: 789 }) });
  await h.handleIncoming('group', 456, videoEvent({ url: '' }, { group_id: 456 }), h.cfg);
  assert.match(attachment(h.calls.prompts.at(-1)).error, /群归属/);
});

await test('关闭接收或使用远程 Harness 时不写入本地附件', async (t) => {
  const requests = transport(t, []);
  for (const config of [{ video: { enabled: false } }, { dsh: { baseUrl: 'https://remote.example', allowRemote: true } }]) {
    const h = await harness(t, config);
    await h.handleIncoming('private', 123, videoEvent(), h.cfg);
    assert.ok(!fs.existsSync(path.join(h.temp, 'state', 'incoming-videos')));
  }
  assert.equal(requests.length, 0);
});

await test('下载中切换模式：丢弃附件，不向新模式投递路径', async (t) => {
  const h = await harness(t);
  transport(t, [{ beforeBody: () => h.setMode('chat') }]);
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  assert.equal(h.calls.prompts.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(h.temp, 'state', 'incoming-videos')), []);
});

await test('DSH 暂停期间先接收视频，恢复后补投已有文件', async (t) => {
  transport(t, [{}]);
  const h = await harness(t);
  h.setReady(false);
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.queued.get('private:123')[0].ownerVideo, true);
  assert.equal(fs.readdirSync(path.join(h.temp, 'state', 'incoming-videos')).length, 1);
  h.setReady(true);
  await h.flushQueue();
  assert.ok(fs.existsSync(attachment(h.calls.prompts[0]).path));
});

await test('离线队列跨模式恢复时不会把本地路径交给聊天会话', async (t) => {
  transport(t, [{}]);
  const h = await harness(t);
  h.setReady(false);
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  h.setMode('chat');
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.queued.size, 0);
});

await test('超出声明大小或目录额度时拒绝下载，已有视频保留', async (t) => {
  const requests = transport(t, [{}]);
  const h = await harness(t, { video: { maxBytes: VIDEO.length, maxStoredBytes: VIDEO.length } });
  await h.handleIncoming('private', 123, videoEvent({ file_size: VIDEO.length + 1 }), h.cfg);
  assert.match(attachment(h.calls.prompts[0]).error, /单文件/);
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  const first = attachment(h.calls.prompts[1]);
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  assert.match(attachment(h.calls.prompts[2]).error, /容量已满/);
  assert.ok(fs.existsSync(first.path));
  assert.equal(requests.length, 1);
});

await test('单条视频数量有上限，普通文件不会被当成视频', async (t) => {
  const requests = transport(t, [{}]);
  const h = await harness(t, { video: { maxFilesPerMessage: 1 } });
  const event = videoEvent({}, { message: [
    { type: 'file', data: { name: 'note.txt', url: PUBLIC } },
    ...videoEvent().message, ...videoEvent().message,
  ] });
  await h.handleIncoming('private', 123, event, h.cfg);
  assert.equal(requests.length, 1);
  assert.match(h.calls.prompts[0].content[0].text, /其余视频未下载/);
});

await test('容器不符与下载地址缺失给出失败信息，不遗留文件', async (t) => {
  transport(t, [{ body: Buffer.from('<html>download failed</html>') }]);
  const h = await harness(t);
  await h.handleIncoming('private', 123, videoEvent(), h.cfg);
  assert.match(attachment(h.calls.prompts[0]).error, /视频容器/);
  h.bot.request = async () => ({ status: 'ok', retcode: 0, data: videoEvent({ url: '' }) });
  await h.handleIncoming('private', 123, videoEvent({ url: '' }), h.cfg);
  assert.match(attachment(h.calls.prompts[1]).error, /未提供视频下载地址/);
  assert.deepEqual(fs.readdirSync(path.join(h.temp, 'state', 'incoming-videos')), []);
});

await test('拒绝本地路径、内网 URL 和带凭据的 URL', async (t) => {
  const requests = transport(t, []);
  const dir = directory(t);
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1/private', 'http://10.0.0.1/private', 'http://user:secret@93.184.216.34/video']) {
    await assert.rejects(safeFetchFile(url, path.join(dir, 'video.mp4')));
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

await test('重定向重新检查地址，拒绝公网转到内网', async (t) => {
  const requests = transport(t, [{ status: 302, headers: { location: 'http://127.0.0.1/private' } }]);
  const dir = directory(t);
  await assert.rejects(safeFetchFile(PUBLIC, path.join(dir, 'video.mp4')), /内网/);
  assert.equal(requests.length, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

await test('响应声明或实际字节超限都拒绝，不留下半文件', async (t) => {
  transport(t, [{ headers: { 'content-length': '1000' } }, {}]);
  const dir = directory(t);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(safeFetchFile(PUBLIC, path.join(dir, 'video.mp4'), { maxBytes: 10 }), /大小限制/);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

await test('连接中断和总超时会关闭文件流并清理临时文件', async (t) => {
  transport(t, [{ abort: true }, { hang: true }]);
  const dir = directory(t);
  await assert.rejects(safeFetchFile(PUBLIC, path.join(dir, 'video.mp4')), /连接中断/);
  assert.deepEqual(fs.readdirSync(dir), []);
  await assert.rejects(safeFetchFile(PUBLIC, path.join(dir, 'video.mp4'), { timeoutMs: 30 }), /超时/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

await test('排队等待期间撤销接收权限，不再获取地址或下载', async (t) => {
  const dir = directory(t);
  let release;
  let downloads = 0;
  const receiver = createVideoReceiver({ directory: dir, request: async () => { throw new Error('不应请求网关'); },
    downloadFile: async (url, target) => {
      downloads++;
      await new Promise((resolve) => { release = resolve; });
      fs.writeFileSync(target, VIDEO);
      return { size: VIDEO.length };
    },
  });
  let allowed = true;
  const options = normalizeVideoConfig();
  const first = receiver.receive(videoEvent(), options, () => true);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const second = receiver.receive(videoEvent(), options, () => allowed);
  allowed = false;
  release();
  await first;
  assert.equal(await second, '');
  assert.equal(downloads, 1);
});
