import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {SoftwareUpdate} from '../shared/software-update.js';
const root=process.cwd();
let updater:Promise<any>|undefined;
let checking=false;
const module=()=>updater||=(import(pathToFileURL(path.join(root,'scripts/auto-update.mjs')).href));
export async function softwareUpdate():Promise<SoftwareUpdate>{return (await module()).updateStatus(root);}
export async function setSoftwareUpdate(input:{enabled?:unknown}):Promise<SoftwareUpdate>{return (await module()).saveUpdateSettings(root,input);}
export async function checkSoftwareUpdate(force=true):Promise<SoftwareUpdate>{
  const m=await module();
  if(!checking){checking=true;void m.checkForUpdate(root,{force}).catch(()=>{}).finally(()=>{checking=false;});}
  return m.updateStatus(root);
}
export function startSoftwareUpdates(){
  void checkSoftwareUpdate(false).catch(()=>{});
  setInterval(()=>void checkSoftwareUpdate(false).catch(()=>{}),6*60*60*1000).unref();
}
