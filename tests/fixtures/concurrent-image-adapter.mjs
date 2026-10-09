import fs from 'node:fs';
import sharp from 'sharp';
const task=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const record=event=>fs.appendFileSync(process.env.MANJU_TEST_QUEUE_EVENTS,JSON.stringify({event,id:task.candidateId,time:Date.now()})+'\n');
record('start');
await new Promise(resolve=>setTimeout(resolve,500));
if(task.asset.name==='failed-fixture'){record('end');throw Error('Explicit offline fixture failure');}
await sharp({create:{width:128,height:64,channels:3,background:'#ddd'}}).png().toFile(process.argv[3]);
record('end');
