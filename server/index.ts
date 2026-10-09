import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readJsonBody as body, RequestBodyError } from './http-body.js';
import { initializeTrialDemo } from './trial-demo.js';
import { agentManifest, agentContext, createAgentProject, createAgentTask, agentCommand, agentTaskControl } from './agent-api.js';
import { agentReadiness, agentDashboard } from './agent-dashboard.js';
import { productionDefaults, saveProductionDefaults } from './production-defaults.js';
import {softwareUpdate,setSoftwareUpdate,checkSoftwareUpdate,startSoftwareUpdates} from './software-update.js';
import { upscaleSettings, saveUpscaleSettings, startUpscaleSetup } from './upscale-settings.js';
import { agentSkillZip,bundledTutorial } from './agent-package.js';
import {studioHome,startStudioRun,saveStudioDraft,controlStudioRun,recoverStudioRuns,closeStudioCodex} from './studio-home.js';
import {projectProgress} from './project-progress.js';
import {workflowsFor,startWorkflow,authorizeWorkflow,controlWorkflow,startWorkflows} from './agent-workflow.js';
import {fetchProviderBilling} from './provider-billing.js';
import {accountStatus,beginAccountConnect,finishAccountConnect,logoutAccount} from './provider-account.js';
import {billingQuote} from '../shared/provider-billing.js';
import {assertAssetImageRole} from '../shared/asset-references.js';
import {candidatePreview,candidateBatches,createCandidates,controlCandidates,startCandidates,candidateChangeImpact,applyCandidateChange} from './candidates.js';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { applyAction } from './actions.js';
import { assertProjectModelIdle, useProjectDefaultModel } from './project-models.js';
import {backups,backupStorage,restoreStorage,runtimePreflight} from './maintenance.js';
import {referenceHashes} from './reference-provenance.js';
import { assetInputHash, generationSignature } from '../shared/generation.js';
import { expectedResolution, validateGeneratedMedia } from '../shared/media-contract.js';
import { beatFor } from '../shared/model.js';
import { generateAssetImage, storyPlanStatus, storyPlanPreview, suggestAssets, suggestEpisodePlan, suggestHighlight, suggestSemanticReview,suggestSegmentPlan, suggestScript, suggestSubshots,
  suggestSemanticEffects } from './assist.js';
import { effectSummary, listEffects, suggestEffects } from './effects.js';
import { labelFonts } from './label-fonts.js';
import { repairLabels } from './label-repair.js';
import { draftsRoot, exportEpisode, exportEpisodeMp4, exportProject, preflightEpisode, upscaleAdapter } from './export.js';
import { cancelQueued, reconcileTask, enqueue, pauseProject, recoverDownloadedVideo, recoverJobs, recoverRemoteVideo, resumeProject, retryFailed } from './jobs.js';
import { inspectVideo, mediaPath, probe, relativeMedia } from './media.js';
import { testModelConnection } from './model-check.js';
import { connectMumu, mumuStatus } from './mumu.js';
import { applyGlobalModels, connectDirect, directStatus, fetchDirectModels, globalModels,
  saveDirectConfig, saveGlobalModel } from './direct-provider.js';
import { exportProductionPackage } from './production-package.js';
import { db, dataDir, getProject, getProjectView, episodePage, generationSpec,registerGenerationSpec, insertProject, jobsFor, listProjects, updateProject } from './store.js';
import { approvalHash, auditEpisode, contentHash, id, makeProject, now, sampleGateHash, type Artifact, type ArtifactKind,
  type ProjectMode } from '../shared/model.js';

const port = Number(process.env.MANJU_PORT || 5698);
const base = path.resolve(process.cwd(), 'dist');

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

function allowedOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { const parsed = new URL(origin); return parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.port === String(port); }
  catch { return false; }
}

async function upload(req: IncomingMessage, projectId: string, episodeId: string, segmentId?: string) {
  if (!String(req.headers['x-file-name'] || '').toLowerCase().endsWith('.mp4')) throw new Error('首版只接收 MP4 文件');
  const expected = Number(req.headers['content-length']);
  if (!Number.isFinite(expected) || expected <= 0 || expected > 2_000_000_000) throw new Error('视频大小无效或超过 2 GB');
  const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
  if (!episode) throw new Error('分集不存在');
  const segment = segmentId ? episode.segments.find(item => item.id === segmentId) : undefined;
  if (segmentId && !segment) throw new Error('片段不存在');
  const fingerprint = segment ? generationSignature(project, episode, segment) : undefined;
  const references = segment ? referenceHashes(project,episode,segment) : undefined;
  const folder = mediaPath(path.join('uploads', episodeId, segmentId || 'preview'));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id()}.mp4`);
  let measured: Awaited<ReturnType<typeof probe>>;
  try {
    await pipeline(req, createWriteStream(file, { flags: 'wx' }));
    measured = await probe(file);
    if (segment) validateGeneratedMedia(measured, segment.durationSec, project.aspectRatio || '16:9', Boolean(beatFor(episode, segment).dialogue.length || beatFor(episode, segment).os.length), expectedResolution(project));
  } catch (error) {
    if (existsSync(file)) unlinkSync(file);
    throw error;
  }
  const relative = relativeMedia(file);
  updateProject(projectId, current => {
    const item = current.episodes.find(e => e.id === episodeId)!;
    if (segmentId) {
      const row = item.segments.find(s => s.id === segmentId)!;
      if (!row || generationSignature(current, item, row) !== fingerprint) throw new Error('上传期间生成输入已变化');
      if (JSON.stringify(references)!==JSON.stringify(referenceHashes(current,item,row))) throw new Error('上传期间参考图文件内容已变化');
      const stat = statSync(file);
      const specId=id();registerGenerationSpec(specId,projectId,{version:1,origin:'import',hash:fingerprint,references,project:{...project,sourceCorpus:undefined,archivedEpisodes:undefined,episodes:[{...episode,scriptHistory:undefined}]}});
      const artifact: Artifact = { id: id(),specId, kind: 'video', createdAt: now(), sourceHash: contentHash(item, row), generationHash: fingerprint, mediaPath: relative,
        referenceHashes: references, technical: { ...measured, warnings: [], size: stat.size, modifiedAt: stat.mtimeMs } };
      row.artifacts.push(artifact);
      if (!row.selected.video) row.selected.video = artifact.id;
    } else item.previewMediaPath = relative;
  });
  return { mediaPath: relative };
}

async function uploadAssetImage(req: IncomingMessage, projectId: string, assetId: string, stateId: string,
  role: string) {
  const expected = Number(req.headers['content-length']);
  if (!Number.isFinite(expected) || expected <= 0 || expected > 30_000_000)
    throw new Error('参考图大小无效或超过 30 MB');
  const project = getProject(projectId), asset = project.assets?.find(item => item.id === assetId);
  if (!asset) throw new Error('资产不存在');
  if (stateId && !asset.states.some(item => item.id === stateId)) throw new Error('资产状态不存在');
  assertAssetImageRole(asset,role);
  const fingerprint = assetInputHash(project, assetId, stateId);
  const folder = mediaPath(path.join('assets', assetId));
  mkdirSync(folder, { recursive: true });
  const temp = path.join(folder, `${id()}.upload`);
  let file = temp;
  try {
    await pipeline(req, createWriteStream(temp, { flags: 'wx' }));
    const bytes = readFileSync(temp).subarray(0, 12);
    const ext = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? '.png' :
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? '.jpg' :
        bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? '.webp' : '';
    if (!ext) throw new Error('参考图只支持 PNG、JPEG 或 WebP');
    file = temp.replace(/\.upload$/, ext);
    renameSync(temp, file);
    const relative = relativeMedia(file);
    updateProject(projectId, current => {
      const target = current.assets?.find(item => item.id === assetId);
      if (!target || assetInputHash(current, assetId, stateId) !== fingerprint) throw new Error('资产描述在上传期间变化');
      target.images.push({ id: id(), ...(stateId ? { stateId } : {}), ...(role==='turnaround'?{layout:'three-view-portrait' as const}:{}), role: role as 'main' | 'turnaround' | 'portrait', mediaPath: relative,
        createdAt: now(), source: 'upload', inputHash: fingerprint });
    });
    return { mediaPath: relative };
  } catch (error) {
    if (existsSync(file)) unlinkSync(file);
    if (file !== temp && existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

function serveFile(res: ServerResponse, file: string, type: string): void {
  if (!existsSync(file)) { json(res, 404, { error: '文件不存在' }); return; }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(file).size,
    'X-Content-Type-Options': 'nosniff' });
  res.end(readFileSync(file));
}

function serveMedia(req: IncomingMessage, res: ServerResponse, file: string): void {
  if (!existsSync(file)) { json(res, 404, { error: '视频不存在' }); return; }
  const size = statSync(file).size;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(req.headers.range || '');
  if (req.headers.range && !match) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
  const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') ? 'image/jpeg' :
    file.endsWith('.webp') ? 'image/webp' : 'video/mp4';
  res.writeHead(match ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    'X-Content-Type-Options': 'nosniff' });
  createReadStream(file, { start, end }).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedOrigin(req)) throw new Error('不允许来自其他站点的请求');
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.pathname === '/api/label-fonts' && req.method === 'GET') { json(res,200,await labelFonts(url.searchParams.get('refresh')==='1')); return; }
    if(url.pathname==='/api/studio/home'&&req.method==='GET'){json(res,200,await studioHome(url.searchParams.get('refresh')==='1'));return;}
    if(parts.length===5&&parts[1]==='studio'&&parts[2]==='projects'&&parts[4]==='progress'&&req.method==='GET'){json(res,200,projectProgress(parts[3]));return;}
    if(url.pathname==='/api/studio/start'&&req.method==='POST'){if(!req.headers.origin)throw Error('请在软件首页启动制作');json(res,202,await startStudioRun(await body(req)));return;}
    if(url.pathname==='/api/studio/draft'&&req.method==='POST'){if(!req.headers.origin)throw Error('请在软件首页保存作品');json(res,201,saveStudioDraft(await body(req)));return;}
    if(parts.length===5&&parts[1]==='studio'&&parts[2]==='runs'&&parts[4]==='control'&&req.method==='POST'){if(!req.headers.origin)throw Error('请在软件中控制制作会话');json(res,200,await controlStudioRun(parts[3],await body(req)));return;}
    if (url.pathname === '/api/agent' && req.method === 'GET') { json(res, 200, agentManifest()); return; }
    if(url.pathname==='/api/agent/tutorial'&&req.method==='GET'){
      const guide=bundledTutorial();res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Length':guide.length,'Content-Disposition':'attachment; filename="wanling-manju-tutorial.md"','X-Content-Type-Options':'nosniff'});res.end(guide);return;
    }
    if (url.pathname === '/api/agent/readiness' && req.method === 'GET') { json(res, 200, agentReadiness(url.searchParams.get('projectId') || undefined)); return; }
    if (url.pathname === '/api/agent/skill' && req.method === 'GET') {
      const client = url.searchParams.get('client') || 'workbuddy', pack = agentSkillZip(client);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': pack.length,
        'Content-Disposition': `attachment; filename="wanling-manju-${client}.zip"`, 'X-Content-Type-Options': 'nosniff' });
      res.end(pack); return;
    }
    if (url.pathname === '/api/agent/projects' && req.method === 'POST') { json(res, 201, createAgentProject(await body(req))); return; }
    if (url.pathname === '/api/production-defaults' && req.method === 'GET') { json(res, 200, productionDefaults()); return; }
    if(url.pathname==='/api/software-update'&&req.method==='GET'){json(res,200,await softwareUpdate());return;}
    if(url.pathname==='/api/software-update/check'&&req.method==='POST'){if(!req.headers.origin)throw Error('请在软件内检查更新');await body(req);json(res,202,await checkSoftwareUpdate());return;}
    if(url.pathname==='/api/software-update/settings'&&req.method==='POST'){if(!req.headers.origin)throw Error('请在软件内修改更新设置');json(res,200,await setSoftwareUpdate(await body(req)));return;}
    if (url.pathname === '/api/upscale/settings' && req.method === 'GET') { json(res, 200, upscaleSettings()); return; }
    if (url.pathname === '/api/upscale/setup' && req.method === 'POST') { await body(req); json(res, 202, startUpscaleSetup()); return; }
    if (url.pathname === '/api/upscale/settings' && req.method === 'POST') { json(res, 200, await saveUpscaleSettings(await body(req))); return; }
    if (url.pathname === '/api/production-defaults' && req.method === 'POST') { json(res, 200, saveProductionDefaults(await body(req))); return; }
    if(url.pathname==='/api/direct-provider/billing'&&req.method==='GET'){json(res,200,await fetchProviderBilling(url.searchParams.get('refresh')==='1'));return;}
    if(url.pathname==='/api/provider-account'&&req.method==='GET'){json(res,200,accountStatus());return;}
    if(url.pathname==='/api/provider-account/connect'&&req.method==='POST'){if(!req.headers.origin)throw Error('请在软件内登录账户');await body(req);json(res,200,await beginAccountConnect(`http://127.0.0.1:${port}`));return;}
    if(url.pathname==='/api/provider-account/logout'&&req.method==='POST'){if(!req.headers.origin)throw Error('请在软件内退出账户');await body(req);json(res,200,await logoutAccount());return;}
    if(url.pathname==='/api/provider-account/callback'&&req.method==='GET'){await finishAccountConnect(url.searchParams.get('code')||'',url.searchParams.get('state')||'');res.writeHead(303,{Location:'/?account_connected=1','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return;}
    if(url.pathname==='/api/runtime' && req.method==='GET'){json(res,200,runtimePreflight());return;}
    if(url.pathname==='/api/storage/backups' && req.method==='GET'){json(res,200,backups());return;}
    if(url.pathname==='/api/storage/backup' && req.method==='POST'){const input=await body(req);json(res,201,backupStorage(input.withMedia===true));return;}
    if(url.pathname==='/api/storage/restore' && req.method==='POST'){const input=await body(req);json(res,201,restoreStorage(String(input.id || '')));return;}
    if (parts[0] === 'media' && req.method === 'GET') {
      serveMedia(req, res, mediaPath(parts.slice(1).join('/'))); return;
    }
    if (parts[0] !== 'api') {
      const relative = parts.length ? parts.join('/') : 'index.html';
      const file = path.resolve(base, relative);
      if (!file.toLowerCase().startsWith((base + path.sep).toLowerCase())) throw new Error('路径无效');
      const ext = path.extname(file).toLowerCase();
      const type = ({ '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
        '.svg': 'image/svg+xml' } as Record<string, string>)[ext] || 'text/html; charset=utf-8';
      serveFile(res, file, type); return;
    }
    if (parts.length === 2 && parts[1] === 'health' && req.method === 'GET') {
      json(res, 200, { ok: true, application: 'wanling-manju', version:(await softwareUpdate()).currentVersion, installationRoot: process.cwd(), dataDirectory: dataDir, videoAdapter: Boolean(process.env.MANJU_VIDEO_ADAPTER),
        upscaleAdapter: Boolean(upscaleAdapter()), draftsRoot: draftsRoot() }); return;
    }
    if (parts.length === 2 && parts[1] === 'mumu' && req.method === 'GET') {
      json(res, 200, await mumuStatus()); return;
    }
    if (parts.length === 2 && parts[1] === 'direct-provider' && req.method === 'GET') {
      json(res, 200, directStatus()); return;
    }
    if (parts.length === 2 && parts[1] === 'direct-provider' && req.method === 'POST') {
      json(res, 200, saveDirectConfig(await body(req))); return;
    }
    if (parts.length === 3 && parts[1] === 'direct-provider' && parts[2] === 'models' && req.method === 'GET') {
      json(res, 200, await fetchDirectModels()); return;
    }
    if (parts.length === 3 && parts[1] === 'direct-provider' && parts[2] === 'defaults' && req.method === 'GET') {
      json(res, 200, globalModels()); return;
    }
    if (parts.length === 3 && parts[1] === 'direct-provider' && parts[2] === 'defaults' && req.method === 'POST') {
      json(res, 200, saveGlobalModel(await body(req))); return;
    }
    if (parts.length === 2 && parts[1] === 'effects' && req.method === 'GET') {
      json(res, 200, { summary: effectSummary(), effects: listEffects(url.searchParams.get('q') || '') }); return;
    }
    if (parts.length === 2 && parts[1] === 'projects' && req.method === 'GET') {
      json(res, 200, listProjects()); return;
    }
    if (parts.length === 2 && parts[1] === 'projects' && req.method === 'POST') {
      const input = await body(req), name = String(input.name || '').trim(), mode = input.mode as ProjectMode;
      if (!name || !['standard', 'douyin-story'].includes(mode)) throw new Error('请填写项目名称并选择项目类型');
      const project = applyGlobalModels(makeProject(name, mode)); project.productionRules = productionDefaults();
      json(res, 201, insertProject(project)); return;
    }
    if (parts[1] === 'projects' && parts[2]) {
      const projectId = parts[2];
      if (parts[3] === 'agent') {
        if (parts.length === 5 && parts[4] === 'dashboard' && req.method === 'GET') { json(res, 200, agentDashboard(projectId)); return; }
        if (parts.length === 7 && parts[4] === 'task' && parts[6] === 'control' && req.method === 'POST') {
          if (!req.headers.origin) throw Error('请在软件任务面板恢复或控制任务授权');
          json(res, 200, await agentTaskControl(projectId, parts[5], await body(req))); return;
        }
        if (parts.length === 4 && req.method === 'GET') { json(res, 200, agentContext(projectId, url.searchParams.get('episodeId') || undefined)); return; }
        if (parts.length === 5 && parts[4] === 'task' && req.method === 'POST') { json(res, 201, createAgentTask(projectId, await body(req))); return; }
        if (parts.length === 5 && parts[4] === 'command' && req.method === 'POST') { json(res, 200, await agentCommand(projectId, await body(req))); return; }
      }
      if(parts[3]==='workflows'){
        if(parts.length===4&&req.method==='GET'){json(res,200,workflowsFor(projectId));return;}
        if(parts.length===4&&req.method==='POST'){json(res,201,startWorkflow(projectId,await body(req)));return;}
        if(parts.length===6&&req.method==='POST'){
          const input=await body(req);
          if(parts[5]==='authorize'){
            // Agent tools cannot approve spending; this action belongs to the UI.
            if(!req.headers.origin)throw Error('请在软件界面确认本次预算');
            json(res,202,await authorizeWorkflow(projectId,parts[4],input));return;
          }
          json(res,200,await controlWorkflow(projectId,parts[4],parts[5]));return;
        }
      }
      if(parts[3]==='candidates') {
        if(parts.length===5&&parts[4]==='change'&&req.method==='POST'){json(res,200,applyCandidateChange(projectId,await body(req)));return;}
        if(parts.length===5&&parts[4]==='impact'&&req.method==='POST'){json(res,200,candidateChangeImpact(projectId,await body(req)));return;}
        if(parts.length===4&&req.method==='GET'){json(res,200,candidateBatches(projectId));return;}
        if(parts.length===4&&req.method==='POST'){json(res,202,createCandidates(projectId,await body(req)));return;}
        if(parts.length===5&&parts[4]==='preview'&&req.method==='POST'){
          const preview=candidatePreview(projectId,await body(req));
          const project=getProject(projectId),adapter=project[`${preview.input.kind}Model`]?.adapterPath||'';
          if(/direct-(image|video)\.mjs$/u.test(adapter))try{const billing=await fetchProviderBilling(),quote=billingQuote(billing,preview.model.id,preview.input.count);preview.cost.message=(quote.known?`API 公开报价范围 ${quote.minimum.toFixed(4)}–${quote.maximum.toFixed(4)} ${quote.currency}。${quote.description}`:quote.description)+' '+preview.cost.message;}catch{/* Original unknown-cost confirmation remains available. */}
          json(res,200,preview);return;
        }
        if(parts.length===6&&req.method==='POST'){const value=await body(req);json(res,200,controlCandidates(projectId,parts[4],parts[5],value.confirmed===true));return;}
      }
      if (parts.length === 3 && req.method === 'GET') { json(res, 200, getProject(projectId)); return; }
      if(parts.length===4 && parts[3]==='view' && req.method==='GET') {json(res,200,getProjectView(projectId,url.searchParams.get('episodeId') || undefined,url.searchParams.get('source')==='1'));return;}
      if(parts.length===4 && parts[3]==='episode-page' && req.method==='GET') {json(res,200,episodePage(projectId,Number(url.searchParams.get('offset') || 0),Number(url.searchParams.get('limit') || 20)));return;}
      if(parts.length===5 && parts[3]==='specs' && req.method==='GET'){json(res,200,generationSpec(projectId,parts[4]));return;}
      if (getProject(projectId).archivedAt && !(parts[3] === 'actions' && req.method === 'POST'))
        throw new Error('项目已移入回收区，请先恢复');
      if (parts.length === 4 && parts[3] === 'export' && req.method === 'POST') {
        const input = await body(req);
        json(res, 200, await exportProject(projectId, { upscale: input.upscale === true,
          onlyBelow1080: input.onlyBelow1080 === true })); return;
      }
      if (parts.length === 5 && parts[3] === 'assist' && parts[4] === 'plan' && req.method === 'POST') {
        const input=await body(req);json(res, 200, await suggestEpisodePlan(projectId,String(input.budgetHash || ''))); return;
      }
      if(parts.length===5 && parts[3]==='assist' && parts[4]==='plan-preview' && req.method==='GET') {json(res,200,storyPlanPreview(projectId));return;}
      if (parts.length === 5 && parts[3] === 'assist' && parts[4] === 'plan' && req.method === 'GET') {
        json(res, 200, storyPlanStatus(projectId)); return;
      }
      if (parts.length === 6 && parts[3] === 'models' && parts[5] === 'test' && req.method === 'POST') {
        json(res, 200, await testModelConnection(projectId, parts[4] as 'text' | 'image' | 'video')); return;
      }
      if (parts.length === 6 && parts[3] === 'models' && parts[5] === 'default' && req.method === 'POST') {
        if (!req.headers.origin) throw Error('请在软件内选择本项目要使用的模型');
        json(res, 200, useProjectDefaultModel(projectId, parts[4], await body(req))); return;
      }
      if (parts.length === 5 && parts[3] === 'mumu' && parts[4] === 'connect' && req.method === 'POST') {
        json(res, 200, await connectMumu(projectId)); return;
      }
      if (parts.length === 5 && parts[3] === 'direct-provider' && parts[4] === 'connect' && req.method === 'POST') {
        json(res, 200, connectDirect(projectId)); return;
      }
      if (parts.length === 6 && parts[3] === 'assets' && parts[5] === 'images' && req.method === 'POST') {
        // Character sheets are kept whole from import through video submission.
        json(res, 201, await uploadAssetImage(req, projectId, parts[4], url.searchParams.get('stateId') || '',
          url.searchParams.get('role') || 'main')); return;
      }
      if (parts.length === 7 && parts[3] === 'assets' && parts[5] === 'images' &&
        parts[6] === 'generate' && req.method === 'POST') {
        const input = await body(req);
        json(res, 201, await generateAssetImage(projectId, parts[4], String(input.stateId || ''),
          String(input.role || 'main'),undefined,{sourceImageId:String(input.sourceImageId||'')})); return;
      }
      if (parts[3] === 'actions' && req.method === 'POST') {
        const action = await body(req);
        if (action.type === 'project.model') assertProjectModelIdle(projectId);
        if (action.type === 'project.style' || action.type === 'project.archive') {
          const pending = db.prepare("SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running','paused') LIMIT 1")
            .get(projectId);
          if (pending) throw new Error('项目还有待执行或正在生成的任务，请先等任务结束再更改风格或模型');
        }
        if (action.type === 'script.newVersion') {
          const pending = db.prepare("SELECT id FROM jobs WHERE project_id=? AND episode_id=? AND status IN ('queued','running','paused') LIMIT 1")
            .get(projectId, String(action.episodeId || ''));
          if (pending) throw new Error('本集还有待执行或正在生成的任务，请先等任务结束再建立剧本新版本');
        }
        if (action.type === 'episode.archive') {
          const pending = db.prepare("SELECT id FROM jobs WHERE project_id=? AND episode_id=? AND status IN ('queued','running','paused') LIMIT 1")
            .get(projectId, String(action.episodeId || ''));
          if (pending) throw new Error('本集还有待执行或正在生成的任务，请先等任务结束再移入回收区');
        }
        json(res, 200, updateProject(projectId, project => applyAction(project, action as { type: string }))); return;
      }
      if (parts[3] === 'jobs') {
        if(parts.length===6 && parts[5]==='spec' && req.method==='GET') {json(res,200,generationSpec(projectId,parts[4]));return;}
        if (parts.length === 4 && req.method === 'GET') { json(res, 200, jobsFor(projectId)); return; }
        if (parts.length === 6 && parts[5] === 'cancel' && req.method === 'POST') {
          await body(req); cancelQueued(projectId, parts[4]); json(res,200,jobsFor(projectId)); return;
        }
        if (parts.length === 6 && parts[5] === 'reconcile' && req.method === 'POST') {
          reconcileTask(projectId,parts[4],await body(req)); json(res,200,jobsFor(projectId)); return;
        }
        if (parts.length === 6 && parts[5] === 'recover' && req.method === 'POST') {
          await body(req);
          json(res, 200, await recoverDownloadedVideo(projectId, parts[4])); return;
        }
        if (parts.length === 6 && parts[5] === 'recover-remote' && req.method === 'POST') {
          await body(req);
          json(res, 200, await recoverRemoteVideo(projectId, parts[4])); return;
        }
        if (parts.length === 4 && req.method === 'POST') {
          const input = await body(req);
          json(res, 202, enqueue(projectId, String(input.episodeId),
            Array.isArray(input.segmentIds) ? input.segmentIds.map(String) : [],
            Array.isArray(input.kinds) ? input.kinds as ArtifactKind[] : [],
            { regenerate: input.regenerate === true })); return;
        }
        if (parts.length === 5 && req.method === 'POST') {
          if (parts[4] === 'pause') pauseProject(projectId);
          else if (parts[4] === 'resume') resumeProject(projectId);
          else if (parts[4] === 'retry') retryFailed(projectId);
          else throw new Error('未知任务操作');
          json(res, 200, jobsFor(projectId)); return;
        }
      }
      if (parts[3] === 'episodes' && parts[4]) {
        const episodeId = parts[4];
        if (parts.length === 7 && parts[5] === 'assist' && req.method === 'POST') {
          if (parts[6] === 'highlight') json(res, 200, await suggestHighlight(projectId, episodeId));
          else if(parts[6]==='semantic-review') json(res,200,await suggestSemanticReview(projectId,episodeId));
          else if(parts[6]==='segment-plan') json(res,200,await suggestSegmentPlan(projectId,episodeId));
          else if (parts[6] === 'script') json(res, 200, await suggestScript(projectId, episodeId));
          else if (parts[6] === 'assets') json(res, 200, await suggestAssets(projectId, episodeId));
          else if (parts[6] === 'recover-assets') { const value=await body(req);json(res,200,await suggestAssets(projectId,episodeId,String(value.adapterTaskId||''),value.reviewedSourceNames as Record<string,string> | undefined,value.reviewedEvidence as Record<string,string> | undefined,value.reviewedStateTriggers as Record<string,string> | undefined)); }
          else if (parts[6] === 'effects') json(res, 200, await suggestSemanticEffects(projectId, episodeId));
          else throw new Error('未知文本建议类型');
          return;
        }
        if (parts.length === 6 && parts[5] === 'audit' && req.method === 'GET') {
          const episode = getProject(projectId).episodes.find(item => item.id === episodeId);
          if (!episode) throw new Error('分集不存在');
          const project = getProject(projectId);
          json(res, 200, { issues: auditEpisode(episode, project),
            approved: auditEpisode(episode,project).length===0 && episode.auditApprovedHash === approvalHash(episode),
            sampleApproved: episode.sampleApprovedHash === sampleGateHash(project, episode) }); return;
        }
        if (parts.length === 6 && parts[5] === 'preflight' && req.method === 'GET') {
          const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
          if (!episode) throw new Error('分集不存在');
          json(res, 200, await preflightEpisode(project, episode)); return;
        }
        if (parts.length === 6 && parts[5] === 'preview' && req.method === 'POST') {
          json(res, 201, await upload(req, projectId, episodeId)); return;
        }
        if (parts.length === 6 && parts[5] === 'export-mp4' && req.method === 'POST') {
          const input = await body(req);
          if (input.editingDraft) throw new Error('MP4 成片须通过正式导出预检');
          json(res, 200, await exportEpisodeMp4(projectId, episodeId, { upscale: input.upscale === true,
            onlyBelow1080: input.onlyBelow1080 === true })); return;
        }
        if (parts.length === 6 && parts[5] === 'export' && req.method === 'POST') {
          const input = await body(req);
          json(res, 200, await exportEpisode(projectId, episodeId, { upscale: input.upscale === true,
            onlyBelow1080: input.onlyBelow1080 === true, editingDraft: input.editingDraft===true,useProductionSettings:input.useProductionSettings===true, installedDestination: input.installedDestination===true, nameSuffix:typeof input.nameSuffix==='string'?input.nameSuffix:undefined, artifactIds: input.artifactIds as Record<string,string> | undefined })); return;
        }
        if (parts.length === 6 && parts[5] === 'package' && req.method === 'POST') {
          json(res, 200, exportProductionPackage(projectId, episodeId)); return;
        }
        if (parts.length === 8 && parts[5] === 'segments' && parts[7] === 'media' && req.method === 'POST') {
          json(res, 201, await upload(req, projectId, episodeId, parts[6])); return;
        }
        if (parts.length === 9 && parts[5] === 'segments' && parts[7] === 'assist' &&
          parts[8] === 'storyboard' && req.method === 'POST') {
          json(res, 200, await suggestSubshots(projectId, episodeId, parts[6])); return;
        }
        if (parts.length === 9 && parts[5] === 'segments' && parts[7] === 'videos' && req.method === 'POST' && url.searchParams.get('action') === 'repair-labels') {
          json(res,201,await repairLabels(projectId,episodeId,parts[6],parts[8],await body(req))); return;
        }
        if (parts.length === 9 && parts[5] === 'segments' && parts[7] === 'videos' &&
          parts[8] && req.method === 'POST' && url.searchParams.get('action') === 'inspect') {
          const artifactId = parts[8], project = getProject(projectId);
          const artifact = project.episodes.find(item => item.id === episodeId)?.segments
            .find(item => item.id === parts[6])?.artifacts.find(item => item.id === artifactId && item.kind === 'video');
          if (!artifact?.mediaPath) throw new Error('视频版本不存在');
          const technical = await inspectVideo(mediaPath(artifact.mediaPath));
          updateProject(projectId, current => {
            const target = current.episodes.find(item => item.id === episodeId)?.segments
              .find(item => item.id === parts[6])?.artifacts.find(item => item.id === artifactId);
            if (!target) throw new Error('视频版本已变化');
            target.technical = technical;
            target.review = undefined;
          });
          json(res, 200, technical); return;
        }
        if (parts.length === 9 && parts[5] === 'segments' && parts[7] === 'effects' && parts[8] === 'suggest' && req.method === 'GET') {
          const episode = getProject(projectId).episodes.find(item => item.id === episodeId);
          const segment = episode?.segments.find(item => item.id === parts[6]);
          const beat = episode?.scriptBeats.find(item => item.id === segment?.beatId);
          if (!episode || !segment || !beat) throw new Error('片段不存在');
          json(res, 200, suggestEffects(`${beat.event}\n${beat.reaction}`)); return;
        }
      }
    }
    json(res, 404, { error: '接口不存在' });
  } catch (error) {
    if (!res.destroyed && !res.headersSent) json(res, error instanceof RequestBodyError ? error.status : 400,
      { error: error instanceof Error ? error.message : String(error) });
  }
});

initializeTrialDemo();
recoverStudioRuns();
process.once('exit',closeStudioCodex);
server.listen(port, '127.0.0.1', () => {
  startSoftwareUpdates();
  try { recoverJobs(); startCandidates(); startWorkflows(); console.log(`万灵漫剧 API: http://127.0.0.1:${port}`); console.log(upscaleSettings().ready?'超分组件自动识别：已就绪':'超分组件自动识别：未找到，可在导出时点一次下载'); }
  catch (error) { console.error((error as Error).message); server.close(); process.exitCode = 1; }
});
