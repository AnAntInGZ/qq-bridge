import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function evaluateAndroidHost(facts) {
  const checks=[
    {name:'Linux x86_64/arm64',ok:facts.platform==='linux' && ['x64','arm64'].includes(facts.arch)},
    {name:'4KiB 内存页',ok:facts.pageSize===4096},
    {name:'IPv6 内核接口已启用',ok:facts.ipv6===true},
    {name:'至少 2 vCPU（建议 4）',ok:facts.cpus>=2},
    {name:'可用内存至少 3 GiB（建议主机总内存 8 GiB）',ok:facts.availableMiB>=3072},
    {name:'部署目录可用空间至少 10 GiB',ok:facts.freeGiB>=10},
    {name:'Binder 已加载并提供设备节点',ok:facts.binderReady===true},
    {name:'本机 Docker socket 可用',ok:facts.docker===true},
    {name:'ADB 客户端可用',ok:facts.adb===true},
    {name:'Redroid Android 13 官方镜像已固定 SHA256 摘要',ok:/^redroid\/redroid:13\.0\.0(?:_64only)?-latest@sha256:[a-f0-9]{64}$/.test(facts.image || '')},
  ];
  return {ready:checks.every(check=>check.ok),checks};
}
export async function collectAndroidHostFacts() {
  let availableMiB=0;
  try {availableMiB=Number(/^MemAvailable:\s+(\d+)/m.exec(await fs.readFile('/proc/meminfo','utf8'))?.[1] || 0)/1024;}catch{}
  let freeGiB=0;try{const disk=await fs.statfs(process.cwd());freeGiB=disk.bavail*disk.bsize/1024**3;}catch{}
  const binderReady=(await Promise.all(['/dev/binder','/dev/hwbinder','/dev/vndbinder'].map(async file=>{try{return (await fs.stat(file)).isCharacterDevice();}catch{return false;}}))).every(Boolean);
  let ipv6=false;try{ipv6=(await fs.readFile('/proc/sys/net/ipv6/conf/all/disable_ipv6','utf8')).trim()==='0';}catch{}
  const pageSize=await new Promise(resolve=>execFile('getconf',['PAGESIZE'],{timeout:5000,windowsHide:true,maxBuffer:65536},(error,stdout)=>resolve(error?0:Number(stdout.trim()))));
  const adb=await new Promise(resolve=>execFile('adb',['version'],{timeout:5000,windowsHide:true,maxBuffer:65536},error=>resolve(!error)));
  let docker=false;try{docker=(await fs.stat('/var/run/docker.sock')).isSocket();}catch{}
  return {platform:os.platform(),arch:os.arch(),cpus:os.availableParallelism(),pageSize,ipv6,availableMiB:Math.floor(availableMiB),freeGiB:Math.floor(freeGiB),binderReady,docker,adb,image:process.env.REDROID_IMAGE || ''};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const facts=await collectAndroidHostFacts(),result=evaluateAndroidHost(facts);
  console.log(JSON.stringify({platform:facts.platform,arch:facts.arch,cpus:facts.cpus,availableMiB:facts.availableMiB,freeGiB:facts.freeGiB,...result},null,2));
  process.exitCode=result.ready?0:1;
}
