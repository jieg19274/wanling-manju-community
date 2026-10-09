import http from 'node:http';
import https from 'node:https';

// Reach this relay directly, without inheriting the desktop's global proxy.
// Other destinations keep their existing transport.
const relayAgent = new https.Agent({keepAlive:true, proxyEnv:{}});
export const isDirectRelay = url => url.origin === 'https://api.mumugofe.com';

// Text completions can take longer than fetch's default header wait. Preserve
// the explicit adapter deadline and never retry a possibly paid submission.
export function longJsonRequest(url, {method, headers, body, timeoutMs, maxBytes=32*1024*1024,onChunk}) {
  return new Promise((resolve,reject)=>{
    const transport=url.protocol==='https:'?https:http;
    let settled=false,timer;
    const finish=(error,value)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(error)reject(error);else resolve(value);
    };
    const requestHeaders={...headers};
    if(body!==undefined&&!Object.keys(requestHeaders).some(k=>k.toLowerCase()==='content-length'))
      requestHeaders['content-length']=Buffer.byteLength(body);
    const req=transport.request(url,{method,headers:requestHeaders,
      ...(isDirectRelay(url)?{agent:relayAgent}:{})},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{
        size+=chunk.length;
        if(size>maxBytes){req.destroy(new Error('模型响应超过允许大小'));return;}
        try{onChunk?.(chunk);}catch(error){req.destroy(error);return;}
        chunks.push(chunk);
      });
      res.on('error',error=>finish(error));
      res.on('aborted',()=>finish(new Error('模型响应连接中断；远端状态未明，禁止自动重试')));
      res.on('end',()=>finish(null,{status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,
        headers:res.headers,
        requestId:res.headers['x-request-id']||res.headers['x-oneapi-request-id']||'',
        raw:Buffer.concat(chunks).toString('utf8')}));
    });
    timer=setTimeout(()=>req.destroy(new Error('模型请求超过明确等待时限；远端状态未明，禁止自动重试')),timeoutMs);
    req.on('error',error=>finish(error));
    if(body!==undefined)req.write(body);
    req.end();
  });
}
