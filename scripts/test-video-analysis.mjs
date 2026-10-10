// 使用临时附件和模拟方舟响应，验证上传字节、权限与清理，不调用真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createVideoAnalyzer, normalizeVideoAnalysisConfig, readArkKey } from '../src/analyze-video.js';
import { registerVideoAttachment, resolveVideoAttachment } from '../src/video-attachments.js';

const VIDEO = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const KEY = 'fixture-only-not-a-real-credential';
const ID = 'file-fixture-1';
const finished = answer => ({ status: 'completed', output: [
  { type: 'reasoning', summary: [{ text: '不应回传的思考内容' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] },
] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-analysis-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'state/incoming-videos');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(root, 'state/secrets'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'state/secrets/ark-api-key'), KEY, { mode: 0o600 });
  const filePath = path.join(directory, randomUUID() + '.mp4');
  fs.writeFileSync(filePath, VIDEO);
  const calls = [];
  const config = normalizeVideoAnalysisConfig({ enabled: true, apiKeyEnv: 'QQ_BRIDGE_ANALYSIS_TEST_KEY' });
  delete process.env.QQ_BRIDGE_ANALYSIS_TEST_KEY;
  const fetchImpl = async (url, init) => {
    let bytes;
    if (typeof init.body !== 'string' && init.body) {
      const chunks = [];
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      bytes = Buffer.concat(chunks);
    }
    calls.push({ url, init, bytes });
    assert.equal(new URL(url).origin, 'https://ark.cn-beijing.volces.com');
    assert.equal(init.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(init.redirect, 'error');
    let payload = url.endsWith('/files') ? { id: ID, status: 'processing' }
      : url.endsWith('/responses') ? finished('00:00 画面中有彩条；声音无法确认。')
      : { id: ID, status: 'active' };
    return Response.json(payload);
  };
  return { root, directory, filePath, calls, config, fetchImpl,
    args: { filePath, question: '画面和声音各是什么？', config } };
}

await test('上传完整原视频、带模型和帧率预处理，引用文件分析后删除', async t => {
  const f = fixture(t);
  const analyze = createVideoAnalyzer({ root: f.root, fetchImpl: f.fetchImpl, pollMs: 1 });
  const result = await analyze(f.args);
  assert.match(result.answer, /彩条/);
  assert.doesNotMatch(JSON.stringify(result), /思考内容|fixture-only/);
  assert.deepEqual(f.calls.map(c => [c.init.method ?? 'GET', new URL(c.url).pathname]), [
    ['POST', '/api/v3/files'], ['GET', '/api/v3/files/' + ID],
    ['POST', '/api/v3/responses'], ['DELETE', '/api/v3/files/' + ID],
  ]);
  const upload = f.calls[0];
  assert.equal(Number(upload.init.headers['content-length']), upload.bytes.length);
  assert.ok(upload.bytes.includes(VIDEO));
  assert.match(upload.bytes.toString(), /name="preprocess_configs\[video\]\[model\]"\r\n\r\ndoubao-seed-2-1-lite-260915/);
  assert.match(upload.bytes.toString(), /name="preprocess_configs\[video\]\[fps\]"\r\n\r\n1/);
  assert.doesNotMatch(upload.bytes.toString(), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const body = JSON.parse(f.calls[2].init.body);
  assert.equal(body.store, false);
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.input[0].content[0].file_id, ID);
  assert.match(body.instructions, /声音/);
  assert.deepEqual(fs.readFileSync(f.filePath), VIDEO);
});

await test('未配置密钥、未启用、模式不允许时不发网络请求', async t => {
  const f = fixture(t);
  let requests = 0;
  const analyze = createVideoAnalyzer({ root: f.root, fetchImpl: async () => { requests++; }, isAllowed: () => false });
  await assert.rejects(analyze(f.args), /权限已撤销/);
  const enabled = createVideoAnalyzer({ root: f.root, fetchImpl: async () => { requests++; } });
  await assert.rejects(enabled({ ...f.args, config: { enabled: false } }), /尚未启用/);
  fs.unlinkSync(path.join(f.root, f.config.apiKeyFile));
  await assert.rejects(enabled(f.args), /密钥未配置/);
  assert.equal(requests, 0);
});

await test('密钥只从私有普通文件或指定环境变量读取', t => {
  const f = fixture(t);
  assert.equal(readArkKey(f.config, f.root, {}), KEY);
  assert.equal(readArkKey(f.config, f.root, { QQ_BRIDGE_ANALYSIS_TEST_KEY: 'env-fixture' }), 'env-fixture');
  const keyPath = path.join(f.root, f.config.apiKeyFile);
  fs.chmodSync(keyPath, 0o644);
  if (process.platform !== 'win32') assert.throws(() => readArkKey(f.config, f.root, {}), /安全读取/);
  fs.unlinkSync(keyPath);
  fs.symlinkSync(f.filePath, keyPath);
  assert.throws(() => readArkKey(f.config, f.root, {}));
});

await test('拒绝附件目录之外、符号链接、硬链接、伪视频和超限文件', async t => {
  const f = fixture(t);
  const analyze = createVideoAnalyzer({ root: f.root, fetchImpl: f.fetchImpl });
  await assert.rejects(analyze({ ...f.args, filePath: path.join(f.root, 'config.json') }), /只能分析/);
  const linked = path.join(f.directory, randomUUID() + '.mp4');
  const outside = path.join(f.root, 'outside.mp4');
  fs.writeFileSync(outside, VIDEO);
  fs.symlinkSync(outside, linked);
  await assert.rejects(analyze({ ...f.args, filePath: linked }), /符号链接/);
  fs.unlinkSync(linked);
  fs.linkSync(outside, linked);
  await assert.rejects(analyze({ ...f.args, filePath: linked }), /类型或大小/);
  await assert.rejects(analyze({ ...f.args, config: { ...f.config, maxBytes: 12 } }), /类型或大小/);
  fs.writeFileSync(f.filePath, 'this is not a video container');
  await assert.rejects(analyze(f.args), /格式后重发/);
  assert.equal(f.calls.length, 0);
});

await test('鉴权错误正文和网络异常不泄漏密钥或请求地址', async t => {
  const f = fixture(t);
  for (const fetchImpl of [
    async () => new Response(KEY + f.root, { status: 401 }),
    async () => { throw new Error(KEY + f.root); },
    async () => new Response(KEY + f.root),
  ]) {
    const analyze = createVideoAnalyzer({ root: f.root, fetchImpl });
    await assert.rejects(analyze(f.args), error => {
      assert.ok(!error.message.includes(KEY) && !error.message.includes(f.root));
      return true;
    });
  }
});

await test('处理失败、输出不完整或输出泄密时仍删除远端文件', async t => {
  const f = fixture(t);
  for (const scenario of ['failed', 'incomplete', 'secret', 'malformed']) {
    const calls = [];
    const analyze = createVideoAnalyzer({ root: f.root, fetchImpl: async (url, init) => {
      calls.push(init.method ?? 'GET');
      if (url.endsWith('/files')) {
        for await (const chunk of init.body) {}
        return Response.json({ id: ID, status: scenario === 'failed' ? 'error' : 'active' });
      }
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (scenario === 'malformed') return new Response(KEY);
      const data = finished(scenario === 'secret' ? KEY : '部分输出');
      if (scenario === 'incomplete') data.status = 'incomplete';
      return Response.json(data);
    } });
    await assert.rejects(analyze(f.args));
    assert.equal(calls.at(-1), 'DELETE');
  }
});

await test('远端删除失败明确提示，404 视为已经删除', async t => {
  const f = fixture(t);
  for (const status of [500, 404]) {
    const analyze = createVideoAnalyzer({ root: f.root, pollMs: 1, fetchImpl: async (url, init) =>
      init.method === 'DELETE' ? new Response('fixture', { status }) : f.fetchImpl(url, init) });
    const result = await analyze(f.args);
    if (status === 500) assert.match(result.warning, /一天有效期/);
    else assert.equal(result.warning, undefined);
  }
});

await test('处理中撤销模式或更换 owner 后不调用模型，并清理上传文件', async t => {
  const f = fixture(t);
  for (const next of [false, 'owner-b']) {
    let identity = 'owner-a';
    const analyze = createVideoAnalyzer({ root: f.root, isAllowed: () => identity,
      fetchImpl: async (url, init) => {
        const response = await f.fetchImpl(url, init);
        if (url.endsWith('/files')) identity = next;
        return response;
      } });
    await assert.rejects(analyze(f.args), /权限已撤销/);
    assert.equal(f.calls.at(-1).init.method, 'DELETE');
    assert.ok(!f.calls.some(c => c.url.endsWith('/responses')));
  }
});

await test('并发调用拒绝；超时清理文件后释放锁，可再次分析', async t => {
  const f = fixture(t);
  let waiting;
  let shouldWait = true;
  const analyze = createVideoAnalyzer({ root: f.root, pollMs: 1, fetchImpl: async (url, init) => {
    if (url.endsWith('/responses') && shouldWait) {
      waiting = true;
      await delay(1000, undefined, { signal: init.signal });
    }
    return f.fetchImpl(url, init);
  } });
  const first = analyze({ ...f.args, config: { ...f.config, timeoutMs: 100 } });
  const firstCheck = assert.rejects(first, /超时/);
  while (!waiting) await delay(1);
  await assert.rejects(analyze(f.args), /另一个视频/);
  await firstCheck;
  assert.equal(f.calls.at(-1).init.method, 'DELETE');
  shouldWait = false;
  assert.match((await analyze(f.args)).answer, /彩条/);
});

await test('异常远端文件 ID 不能构造新 URL；配置拒绝超时与帧率越界', async t => {
  const f = fixture(t);
  const analyze = createVideoAnalyzer({ root: f.root, fetchImpl: async (url, init) => {
    for await (const chunk of init.body) {}
    return Response.json({ id: 'https://untrusted.example/steal', status: 'active' });
  } });
  await assert.rejects(analyze(f.args), /文件标识/);
  assert.throws(() => normalizeVideoAnalysisConfig({ fps: 6 }), /fps/);
  assert.throws(() => normalizeVideoAnalysisConfig({ timeoutMs: 325000 }), /timeoutMs/);
});

await test('四种模式只解析已登记附件；模式切换、撤销白名单、过期和伪造编号都拒绝', t => {
  const f = fixture(t);
  for (const mode of ['closed-agent', 'chat', 'reserved', 'reserved2']) {
    const config = { ownerQQ: '123', allow: { private: ['123'], groups: ['456'] } };
    const attachmentId = registerVideoAttachment({ root: f.root, filePath: f.filePath, kind: 'private', id: '123', mode, ownerQQ: '123' });
    const args = { root: f.root, attachmentId, config, mode };
    assert.equal(resolveVideoAttachment(args).filePath, f.filePath);
    assert.throws(() => resolveVideoAttachment({ ...args, mode: 'another' }), /不允许分析/);
    if (mode === 'closed-agent') assert.throws(() => resolveVideoAttachment({ ...args, config: { ...config, ownerQQ: '124' } }));
    else assert.throws(() => resolveVideoAttachment({ ...args, config: { allow: { private: ['124'] } } }));
    const recordPath = path.join(f.root, 'state/video-attachments', attachmentId + '.json');
    const record = JSON.parse(fs.readFileSync(recordPath));
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, expiresAt: 0 }));
    assert.throws(() => resolveVideoAttachment(args), /过期/);
  }
  assert.throws(() => resolveVideoAttachment({ root: f.root, attachmentId: '../config', config: {}, mode: 'chat' }), /编号/);
  assert.throws(() => resolveVideoAttachment({ root: f.root, attachmentId: randomUUID(), config: {}, mode: 'chat' }), /不存在/);
});
