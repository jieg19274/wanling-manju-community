import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {dataDir} from './store.js';
import {CATALOG_API_URL,directKey,protectLocalSecret,unprotectLocalSecret} from './direct-provider.js';
import {accountFetch} from './account-network.js';
const origin=new URL(CATALOG_API_URL).origin,host=new URL(origin);
if(host.protocol!=='https:'&&!(host.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(host.hostname)))throw Error('账户连接地址必须使用 HTTPS');
const file=path.join(dataDir,'provider-account.json');
type Session={origin:string;name:string;walletToken:string;expiresAt:number};
let session:Session|undefined,loaded=false,epoch=0;
let pending:{state:string;verifier:string;redirectUri:string;expiresAt:number;claimed:boolean}|undefined;
function read(){
  if(!loaded){loaded=true;if(existsSync(file))try{const value=JSON.parse(unprotectLocalSecret(JSON.parse(readFileSync(file,'utf8')).protectedSession));
    if(value.origin===origin&&typeof value.walletToken==='string'&&value.walletToken&&!/[\r\n]/.test(value.walletToken)&&Number.isFinite(value.expiresAt)&&typeof value.name==='string')session=value;
  }catch{/* A different Windows user must connect again. */}}
  if(session&&session.expiresAt<=Date.now()/1000)clear();return session;
}
function save(value:Session){const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify({protectedSession:protectLocalSecret(JSON.stringify(value))}),{mode:0o600});renameSync(tmp,file);session=value;loaded=true;epoch++;}
function clear(){session=undefined;loaded=true;pending=undefined;epoch++;if(existsSync(file))unlinkSync(file);}
export function accountStatus(){const s=read();return {connected:Boolean(s),name:s?.name||'',revision:epoch,pending:Boolean(pending&&pending.expiresAt>Date.now()&&!pending.claimed)};}
async function call(route:string,method='GET',payload?:unknown,s?:Session){
  let modelKey='';if(s)try{modelKey=directKey();}catch{}
  const response=await accountFetch(new URL(route,origin),{method,redirect:'manual',signal:AbortSignal.timeout(20000),headers:{
    ...(payload===undefined?{}:{'Content-Type':'application/json'}),...(s?{Authorization:'Bearer '+s.walletToken,...(modelKey?{'X-Api-Key':modelKey}:{})}:{}),
  },...(payload===undefined?{}:{body:JSON.stringify(payload)})},route.endsWith('/token')?'木木授权交换':'木木账户连接');
  let body;try{body=await response.json();}catch{throw Error('平台账户连接接口尚未就绪');}return {response,body,hasModelKey:Boolean(modelKey)};
}
export async function beginAccountConnect(localOrigin:string){
  const local=new URL(localOrigin);
  if(local.protocol!=='http:'||local.hostname!=='127.0.0.1'||!Number.isInteger(Number(local.port))||Number(local.port)<1024)throw Error('登录回调地址无效');
  const check=await accountFetch(new URL('/api/studio-wallet/config',origin),{redirect:'manual',signal:AbortSignal.timeout(12000)},'木木登录配置检查');
  let config;try{config=await check.json();}catch{}
  if(!check.ok||config?.success!==true||config.data?.scope!=='wallet:read')throw Error('木木平台登录回调尚未部署，暂未建立账户连接');
  const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url'),redirectUri=new URL('/api/provider-account/callback',local.origin).href;
  pending={state,verifier,redirectUri,expiresAt:Date.now()+600000,claimed:false};
  const url=new URL('/studio-connect',origin);
  for(const [k,v]of Object.entries({client_id:'wanling-manju',redirect_uri:redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(k,v);
  return {url:url.href,...accountStatus()};
}
export async function finishAccountConnect(code:string,state:string){
  const p=pending;
  if(!p||p.claimed||p.expiresAt<Date.now()||code.length>128||!/^[A-Za-z0-9_-]{32,128}$/.test(code)||!/^[A-Za-z0-9_-]{43}$/.test(state)||!timingSafeEqual(Buffer.from(state),Buffer.from(p.state)))throw Error('登录回调已过期或不属于当前软件，请重新登录');
  p.claimed=true;
  const {response,body}=await call('/api/studio-wallet/token','POST',{code,code_verifier:p.verifier,redirect_uri:p.redirectUri,client_id:'wanling-manju'});
  if(pending!==p)throw Error('账户连接已取消，请重新登录');
  if(!response.ok||body.success!==true)throw Error('平台登录授权已失效，请重新登录');
  const d=body.data;
  if(typeof d?.wallet_token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(d.wallet_token)||!Number.isFinite(d.expires_at)||d.expires_at<=Date.now()/1000||typeof d.display_name!=='string')throw Error('平台未返回有效余额查询授权');
  save({origin,name:d.display_name.slice(0,80),walletToken:d.wallet_token,expiresAt:d.expires_at});pending=undefined;return accountStatus();
}
export async function readAccountWallet(){
  const s=read();if(!s)return undefined;
  const started=epoch,{response,body,hasModelKey}=await call('/api/studio-wallet/balance','GET',undefined,s);
  if(epoch!==started)throw Error('账户已切换，请重新读取余额');
  if(response.status===401||response.status===403){clear();throw Error('账户登录已失效，请重新登录');}
  if(!response.ok||body.success!==true)throw Error('账户余额查询失败，稍后自动重试');
  const u=body.data;if(typeof u?.quota!=='number'||!Number.isFinite(u.quota))throw Error('平台未返回有效账户余额');
  return {quota:u.quota,name:s.name,matchesModelKey:hasModelKey?u.matches_model_key===true:undefined};
}
export async function logoutAccount(){
  pending=undefined;const s=read();if(s){const {response,body}=await call('/api/studio-wallet/revoke','POST',{},s);if(!response.ok||body.success!==true)throw Error('平台取消连接失败，请重试');}
  clear();return accountStatus();
}
