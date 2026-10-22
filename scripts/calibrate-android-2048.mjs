import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeScreenshot, suggest2048Board } from '../src/character/android-image.mjs';

export async function calibrate2048(file,width=720,height=1280) {
  if (!Number.isInteger(width)||width<320||width>1440||!Number.isInteger(height)||height<480||height>2560)throw new Error('截图尺寸无效');
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>8*1024*1024)throw new Error('校准截图文件边界无效');
  return suggest2048Board(decodeScreenshot(await fs.readFile(file),width,height));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(![3,5].includes(process.argv.length))throw new Error('用法：node scripts/calibrate-android-2048.mjs screenshot.png [width height]');
    console.log(JSON.stringify(await calibrate2048(process.argv[2],Number(process.argv[3]||720),Number(process.argv[4]||1280)),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
