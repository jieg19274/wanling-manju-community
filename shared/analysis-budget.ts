import {storyBatches} from './episode-plan.js';
import {digest} from './model.js';
import type { ProductionRules } from './production-rules.js';
export function storyPlanFingerprint(source:string,adapter:string,model?:string,rules?:ProductionRules) {
  return digest({source,adapter,model,batchSize:5,...(rules ? {rules} : {})});
}
export function analysisBudget(source:string,adapter:string,model?:string,rules?:ProductionRules) {
  const batches=storyBatches(source);
  let count=batches.length,compression=0;
  while(count>8) {count=Math.ceil(count/5);compression+=count;}
  return {hash:storyPlanFingerprint(source,adapter,model,rules),characters:source.length,
    chapters:[...new Map(batches.flatMap(batch=>batch.chapters).map(chapter=>[`${chapter.start}:${chapter.end}`,chapter])).values()],
    batches:batches.map(batch=>({start:batch.start,end:batch.end,characters:batch.end-batch.start,titles:batch.chapters.map(chapter=>chapter.title)})),
    minimumRequests:batches.length+(batches.length>1?1:0),estimatedMaximumRequests:batches.length+compression+(batches.length>1?1:0),
    priceKnown:false as const};
}
