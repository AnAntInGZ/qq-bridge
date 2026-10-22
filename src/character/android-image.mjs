import { inflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

// 仅解码 ADB 产生的有限尺寸 RGB/RGBA PNG，不引入通用图片执行能力。
export function decodeScreenshot(buffer, width, height) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 8 * 1024 * 1024 || !buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('安卓截图格式无效');
  let offset = 8, channels = 0, ended = false, header = false;
  const chunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), end = offset + 12 + length;
    if (end > buffer.length) throw new Error('安卓截图被截断');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, end - 4);
    if (crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) throw new Error('安卓截图校验失败');
    if (type === 'IHDR') {
      if (header || offset !== 8 || length !== 13 || body.readUInt32BE(0) !== width || body.readUInt32BE(4) !== height
        || body[8] !== 8 || ![2,6].includes(body[9]) || body[10] || body[11] || body[12]) throw new Error('安卓画面尺寸或编码改变');
      channels = body[9] === 6 ? 4 : 3; header = true;
    } else if (type === 'IDAT' && header) chunks.push(body);
    else if (type === 'IEND') { if (length) throw new Error('安卓截图结束无效'); ended = true; offset = end; break; }
    else if (type[0] === type[0].toUpperCase()) throw new Error('安卓截图包含不支持的数据');
    offset = end;
  }
  if (!ended || offset !== buffer.length || !chunks.length) throw new Error('安卓截图不完整');
  const stride = width * channels, expected = height * (stride + 1);
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  if (raw.length !== expected) throw new Error('安卓截图像素长度无效');
  const pixels = Buffer.alloc(width * height * channels);
  const paeth = (a,b,c) => { const p = a+b-c, x = Math.abs(p-a), y = Math.abs(p-b), z = Math.abs(p-c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('安卓截图过滤器无效');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= channels ? pixels[at-channels] : 0, above = y ? pixels[at-stride] : 0, corner = y && x >= channels ? pixels[at-stride-channels] : 0;
      pixels[at] = (raw[y*(stride+1)+1+x] + [0,left,above,Math.floor((left+above)/2),paeth(left,above,corner)][filter]) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export const TILE_COLORS = Object.freeze({ 0: [205,193,180], 2: [238,228,218], 4: [237,224,200], 8: [242,177,121],
  16: [245,149,99], 32: [246,124,95], 64: [246,94,59], 128: [237,207,114], 256: [237,204,97],
  512: [237,200,80], 1024: [237,197,63], 2048: [237,194,46] });

// 播放器画面是否真的在推进：B 站播放器是自绘 SurfaceView，UI 树里读不到进度，
// 只能比较两张截图的像素变化。返回变化像素占全屏比例，供调用方与阈值比较。
export function frameChange(before, after) {
  if (!before || !after || before.width !== after.width || before.height !== after.height
    || before.channels !== after.channels) throw new Error('安卓画面无法比较');
  const { channels, pixels } = before, other = after.pixels, total = before.width * before.height;
  if (pixels.length !== total * channels || other.length !== total * channels) throw new Error('安卓画面无法比较');
  let changed = 0;
  for (let index = 0; index < total; index++) {
    const at = index * channels;
    if (Math.abs(pixels[at]-other[at]) + Math.abs(pixels[at+1]-other[at+1]) + Math.abs(pixels[at+2]-other[at+2]) > 24) changed++;
  }
  return changed / total;
}
export function read2048(image, board) {
  const cell = (board.size - board.gap * 5) / 4;
  const grid = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    let value = null;
    for (const dy of [0.18,0.28,0.72,0.82]) for (const dx of [0.18,0.82]) {
      const x = Math.floor(board.left + board.gap + col*(cell+board.gap) + dx*cell);
      const y = Math.floor(board.top + board.gap + row*(cell+board.gap) + dy*cell);
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) throw new Error('2048 截图校准越界');
      const at = (y*image.width+x)*image.channels;
      if (image.channels === 4 && image.pixels[at+3] !== 255) throw new Error('2048 棋盘透明度异常');
      const found = Object.entries(TILE_COLORS).filter(([,color]) => color.every((component, i) => Math.abs(component-image.pixels[at+i]) <= 4));
      if (found.length !== 1 || (value !== null && value !== Number(found[0][0]))) throw new Error('2048 棋盘未知或仍在动画中');
      value = Number(found[0][0]);
    }
    grid.push(value);
  }
  if (grid.every(value => value === 0)) throw new Error('2048 棋盘尚未就绪');
  return grid;
}

export function suggest2048Board(image) {
  const {width,height,channels,pixels}=image, visited=new Uint8Array(width*height), queue=new Int32Array(width*height);
  const background=index=>{const at=index*channels;return [187,173,160].every((value,i)=>Math.abs(value-pixels[at+i])<=2);};
  const candidates=[];
  for(let index=0;index<visited.length;index++){
    if(visited[index] || !background(index))continue;
    let start=0,end=1;queue[0]=index;visited[index]=1;
    let left=width,top=height,right=0,bottom=0;
    while(start<end){
      const current=queue[start++],x=current%width,y=Math.floor(current/width);
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(const next of [x?current-1:-1,x<width-1?current+1:-1,y?current-width:-1,y<height-1?current+width:-1]){
        if(next>=0&&!visited[next]&&background(next)){visited[next]=1;queue[end++]=next;}
      }
    }
    const size=right-left+1;
    if(size<160 || size>width || Math.abs(size-(bottom-top+1))>1)continue;
    const y=Math.floor(top+size*0.15);let gap=0;
    for(let x=left;x<left+size/4;x++){if(!background(y*width+x)){gap=x-left;break;}}
    if(gap<3 || gap>60 || size<=gap*9)continue;
    const board={left,top,size,gap};
    try{const grid=read2048(image,board);candidates.push({board,grid});}catch{}
  }
  if(candidates.length!==1)throw new Error('未找到唯一可信的 2048 棋盘，需要人工校准');
  return {...candidates[0],reviewRequired:true};
}
