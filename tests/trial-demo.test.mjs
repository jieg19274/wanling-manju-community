import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';

test('首次试用可离线查看真实演示，模型已预置，不转移审批或自动提交任务', async()=>{
  const folder=fs.mkdtempSync(path.join(tmpdir(),'wanling-public-demo-'));
  process.env.MANJU_DATA_DIR=path.join(folder,'data');
  process.env.MANJU_TRIAL_SAMPLE=path.resolve('examples/promo-demo');
  const {initializeTrialDemo}=await import('../dist-server/server/trial-demo.js');
  const store=await import('../dist-server/server/store.js');
  const provider=await import('../dist-server/server/direct-provider.js');
  const {makeProject,auditEpisode,approvalHash}=await import('../dist-server/shared/model.js');
  const {currentVideo}=await import('../dist-server/shared/generation.js');
  try {
    const models=provider.globalModels();
    assert.equal(provider.directStatus().hasKey,false);
    assert.equal(models.text.modelId,'claude-opus-5-5');assert.equal(models.image.modelId,'gpt-image-2.5-sunburst');
    assert.equal(models.video.modelId,'专享sd2.5(30图10音/4-30秒/720p)');assert.equal(models.video.capabilities.nativeAudio,true);
    assert.equal(provider.applyGlobalModels(makeProject('自己的故事','standard')).imageModel.modelId,models.image.modelId);
    const configured=makeProject('保留已有选择','standard');configured.textModel.modelId='custom-text';
    assert.equal(provider.applyGlobalModels(configured).textModel.modelId,'custom-text');
    assert.equal(initializeTrialDemo(),true);assert.equal(initializeTrialDemo(),false);
    assert.equal(store.listProjects().length,1);
    const project=store.getProject(store.listProjects()[0].id),episode=project.episodes[0],segment=episode.segments[0];
    const video=segment.artifacts.find(a=>a.kind==='video');
    assert.equal(project.demo.version,1);assert.equal(episode.sourceText.length>300,true);
    assert.equal(project.assets.length,2);assert.equal(project.assets.flatMap(a=>a.images).length,3);
    assert.ok(auditEpisode(episode,project).some(issue=>issue.includes('完整四视图')));
    assert.equal(episode.auditApprovedHash,undefined);
    assert.equal(currentVideo(project,episode,segment,video),false,'legacy preview stays playable but cannot pass the new complete-sheet production contract');
    assert.equal(video.review,undefined);assert.equal(video.userAcceptance,undefined);assert.equal(episode.sampleApprovedHash,undefined);
    assert.equal(video.jobId,undefined);assert.equal(store.generationSpec(project.id,video.specId).origin,'import');
    assert.equal(store.generationSpec(project.id,video.specId).legacyReferences,true);
    assert.equal(video.referenceHashes.length,3);
    for(const file of [project.demo.previewMediaPath,video.mediaPath,...project.assets.flatMap(a=>a.images.map(i=>i.mediaPath))])assert.ok(fs.existsSync(path.join(folder,'data/media',file)));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM candidate_batches').get().n,0);
    assert.equal(fs.existsSync(path.join(folder,'data/direct-provider.json')),false);
    assert.equal(fs.existsSync(path.join(folder,'data/provider-account.json')),false);
    store.db.prepare('DELETE FROM projects').run();assert.equal(initializeTrialDemo(),false,'deleted sample stays deleted');
    fs.unlinkSync(path.join(folder,'data/trial-sample-imported.json'));
    store.insertProject(makeProject('已有用户项目','standard'));assert.equal(initializeTrialDemo(),false,'existing user database preserved');
    store.db.prepare('DELETE FROM projects').run();
    const bad=path.join(folder,'broken');fs.cpSync(process.env.MANJU_TRIAL_SAMPLE,bad,{recursive:true});
    const manifest=JSON.parse(fs.readFileSync(path.join(bad,'manifest.json'),'utf8'));manifest.files[0].sha256='0'.repeat(64);
    fs.writeFileSync(path.join(bad,'manifest.json'),JSON.stringify(manifest));process.env.MANJU_TRIAL_SAMPLE=bad;
    assert.throws(initializeTrialDemo,/校验失败/);assert.equal(store.listProjects().length,0);
  } finally {store.db.close();delete process.env.MANJU_TRIAL_SAMPLE;delete process.env.MANJU_DATA_DIR;}
});
