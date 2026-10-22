import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectAndroidHostFacts, evaluateAndroidHost } from './check-android-host.mjs';

export async function startAndroid({ apply=false, facts, command } = {}) {
  if (!apply) throw new Error('此命令会在当前 Linux 节点创建特权安卓容器；核对部署指南后显式传入 --apply');
  facts ??= await collectAndroidHostFacts();
  const result=evaluateAndroidHost(facts);
  if (!result.ready) throw new Error('安卓节点前置检查未通过：'+result.checks.filter(item=>!item.ok).map(item=>item.name).join('；'));
  command ??= args=>new Promise((resolve,reject)=>execFile('docker',args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024},(error,stdout)=>{
    if (error) reject(new Error('Docker 请求未成功'));else resolve(stdout);
  }));
  // 不拉取镜像、不安装内核模块，也不覆盖任何已有同名容器。
  const existing=(await command(['container','ls','-a','--filter','name=^/qq-android-redroid$','--format','{{.ID}}'])).trim();
  if (existing) throw new Error('同名安卓容器已存在，请人工核对，脚本不会重建它');
  await command(['image','inspect',facts.image]);
  const directory=fileURLToPath(new URL('../deploy/android',import.meta.url));
  const data=path.join(directory,'data');
  try {await fs.mkdir(data,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=await fs.lstat(data);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(data)!==path.join(await fs.realpath(directory),'data') || (stat.mode & 0o077)) throw new Error('安卓数据目录边界或权限无效');
  await command(['compose','-f',path.join(directory,'compose.yml'),'up','-d']);
  return {containerRequested:true,androidReady:false};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await startAndroid({apply:process.argv.length===3 && process.argv[2]==='--apply'})));}
  catch(error) {console.error(error.message);process.exitCode=1;}
}
