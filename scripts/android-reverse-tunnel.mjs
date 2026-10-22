import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function port(value, label) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(number) || number < 1024 || number > 65535 || number === 5037)
    throw new Error(label + '必须是 1024～65535 的设备端口，不能转发 ADB 服务端口 5037');
  return number;
}
export function tunnelPlan(options = {}) {
  const server = options.server;
  if (typeof server !== 'string' || !/^(?:[a-z_][a-z0-9_-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(server))
    throw new Error('请提供 SSH 别名或 user@host');
  const localPort = port(options.localPort, '本机端口');
  const remotePort = port(options.remotePort ?? 15555, '服务器端口');
  const base = ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10'];
  if (options.identity) base.push('-i', options.identity, '-o','IdentitiesOnly=yes');
  return {
    ssh: options.ssh || 'ssh',
    adb: options.adb || 'adb',
    server, localPort, remotePort,
    serial: '127.0.0.1:' + localPort,
    serverSerial: '127.0.0.1:' + remotePort,
    base,
    args: [...base,'-NT','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15',
      '-o','ServerAliveCountMax=3','-R','127.0.0.1:' + remotePort + ':127.0.0.1:' + localPort,server],
    listenerCommand: "ss -H -lnt 'sport = :" + remotePort + "'",
  };
}
export function assertLoopbackListener(output, remotePort, { vacant = false } = {}) {
  const rows = String(output).trim().split(/\r?\n/).filter(Boolean);
  if (vacant) {
    if (rows.length) throw new Error('服务器端口已占用，拒绝覆盖已有转发');
    return;
  }
  // 核对实际监听，防止 sshd 的 GatewayPorts 配置把 -R 扩为公网监听。
  if (rows.length !== 1 || rows[0].trim().split(/\s+/)[3] !== '127.0.0.1:' + remotePort)
    throw new Error('SSH 反向转发未确认仅在服务器 IPv4 回环监听');
}
function command(executable, args) {
  return new Promise((resolveCommand, reject) => execFile(executable,args,{
    encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:64*1024,
  },(error,stdout)=>error ? reject(new Error('连接检查命令失败，请核对 ADB、SSH 或主机信任')) : resolveCommand(stdout)));
}
export async function checkTunnelDevice(plan, deviceId, execute = command) {
  if (!/^[0-9a-f]{16}$/.test(deviceId || '')) throw new Error('必须提供预先核对的 --device-id（16 位 android_id）');
  const connected = await execute(plan.adb,['connect',plan.serial]);
  if (!connected.includes('connected to ' + plan.serial)) throw new Error('本机模拟器未连接');
  if ((await execute(plan.adb,['-s',plan.serial,'get-state'])).trim() !== 'device') throw new Error('模拟器未授权或离线');
  if ((await execute(plan.adb,['-s',plan.serial,'shell','settings','get','secure','android_id'])).trim() !== deviceId)
    throw new Error('模拟器身份与指定设备不符，拒绝转发');
}
export async function openAndroidTunnel(options = {}, { execute = command, launch = spawn, sleep = ms => new Promise(r=>setTimeout(r,ms)) } = {}) {
  const plan = tunnelPlan(options);
  if (!options.apply) return { ...plan, requested:false };
  options.signal?.throwIfAborted();
  await checkTunnelDevice(plan,options.deviceId,execute);
  const listeners = () => execute(plan.ssh,[...plan.base,plan.server,plan.listenerCommand]);
  assertLoopbackListener(await listeners(),plan.remotePort,{vacant:true});
  options.signal?.throwIfAborted();
  const child = launch(plan.ssh,plan.args,{windowsHide:true,stdio:['ignore','ignore','inherit']});
  let exited = false, spawnError = false;
  const closed = new Promise(resolveClose=>{
    child.once('error',()=>{spawnError=true;});
    child.once('close',(code,signal)=>{exited=true;resolveClose({code,signal,spawnError});});
  });
  const abort = ()=>{ if (!exited) child.kill(); };
  options.signal?.addEventListener('abort',abort,{once:true});
  void closed.then(()=>options.signal?.removeEventListener('abort',abort));
  const terminate = async()=>{
    if (!exited) child.kill();
    await closed;
  };
  try {
    let ready = false;
    for (let index=0; index<8; index++) {
      options.signal?.throwIfAborted();
      if (exited || spawnError) throw new Error('SSH 隧道启动失败');
      const output = await listeners();
      if (output.trim()) { assertLoopbackListener(output,plan.remotePort); ready=true;break; }
      await sleep(250);
    }
    if (!ready || exited) throw new Error('SSH 隧道未就绪');
    return { requested:true,serverSerial:plan.serverSerial,closed,terminate };
  } catch (error) { await terminate();throw error; }
}
export function argumentsFrom(argv) {
  const allowed = new Set(['server','local-port','remote-port','ssh','adb','identity','device-id']);
  const options = {};
  for (let index=0;index<argv.length;index++) {
    const arg = argv[index];
    if (arg === '--apply') {options.apply=true;continue;}
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!allowed.has(name) || !argv[index+1] || argv[index+1].startsWith('--')) throw new Error('未知或不完整参数：' + arg);
    const key = name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
    if (Object.hasOwn(options,key)) throw new Error('参数重复：' + arg);
    options[key] = argv[++index];
  }
  return options;
}
async function main() {
  const controller = new AbortController();
  const stop = ()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    const result = await openAndroidTunnel({...argumentsFrom(process.argv.slice(2)),signal:controller.signal});
    if (!result.requested) {
      console.log(JSON.stringify({apply:false,serverSerial:result.serverSerial,command:result.ssh,args:result.args},null,2));
      console.log('仅预览。确认指定实例与 android_id 后，添加 --device-id 和 --apply；保持该终端运行。');
      return;
    }
    console.log('SSH 隧道已核对为服务器回环监听：' + result.serverSerial + '。Ctrl+C 断开；不会自动重放安卓动作。');
    const ended = await result.closed;
    if (ended.spawnError || (ended.code !== 0 && !ended.signal)) process.exitCode=1;
  } finally {
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
