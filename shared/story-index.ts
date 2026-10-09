import {digest} from './model.js';
export interface IndexedEvent {id:string;sourceStart:number;sourceEnd:number;sourceQuote:string;summary:string;characters:string[]}
export function storyIndex(source:string,batchStart:number,batchEnd:number,raw:unknown):IndexedEvent[] {
  if(!Array.isArray(raw) || !raw.length || raw.length>30)throw new Error('分批分析须提供1–30条有原文定位的人物/事件索引');
  const seen=new Set<string>();
  return raw.map(entry=>{
    const start=batchStart+entry.sourceStart,end=batchStart+entry.sourceEnd;
    if(!Number.isInteger(entry.sourceStart) || !Number.isInteger(entry.sourceEnd) || start<batchStart || end>batchEnd || end<=start ||
      typeof entry.sourceQuote!=='string' || !entry.sourceQuote || entry.sourceQuote.length>300 || !source.slice(start,end).includes(entry.sourceQuote) ||
      typeof entry.summary!=='string' || entry.summary.trim().length<8 || entry.summary.length>300 || !Array.isArray(entry.characters) || entry.characters.length>20 ||
      entry.characters.some((name:unknown)=>typeof name!=='string' || !name || name.length>60 || !source.slice(batchStart,batchEnd).includes(name)))throw new Error('事件索引的原文跨度、人物或逐字依据无效');
    const id=`event:${digest({source:digest(source),start,end,quote:entry.sourceQuote})}`;
    if(seen.has(id))throw new Error('事件索引重复');seen.add(id);
    return {id,sourceStart:start,sourceEnd:end,sourceQuote:entry.sourceQuote,summary:entry.summary.trim(),characters:[...new Set(entry.characters)] as string[]};
  });
}
