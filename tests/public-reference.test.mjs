import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {publicReference} from '../adapters/public-reference.mjs';

const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('mock')]);
const hash=createHash('sha256').update(png).digest('hex');
const referenceUrl='https://api.mumugofe.com/v1/studio/assets/owned/artifacts/source/content?access=mock';
const validHead={status:200,headers:{'content-type':'image/png','content-length':String(png.length),etag:'"'+hash+'"'}};

function mockHeads(t,responses=[validHead]){
 let calls=0;
 t.mock.method(https,'request',(url,options,callback)=>{
  assert.equal(url.origin,'https://api.mumugofe.com');
  assert.equal(options.method,'HEAD');
  assert.ok(options.agent,'relay HEAD must use its explicit direct agent');
  assert.equal(options.headers.authorization,undefined);
  const response=responses[Math.min(calls++,responses.length-1)];
  const request=new EventEmitter();
  request.write=()=>{throw Error('HEAD must not send reference bytes');};
  request.end=()=>queueMicrotask(()=>{
   const stream=Readable.from([]);
   stream.statusCode=response.status;stream.headers=response.headers;
   callback(stream);
  });
  request.destroy=error=>queueMicrotask(()=>request.emit('error',error));
  return request;
 });
 return()=>calls;
}

test('full PNG upload verifies checksum, size and approved destination without network',async t=>{
 const heads=mockHeads(t);let uploads=0;
 const send=async(route,options)=>{
  uploads++;assert.equal(route,'/studio/assets/'+hash);assert.equal(options.method,'PUT');
  assert.equal(options.body,png);return{url:referenceUrl};
 };
 assert.equal(await publicReference(png,send),referenceUrl);
 assert.equal(uploads,1);assert.equal(heads(),1);
 await assert.rejects(publicReference(Buffer.from('bad'),()=>{throw Error('must not send');}));
 await assert.rejects(publicReference(png,async()=>({url:'https://third-party.example/ref.png'})));
 assert.equal(heads(),1);
});

test('uploaded reference with wrong full-image checksum is rejected',async t=>{
 mockHeads(t,[{...validHead,headers:{...validHead.headers,etag:'"wrong"'}}]);
 await assert.rejects(publicReference(png,async()=>({url:referenceUrl})),/SHA-256\/length verification/);
});

test('verified cached URLs skip upload and expired URLs are renewed with a non-billable PUT',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'manju-reference-test-'));
 t.after(async()=>{
  assert.equal(path.dirname(directory),path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('manju-reference-test-'));
  await rm(directory,{recursive:true,force:true});
 });
 const heads=mockHeads(t,[validHead,validHead,{status:403,headers:{}},validHead]);
 let uploads=0;
 const send=async(route,options)=>{
  uploads++;assert.equal(options.method,'PUT');assert.equal(route,'/studio/assets/'+hash);
  return{url:referenceUrl};
 };
 send.referenceCacheDirectory=directory;send.referenceCacheScope='owned-provider';
 assert.equal(await publicReference(png,send),referenceUrl);
 assert.equal(await publicReference(png,send),referenceUrl);
 assert.equal(uploads,1);
 assert.equal(await publicReference(png,send),referenceUrl);
 assert.equal(uploads,2);assert.equal(heads(),4);
});
