import path from 'node:path';
import fs from 'node:fs';
import { configureRuntimeNetwork } from './network-env.mjs';
export function trialEnv(root){
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MANJU_')||key.startsWith('MUMU_')||key==='NODE_OPTIONS')delete env[key];
 const runtime=path.join(root,'runtime');fs.mkdirSync(runtime,{recursive:true});
 const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';
 env[pathKey]=[path.join(root,'tools/node'),path.join(root,'tools/ffmpeg/bin'),env[pathKey]||''].join(path.delimiter);
 Object.assign(env,{MANJU_PORT:'5780',MANJU_DATA_DIR:path.join(runtime,'data'),MANJU_BACKUP_DIR:path.join(runtime,'backups'),MANJU_JIANYING_DRAFTS_DIR:path.join(runtime,'drafts'),MANJU_MUMU_BASE_URL:'http://127.0.0.1:1'});
 try{const saved=JSON.parse(fs.readFileSync(path.join(runtime,'launch-preferences.json'),'utf8'));if(typeof saved.draftsRoot==='string'&&path.isAbsolute(saved.draftsRoot))env.MANJU_JIANYING_DRAFTS_DIR=saved.draftsRoot;}catch{}
 const sample=path.join(root,'examples/promo-demo');if(fs.existsSync(path.join(sample,'manifest.json')))env.MANJU_TRIAL_SAMPLE=sample;
 return configureRuntimeNetwork(env);
}
