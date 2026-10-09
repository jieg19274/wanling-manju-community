// A presentation qualifier is not a word added to the source. Nontrivial aliases
// require an explicit reviewed mapping and still retain the exact source quote.
export function assetEvidenceName(name:string,evidence:string,scriptText:string,reviewedSourceName?:string):string {
  const sourceName=reviewedSourceName || name.replace(/(?:（群体）|\(群体\))$/u,'');
  if(!sourceName.trim()||sourceName.length>80||evidence.length<4||!evidence.includes(sourceName)||!scriptText.includes(evidence))throw new Error(`资产“${name}”缺少正式剧本中的逐字依据`);
  return sourceName;
}
export function reviewedAssetEvidence(modelEvidence:string,scriptText:string,replacement?:string){
  const evidence=replacement===undefined?modelEvidence:replacement;
  if(evidence.length<4||!scriptText.includes(evidence))throw new Error('Asset evidence must be a literal locked-script quote');
  return {evidence,...(replacement!==undefined&&replacement!==modelEvidence?{modelEvidence}:{})};
}
