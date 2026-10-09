import {readFileSync,writeFileSync} from 'node:fs';
import sharp from 'sharp';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(request.task==='health'){writeFileSync(process.argv[3],JSON.stringify({ok:true}));process.exit(0);}
if(request.task!=='asset-image')throw Error('Unknown offline fixture task');
writeFileSync(process.argv[3]+'.request.json',JSON.stringify(request));
const panels=await Promise.all(['#f02020','#20f020','#2020f0','#f0f020'].map(background=>sharp({create:{width:320,height:640,channels:3,background}}).png().toBuffer()));
await sharp({create:{width:1280,height:640,channels:3,background:'#fff'}}).composite(panels.map((input,index)=>({input,left:index*320,top:0}))).png().toFile(process.argv[3]);
