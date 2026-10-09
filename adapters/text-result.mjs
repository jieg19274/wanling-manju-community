// Provider responses may use a bare list for semantic entries. Preserve the
// entries unchanged; server validation still checks source ranges and identity.
export function parseTextResult(content, task) {
  let text=String(content || '').trim();
  if(text.startsWith('```'))text=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let parsed;
  try { parsed=JSON.parse(text); }
  catch {
    let repaired='',inside=false;
    for(let index=0;index<text.length;index++){
      const char=text[index];
      if(inside&&char==='\\'){repaired+=text.slice(index,index+2);index++;continue;}
      if(char==='"'){
        if(!inside)inside=true;
        else if(!text.slice(index+1).trimStart()||/^[,:}\]]/u.test(text.slice(index+1).trimStart()))inside=false;
        else repaired+='\\';
      }
      repaired+=char;
    }
    // A second parse must succeed. Structural errors and truncated responses remain errors.
    parsed=JSON.parse(repaired);
  }
  return task==='semantic-review' && Array.isArray(parsed) ? {entries:parsed,warnings:[]} : parsed;
}
