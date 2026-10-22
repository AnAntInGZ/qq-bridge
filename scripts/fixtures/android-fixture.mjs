import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { normalizeCharacterConfig } from '../../src/character/policy.mjs';
import { TILE_COLORS, crc32 } from '../../src/character/android-image.mjs';
import { move2048 } from '../../src/character/game-2048.mjs';

export const INITIAL_BOARD=[2,2,0,0,4,0,0,0,0,0,0,0,0,0,0,0];
export function androidConfig(overrides={},character={}) {
  return normalizeCharacterConfig({enabled:true,autonomy:{timezone:'UTC'},...character,android:{
    enabled:true,deviceId:'0123456789abcdef',scope:'private:123',width:720,height:1280,dailySeconds:20,dailyActions:4,activitySeconds:10,maxActions:2,
    game:{enabled:true,version:'fixture-1',board:{left:20,top:240,size:680,gap:20}},
    bilibili:{enabled:true,version:'fixture-1',watchSeconds:2,maxVideos:1,scrolls:1,
      selectors:{feedReady:'tv.danmaku.bili:id/feedReady',feedTitle:'tv.danmaku.bili:id/feedTitle',
        feedCard:'',playerReady:'tv.danmaku.bili:id/playerReady'}},
    ...overrides,
  }});
}
export function boardImage(config,grid=INITIAL_BOARD) {
  const image={width:config.width,height:config.height,channels:4,pixels:Buffer.alloc(config.width*config.height*4,255)};
  const board=config.game.board, cell=(board.size-board.gap*5)/4;
  for(let y=board.top;y<board.top+board.size;y++)for(let x=board.left;x<board.left+board.size;x++){const at=(y*config.width+x)*4;image.pixels[at]=187;image.pixels[at+1]=173;image.pixels[at+2]=160;}
  for(let r=0;r<4;r++)for(let c=0;c<4;c++){
    const color=TILE_COLORS[grid[r*4+c]];
    for(let y=Math.ceil(board.top+board.gap+r*(cell+board.gap));y<Math.floor(board.top+board.gap+r*(cell+board.gap)+cell);y++)
      for(let x=Math.ceil(board.left+board.gap+c*(cell+board.gap));x<Math.floor(board.left+board.gap+c*(cell+board.gap)+cell);x++){
        const at=(y*config.width+x)*4;image.pixels[at]=color[0];image.pixels[at+1]=color[1];image.pixels[at+2]=color[2];
      }
  }
  return image;
}
// 播放器画面随时间推进，模拟真机上"进度读不到、但画面确实在动"。
export function screenImage(config, grid, screen, tick) {
  const image=boardImage(config,grid);
  if (screen!=='player') return image;
  const { width } = image;
  for(let y=0;y<48;y++)for(let x=0;x<width;x++){
    const at=(y*width+x)*4;
    image.pixels[at]=(Math.floor(tick/100)+x)%256;
    image.pixels[at+1]=(Math.floor(tick/100)*7+y)%256;
    image.pixels[at+2]=(x+y)%256;
  }
  return image;
}
export function png(image) {
  const chunk=(type,data)=>{
    const buffer=Buffer.alloc(data.length+12);buffer.writeUInt32BE(data.length);buffer.write(type,4);data.copy(buffer,8);
    buffer.writeUInt32BE(crc32(buffer.subarray(4,-4)),buffer.length-4);return buffer;
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(image.width);header.writeUInt32BE(image.height,4);header[8]=8;header[9]=6;
  const raw=Buffer.alloc((image.width*4+1)*image.height);
  for(let y=0;y<image.height;y++)image.pixels.copy(raw,y*(image.width*4+1)+1,y*image.width*4,(y+1)*image.width*4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function node(id,text='',clickable=false) {return {id,text,description:'',class:'android.widget.TextView',package:'tv.danmaku.bili',clickable,enabled:true,left:30,top:300,right:650,bottom:380};}
export function fakeDevice(config,time={value:0},options={}) {
  // 推荐流条目按顺序铺开，连续浏览时才会真的换到下一条。
  const titles=options.titles ?? ['离线夹具视频'];
  // 指定下标模拟"点开才发现不是那一条"：播放态回报的标题与列表候选不一致。
  const misreport=new Set(options.misreport ?? []);
  const CARD_TOP=i=>200+i*280;
  let grid=[...INITIAL_BOARD], screen='feed', current=0;
  const calls={launch:[],gesture:[],stop:[],record:0};
  const device={
    calls,stopFails:false,invalidMove:false,playState:'PLAYING',frozen:false,
    get opened(){return titles[current];},
    async launch(kind,options){options.guard();await options.beforeSend();calls.launch.push(kind);},
    async playback(){return {state:device.playState,code:device.playState==='PLAYING'?3:2,title:misreport.has(current)?'广告位招租：完全无关的另一条内容':titles[current]};},
    // 录屏按真实时长推进墙钟：录制本身就是停留的一部分，夹具必须体现这一点。
    async record(kind,options={}) {
      options.guard?.();options.signal?.throwIfAborted();
      if (device.recordFails) throw new Error('fixture-record-failed');
      calls.record++;
      time.value+=options.seconds*1000;
      return Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.alloc(32)]);
    },
    async observe(kind,options={}) {
      options.guard?.();options.signal?.throwIfAborted();
      const s=config.bilibili.selectors;
      // 卡片按真机形态构造：可点击容器没有 resource-id，靠 content-desc 第一段声明类型。
      let nodes;
      if (kind==='game') nodes=[];
      else if (screen==='player') nodes=[node(s.playerReady)];
      else {
        nodes=[node(s.feedReady)];
        for (const [i,title] of titles.entries()) {
          const at=nodes.length;
          nodes.push({...node(s.feedCard,'',true),description:'视频,'+title+',1.2万播放',top:CARD_TOP(i),bottom:CARD_TOP(i)+260});
          nodes.push({...node(s.feedTitle,title),parent:at,top:CARD_TOP(i)+20,bottom:CARD_TOP(i)+60});
        }
      }
      return {at:Date.now(),hash:createHash('sha256').update(JSON.stringify([grid,nodes,time.value,screen])).digest('hex'),image:screenImage(config,grid,screen,device.frozen?0:time.value),nodes};
    },
    async gesture(kind,frame,action,options) {
      options.guard();const fresh=await device.observe(kind,options);
      if (!options.verify(fresh)) throw new Error('fixture-stale');
      await options.beforeSend(fresh);calls.gesture.push(action);
      if(action.type==='scroll'&&device.scrollFails)throw new Error('安卓命令失败或退出未确认（135）');
      if(kind==='game'&&!device.invalidMove){grid=move2048(grid,action.direction).board;grid[grid.indexOf(0)]=2;}
      else if(action.type==='tap'){
        const index=titles.findIndex((_,i)=>action.node.top===CARD_TOP(i));
        current=index<0?0:index;screen='player';
      }
      else if(action.type==='back')screen='feed';
      options.guard();
    },
    async stop(kind){calls.stop.push(kind);if(device.stopFails)throw new Error('fixture-stop-failed');},
    status(){return {commandInFlight:false};},
  };
  return device;
}
