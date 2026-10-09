import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'manju-execution-labels-'));
process.env.MANJU_DATA_DIR=path.join(root,'data');process.env.MANJU_BACKUP_DIR=path.join(root,'backups');
const m=await import('../dist-server/shared/model.js');
const x=await import('../dist-server/shared/execution-plan.js');
const effects=await import('../dist-server/server/effects.js');
const store=await import('../dist-server/server/store.js');
const {applyAction}=await import('../dist-server/server/actions.js');
const {generationSignature,assetInputHash,usableVideo}=await import('../dist-server/shared/generation.js');
const {repairLabels,verifyLabelRepair,escapeAss,buildLabelAss}=await import('../dist-server/server/label-repair.js');
const {labelFonts,resolvedLabelFonts}=await import('../dist-server/server/label-fonts.js');
const {probe,inspectVideo,mediaPath}=await import('../dist-server/server/media.js');
const {preflightEpisode}=await import('../dist-server/server/export.js');
const {verifyReferenceProvenance}=await import('../dist-server/server/reference-provenance.js');
function fixture() {
  const p=m.makeProject('隔离执行计划','standard'),e=m.makeEpisode(1,'离线样例');p.episodes=[e];e.previewOverride=false;
  const b={...m.makeBeat(),event:'甲在门口拔刀，向乙肩侧挥刀；乙抬剑格挡，刀剑相撞，甲收刀后退。',reaction:'乙稳住站位，注视甲，没有追击。',dialogue:['甲：到此为止。'],floatLabels:['场景：门口','人物：乙'],systemPanels:['体力：100/100']};
  e.sourceText=(b.event+b.reaction).repeat(5);e.sourceReviewedHash=m.sourceHash(e);e.highlightReport='拔刀、挥刀、格挡、相撞、收刀后退和人物反应。';e.highlightReviewedHash=m.highlightHash(e);b.sourceQuote=e.sourceText;e.scriptBeats=[b];m.lockScript(e);
  const s=e.segments[0],times=[0,2,7,12,18,24,30];
  s.subshots=times.slice(0,-1).map((start,i)=>({id:`shot-${i}`,startSec:start,endSec:times[i+1],framing:'正式中景',action:['甲在门口拔刀。','甲向乙肩侧挥刀。','乙抬剑格挡。','刀剑相撞。','甲收刀后退。','乙稳住站位，注视甲。'][i],evidence:i<5?b.event:b.reaction,location:'门口',priorState:`原定前置${i}`,result:`原定结果${i}`,endFrame:`原定末帧${i}`,assetIds:['a','b','room'],lineRefs:{dialogue:i===1?[0]:[],os:[],floatLabels:i===0?[0]:i===2?[1]:[],systemPanels:i===4?[0]:[]}}));
  s.visualPlan='门口保持甲左乙右，持械与动作按正式原句。';s.shotContractVersion=2;s.subshotsReviewed=true;
  p.assets=['a','b','room'].map((id,i)=>({id,name:['甲','乙','门口'][i],kind:i===2?'scene':'character',identity:i===2?'室内门边':'正式人物',voice:'',states:[],images:[]}));
  const refs=p.assets.map(a=>({assetId:a.id,name:a.name,kind:a.kind,identity:a.identity}));
  const prompt={id:m.id(),kind:'prompt',createdAt:m.now(),sourceHash:m.contentHash(e,s),content:m.composePrompt(e,s,[],refs)};s.artifacts=[prompt];s.selected.prompt=prompt.id;
  return {p,e,b,s,refs,prompt};
}
const act=(f,action)=>applyAction(f.p,{episodeId:f.e.id,segmentId:f.s.id,...action});
test('intentions, negation, hypothetical, future, memory and cancelled casts never bind fire effects',()=>{
  for(const event of ['他只是想着释放火球，实际没有施法，转身离开。','他准备释放火球。','如果他释放火球，敌人就会后退。','他即将放出火球。','他将释放火球。','他没放出火球。','他回忆起释放火球的一幕。','他取消火球施法。','没有火球出现。','他握住火球杖。']) {
    assert.ok(!effects.suggestEffects(event).some(e=>e.id==='fire-orb'),event);
    assert.throws(()=>effects.checkedEffectEvidence('fire-orb','火球',event));
  }
  const actual='他没有犹豫，掌心凝出火球，沿原定方向射出。';
  assert.equal(effects.suggestEffects(actual).find(e=>e.id==='fire-orb').evidence,actual);
  assert.equal(effects.checkedEffectEvidence('fire-orb','火球',actual),actual);
});
test('vine restraints cannot use chains, and chain descriptions do not invent count or body parts',()=>{
  const event='她施展大地禁锢，两条藤蔓从地面升起，仅缠住敌人脚踝。';
  assert.ok(!effects.suggestEffects(event).some(e=>e.id==='restraint-chain-ground'));
  assert.throws(()=>effects.checkedEffectEvidence('restraint-chain-ground','大地禁锢',event),/材质不是锁链/);
  const actual='两条锁链从地面升起，仅缠住敌人脚踝。';assert.equal(effects.checkedEffectEvidence('restraint-chain-ground','锁链',actual),actual);
  const description=effects.visualDescription('restraint-chain-ground');assert.ok(!description.includes('四道锁链'));assert.ok(description.includes('不补手腕'));
  assert.ok(effects.visualDescription('restraint-break-free').includes('藤蔓、绳索'));
});
test('manual bindings are checked against complete surrounding context and rejected atomically',()=>{
  const f=fixture();f.b.event='他只是想着释放火球，实际没有施法，转身离开。';f.e.scriptLockedHash=m.scriptHash(f.e);
  const before=JSON.stringify(f.s.effectIds);assert.throws(()=>act(f,{type:'segment.effects',entries:[{id:'fire-orb',evidence:'火球'}]}),/完整依据/);assert.equal(JSON.stringify(f.s.effectIds),before);
  assert.throws(()=>effects.checkedEffectEvidence('fire-orb','甲在门口拔刀','甲在门口拔刀。'),/材质或对象/);
});
test('saving an execution plan writes canonical per-shot instructions, exact text and shared ownership into all layers',()=>{
  const f=fixture(),plan=x.defaultExecutionPlan(f.b,f.s,f.s.subshots);
  plan.visible.find(c=>c.index===1&&c.kind==='floatLabels').placement='object';plan.visible.find(c=>c.index===1&&c.kind==='floatLabels').ownerId='b';
  const original=m.contentHash(f.e,f.s);act(f,{type:'segment.executionPlan',plan});assert.notEqual(m.contentHash(f.e,f.s),original);assert.equal(f.s.subshotsReviewed,false);
  const content=m.composePrompt(f.e,f.s,[],f.refs);assert.ok(content.includes('楷体'));assert.ok(content.includes('Noto Sans SC'));assert.ok(content.includes('乙所属浮签'));
  assert.ok(m.composeStoryboard(f.e,f.s).includes('乙所属浮签'));assert.ok(m.composeImport(f.e,f.s).includes('乙所属浮签'));
  const prompt={...f.prompt,id:m.id(),sourceHash:m.contentHash(f.e,f.s),content};f.s.artifacts.push(prompt);f.s.selected.prompt=prompt.id;
  assert.deepEqual(m.selectedPromptContractIssues(f.e,f.s,f.p),[]);
  prompt.content=content.replaceAll('静置可读','保持字形稳定，让观众看清全文').replaceAll('【浮签执行】','【浮签排程】');
  assert.deepEqual(m.selectedPromptContractIssues(f.e,f.s,f.p),[]);
  prompt.content=content.replace('【浮签执行】0–2秒','【浮签执行】1–2秒');assert.ok(m.selectedPromptContractIssues(f.e,f.s,f.p).some(i=>i.includes('浮签全文、时窗')));
  prompt.content=content.replace(/^【浮签执行】[^\n]+\n/mu,'');assert.ok(m.selectedPromptContractIssues(f.e,f.s,f.p).some(i=>i.includes('执行计划')));
});
test('overlapping floats, wrong owner, missing formal items and unreadable windows are rejected',()=>{
  for(const edit of [plan=>{plan.visible[0].endSec=.5;},plan=>{plan.visible[1].placement='object';plan.visible[1].ownerId='a';},plan=>{plan.visible.pop();},plan=>{plan.visible[0].y=.91;}]) {
    const f=fixture(),plan=x.defaultExecutionPlan(f.b,f.s,f.s.subshots);edit(plan);assert.throws(()=>act(f,{type:'segment.executionPlan',plan}));assert.equal(f.s.executionPlan,undefined);
  }
  const f=fixture();f.b.floatLabels.push('时间：清晨');f.s.subshots[0].lineRefs.floatLabels.push(2);const plan=x.defaultExecutionPlan(f.b,f.s,f.s.subshots);plan.visible[1].x=plan.visible[0].x;plan.visible[1].y=plan.visible[0].y;
  assert.ok(x.executionPlanIssues(f.b,{...f.s,executionPlan:plan},f.s.subshots,f.p).some(i=>i.includes('重叠')));
});
test('combat plans reject changed participants, reversed phases and contradictory attack results',()=>{
  const f=fixture(),plan=x.defaultExecutionPlan(f.b,f.s,f.s.subshots);
  const cue={subshotId:'shot-2',attackKey:'攻击1',attackerId:'a',defenderId:'b',phase:'contact',outcome:'blocked',origin:'甲左乙右，各持正式刀剑',path:'甲挥刀，乙抬剑',contact:'刀剑相撞',direction:'原定刀剑受力方向',reaction:'乙稳住站位',ending:'双方保持原站位',evidence:f.b.event};
  plan.combat=[cue,{...cue,subshotId:'shot-3',phase:'reaction'}];assert.deepEqual(x.executionPlanIssues(f.b,{...f.s,executionPlan:plan},f.s.subshots,f.p),[]);
  for(const edit of [c=>{c.attackerId='b';c.defenderId='a';},c=>{c.phase='windup';},c=>{c.outcome='hit';}]) {const copy=structuredClone(plan);edit(copy.combat[1]);assert.ok(x.executionPlanIssues(f.b,{...f.s,executionPlan:copy},f.s.subshots,f.p).length);}
});
test('per-shot effect and combat contracts allow presentation changes but reject swapped roles and repeated impacts',()=>{
  const f=fixture(),effectId='combat-frame-hard-contact-flash';act(f,{type:'segment.effects',entries:[{id:effectId,evidence:f.b.event}]});
  const plan=x.defaultExecutionPlan(f.b,f.s,f.s.subshots);
  plan.effects=[{effectId,subshotId:'shot-3',startSec:12,endSec:12.2,trigger:'contact',scope:'frame',intensity:'medium',actorId:'a',targetId:'b',evidence:f.b.event,description:'不信任客户端描述'}];
  plan.combat=[{subshotId:'shot-3',attackKey:'攻击1',attackerId:'a',defenderId:'b',phase:'contact',outcome:'blocked',origin:'甲左乙右',path:'原定刀剑路径',contact:'刀剑相撞',direction:'原定夹角',reaction:'乙稳住站位',ending:'甲收刀后退',evidence:f.b.event}];
  act(f,{type:'segment.executionPlan',plan});assert.equal(f.s.executionPlan.effects[0].description,effects.visualDescription(effectId));
  const content=m.composePrompt(f.e,f.s,[],f.refs),prompt={...f.prompt,id:m.id(),sourceHash:m.contentHash(f.e,f.s),content};f.s.artifacts.push(prompt);f.s.selected.prompt=prompt.id;
  assert.deepEqual(m.selectedPromptContractIssues(f.e,f.s,f.p),[]);
  prompt.content=content.replace('【逐镜特效】','【特效执行】').replace('【战斗执行】','【战斗动作】');assert.deepEqual(m.selectedPromptContractIssues(f.e,f.s,f.p),[]);
  prompt.content=content.replace('攻方甲；受方乙','攻方乙；受方甲');assert.ok(m.selectedPromptContractIssues(f.e,f.s,f.p).some(i=>i.includes('攻防双方')));
  prompt.content=content.replace('施放者甲；对象乙','施放者乙；对象甲');assert.ok(m.selectedPromptContractIssues(f.e,f.s,f.p).some(i=>i.includes('逐镜特效')));
  const row=content.match(/^【逐镜特效】[^\n]+/mu)[0];prompt.content=content.replace(row,`${row}\n${row}`);assert.ok(m.selectedPromptContractIssues(f.e,f.s,f.p).some(i=>i.includes('重复')));
});
test('editing existing shot IDs preserves attached plans, and huge text cannot fit a tiny native label area',()=>{
  const f=fixture();act(f,{type:'segment.executionPlan',plan:x.defaultExecutionPlan(f.b,f.s,f.s.subshots)});
  const ids=f.s.subshots.map(s=>s.id);act(f,{type:'segment.writeSubshots',shots:structuredClone(f.s.subshots)});assert.deepEqual(f.s.subshots.map(s=>s.id),ids);assert.deepEqual(x.executionPlanIssues(f.b,f.s,f.s.subshots,f.p),[]);
  const plan=structuredClone(f.s.executionPlan);plan.visible[0].width=.1;plan.visible[0].height=.05;assert.ok(x.executionPlanIssues(f.b,{...f.s,executionPlan:plan},f.s.subshots,f.p).some(i=>i.includes('容不下')));
});
test('contact effects cannot invent a hit after a dodge or stack two flashes on the same contact',()=>{
  const f=fixture(),plan=x.defaultExecutionPlan(f.b,f.s,f.s.subshots);f.s.effectIds=['combat-impact-black-ink','combat-frame-hard-contact-flash'];
  const cue={effectId:f.s.effectIds[0],subshotId:'shot-3',startSec:12,endSec:12.2,trigger:'contact',scope:'local',intensity:'medium',evidence:f.b.event,description:'原定接触点爆墨白闪，不新增命中',actorId:'a',targetId:'b'};
  plan.effects=[cue,{...cue,effectId:f.s.effectIds[1]}];assert.ok(x.executionPlanIssues(f.b,{...f.s,executionPlan:plan},f.s.subshots,f.p).some(i=>i.includes('合并一次冲击')));
  plan.combat=[{subshotId:'shot-3',attackKey:'1',attackerId:'a',defenderId:'b',phase:'contact',outcome:'dodged',origin:'原定站位',path:'原定出招',contact:'避开',direction:'无',reaction:'闪避',ending:'未受伤',evidence:f.b.event}];assert.ok(x.executionPlanIssues(f.b,{...f.s,executionPlan:plan},f.s.subshots,f.p).some(i=>i.includes('不能绑定接触')));
});
test('font preferences preserve old prompt hashes and approval, while explicit segment plans only change that segment',()=>{
  const f=fixture(),hash=m.contentHash(f.e,f.s),sig=JSON.stringify(f.s.artifacts),approval='historical-approved';f.e.auditApprovedHash=approval;
  act(f,{type:'project.labelStyle',style:{preset:'wuxia',size:'large'}});assert.equal(m.contentHash(f.e,f.s),hash);assert.equal(JSON.stringify(f.s.artifacts),sig);assert.equal(f.e.auditApprovedHash,approval);assert.equal(m.promptReadiness(f.e,f.s,f.p).state,'ready');
});
test('final speed checks use exact corrected text windows and measured native voice windows',()=>{
  const f=fixture();f.s.action=true;f.s.executionPlan=x.defaultExecutionPlan(f.b,f.s,f.s.subshots);const video={review:{speech:[{id:`${f.b.id}:dialogue:0`,startSec:2,endSec:3.5}]}};
  const warnings=x.finalPlaybackWarnings(f.b,f.s,f.s.subshots,video);assert.ok(warnings.some(w=>w.includes('场景：门口')));assert.ok(warnings.some(w=>w.includes('正式声音')));
  f.s.speedOverride=1;video.review.speech[0].endSec=4;assert.deepEqual(x.finalPlaybackWarnings(f.b,f.s,f.s.subshots,video),[]);
});
test('estimated timing of other legacy labels remains advisory after correcting one exact visible window',()=>{
  const f=fixture();f.s.action=true;f.b.floatLabels[1]='人物：乙·正式长浮签'.repeat(3);
  const corrected=x.defaultExecutionPlan(f.b,f.s,f.s.subshots).visible[0],video={labelRepair:{cues:[corrected]}};
  const checks=x.finalPlaybackChecks(f.b,f.s,f.s.subshots,video);assert.equal(checks.warnings.length,2);assert.equal(checks.issues.length,1);assert.ok(checks.issues[0].includes(f.b.floatLabels[0]));
  assert.deepEqual(x.finalPlaybackChecks(f.b,f.s,f.s.subshots).issues,[]);
});
test('ASS renderer preserves formal characters and rejects controls instead of executing or deleting them',()=>{
  assert.equal(escapeAss('人物：乙\n体力：100/100'),'人物：乙\\N体力：100/100');assert.throws(()=>escapeAss('{\\pos(0,0)}篡改'),/不支持/);
  const f=fixture(),plan=x.defaultExecutionPlan(f.b,f.s,f.s.subshots),cue=plan.visible[0];const ass=buildLabelAss(1280,720,[cue],[f.b.floatLabels[0]],x.DEFAULT_LABEL_STYLE,{label:'楷体',system:'Noto Sans SC'});assert.ok(ass.includes('场景：门口'));assert.ok(ass.includes('\\fn楷体'));
  assert.throws(()=>buildLabelAss(1280,720,[{...cue,width:.1,height:.05}],['正式全文不得省略'.repeat(20)],x.DEFAULT_LABEL_STYLE,{label:'楷体',system:'Noto Sans SC'}),/放不下/);
});
function command(command,args){return new Promise((resolve,reject)=>{const c=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('close',code=>code===0?resolve(out):reject(Error(err)));});}
test('demo movies cannot become production versions by passing through text correction',async()=>{
  const f=fixture(),source={id:m.id(),kind:'video',sourceHash:m.contentHash(f.e,f.s),mediaPath:'demo-not-rendered.mp4',generationHash:'demo-signature',demo:true};f.s.artifacts.push(source);store.insertProject(f.p);
  await assert.rejects(repairLabels(f.p.id,f.e.id,f.s.id,source.id,{requestId:m.id(),confirmed:true,style:x.DEFAULT_LABEL_STYLE,cues:[x.defaultExecutionPlan(f.b,f.s,f.s.subshots).visible[0]]}),/技术演示/);
  assert.equal(store.getProject(f.p.id).episodes[0].segments[0].artifacts.filter(a=>a.kind==='video').length,1);
});
test('local font inventory resolves the selected wuxia preset using installed Chinese fonts',async()=>{
  const fonts=await labelFonts();assert.ok(fonts.checked);assert.ok(fonts.families.length);const resolved=await resolvedLabelFonts(x.DEFAULT_LABEL_STYLE);assert.ok(fonts.families.includes(resolved.label));assert.ok(fonts.families.includes(resolved.system));
  if(fonts.families.includes('楷体')) assert.equal(resolved.label,'楷体');
  if(fonts.families.includes('Noto Sans SC')) assert.equal(resolved.system,'Noto Sans SC');
  const preset=fonts.presets.find(p=>p.id==='wuxia');assert.equal(preset.available,fonts.families.includes('楷体')&&fonts.families.includes('Noto Sans SC'));
});
test('local label correction keeps original audio and approval, creates one pending derivative and checks file provenance',async()=>{
  const f=fixture();f.s.action=true;f.p.assets=[f.p.assets[2]];f.s.subshots.forEach(s=>s.assetIds=['room']);f.s.assetBindings=[{assetId:'room'}];
  const image=mediaPath('room.png');await sharp({create:{width:96,height:64,channels:3,background:'#243540'}}).png().toFile(image);
  const asset=f.p.assets[0];asset.images=[{id:m.id(),role:'main',mediaPath:'room.png',fileHash:createHash('sha256').update(fs.readFileSync(image)).digest('hex'),createdAt:m.now(),source:'upload',inputHash:assetInputHash(f.p,asset.id),review:{status:'approved',checks:{identity:true,state:true,shape:true,clothing:true},reviewedAt:m.now()}}];f.s.assetBindings[0].imageId=asset.images[0].id;
  f.p.videoModel={name:'本地模拟',modelId:'offline-labels',adapterPath:path.resolve('tests/fixtures/video-adapter.mjs'),capabilities:{maxDurationSec:30,maxReferences:30,nativeAudio:true}};
  f.prompt.sourceHash=m.contentHash(f.e,f.s);f.prompt.content=m.composePrompt(f.e,f.s,[],m.segmentReferences(f.p,f.e,f.s),m.videoReferences(f.p,f.e,f.s));
  const input=mediaPath('synthetic-original.mp4');await command('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','color=c=#304050:s=640x360:r=12:d=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=30','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',input]);
  const source={id:m.id(),kind:'video',createdAt:m.now(),sourceHash:m.contentHash(f.e,f.s),generationHash:generationSignature(f.p,f.e,f.s),referenceHashes:[{imageId:asset.images[0].id,hash:asset.images[0].fileHash}],mediaPath:'synthetic-original.mp4',technical:await inspectVideo(input),review:{status:'approved',notes:'隔离技术样例，不是剧情审片',reviewedAt:m.now(),checks:{story:true,voice:true,assets:true,labels:true,pacing:true,continuity:true},speech:[]}};
  source.specId=source.id;f.s.artifacts.push(source);f.s.selected.video=source.id;store.insertProject(f.p);store.registerGenerationSpec(source.id,f.p.id,{version:1,origin:'import',hash:source.generationHash,references:source.referenceHashes,project:f.p});
  const originalReview=JSON.stringify(source.review),originalFile=createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  const cue=x.defaultExecutionPlan(f.b,f.s,f.s.subshots).visible[0],requestId=m.id(),payload={requestId,confirmed:true,style:x.DEFAULT_LABEL_STYLE,cues:[cue]};
  const results=await Promise.all([repairLabels(f.p.id,f.e.id,f.s.id,source.id,payload),repairLabels(f.p.id,f.e.id,f.s.id,source.id,payload)]);assert.equal(results[0].artifactId,results[1].artifactId);
  const project=store.getProject(f.p.id),episode=project.episodes[0],segment=episode.segments[0],derived=segment.artifacts.find(a=>a.id===results[0].artifactId);
  assert.equal(segment.selected.video,source.id);assert.equal(JSON.stringify(segment.artifacts.find(a=>a.id===source.id).review),originalReview);assert.equal(derived.review,undefined);assert.equal(derived.userAcceptance,undefined);assert.ok(derived.labelRepair.audioHash?.startsWith('SHA256='));assert.equal(createHash('sha256').update(fs.readFileSync(input)).digest('hex'),originalFile);assert.equal((await probe(mediaPath(derived.mediaPath))).duration,30);
  const originalAudio=await command('ffmpeg',['-loglevel','error','-i',input,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-']);assert.equal(originalAudio.trim(),derived.labelRepair.audioHash);
  const frame=path.join(root,'wuxia-label-preview.png');await command('ffmpeg',['-hide_banner','-loglevel','error','-n','-ss','1','-i',mediaPath(derived.mediaPath),'-frames:v','1',frame]);
  fs.writeFileSync(path.resolve('.test-temp/fx-fonts-review-frame.json'),JSON.stringify({frame,sha256:createHash('sha256').update(fs.readFileSync(frame)).digest('hex'),source:'隔离合成视频，未调用模型',artifactId:derived.id},null,2));
  assert.equal(usableVideo(project,episode,segment,derived),true);await verifyLabelRepair(segment.artifacts,derived);verifyReferenceProvenance(project,episode,segment,derived);
  assert.equal((await repairLabels(f.p.id,f.e.id,f.s.id,source.id,payload)).artifactId,derived.id);
  await assert.rejects(repairLabels(f.p.id,f.e.id,f.s.id,source.id,{...payload,style:{preset:'clean',size:'large'}}),/内容已变化/);
  segment.selected.video=derived.id;const preflight=await preflightEpisode(project,episode);assert.ok(preflight.issues.some(i=>i.includes('人工审片')));assert.ok(preflight.issues.some(i=>i.includes('导出仅显示')));
  fs.appendFileSync(mediaPath(derived.mediaPath),'changed');assert.throws(()=>verifyReferenceProvenance(project,episode,segment,derived),/哈希已变化/);
  await assert.rejects(verifyLabelRepair(segment.artifacts,derived),/哈希已变化/);
});
