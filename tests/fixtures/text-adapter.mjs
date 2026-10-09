import { readFileSync, writeFileSync } from 'node:fs';

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let result;
if (request.task === 'health') result = { ok: true, detail: '文本适配器可运行' };
else if(request.task==='semantic-review') result={entries:request.beats.map(beat=>({beatId:beat.id,sourceStart:0,sourceEnd:request.sourceText.length,notes:'mock原文因果反应声音与高光需人工确认',highlightIds:request.highlights.map(item=>item.id)})),warnings:['mock仅结构候选，不证明语义正确']};
else if (request.task === 'episode-plan') result = { boundaries: [0, request.sourceText.length], summary: 'mock完整章节的行动、原因、结果与跨批衔接已汇总',events:[{sourceStart:0,sourceEnd:Math.min(100,request.sourceText.length),sourceQuote:request.sourceText.slice(0,24),summary:'mock原文人物事件因果索引待人工核对',characters:[]}] };
else if (request.task === 'episode-plan-global') result = { boundaries: request.chapterBoundaries };
else if (request.task === 'highlight-report') result = {
  highlightReport: `章节范围：测试原文。事件因果与人物反应：${request.sourceText.slice(0, 100)}。未采用素材：待人工核对。`,
};
else if (request.task === 'script-beats') result = { beats: [{
  sourceQuote: request.sourceText.slice(0, 24), event: request.sourceText.slice(0, 24), reaction: '测试候选，须人工核对',
  dialogue: [], os: [], floatLabels: [], systemPanels: [],
}] };
else if (request.task === 'asset-extract') result = { assets: [{ kind: 'character', name: '林舟',
  identity: '待核对固定身份', voice: '', evidence: request.beats[0].event }] };
else if (request.task === 'storyboard-shots') {
  const boundaries = [0, 2, 6, 11, 16, 21, 26, 30];
  result = { shots: boundaries.slice(0,-1).map((startSec,index) => {
    const source = index < 3 ? request.beat.event : request.beat.reaction;
    const action = source.slice(Math.min((index < 3 ? index : index-3)*4, source.length-4), Math.min((index < 3 ? index+1 : index-2)*4, source.length));
    return { startSec, endSec: boundaries[index+1], framing: '主体近景', location: '屋内门边',
      priorState: '承接前镜的正式状态', action, evidence: action, result: action, endFrame: '两人仍在门边',
      assetIds: (request.availableAssets || []).map(asset => asset.id),
      lineRefs: Object.fromEntries(['dialogue','os','floatLabels','systemPanels'].map(kind => [kind, index === 0 ? request.beat[kind].map((_,i)=>i) : []])) };
  }) };
}
else if (request.task === 'effect-match') result = { matches: [] };
else throw new Error(`unknown task ${request.task}`);
writeFileSync(process.argv[3], JSON.stringify(result));
