export type RangeSummary={start:number;end:number;summary:string};
/** Hierarchical summaries preserve original range anchors; never truncate source text. */
export async function fitSummaryBudget(input: RangeSummary[], boundaryBytes: number,
  compress:(items:RangeSummary[])=>Promise<string>):Promise<RangeSummary[]> {
  let items=input;
  for(let level=0;JSON.stringify(items).length+boundaryBytes>20000;level++) {
    if(level>=8 || items.length<2) throw new Error('递归摘要仍超过预算，保留原文与全部分析结果');
    const next:RangeSummary[]=[];
    for(let index=0;index<items.length;) {
      const group:RangeSummary[]=[];
      while(index<items.length && group.length<5 && (group.length===0 || JSON.stringify([...group,items[index]]).length<12000)) group.push(items[index++]);
      if(group.length===1) {next.push(group[0]);continue;}
      const summary=await compress(group);
      if(typeof summary!=='string' || !summary.trim() || summary.length>2000) throw new Error('递归摘要无效，不能以截断原文替代');
      next.push({start:group[0].start,end:group.at(-1)!.end,summary});
    }
    if(JSON.stringify(next).length>=JSON.stringify(items).length) throw new Error('摘要压缩未减少输入，停止继续请求');
    items=next;
  }
  return items;
}
