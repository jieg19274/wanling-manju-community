import { spawn } from 'node:child_process';
import { LABEL_PRESETS, labelAppearance, type LabelStyle } from '../shared/execution-plan.js';
import { terminateChild } from './process-contract.js';

export type FontInventory = { checked: boolean; families: string[]; presets: { id: string; name: string; labelFont: string; systemFont: string; available: boolean }[]; note?: string };
let cached: Promise<FontInventory> | undefined;
export async function labelFonts(refresh = false): Promise<FontInventory> {
  if(refresh)cached=undefined;
  return cached ||= (async () => {
    let families: string[] = [], note = '';
    try {
      const output = await new Promise<string>((resolve,reject) => {
        const command = process.platform === 'win32' ? 'powershell.exe' : 'fc-list';
        const args = process.platform === 'win32' ? ['-NoProfile','-NonInteractive','-Command', "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Drawing; $manjuFontSet=New-Object System.Drawing.Text.InstalledFontCollection; ConvertTo-Json -Compress -InputObject @($manjuFontSet.Families.Name)"] : ['--format','%{family}\n'];
        const child = spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
        const timer=setTimeout(()=>{terminateChild(child);reject(Error('字体检测超时'));},8000);
        let stdout=''; child.stdout.on('data',c=>{stdout=(stdout+c.toString('utf8')).slice(-100000);});
        child.on('error',e=>{clearTimeout(timer);reject(e);}); child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(Error('字体检测不可用'));});
      });
      families = process.platform === 'win32' ? JSON.parse(output.trim().replace(/^\uFEFF/u,'')) : output.split(/[\n,]/u).map(s=>s.trim()).filter(Boolean);
    } catch(error) { note=(error as Error).message; }
    const allowed = new Set(['Noto Serif SC','Noto Sans SC','楷体','KaiTi','SimSun','宋体','Microsoft YaHei','微软雅黑']);
    families=[...new Set(families.filter(f=>allowed.has(f)))];
    return { checked: !note, families, presets:Object.entries(LABEL_PRESETS).map(([id,p])=>({id,name:p.name,labelFont:p.labelFont,systemFont:p.systemFont,available:families.includes(p.labelFont)&&families.includes(p.systemFont)})), ...(note?{note}:{}) };
  })();
}
export async function resolvedLabelFonts(style: LabelStyle) {
  const inventory=await labelFonts();
  const resolve=(system:boolean)=> {
    const requested=labelAppearance(style,system).font;
    const match=[requested,system?'Noto Sans SC':'Noto Serif SC','Microsoft YaHei','微软雅黑','SimSun','宋体'].find(f=>inventory.families.includes(f));
    if(!inventory.checked||!match) throw Error('尚未检测到可用中文字体，请先在系统安装中文字体再执行本地纠字');
    return match;
  };
  return {label:resolve(false),system:resolve(true)};
}
