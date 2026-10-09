import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(os.tmpdir(),'manju-mp4-'));
process.env.MANJU_DATA_DIR=path.join(root,'data');
const {renderMp4}=await import('../dist-server/server/mp4-render.js');
function run(args) {
  const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:8e6});
  assert.equal(r.status,0,r.stderr?.toString());return r.stdout;
}
function clip(color,size,duration,speed,tone) {
  const file=path.join(root,color+'.mp4');
  run(['-f','lavfi','-i',`color=c=${color}:s=${size}:r=30`,...(tone?['-f','lavfi','-i',`sine=frequency=${tone}:sample_rate=48000`]:[]),
    '-t',String(duration),'-c:v','libx264','-pix_fmt','yuv420p',...(tone?['-c:a','aac']:[]),file]);
  const [width,height]=size.split('x').map(Number);
  return {file,width,height,hasAudio:!!tone,sourceStartUs:0,durationUs:duration*1e6,speed,segmentId:color,preview:false};
}
function pixel(file,time) {
  return [...run(['-ss',String(time),'-i',file,'-frames:v','1','-vf','crop=2:2:80:44','-f','rawvideo','-pix_fmt','rgb24','-']).subarray(0,3)];
}
function audio(file,time) {
  const b=run(['-ss',String(time),'-i',file,'-t','0.2','-vn','-f','s16le','-ac','1','-ar','48000','-']);
  const samples=Array.from({length:b.length/2},(_,i)=>b.readInt16LE(i*2));
  const rms=Math.sqrt(samples.reduce((n,v)=>n+v*v,0)/samples.length);
  let crossings=0;for(let i=1;i<samples.length;i++)if(samples[i-1]<0&&samples[i]>=0)crossings++;
  return {rms,hz:crossings/(samples.length/48000)};
}
test('MP4 preserves order, audio pitch and silence across sizes, crops and speeds',async()=>{
  const red=clip('red','160x90',1.4,2,440);red.sourceStartUs=200000;red.durationUs=1200000;
  const clips=[red,clip('blue','120x90',1,0.5),clip('green','240x136',0.8,1,880)];
  const out=await renderMp4(clips,path.join(root,'work'));
  assert.equal(out.width,160);assert.equal(out.height,90);assert.equal(out.hasAudio,true);
  assert.ok(Math.abs(out.duration-3.4)<0.2);
  let rgb=pixel(out.file,0.2);assert.ok(rgb[0]>180&&rgb[2]<30,rgb);
  rgb=pixel(out.file,1.4);assert.ok(rgb[2]>180&&rgb[0]<30,rgb);
  rgb=pixel(out.file,2.9);assert.ok(rgb[1]>75&&rgb[0]<30,rgb);
  let sound=audio(out.file,0.2);assert.ok(sound.rms>500);assert.ok(Math.abs(sound.hz-440)<25,sound.hz);
  sound=audio(out.file,1.4);assert.ok(sound.rms<20,sound.rms);
  sound=audio(out.file,2.9);assert.ok(sound.rms>500);assert.ok(Math.abs(sound.hz-880)<25,sound.hz);
  await assert.rejects(renderMp4([{...red,speed:0}],path.join(root,'bad')),/无效/);
});
