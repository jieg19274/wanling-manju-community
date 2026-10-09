// Preview only: allow the explicitly configured read-only catalog, never generation/upload.
const original=globalThis.fetch;
const configured=process.env.MANJU_CATALOG_API_BASE_URL;
const catalog=configured?new URL(configured.replace(/\/$/,'')+'/models'):null;
// A completed approved video may redirect its read-only content endpoint to a
// signed storage URL. Authorize only that exact response-derived GET, never an
// arbitrary storage origin, and never send provider credentials to storage.
const resultRedirects=new Set();
function rememberResultRedirect(response,from){
  if([301,302,303,307,308].includes(response.status)){
    const location=response.headers?.get('location');
    if(location){const next=new URL(location,from);if(next.protocol==='https:'&&!next.username&&!next.password)resultRedirects.add(next.href);}
  }
  return response;
}
globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  const method=String(options?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))return original(input,options);
  if(catalog&&catalog.protocol==='https:'&&url.origin===catalog.origin&&!url.username&&!url.password&&
    (method==='GET'&&['/api/studio-wallet/config','/api/studio-wallet/balance'].includes(url.pathname)||method==='POST'&&['/api/studio-wallet/token','/api/studio-wallet/revoke'].includes(url.pathname)))return original(input,{...options,redirect:'manual'});
  if(method==='GET'&&resultRedirects.has(url.href)){
    const headers=new Headers(options?.headers||(input instanceof Request?input.headers:undefined));
    if(url.origin!=='https://api.mumugofe.com'&&(headers.has('authorization')||headers.has('cookie')))throw new Error('结果下载不能向存储地址发送供应商凭据');
    resultRedirects.delete(url.href);
    return Promise.resolve(original(input,{...options,redirect:'manual'})).then(response=>rememberResultRedirect(response,url));
  }
  if(process.env.MANJU_BATCH_BUDGET_PROFILE && process.env.MANJU_APPROVED_BATCH_API_BASE_URL === 'https://api.mumugofe.com/v1' && url.origin === 'https://api.mumugofe.com' && !url.username && !url.password &&
    ((method==='PUT' && /^\/v1\/studio\/assets\/[a-f0-9]{64}$/.test(url.pathname)) ||
     (method==='POST' && ['/v1/chat/completions','/v1/images/generations','/v1/videos','/v1/messages/count_tokens'].includes(url.pathname)) ||
     (method==='GET' && /^\/v1\/(?:videos|images\/generations)\/[A-Za-z0-9_-]+(?:\/content)?$/.test(url.pathname))))
    return Promise.resolve(original(input,{...options,redirect:'manual'})).then(response=>method==='GET'&&/^\/v1\/videos\/[A-Za-z0-9_-]+\/content$/.test(url.pathname)?rememberResultRedirect(response,url):response);
  if(catalog&&catalog.protocol==='https:'&&url.origin===catalog.origin&&(url.pathname===catalog.pathname||['/api/usage/token/','/api/pricing','/api/status','/api/user/self','/dashboard/billing/subscription','/dashboard/billing/usage'].includes(url.pathname))&&method==='GET'&&!url.username&&!url.password)
    return original(input,{...options,redirect:'manual'});
  throw new Error('隔离预览只允许只读模型目录；生成、上传及其他外部请求已阻止');
};
