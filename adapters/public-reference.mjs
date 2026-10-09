import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import path from 'node:path';
import {longJsonRequest} from './long-http.mjs';

function approvedUrl(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.origin!=='https://api.mumugofe.com'||url.username||url.password||!url.pathname.startsWith('/v1/studio/assets/'))
  throw Error('Provider reference URL is not an approved studio artifact');
 return url;
}
export async function referenceHead(value){
 return longJsonRequest(approvedUrl(value),{method:'HEAD',headers:{},timeoutMs:20000,maxBytes:0});
}
function matches(head,bytes,hash){
 const etag=String(head.headers.etag||'').replace(/^W\//,'').replace(/^"|"$/g,'');
 return head.status===200&&String(head.headers['content-type']||'').startsWith('image/png')&&
  Number(head.headers['content-length'])===bytes.length&&etag===hash;
}
export async function publicReference(bytes,send){
 if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>30_000_000||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))
  throw Error('Reference must be a bounded PNG');
 const hash=createHash('sha256').update(bytes).digest('hex');
 const cacheFile=send.referenceCacheDirectory&&send.referenceCacheScope?
  path.join(send.referenceCacheDirectory,hash+'.json'):null;
 let cached;
 if(cacheFile){try{cached=JSON.parse(readFileSync(cacheFile,'utf8'));}catch(error){
  if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;
 }}
 if(cached?.version===1&&cached.scope===send.referenceCacheScope&&cached.sha256===hash&&cached.bytes===bytes.length){
  const url=approvedUrl(cached.url),head=await referenceHead(url.href);
  if(matches(head,bytes,hash))return url.href;
  if(![200,401,403,404,410].includes(head.status))throw Error('Reference cache verification failed: HTTP '+head.status);
 }
 // PUT is idempotent and non-billable. Paid POSTs are never retried here.
 const data=await send('/studio/assets/'+hash,{method:'PUT',body:bytes,timeoutMs:120000});
 const url=approvedUrl(data.url),head=await referenceHead(url.href);
 if(!matches(head,bytes,hash))throw Error('Uploaded full reference failed SHA-256/length verification');
 if(cacheFile){
  mkdirSync(path.dirname(cacheFile),{recursive:true});
  const temp=cacheFile+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify({version:1,scope:send.referenceCacheScope,sha256:hash,bytes:bytes.length,url:url.href,verifiedAt:new Date().toISOString()}),{mode:0o600});
  renameSync(temp,cacheFile);
 }
 return url.href; // Never log its signed query or copy credentials.
}
