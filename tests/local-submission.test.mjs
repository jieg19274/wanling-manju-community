import test from 'node:test';import assert from 'node:assert/strict';
import {localImageSubmissionProof,localVideoSubmissionProof} from '../dist-server/server/local-submission.js';
test('original video may resume only a proven key initialization failure with no provider ID or fee reservation',()=>{
 const p={scope:'episodes3-8',state:'active',projectId:'p',overallApproval:{confirmed:true,sourceMessageId:'approved'},requests:[{id:'vgrant',kind:'video',episodeId:'e',segmentId:'s',requestId:'batch',confirmed:true,sourceMessageId:'approved'}]},job={id:'candidate',project_id:'p',episode_id:'e',segment_id:'s',kind:'video',status:'failed',error:'Error: 新软件 API Key 解密失败\n at direct-common.mjs:11:50'},request={projectId:'p',episodeId:'e',segmentId:'s',batchId:'batch',durationSec:30,model:{id:'专享sd2.5(30图10音/4-30秒/720p)'}},remote={status:'submitting'},output='.test-temp/nonexistent-proven-video-output.mp4';
 assert.equal(localVideoSubmissionProof(p,[],job,request,remote,'batch',output).providerSubmission,false);
 for(const changed of [{id:'task_AlreadySubmitted',status:'submitting'},{status:'downloaded'},{status:'failed'}])assert.throws(()=>localVideoSubmissionProof(p,[],job,request,changed,'batch',output));
 for(const rows of [[{kind:'video',state:'reserved',approval:'vgrant'}],[{kind:'video',state:'remote_unknown',subject:'video:e:s'}],[{kind:'text',state:'reserved'}]])assert.throws(()=>localVideoSubmissionProof(p,rows,job,request,remote,'batch',output));
 assert.throws(()=>localVideoSubmissionProof(p,[],{...job,error:'HTTP 503'},request,remote,'batch',output));assert.throws(()=>localVideoSubmissionProof(p,[],job,{...request,segmentId:'other'},remote,'batch',output));assert.throws(()=>localVideoSubmissionProof({...p,state:'pending'},[],job,request,remote,'batch',output));
});
const profile={scope:'episodes3-8',state:'active',projectId:'p',overallApproval:{confirmed:true,sourceMessageId:'approved'},requests:[{id:'grant',kind:'image',assetId:'a',requestId:'batch',confirmed:true,sourceMessageId:'approved'}]};
const adapter={project_id:'p',task:'asset-image',status:'remote_unknown',error:'模型适配器失败：Unsettled text or overrun blocks further spending\n',output_path:'.test-temp/nonexistent-local-proof-output.png',snapshot:JSON.stringify({request:{projectId:'p',candidateId:'candidate',batchId:'batch',asset:{id:'a'},model:'gpt-image-2.5-sunburst'}})};
test('only proven rejection before any reservation can resume original candidate',()=>{
 assert.equal(localImageSubmissionProof(profile,[{kind:'text',state:'completed'}],adapter,'candidate','batch','a').providerSubmission,false);
 for(const rows of [[{kind:'image',state:'reserved',approval:'grant'}],[{kind:'image',state:'remote_unknown',subject:'image:ep:a'}],[{kind:'text',state:'reserved'}],[{kind:'text',state:'overrun'}]])assert.throws(()=>localImageSubmissionProof(profile,rows,adapter,'candidate','batch','a'));
});
test('network failures, another candidate/project or pending authorization never become not submitted',()=>{
 for(const changed of [{error:'模型适配器失败：HTTP 503'},{project_id:'other'},{status:'completed'}])assert.throws(()=>localImageSubmissionProof(profile,[],{...adapter,...changed},'candidate','batch','a'));
 assert.throws(()=>localImageSubmissionProof({...profile,state:'pending'},[],adapter,'candidate','batch','a'));
 assert.throws(()=>localImageSubmissionProof(profile,[],adapter,'different','batch','a'));
 assert.throws(()=>localImageSubmissionProof({...profile,requests:[...profile.requests,...profile.requests]},[],adapter,'candidate','batch','a'));
});
test('local credential initialization failure is distinct from a supplier unknown result and still needs zero reservations',()=>{
 const keyFailure={...adapter,error:'模型适配器失败：Error: 新软件 API Key 解密失败\n at direct-common.mjs:11:50'};
 assert.equal(localImageSubmissionProof(profile,[],keyFailure,'candidate','batch','a').providerSubmission,false);
 assert.throws(()=>localImageSubmissionProof(profile,[{kind:'image',state:'remote_unknown',approval:'grant'}],keyFailure,'candidate','batch','a'));
 assert.throws(()=>localImageSubmissionProof(profile,[],{...keyFailure,error:keyFailure.error+' HTTP 503'},'candidate','batch','a'));
});
