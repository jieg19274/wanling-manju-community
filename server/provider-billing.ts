import { CATALOG_API_URL, directKey } from './direct-provider.js';
import type { ProviderBilling } from '../shared/provider-billing.js';
import { digest } from '../shared/model.js';
import {accountStatus,readAccountWallet} from './provider-account.js';
let cache: {key:string;at:number;value:ProviderBilling}|undefined;
export async function fetchProviderBilling(force=false):Promise<ProviderBilling> {
  let apiKey='',credentialError:string|undefined;
  try{apiKey=directKey();}catch{credentialError='保存的密钥无法由当前 Windows 用户读取。请在软件设置中重新填写并保存密钥。';}
  const key=digest({apiKey,credentialError,base:CATALOG_API_URL,account:accountStatus()});
  if(!force&&cache?.key===key&&Date.now()-cache.at<30000)return cache.value;
  const base=new URL(CATALOG_API_URL);
  if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)))throw Error('费用查询地址无效');
  async function get(route:string,authenticated=false){
    const response=await fetch(new URL(route,base.origin),{redirect:'manual',signal:AbortSignal.timeout(12000),headers:authenticated?{Authorization:'Bearer '+apiKey}:{}});
    if(!response.ok)throw Error(`费用接口 HTTP ${response.status}`);
    const data=await response.json() as Record<string,any>;
    if(data.success===false||data.code===false)throw Error('服务商拒绝额度或价格查询');
    return data;
  }
  const authenticated=(route:string)=>apiKey?get(route,true):Promise.reject(Error(credentialError||'请先保存密钥'));
  const [quota,pricing,status,user,subscription,usage,wallet]=await Promise.allSettled([
    authenticated('/api/usage/token/'),get('/api/pricing'),get('/api/status'),
    authenticated('/api/user/self'),authenticated('/dashboard/billing/subscription'),authenticated('/dashboard/billing/usage'),readAccountWallet()]);
  const info=status.status==='fulfilled'?status.value.data||{}:{};
  const conversion=info.quota_display_type==='CUSTOM'?Number(info.custom_currency_exchange_rate):info.quota_display_type==='CNY'?Number(info.usd_exchange_rate):info.quota_display_type==='USD'?1:undefined;
  const value:ProviderBilling={fetchedAt:new Date().toISOString(),accountBalanceAvailable:false,prices:[],...(credentialError?{credentialError}:{}),
    currency:info.quota_display_type==='CUSTOM'?String(info.custom_currency_symbol||'自定义额度'):info.quota_display_type==='CNY'?'元':info.quota_display_type==='USD'?'USD':'原始额度',
    ...(Number(info.quota_per_unit)>0?{quotaPerUnit:Number(info.quota_per_unit)}:{}),...(conversion&&conversion>0?{conversion}:{})};
  if(quota.status==='fulfilled'){
    const q=quota.value.data;
    if(q&&typeof q.total_available==='number'&&typeof q.total_used==='number'&&typeof q.unlimited_quota==='boolean')value.quota={available:q.total_available,used:q.total_used,unlimited:q.unlimited_quota,expiresAt:Number(q.expires_at)||0};
    else value.quotaError='服务商未返回有效的密钥额度字段';
  }else value.quotaError=String(quota.reason?.message||'额度查询失败');
  const account=user.status==='fulfilled'?user.value.data:undefined;
  if(account&&typeof account.quota==='number'&&Number.isFinite(account.quota)&&value.quotaPerUnit&&value.conversion){
    value.accountBalance={available:account.quota/value.quotaPerUnit*value.conversion,currency:value.currency,source:'user'};
    if(typeof account.group==='string')value.group=account.group;
  }else if(subscription.status==='fulfilled'&&usage.status==='fulfilled'){
    const sub=subscription.value,total=Number(sub.hard_limit_usd),used=Number(usage.value.total_usage)/100;
    // New API's token-scoped billing returns 100000000 for an unlimited token.
    // A finite subscription + usage for that token therefore uses the account
    // branch. Limited-token replies without an explicit scope remain unverified.
    const accountScope=sub.scope==='account'||sub.billing_scope==='account'||info.display_token_stat===false||
      (value.quota?.unlimited===true&&sub.object==='billing_subscription'&&sub.has_payment_method===true&&
       sub.access_until===0&&Number.isFinite(total)&&total>=0&&total<100000000);
    const validValues=typeof sub.hard_limit_usd==='number'&&typeof usage.value.total_usage==='number'&&
      Number.isFinite(total)&&Number.isFinite(used)&&used>=0;
    const displayFactor=info.quota_display_type==='CUSTOM'?value.conversion:
      ['USD','CNY','TOKENS'].includes(info.quota_display_type)?1:undefined;
    if(accountScope&&validValues&&displayFactor){
      value.accountBalance={available:(total-used)*displayFactor,currency:value.currency,source:'billing'};
    }
  }
  value.accountBalanceAvailable=Boolean(value.accountBalance);
  const walletData=wallet.status==='fulfilled'?wallet.value:undefined;
  if(walletData&&value.quotaPerUnit&&value.conversion){value.accountBalance={available:walletData.quota/value.quotaPerUnit*value.conversion,currency:value.currency,source:'wallet',matchesModelKey:walletData.matchesModelKey};value.accountBalanceAvailable=true;value.accountBalanceUpdatedAt=value.fetchedAt;}
  value.account=accountStatus();
  if(!value.accountBalanceAvailable)value.accountBalanceError='请通过上方木木网页登录并授权同步余额';
  if(wallet.status==='rejected'){value.accountBalance=undefined;value.accountBalanceAvailable=false;value.accountBalanceError=String(wallet.reason?.message||'账户余额查询失败');}
  if(wallet.status==='rejected'&&value.account.connected&&cache?.key===key&&cache.value.accountBalance?.source==='wallet'){
    value.accountBalance=cache.value.accountBalance;value.accountBalanceAvailable=true;value.accountBalanceStale=true;
    value.accountBalanceUpdatedAt=cache.value.accountBalanceUpdatedAt||cache.value.fetchedAt;
  }
  if(pricing.status==='fulfilled'&&Array.isArray(pricing.value.data)){
    const raw=pricing.value;value.pricingVersion=String(raw.pricing_version||'');
    value.prices=raw.data.filter((p:any)=>typeof p.model_name==='string').map((p:any)=>({model:p.model_name,description:'',quotaType:Number(p.quota_type),modelPrice:Number(p.model_price),modelRatio:Number(p.model_ratio),completionRatio:Number(p.completion_ratio),...(typeof p.billing_expr==='string'?{expression:p.billing_expr}:{}),groups:(Array.isArray(p.enable_groups)?p.enable_groups:[]).filter((g:string)=>Number.isFinite(raw.group_ratio?.[g])&&raw.group_ratio[g]>0).map((name:string)=>({name,ratio:Number(raw.group_ratio[name])}))}));
  }else value.pricingError='价格查询失败或服务商未返回价格清单';
  cache={key,at:Date.now(),value};return value;
}
