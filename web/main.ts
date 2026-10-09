import {modelPicker,catalogFeedback} from './model-picker';
import {agentPanel,billingPanel} from './agent-panel';
import {renderAgentSettings} from './agent-settings';
import {renderAgentDashboard} from './agent-dashboard';
import type {AgentDashboard,AgentReadiness} from '../shared/agent-dashboard';
import './agent-dashboard.css';
import {productionRules,type ProductionRules} from '../shared/production-rules';
import type {AgentWorkflow} from '../shared/agent-workflow';
import type {ProviderBilling} from '../shared/provider-billing';
import {modelPriceLabel} from '../shared/provider-billing';
import {canvasAssets,renderCanvasAsset} from './canvas-media';
import {fitCanvasNodes,nodesInMarquee} from '../shared/canvas-viewport';
import {reviewPanel} from './review-panel';
import {candidatePanel,type CandidateInput,type CandidateWorkspace,type CandidatePreview,type CandidateBatch} from './candidate-panel';
import { beatFor, digest, promptReadiness } from '../shared/model';
import { promptVersionStatus } from './prompt-status';
import { renderExecutionPanel, renderLabelStyle, readLabelStyle, readExecutionPlan, readVisibleCues, updateLabelPreviews, addEffectCue, type LabelFontStatus } from './execution-panel';
import {uiIcon} from './ui-icons';
import {noticeAutoDismissMs,renderAppNotice} from '../shared/ui-notice.js';
import { requestJson as api } from '../shared/local-api.js';
import { MAX_SOURCE_CHARACTERS, MAX_SOURCE_FILE_BYTES } from '../shared/source-limits.js';
import {analysisBudget} from '../shared/analysis-budget';
import { storyUnits, orderedSpeech } from '../shared/segmentation';
import type { Artifact, Episode, Project, ScriptBeat, Segment, VideoModel } from '../shared/model';
import { speechChecklist } from '../shared/speech-contract';
import { pacingWarnings } from '../shared/pacing';
import { segmentReferences, videoReferences, isCharacterSheet, requiresPortraitReference } from '../shared/asset-references';
import { effectiveState } from '../shared/asset-state';
import { stylePresets } from '../shared/style-presets';
import './style.css';
import './candidate.css';
import './canvas.css';
import './graph.css';
import './unified-canvas.css';
import { StudioCanvasMount } from './studio-canvas';
import { canvasConnectionAction, studioCanvas, type StudioNode } from '../shared/studio-canvas';
import './studio-canvas.css';
import './product-ui.css';
import './studio-home.css';
import './home-design.css';
import {renderStudioHome,renderHomeActivity,renderHomeProjects,renderHomeChat} from './studio-home';
import type {StudioHome,StudioRun} from '../shared/studio-home';
import type {ProjectProgress} from '../shared/project-progress';
import {renderHomeProgress} from './home-progress';
import {newAssetView,renderAssetWorkspace,segmentOptions} from './asset-workspace';
import './asset-workspace.css';
import {initializeStudioAppearance,renderStudioThemePicker,setStudioTheme,setStudioAppearancePage} from './studio-appearance';
import './cosmic-ui.css';
import type {SoftwareUpdate} from '../shared/software-update';
import {renderSoftwareUpdate} from './software-update';
import './software-update.css';
import { renderPromptManager } from './prompt-management';
import './prompt-management.css';

type Tab = 'home' | 'settings' | 'assets' | 'sourcePlan' | 'episodes' | 'tasks' | 'provider' | 'source' | 'script' | 'canvas' | 'export' | 'effects';
type Job = { id: string; episode_id: string; segment_id: string; kind: string; status: string; error: string | null };
type Effect = { id: string; name: string; category: string; localAdaptation: boolean; prompt: string; notes?: string };
type MumuGroup = { kind: 'text' | 'image' | 'video'; name: string; models: string[];
  defaultModel: string; ready: boolean; capabilities?: Record<string, { duration?: { max_seconds?: number };
    prompt?: { max_unicode_code_points?: number }; references?: { max_image_urls?: number };
    aspect_ratio?: { allowed?: string[] } } | null> };
type DirectCatalogModel = { id: string; kind: 'text' | 'image' | 'video' | 'other'; source: 'declared' | 'name'; declaredCapabilities?: VideoModel['capabilities'] };
type StoryPlanStatus = { status: 'running' | 'failed' | 'completed' | 'interrupted';
  totalBatches: number; completedBatches: number; error: string; updatedAt: string };
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const mediaUrl = (path: string) => `/media/${path.split('/').map(encodeURIComponent).join('/')}`;
const splitLines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
type VideoCategory = 'success' | 'waste' | 'pending' | 'accepted';
const videoCategory = (item: Artifact): VideoCategory => item.userAcceptance?.status==='accepted' ? 'accepted' : item.review?.status === 'approved' ? 'success' :
  item.review?.status === 'rejected' ? 'waste' : 'pending';
const videoCategoryName: Record<VideoCategory, string> =
  { success: '成功片段', waste: '废片段', pending: '待审片段',accepted:'用户验收通过' };
const segmentVideoCategory = (segment: Segment): VideoCategory | 'empty' => {
  const videos = segment.artifacts.filter(item => item.kind === 'video');
  if(videos.some(item=>videoCategory(item)==='accepted'))return 'accepted';
  if (videos.some(item => videoCategory(item) === 'success')) return 'success';
  if (videos.some(item => videoCategory(item) === 'pending')) return 'pending';
  return videos.length ? 'waste' : 'empty';
};
const videoCounts = (episode: Episode) => {
  const videos = episode.segments.flatMap(segment => segment.artifacts.filter(item => item.kind === 'video'));
  return { accepted:videos.filter(item=>videoCategory(item)==='accepted').length,success: videos.filter(item => videoCategory(item) === 'success').length,
    waste: videos.filter(item => videoCategory(item) === 'waste').length,
    pending: videos.filter(item => videoCategory(item) === 'pending').length };
};

const post = <T>(path: string, value: object) => api<T>(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});

class ManjuApp extends HTMLElement {
  private sidebarOpen=false;
  private sourceSaving=false;
  private projectConfigOpen=false;
  private projectModelsOpen=false;
  private nativeCanvas?: StudioCanvasMount;
  private projects: Pick<Project, 'id' | 'name' | 'mode' | 'updatedAt' | 'archivedAt'>[] = [];
  private project?: Project;
  private episodeId = '';
  private tab: Tab = 'home';
  private home?:StudioHome;
  private homeProjectId='';
  private homeLaunchOpen=false;
  private homeChatId='';
  private homeProjectQuery='';
  private homeProgress?:ProjectProgress;
  private homeProgressLoading=false;
  private homeProgressError='';
  private homeProgressPage=1;
  private homeProgressRequest=0;
  private homeProgressAt=0;
  private assetView=newAssetView();
  private homePollBusy=false;
  private homeRequest?:{action:string;body:Record<string,unknown>;key:string};
  private homeControlRequest?:{runId:string;body:Record<string,unknown>;key:string};
  private renameProjectId='';
  private renameOriginal='';
  private renameReturn?:HTMLElement;
  private jobs: Job[] = [];
  private workflows:AgentWorkflow[]=[];
  private taskDashboard?:AgentDashboard;
  private taskPollBusy=false;
  private taskControlRequest?:{taskId:string;operation:string;requestId:string};
  private billing?:ProviderBilling;
  private billingRefreshedAt=0;
  private billingPollBusy=false;
  private accountConnecting=false;
  private accountError='';
  private candidateWorkspace?:CandidateWorkspace;
  private candidateLoadId=0;
  private candidateInputs:CandidateInput[]=[];
  private candidateBatches:CandidateBatch[]=[];
  private assetImpact?:{action:Record<string,unknown>;hash:string;affected:{episode:number;segment:number}[];message:string};
  private effects: Effect[] = [];
  private effectSummary = { total: 0, locallyAdapted: 0 };
  private effectQuery = '';
  private effectSegmentId = '';
  private effectSuggestions: { id: string; name: string; evidence: string }[] = [];
  private checked = new Set<string>();
  private canvasSelectedSegmentId = '';
  private canvasSelectedAssetId = '';
  private canvasZoom = 1;
  private canvasView: 'graph' | 'table' = 'graph';
  private graphWorkflow: Tab | 'review' | null = null;
  private graphAssetFocusId = '';
  private videoFilter: VideoCategory | 'all' = 'all';
  private graphPending?: { segmentId: string; stage: 'shot'; nodeId: string };
  private graphInspectorOpen = false;
  private graphDrag?: { nodeId: string; pointerId: number; x: number; y: number; left: number; top: number };
  private graphSelection=new Set<string>();
  private graphGroupOrigins=new Map<string,{left:number;top:number}>();
  private graphSpace=false;
  private graphMarquee?:{pointerId:number;start:{x:number;y:number};initial:Set<string>;additive:boolean};
  private graphPan?: { pointerId: number; x: number; y: number; left: number; top: number };
  private graphOffset = { x: 48, y: 56 };
  private graphConnectDrag?: { pointerId: number; segmentId: string; nodeId: string; x: number; y: number; moved: boolean };
  private graphIgnorePortClickUntil = 0;
  private graphJobsOpen = false;
  private graphReviewMode: 'references' | 'anchors' | null = null;
  private graphLightbox?: { src: string; label: string };
  private auditIssues: string[] = [];
  private approved = false;
  private sampleApproved = false;
  private exportIssues: string[] = [];
  private exportWarnings: string[] = [];
  private labelFonts?: LabelFontStatus;
  private health = { videoAdapter: false, upscaleAdapter: false, draftsRoot: '' };
  private softwareUpdate:SoftwareUpdate={currentVersion:'',configured:false,enabled:true,status:'idle',message:'正在读取更新状态…'};
  private updatePollBusy=false;
  private updateSettingsSaving=false;
  private updateSettingsRevision=0;
  private upscaleSettings: {toolDirectory:string;ready:boolean;version?:string;mode:'auto'|'custom';message:string;setup:{status:'idle'|'preparing'|'ready'|'error';progress:number;message:string}} = {toolDirectory:'',ready:false,mode:'auto',message:'正在识别本机超分组件…',setup:{status:'idle',progress:0,message:''}};
  private upscaleError = '';
  private upscaleChecking = false;
  private upscalePollBusy = false;
  private upscaleAdvancedOpen = false;
  private runtime?: {ready:boolean;tools:{name:string;available:boolean;version:string}[];dataDirectory:string;backupDirectory:string;notes:string};
  private backups: {id:string;createdAt:string;mediaIncluded:boolean}[]=[];
  private mumu: { running: boolean; connected: boolean; models: MumuGroup[]; detail?: string } =
    { running: false, connected: false, models: [] };
  private directProvider: { configured: boolean; hasKey: boolean;catalogMode?:string } =
    { configured: false, hasKey: false };
  private globalModels: Partial<Record<'text' | 'image' | 'video', VideoModel>> = {};
  private productionDefaults: ProductionRules = productionRules();
  private agentEntry?: {skill:string;cli:string;readiness?:AgentReadiness};
  private directModels: DirectCatalogModel[] = [];
  private directModelsFetchedAt = '';
  private directModelsError = '';
  private storyPlanProgress: StoryPlanStatus | null = null;
  private settingsModelKind: 'text' | 'image' | 'video' = 'text';
  private settingsModelsOpen = false;
  private settingsStylePickerOpen = false;
  private episodeQuery = '';
  private episodePage = 1;
  private noticeText = '';
  private noticeTimer?:number;
  private get message(){return this.noticeText;}
  private set message(value:string){
    if(this.noticeTimer!==undefined)window.clearTimeout(this.noticeTimer);
    this.noticeTimer=undefined;this.noticeText=value;
    const delay=noticeAutoDismissMs(value);
    if(delay!==undefined)this.noticeTimer=window.setTimeout(()=>{this.noticeTimer=undefined;this.dismissNotice();},delay);
  }
  private dismissNotice(){
    this.message='';
    // Remove only the notice; preserve text input focus, drafts and playing media.
    this.querySelectorAll('[data-app-notice]').forEach(el=>el.remove());
  }
  private busy = false;
  private projectLoadId = 0;
  private projectPollBusy = false;
  private pendingText = new Map<string, { projectId: string; episodeId: string; segmentId: string }>();
  private textRefreshProjects = new Set<string>();
  private mp4Running = false;
  private draftFields = new Map<string, { value: string; checked: boolean }>();
  private labelRepairs = new Set<string>();
  private promptManagerScope = '';

  connectedCallback() {
    initializeStudioAppearance();
    this.addEventListener('toggle',event=>{
      const target=event.target;if(!(target instanceof HTMLDetailsElement)||!target.isConnected)return;
      if(target.matches('.asset-extraction')&&this.assetView.extractionOpen!==target.open){
        this.assetView.extractionOpen=target.open;
        if(this.project){const template=document.createElement('template');template.innerHTML=renderAssetWorkspace(this.project,this.assetView);const next=template.content.querySelector('.asset-extraction');if(next)target.replaceWith(next);this.restoreDraftFields();this.updateTextControls();}
      }
      if(target.matches('.asset-add'))this.assetView.addOpen=target.open;
      if(target.matches('.asset-add-state'))this.assetView.newStateOpen=target.open;
    },true);
    this.addEventListener('toggle',event=>{const target=event.target;if(!(target instanceof HTMLDetailsElement)||!target.isConnected)return;
      if(target.matches('[data-project-config]'))this.projectConfigOpen=target.open;
      if(target.matches('[data-project-model-settings]'))this.projectModelsOpen=target.open;
    },true);
    this.addEventListener('toggle',event=>{const target=event.target;if(target instanceof HTMLDetailsElement&&target.isConnected&&target.matches('[data-upscale-advanced]'))this.upscaleAdvancedOpen=target.open;},true);
    this.addEventListener('click', event => {this.querySelectorAll<HTMLDetailsElement>('.home-project-menu[open]').forEach(menu=>{if(!menu.contains(event.target as Node))menu.open=false;});void this.handleClick(event);});
    this.addEventListener('change', event => void this.change(event));
    this.addEventListener('dragover',event=>{if((event.target as Element).closest('[data-home-drop]'))event.preventDefault();});
    this.addEventListener('drop',event=>{if((event.target as Element).closest('[data-home-drop]')){event.preventDefault();const file=event.dataTransfer?.files[0];if(file)void this.importHomeFile(file);}});
    this.addEventListener('pointerdown', event => this.graphPointerDown(event));
    this.addEventListener('pointermove', event => this.graphPointerMove(event));
    this.addEventListener('pointerup', event => this.graphPointerUp(event));
    this.addEventListener('pointercancel', event => this.graphPointerUp(event));
    this.addEventListener('wheel', event => this.graphWheel(event), { passive: false });
    this.addEventListener('keydown',event=>{
      if(this.querySelector('[data-prompt-manager]')) {
        if(event.key==='Escape'){event.preventDefault();this.promptManagerScope='';this.render();this.querySelector<HTMLButtonElement>('[data-action="prompt-manager-open"]')?.focus();return;}
        if(event.key==='Tab'){const fields=[...this.querySelectorAll<HTMLElement>('[data-prompt-manager] button:not(:disabled),[data-prompt-manager] input,[data-prompt-manager] textarea,[data-prompt-manager] select,[data-prompt-manager] summary')].filter(el=>el.getClientRects().length);const first=fields[0],last=fields.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
        return;
      }
      if(this.renameProjectId){
        if(event.key==='Escape'){this.closeRename();return;}
        if(event.key==='Enter'&&(event.target as Element).matches('[name="rename-name"]')){event.preventDefault();this.querySelector<HTMLButtonElement>('[data-action="rename-save"]')?.click();return;}
        if(event.key==='Tab'){const fields=[...this.querySelectorAll<HTMLElement>('.home-rename-dialog input,.home-rename-dialog button')];const first=fields[0],last=fields.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}return;
      }
      if(event.key==='Escape'){const menu=this.querySelector<HTMLDetailsElement>('.home-project-menu[open]');if(menu){menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus();return;}}
      if(event.key==='Escape'&&this.sidebarOpen){this.sidebarOpen=false;this.render();this.querySelector<HTMLButtonElement>('.sidebar-toggle')?.focus();return;}
      if(event.key==='Enter'&&(event.target as HTMLInputElement).matches('[name="asset-search"],[name="home-project-search"]')){event.preventDefault();this.querySelector<HTMLButtonElement>(`[data-action="${(event.target as HTMLInputElement).name}"]`)?.click();return;}
      const target=event.target as Element;if(!target.closest('.graph-viewport')||target.closest('input,textarea,select,video,button,[contenteditable="true"]'))return;
      if(event.code==='Space'){this.graphSpace=true;event.preventDefault();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();this.graphSelection=new Set([...this.querySelectorAll<HTMLElement>('.graph-node')].map(n=>n.dataset.nodeId!));this.applyGraphTransform();}
      if(event.key==='Escape'){this.graphSelection.clear();this.applyGraphTransform();}
    });
    this.addEventListener('keyup',event=>{if(event.code==='Space')this.graphSpace=false;});
    this.addEventListener('focusout',()=>{this.graphSpace=false;});
    this.addEventListener('input', event => {
      const slider = event.target as HTMLInputElement;
      if (slider.closest('[data-label-style],[data-label-repair]')) {
        updateLabelPreviews(this,this.project,this.episode);
        if(slider.name==='repair-time') { const video=slider.closest('[data-label-repair]')?.querySelector<HTMLVideoElement>('[data-label-video]'); if(video?.readyState)video.currentTime=Number(slider.value); }
      }
      if (slider.matches('.graph-zoom-slider')) this.graphZoomTo(Number(slider.value) / 100);
      else if (slider.name && !['asset-search','asset-candidate-episode','home-project-search'].includes(slider.name) && !slider.name.startsWith('workflow-') && slider.type !== 'file' && !slider.closest('.candidate-workbench')) this.draftFields.set(this.draftKey(slider), { value: slider.value, checked: slider.checked });
      if(slider.name==='home-episodes')this.updateHomeProgress();
    });
    this.addEventListener('change', event => {
      const field = event.target as HTMLInputElement;
      if(field.closest('[data-label-style],[data-label-repair]')){updateLabelPreviews(this,this.project,this.episode);this.updateLabelRepairControls();}
      if (field.name && !['asset-search','asset-candidate-episode','home-project-search'].includes(field.name) && !field.name.startsWith('workflow-') && field.type !== 'file' && !field.closest('.candidate-workbench')) this.draftFields.set(this.draftKey(field), { value: field.value, checked: field.checked });
      if(field.name==='upscale'||field.name==='editing-settings')this.updateUpscaleControls();
    });
    void this.load();
    window.setInterval(() => void this.poll(), 3000);
    window.addEventListener('focus',()=>void this.refreshAccountBilling(true));
  }

  private get episode(): Episode | undefined { return this.project?.episodes.find(item => item.id === this.episodeId); }
  private findSegment(id: string): Segment | undefined { return this.episode?.segments.find(item => item.id === id); }
  private async load() {
    this.projects = await api('/api/projects');
    this.health = await api('/api/health');
    this.softwareUpdate=await api<SoftwareUpdate>('/api/software-update').catch(()=>({...this.softwareUpdate,message:'请重新启动软件后台后重试'}));
    this.upscaleSettings = await api<typeof this.upscaleSettings>('/api/upscale/settings').catch(()=>({...this.upscaleSettings,message:'请重新启动软件后台后重试'}));
    this.runtime=await api('/api/runtime');this.backups=await api('/api/storage/backups');
    this.mumu = await api('/api/mumu');
    this.directProvider = await api('/api/direct-provider');
    this.globalModels = await api('/api/direct-provider/defaults');
    this.productionDefaults = await api('/api/production-defaults');
    this.agentEntry = await api('/api/agent');
    // Opening a local sample must not wait for remote pricing or account queries.
    const billingRequest=api<ProviderBilling>('/api/direct-provider/billing').catch(()=>undefined);
    if (this.directProvider.configured) {
      try {
        const result = await api<{ fetchedAt: string; models: DirectCatalogModel[] }>('/api/direct-provider/models');
        this.directModels = result.models; this.directModelsFetchedAt = result.fetchedAt;this.directModelsError='';
      } catch(error) { this.directModelsError=error instanceof Error?error.message:String(error); }
    }
    this.render();
    void this.refreshHome().catch(error=>{this.message=(error as Error).message;this.render();});
    void billingRequest.then(value=>{this.billing=value;this.billingRefreshedAt=Date.now();if(this.tab==='provider')this.render();});
  }

  private async openProject(id: string, background = false) {
    if(!background)this.candidateLoadId++;
    const loadId = ++this.projectLoadId;
    let episodeId = this.episodeId, tab = this.tab;
    const current = () => loadId === this.projectLoadId && episodeId === this.episodeId && tab === this.tab &&
      (!background || (this.project?.id === id && !this.busy && this.canRefreshView()));
    const [jobs, project, workflows, taskDashboard, storyPlanProgress, candidateBatches] = await Promise.all([
      api<Job[]>(`/api/projects/${id}/jobs`),
      api<Project>(`/api/projects/${id}/view?episodeId=${encodeURIComponent(episodeId)}&source=${tab === 'sourcePlan' ? '1' : '0'}`),
      api<AgentWorkflow[]>(`/api/projects/${id}/workflows`).catch(() => []),
      tab === 'tasks' ? api<typeof this.taskDashboard>(`/api/projects/${id}/agent/dashboard`) : undefined,
      tab === 'sourcePlan' ? api<StoryPlanStatus | null>(`/api/projects/${id}/assist/plan`) : null,
      api<CandidateBatch[]>(`/api/projects/${id}/candidates`).catch(() => this.project?.id === id ? this.candidateBatches : []),
    ]);
    if (!current()) return;
    if(this.project?.id!==id){
      this.assetView=newAssetView();
      this.candidateLoadId++;
      this.candidateWorkspace=undefined;
      this.candidateInputs=[];
      this.assetImpact=undefined;
    }
    this.project = project;
    localStorage.setItem('manju-project-id', id);
    if (this.tab === 'sourcePlan' && this.project.mode !== 'standard') this.tab = 'settings';
    if (!this.project.episodes.some(item => item.id === this.episodeId)) this.episodeId = this.project.episodes[0]?.id || '';
    this.jobs = jobs;
    this.candidateBatches = candidateBatches;
    episodeId = this.episodeId; tab = this.tab;
    this.workflows = workflows;
    this.taskDashboard = taskDashboard;
    for(const flow of [...this.workflows].reverse()){
      const result=flow.exportResult as {draftDir?:string;draftError?:string;mp4?:{url:string;filePath:string;durationSeconds:number}}|undefined;
      if(result?.draftDir)localStorage.setItem('manju-export:'+id+':'+flow.episodeId,result.draftDir);
      if(result?.mp4)localStorage.setItem('manju-mp4-export:'+id+':'+flow.episodeId,JSON.stringify({...result.mp4,draftError:result.draftError}));
    }
    this.storyPlanProgress = storyPlanProgress;
    if(this.tab==='assets'||this.graphWorkflow==='assets')await this.loadAssetCandidate();
    if (!current()) return;
    await this.refreshAudit();
    if (!current()) return;
    this.textRefreshProjects.delete(id);
    this.render();
  }

  private async refreshAudit() {
    if (!this.project || !this.episode) { this.auditIssues = []; this.approved = false; this.sampleApproved = false; return; }
    const projectId = this.project.id, episodeId = this.episodeId, loadId = this.projectLoadId;
    const result = await api<{ issues: string[]; approved: boolean; sampleApproved: boolean }>(`/api/projects/${projectId}/episodes/${episodeId}/audit`);
    if (this.project?.id !== projectId || this.episodeId !== episodeId || this.projectLoadId !== loadId) return;
    this.auditIssues = result.issues;
    this.approved = result.approved && result.issues.length===0;
    this.sampleApproved = result.sampleApproved;
    if (this.tab === 'export' || this.graphWorkflow === 'export') await this.loadPreflight();
  }

  private async loadPreflight() {
    if (!this.project || !this.episode) { this.exportIssues = []; return; }
    const projectId = this.project.id, episodeId = this.episodeId, loadId = this.projectLoadId;
    const result = await api<{ issues: string[]; warnings?: string[] }>(`/api/projects/${projectId}/episodes/${episodeId}/preflight`);
    if (this.project?.id !== projectId || this.episodeId !== episodeId || this.projectLoadId !== loadId) return;
    this.exportIssues = result.issues;
    this.exportWarnings = result.warnings || [];
  }

  private async refreshAccountBilling(force=false){
    if(this.billingPollBusy||this.busy)return;
    if(!force&&!this.accountConnecting&&Date.now()-this.billingRefreshedAt<30000)return;
    this.billingPollBusy=true;
    try{
      const status=await api<{connected:boolean;name:string;pending:boolean}>('/api/provider-account');
      const changed=Boolean(this.billing?.account?.connected)!==status.connected||this.billing?.account?.name!==status.name||Boolean(this.billing?.account?.pending)!==status.pending;
      if(force||changed||Date.now()-this.billingRefreshedAt>=30000){this.billing=await api('/api/direct-provider/billing?refresh=1');this.billingRefreshedAt=Date.now();
        this.querySelectorAll('.provider-billing').forEach(el=>el.outerHTML=billingPanel(this.billing));
        this.querySelectorAll<HTMLElement>('[data-price-kind]').forEach(el=>{const kind=el.dataset.priceKind as 'text'|'image'|'video';const label=el.querySelector('dd');if(label)label.textContent=modelPriceLabel(this.billing,this.globalModels[kind]?.modelId||'',kind);});
        this.querySelectorAll<HTMLElement>('.provider-pricing-error').forEach(el=>el.hidden=!this.billing?.pricingError);
        if(changed&&!this.draftFields.size&&!(document.activeElement instanceof HTMLInputElement))this.render();
      }
      this.accountConnecting=status.pending;
    }catch{/* Keep the last verified balance during a temporary local connection failure. */}
    finally{this.billingPollBusy=false;}
  }
  private async poll() {
    if(this.tab==='provider'&&!this.updatePollBusy&&!this.updateSettingsSaving){
      this.updatePollBusy=true;
      const revision=this.updateSettingsRevision;
      try{const next=await api<SoftwareUpdate>('/api/software-update');if(revision===this.updateSettingsRevision){this.softwareUpdate=next;this.refreshUpdateControls();}}catch{}
      finally{this.updatePollBusy=false;}
    }
    if(this.tab==='home'){if(!this.busy)await this.refreshHome().catch(()=>{const status=this.querySelector('[data-home-codex-status] span');if(status)status.textContent='本机连接暂时中断，请刷新后核对进度。';});return;}
    await this.pollUpscale();
    if(this.tab==='tasks'){
      if(!this.project||this.busy||this.taskPollBusy)return;
      this.taskPollBusy=true;
      try{await this.loadTaskDashboard();}catch{
        const region=this.querySelector<HTMLElement>('[data-agent-dashboard]');if(region){region.dataset.stale='1';const status=region.querySelector('[data-dashboard-summary]');if(status)status.textContent='连接暂时中断，显示上次读取的进度。';}
      }
      finally{this.taskPollBusy=false;}
      return;
    }
    await this.refreshAccountBilling();
    if (!this.project || this.busy || this.projectPollBusy || !this.canRefreshView()) return;
    const projectId = this.project.id, episodeId = this.episodeId, tab = this.tab, loadId = this.projectLoadId;
    const priorJobs = this.jobs, priorWorkflows = this.workflows, priorBatches = this.candidateBatches, priorProgress = this.storyPlanProgress;
    this.projectPollBusy = true;
    try {
      const [jobs, workflows, batches, progress] = await Promise.all([
        api<Job[]>(`/api/projects/${projectId}/jobs`).catch(() => priorJobs),
        api<AgentWorkflow[]>(`/api/projects/${projectId}/workflows`).catch(() => priorWorkflows),
        api<CandidateBatch[]>(`/api/projects/${projectId}/candidates`).catch(() => priorBatches),
        tab === 'sourcePlan' && priorProgress?.status === 'running'
          ? api<StoryPlanStatus | null>(`/api/projects/${projectId}/assist/plan`).catch(() => priorProgress) : priorProgress,
      ]);
      if (this.project?.id !== projectId || this.episodeId !== episodeId || this.tab !== tab ||
        this.projectLoadId !== loadId || this.busy || !this.canRefreshView()) return;
      if (!this.textRefreshProjects.has(projectId) && JSON.stringify(jobs) === JSON.stringify(priorJobs) &&
        JSON.stringify(workflows) === JSON.stringify(priorWorkflows) && JSON.stringify(batches) === JSON.stringify(priorBatches) &&
        JSON.stringify(progress) === JSON.stringify(priorProgress)) return;
      await this.openProject(projectId, true);
      void this.refreshAccountBilling(true);
    } finally { this.projectPollBusy = false; }
  }

  private async pollUpscale(){
    if(this.upscalePollBusy||this.upscaleChecking)return;
    this.upscalePollBusy=true;
    try{
      const next=await api<typeof this.upscaleSettings>('/api/upscale/settings');
      if(JSON.stringify(next)!==JSON.stringify(this.upscaleSettings)){
        this.upscaleSettings=next;this.health=await api('/api/health');this.updateUpscaleControls();
      }
    }catch{/* Retain the last verified state during a local connection interruption. */}
    finally{this.upscalePollBusy=false;}
  }
  private refreshUpdateControls(){
    const s=this.softwareUpdate,message=this.querySelector('[data-software-update-message]');
    if(message)message.textContent=s.message+(s.status==='downloading'?`（${s.progress||0}%）`:'');
    const button=this.querySelector<HTMLButtonElement>('[data-action="check-software-update"]');
    if(button){const busy=s.status==='checking'||s.status==='downloading';button.disabled=busy||!s.configured;button.textContent=busy?'正在更新…':'检查更新';}
    const checkbox=this.querySelector<HTMLInputElement>('[name="software-auto-update"]');if(checkbox){checkbox.checked=s.enabled;checkbox.disabled=this.updateSettingsSaving;}
  }
  private renderUpscaleStatus(){
    const s=this.upscaleSettings,preparing=s.setup.status==='preparing';
    return `<div class="upscale-status" role="status" aria-live="polite"><span class="chip ${s.ready?'green':''}">${s.ready?'超分已就绪':preparing?'正在准备超分':'缺少超分组件'}</span><p>${esc(s.message)}${s.ready&&s.version?' · v'+esc(s.version):''}</p>${preparing?`<progress max="100" value="${s.setup.progress}" aria-label="超分组件下载与安装进度"></progress><span> ${s.setup.progress}%</span><p class="muted">准备期间可以继续编辑项目。</p>`:!s.ready?'<button class="primary" data-action="download-upscale">下载超分组件</button><p class="muted">点击后下载约 45 MB 并自动连接，只需首次联网一次。</p>':''}${this.upscaleError?`<p class="notice error" role="alert">${esc(this.upscaleError)}</p>`:''}</div>`;
  }
  private updateUpscaleControls(){
    this.querySelectorAll('[data-upscale-status]').forEach(el=>{el.innerHTML=this.renderUpscaleStatus();});
    this.querySelectorAll('[data-upscale-availability]').forEach(el=>{el.textContent=this.health.upscaleAdapter?'已就绪':'未就绪';});
    const advanced=this.querySelector<HTMLButtonElement>('[data-action="save-upscale-settings"]');if(advanced)advanced.disabled=this.upscaleChecking||this.upscaleSettings.setup.status==='preparing';
    const checked=this.querySelector<HTMLInputElement>('[name="upscale"]')?.checked;
    for(const button of this.querySelectorAll<HTMLButtonElement>('[data-upscale-export]')){
      const original=button.dataset.action==='export-editing'&&this.field('editing-settings')==='original';
      button.disabled=button.dataset.exportBlocked==='true'||Boolean(checked&&!original&&!this.health.upscaleAdapter);
    }
  }

  private async act(value: object) {
    if (!this.project) throw new Error('请先新建项目');
    this.project = await post(`/api/projects/${this.project.id}/actions`, value);
    await this.refreshAudit();
    this.render();
  }
  private async loadTaskDashboard(){
    const projectId=this.project?.id;if(!projectId)return;
    const value=await api<AgentDashboard>(`/api/projects/${projectId}/agent/dashboard`);
    if(this.project?.id!==projectId||this.tab!=='tasks')return;
    if(window.getSelection()?.isCollapsed===false)return;
    const region=this.querySelector<HTMLElement>('[data-agent-dashboard]');
    if(JSON.stringify(value)===JSON.stringify(this.taskDashboard)&&!region?.dataset.stale)return;
    this.taskDashboard=value;
    if(!region){this.render();return;}
    const opened=[...region.querySelectorAll<HTMLDetailsElement>('details[open][data-dashboard-key]')].map(el=>el.dataset.dashboardKey);
    const focused=region.contains(document.activeElement)?document.activeElement as HTMLElement:undefined;
    const focusKey=focused?{action:focused.dataset.action,task:focused.dataset.taskId,operation:focused.dataset.operation,key:focused.parentElement?.dataset.dashboardKey}:undefined;
    region.innerHTML=renderAgentDashboard(value);
    delete region.dataset.stale;
    for(const item of region.querySelectorAll<HTMLDetailsElement>('details[data-dashboard-key]'))item.open=opened.includes(item.dataset.dashboardKey);
    if(focusKey){const next=[...region.querySelectorAll<HTMLElement>('button,summary')].find(el=>focusKey.action?el.dataset.action===focusKey.action&&el.dataset.taskId===focusKey.task&&el.dataset.operation===focusKey.operation:el.parentElement?.dataset.dashboardKey===focusKey.key);next?.focus({preventScroll:true});}
  }
  private async openCandidates(inputs:CandidateInput[]) {
    if(!this.project||!inputs.length)return;
    const project=this.project,loadId=++this.candidateLoadId,episodeId=this.episodeId,tab=this.tab;
    if(inputs[0]?.kind==='image')inputs=inputs.map(input=>{const asset=project.assets?.find(a=>a.id===input.assetId);return {...input,role:asset&&requiresPortraitReference(asset)?'turnaround':'main',episodeId:input.episodeId||this.episode?.id,segmentId:input.segmentId||this.canvasSelectedSegmentId||this.episode?.segments[0]?.id};});
    const input=inputs[0],asset=project.assets?.find(a=>a.id===input.assetId),segment=project.episodes.find(e=>e.id===input.episodeId)?.segments.find(s=>s.id===input.segmentId);
    const choices=input.kind==='image'?asset?.images.filter(i=>(i.stateId||'')===(input.stateId||'')&&(i.role||'main')===(input.role||'main')).map(i=>i.id)||[]:segment?.artifacts.filter(a=>a.kind==='video').map(a=>a.id)||[];
    const selected=input.kind==='video'?segment?.selected.video:segment?.assetBindings?.find(b=>b.assetId===input.assetId)?.imageId;
    const workspace:CandidateWorkspace={input,previews:[],requestIds:[],compareIds:[...new Set([selected,...choices.slice(-2)].filter((v):v is string=>Boolean(v)))].slice(0,3)};
    const batches=await api<CandidateBatch[]>(`/api/projects/${project.id}/candidates`);
    if(this.project?.id!==project.id||this.candidateLoadId!==loadId||this.episodeId!==episodeId||this.tab!==tab)return;
    this.candidateInputs=inputs;
    this.candidateWorkspace=workspace;
    this.candidateBatches=batches;this.render();
    return workspace;
  }
  private async previewAssetChange(action:Record<string,unknown>){
    if(!this.project)return;
    const impact=await post<{hash:string;affected:{episode:number;segment:number}[];message:string}>(`/api/projects/${this.project.id}/candidates/impact`,action);
    if(!impact.affected.length){await this.act(action);return;}
    this.assetImpact={action,...impact};this.render();
  }

  private draftKey(field: HTMLElement & { name: string; value: string; type?: string }): string {
    if(field.name==='rename-name')return 'rename:'+this.renameProjectId;
    if(field.name.startsWith('home-'))return field.name==='home-chat-text'?'home:chat:'+this.homeChatId:'home:'+this.homeProjectId+':'+field.name;
    const keys = ['data-segment-id','data-artifact-id','data-subshot-id','data-asset-id','data-state-id','data-beat-id','data-binding-asset-id','data-model-kind','data-image-id','data-story-review-beat','data-task-review','data-boundary-left','data-boundary-right'];
    return [this.project?.id,this.episodeId,this.tab,...keys.map(key => field.closest(`[${key}]`)?.getAttribute(key) || ''),
      field.name, ['checkbox','radio'].includes(field.type || '') ? field.value : ''].join(':');
  }

  private restoreDraftFields(pruneSaved = false): void {
    for (const field of this.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name],textarea[name],select[name]')) {
      const key = this.draftKey(field), draft = this.draftFields.get(key);
      if (!draft || (field instanceof HTMLInputElement && field.type === 'file')) continue;
      if (pruneSaved && field.value === draft.value &&
        (!(field instanceof HTMLInputElement) || !['checkbox','radio'].includes(field.type) || field.checked === draft.checked)) {
        this.draftFields.delete(key); continue;
      }
      if(field.name==='state-start'&&this.project){
        const form=field.closest('[data-state-form]'),episode=form?.querySelector<HTMLSelectElement>('[name="state-episode"]');
        if(episode)field.innerHTML=segmentOptions(this.project,Number(episode.value),draft.value);
      }
      field.value = draft.value;
      if (field instanceof HTMLInputElement && ['checkbox','radio'].includes(field.type)) field.checked = draft.checked;
    }
    if (!this.draftFields.size) this.querySelector('[data-action="discard-drafts"]')?.remove();
  }

  private field(name: string, scope: ParentNode = this): string {
    return (scope.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value || '';
  }
  private homeLimitSummary(){const label=this.querySelector('[data-home-limit-summary]');if(label)label.textContent=`文本${this.field('home-limit-text')} / 图片${this.field('home-limit-image')}${this.field('home-delivery')==='video'?' / 视频'+this.field('home-limit-video'):''}`;}

  private selectHomeProject(projectId:string,chatId=''){
    if(projectId!==this.homeProjectId){this.homeProgressRequest++;this.homeProgress=undefined;this.homeProgressLoading=false;this.homeProgressError='';this.homeProgressPage=1;this.homeProgressAt=0;}
    this.homeProjectId=projectId;this.homeChatId=chatId;if(projectId)this.homeLaunchOpen=true;this.render();
  }
  private updateHomeProgress(){
    const panel=this.querySelector('[data-home-progress]');if(!panel)return;
    const progress=this.homeProgress?.projectId===this.homeProjectId?this.homeProgress:undefined;
    const markup=renderHomeProgress(progress,this.homeProgressLoading,this.homeProgressError,this.field('home-delivery')==='video'?'video':'package',Number(this.field('home-episodes')),this.homeProgressPage);
    if(panel.innerHTML!==markup){
      const focused=panel.contains(document.activeElement)?document.activeElement as HTMLElement:undefined,action=focused?.dataset.action,episodeId=focused?.dataset.episodeId,direction=focused?.dataset.direction;
      panel.innerHTML=markup;
      if(action){const buttons=[...panel.querySelectorAll<HTMLButtonElement>('button')].filter(b=>b.dataset.action===action&&!b.disabled);(buttons.find(b=>b.dataset.episodeId===episodeId&&b.dataset.direction===direction)||buttons[0])?.focus({preventScroll:true});}
    }
  }
  private async loadHomeProgress(force=false){
    const projectId=this.homeProjectId;if(!projectId||this.homeProgressLoading||(!force&&Date.now()-this.homeProgressAt<15000))return;
    const request=++this.homeProgressRequest;this.homeProgressLoading=true;this.homeProgressError='';this.updateHomeProgress();
    try{
      const progress=await api<ProjectProgress>(`/api/studio/projects/${encodeURIComponent(projectId)}/progress`);
      if(request!==this.homeProgressRequest||this.homeProjectId!==projectId)return;
      this.homeProgress=progress;this.homeProgressAt=Date.now();
    }catch(error){if(request===this.homeProgressRequest&&this.homeProjectId===projectId){this.homeProgressError='读取进度失败：'+(error as Error).message;this.homeProgressAt=Date.now();}}
    finally{if(request===this.homeProgressRequest){this.homeProgressLoading=false;if(this.tab==='home')this.updateHomeProgress();}}
  }

  private canRefreshView(): boolean {
    return ![...this.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name],textarea[name],select[name]')]
      .some(field => this.draftFields.has(this.draftKey(field))) &&
      ![...this.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(input => input.files?.length) &&
      !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLSelectElement);
  }

  private isTextAction(action: string): boolean {
    return ['suggest-plan', 'suggest-assets', 'suggest-highlight', 'suggest-script', 'suggest-semantic',
      'suggest-segment-plan', 'suggest-subshots', 'suggest-effects-model'].includes(action);
  }

  private textScope(button: HTMLElement) {
    return { projectId: this.project?.id || '',
      episodeId: button.dataset.action === 'suggest-plan' ? '' : button.dataset.episodeId || this.episodeId,
      segmentId: button.dataset.action === 'suggest-subshots' ? button.closest<HTMLElement>('[data-segment-id]')?.dataset.segmentId || '' : '' };
  }

  private textScopePending(scope: { projectId: string; episodeId: string; segmentId: string }): boolean {
    return [...this.pendingText.values()].some(pending => pending.projectId === scope.projectId && pending.episodeId === scope.episodeId &&
      (!pending.segmentId || !scope.segmentId || pending.segmentId === scope.segmentId));
  }

  private updateTextControls(): void {
    for (const button of this.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
      if (!this.isTextAction(button.dataset.action!)) continue;
      if (this.textScopePending(this.textScope(button))) {
        if (button.dataset.textPendingLabel === undefined) {
          button.dataset.textPendingLabel = button.textContent || '';
          button.dataset.textPendingDisabled = String(button.disabled);
        }
        button.disabled = true; button.textContent = '文本任务排队或处理中…';
      } else if (button.dataset.textPendingLabel !== undefined) {
        button.textContent = button.dataset.textPendingLabel;
        button.disabled = button.dataset.textPendingDisabled === 'true';
        delete button.dataset.textPendingLabel; delete button.dataset.textPendingDisabled;
      }
    }
  }

  private async handleTextAction(button: HTMLElement): Promise<void> {
    const project = this.project, action = button.dataset.action!;
    if (!project) return;
    const scope = this.textScope(button), tab = this.tab, episodeId = this.episodeId;
    if (this.textScopePending(scope)) return;
    const key = JSON.stringify([scope.projectId, scope.episodeId, scope.segmentId, action]);
    const sameView = () => this.project?.id === project.id && this.episodeId === episodeId && this.tab === tab;
    try {
      let body: object = {}, url: string;
      if (action === 'suggest-plan') {
        if (this.field('project-source') !== (project.sourceCorpus || '')) throw new Error('请先保存完整原文');
        if (!this.querySelector<HTMLInputElement>('[name="analysis-budget-confirmed"]')?.checked) throw new Error('请先核对章节、输入批次及请求预算并勾选确认');
        const budget = analysisBudget(project.sourceCorpus || '', project.textModel?.adapterPath || '', project.textModel?.modelId);
        body = { budgetHash: budget.hash }; url = `/api/projects/${project.id}/assist/plan`;
      } else {
        if (!scope.episodeId) return;
        const route: Record<string, string> = { 'suggest-assets': 'assets', 'suggest-highlight': 'highlight',
          'suggest-script': 'script', 'suggest-semantic': 'semantic-review', 'suggest-segment-plan': 'segment-plan', 'suggest-effects-model': 'effects' };
        if (action === 'suggest-subshots' && !scope.segmentId) return;
        url = `/api/projects/${project.id}/episodes/${scope.episodeId}` + (action === 'suggest-subshots'
          ? `/segments/${scope.segmentId}/assist/storyboard` : `/assist/${route[action]}`);
      }
      this.pendingText.set(key, scope); this.updateTextControls();
      await post(url, body);
      this.textRefreshProjects.add(project.id);
      if (sameView() && !this.busy && this.canRefreshView()) {
        this.message = '文本任务已提交或完成，请核对任务进度与候选结果。';
        await this.openProject(project.id, true);
      }
    } catch (error) {
      if (sameView()) {
        this.message = (error as Error).message;
        if (!this.busy && this.canRefreshView()) this.render();
      }
    } finally {
      this.pendingText.delete(key); this.updateTextControls();
    }
  }

  private updateLabelRepairControls() {
    for(const button of this.querySelectorAll<HTMLButtonElement>('[data-action="repair-labels"]')) {
      const panel=button.closest<HTMLElement>('[data-label-repair]');
      const key=`${this.project?.id}:${this.episodeId}:${panel?.dataset.segmentId}`;
      button.disabled=this.labelRepairs.has(key);button.textContent=button.disabled?'正在本地修正，可继续其他工作…':'本地生成浮签修正版';
      const recovery=panel?.querySelector<HTMLButtonElement>('[data-action="recover-label-repair"]');
      if(recovery&&panel){recovery.hidden=!localStorage.getItem(`manju-label-repair:${key}:${this.field('repair-video',panel)}`);recovery.disabled=button.disabled;}
    }
  }

  private async handleLabelRepair(button:HTMLElement,resume=false) {
    const project=this.project,episode=this.episode,panel=button.closest<HTMLElement>('[data-label-repair]');
    if(!project||!episode||!panel)return;
    const segmentId=panel.dataset.segmentId!,artifactId=this.field('repair-video',panel),key=`${project.id}:${episode.id}:${segmentId}`;
    if(this.labelRepairs.has(key))return;
    const storageKey=`manju-label-repair:${key}:${artifactId}`,loadId=this.projectLoadId;
    const current=()=>this.project?.id===project.id&&this.episodeId===episode.id&&this.projectLoadId===loadId;
    try {
      const saved=localStorage.getItem(storageKey),pending=saved?JSON.parse(saved) as {requestId:string;payload:{style:ReturnType<typeof readLabelStyle>;cues:ReturnType<typeof readVisibleCues>}}:undefined;
      if(resume&&!pending)throw Error('没有待查询的纠字请求');
      if(!resume&&!panel.querySelector<HTMLInputElement>('[name="repair-confirmed"]')?.checked)throw Error('请先核对正式全文、时窗和覆盖区域并勾选确认');
      const payload=resume&&pending?pending.payload:{style:readLabelStyle(panel),cues:readVisibleCues(panel,true)};
      if(!payload.cues.length)throw Error('请勾选需要修正的正式文字');
      if(pending&&JSON.stringify(pending.payload)!==JSON.stringify(payload)) {
        const updated=await api<Project>(`/api/projects/${project.id}`),completed=updated.episodes.find(e=>e.id===episode.id)?.segments.find(s=>s.id===segmentId)?.artifacts.find(a=>a.labelRepair?.requestId===pending.requestId);
        if(!completed)throw Error('上一次纠字响应未确认；请先用原设置重试查询，或重新进入项目查看已保存版本');
        localStorage.removeItem(storageKey);
      }
      const requestId=pending&&JSON.stringify(pending.payload)===JSON.stringify(payload)?pending.requestId:crypto.randomUUID();
      localStorage.setItem(storageKey,JSON.stringify({requestId,payload}));this.labelRepairs.add(key);this.updateLabelRepairControls();
      const result=await post<{artifactId:string;mediaPath:string}>(`/api/projects/${project.id}/episodes/${episode.id}/segments/${segmentId}/videos/${artifactId}?action=repair-labels`,{...payload,requestId,confirmed:true});
      localStorage.removeItem(storageKey);
      if(current()) {await this.openProject(project.id,true);this.message=`浮签修正版已生成（${result.artifactId.slice(0,8)}），原声已校验；请在视频版本中审片后选用`;this.render();}
      else this.textRefreshProjects.add(project.id);
    } catch(error) {
      if((error as Error&{status?:number}).status===400)localStorage.removeItem(storageKey);
      if(current()){this.message=`浮签修正未完成：${(error as Error).message}`;this.render();}
    } finally {this.labelRepairs.delete(key);this.updateLabelRepairControls();}
  }

  private async handleClick(event: Event) {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if(!button)return;
    if(button.dataset.action==='studio-theme'){setStudioTheme(button.dataset.theme==='light'?'light':'black');return;}
    if(button.dataset.action==='dismiss-notice'){this.dismissNotice();return;}
    if(button.dataset.action==='repair-labels'||button.dataset.action==='recover-label-repair'){await this.handleLabelRepair(button,button.dataset.action==='recover-label-repair');return;}
    if(this.busy){if(button.dataset.action==='toggle-software-update')(button as HTMLInputElement).checked=this.softwareUpdate.enabled;return;}
    const action = button.dataset.action!, episode = this.episode, project = this.project;
    if (this.isTextAction(action)) { await this.handleTextAction(button); return; }
    if(['asset-open','asset-close','asset-search','asset-kind','asset-page','asset-state-page','asset-image-page','asset-candidate-page'].includes(action)&&[...this.querySelectorAll<HTMLInputElement>('[name="asset-image-file"]')].some(input=>input.files?.length)){
      this.querySelector('[data-asset-file-notice]')?.remove();
      this.querySelector('.asset-upload')?.insertAdjacentHTML('beforeend','<p data-asset-file-notice role="alert">已选择参考图，请先导入，再切换资产或分页。</p>');return;
    }
    if(['open-project','project-settings','source-plan','tab','open-episode','open-app-settings','graph-workflow','graph-workflow-close','canvas-view'].includes(action)&&noticeAutoDismissMs(this.message)!==undefined)this.dismissNotice();
    this.projectLoadId++;
    this.busy = true;
    try {
      if(action.startsWith('home-')||action==='rename-project'||action==='rename-save'||action==='rename-cancel'){await this.handleHomeAction(action,button);}
      else if(['asset-open','asset-close','asset-search','asset-kind','asset-page','asset-state-page','asset-image-page','asset-candidate-page'].includes(action)){
        if(action==='asset-open'){this.assetView.assetId=button.dataset.id!;this.assetView.statePage=1;this.assetView.imagePage=1;this.assetView.newStateOpen=false;}
        if(action==='asset-close'){this.assetView.assetId='';if(this.tab==='canvas')this.graphAssetFocusId='';}
        if(action==='asset-search'){this.assetView.query=this.field('asset-search');this.assetView.page=1;}
        if(action==='asset-kind'){this.assetView.kind=button.dataset.kind!;this.assetView.page=1;}
        if(action==='asset-page')this.assetView.page=Number(button.dataset.page);
        if(action==='asset-state-page')this.assetView.statePage=Number(button.dataset.page);
        if(action==='asset-image-page')this.assetView.imagePage=Number(button.dataset.page);
        if(action==='asset-candidate-page')this.assetView.candidatePage=Number(button.dataset.page);
        this.render();
        if(action==='asset-open')this.querySelector('[data-asset-editor]')?.scrollIntoView({block:'start'});
      }
      else if(action==='workflow-start'&&project&&episode){const delivery=this.field('workflow-delivery');await post(`/api/projects/${project.id}/workflows`,{episodeId:episode.id,delivery,limits:Object.fromEntries(['text','image','video'].map(k=>[k,k==='video'&&delivery==='package'?0:Number(this.field('workflow-limit-'+k))]))});this.message='';await this.openProject(project.id);}
      else if(action==='agent-task-control'&&project){
        const taskId=button.dataset.taskId!,operation=button.dataset.operation!;
        if(this.taskControlRequest&&(this.taskControlRequest.taskId!==taskId||this.taskControlRequest.operation!==operation))throw Error('上次控制请求结果未确认，请先刷新进度核对');
        this.taskControlRequest??={taskId,operation,requestId:'ui-task-'+crypto.randomUUID()};
        if(button instanceof HTMLButtonElement){button.disabled=true;button.textContent='正在保存…';}
        const result=await post<{dashboard:AgentDashboard}>(`/api/projects/${project.id}/agent/task/${taskId}/control`,{operation,requestId:this.taskControlRequest.requestId});
        this.taskControlRequest=undefined;this.taskDashboard=result.dashboard;
        this.message=operation==='resume'?'任务已恢复，剩余额度保留。外部 Agent 需继续运行，才能完成内容核验与后续制作。':operation==='pause'?'任务已暂停，后续生成与 Agent 核验已锁住；已提交请求可能继续返回结果。':'任务授权已撤回，已有结果保留。';this.render();
      }
      else if(action==='refresh-agent-dashboard'&&project){this.taskDashboard=await api(`/api/projects/${project.id}/agent/dashboard`);this.taskControlRequest=undefined;this.render();}
      else if(action==='copy-task-context'&&project){
        if(!this.agentEntry)throw Error('接管入口尚未读取，请刷新软件');
        await navigator.clipboard.writeText(`请读取万灵漫剧官方技能：${this.agentEntry.skill}\n本机入口：${this.agentEntry.cli}\n继续项目 ${project.name}，projectId=${project.id}。先读取 dashboard 和最新 context，复用已有结果、任务与工作流。默认每段30秒、每集1–3章；以项目实际规则为准。暂停任务等待我在软件恢复，过期或额度不足时说明缺少的授权，不自动追加生成或重提未知结果。`);
        this.message='已复制当前项目接管说明';this.render();
      }
      else if(action==='workflow-control'&&project){await post(`/api/projects/${project.id}/workflows/${button.dataset.id}/${button.dataset.operation}`,{});this.message='';await this.openProject(project.id);}
      else if(action==='workflow-authorize'&&project){const flow=this.workflows.find(w=>w.id===button.dataset.id);if(!flow||!this.querySelector<HTMLInputElement>('[name="workflow-confirmed"]')?.checked)throw Error('请先核对本步输入、费用和额度并勾选确认');await post(`/api/projects/${project.id}/workflows/${flow.id}/authorize`,{hash:flow.step.hash,confirmed:true,acceptUnknownCost:true,pricingVersion:this.billing?.pricingVersion});this.message='';await this.openProject(project.id);}
      else if(action==='workflow-review'){this.canvasSelectedSegmentId=button.dataset.segmentId||this.canvasSelectedSegmentId;this.graphJobsOpen=false;this.graphWorkflow=button.dataset.tab as Tab|'review';if(this.graphWorkflow==='export')await this.loadPreflight();this.render();}
      else if(action==='account-login'){
        this.accountError='';
        if(button instanceof HTMLButtonElement){button.disabled=true;button.textContent='正在打开木木登录…';}
        const result=await post<{url:string}>('/api/provider-account/connect',{});
        this.accountConnecting=true;
        window.location.assign(result.url);
      }
      else if(action==='account-logout'){await post('/api/provider-account/logout',{});this.accountConnecting=false;this.billing=await api('/api/direct-provider/billing?refresh=1');this.render();}
      else if(action==='refresh-billing'){this.billing=await api('/api/direct-provider/billing?refresh=1');this.billingRefreshedAt=Date.now();this.render();}
      else if(action==='export-review'){this.tab='canvas';this.canvasView='table';this.graphWorkflow=null;this.render();}
      else if(action==='toggle-sidebar'){this.sidebarOpen=!this.sidebarOpen;this.render();}
      else if(action==='new-project-form'){this.sidebarOpen=true;this.render();const form=this.querySelector<HTMLDetailsElement>('.sidebar-disclosure');if(form)form.open=true;this.querySelector<HTMLInputElement>('input[name="project-name"]')?.focus();}
      else if(action==='copy-export-path'){const value=button.dataset.path||'';if(!value)throw Error('没有已保存的导出目录');if(!navigator.clipboard)throw Error('浏览器不支持复制，请选中目录文本复制');await navigator.clipboard.writeText(value);this.message='已复制导出路径，可在资源管理器定位';this.render();}
      else if(action==='candidate-close'){this.candidateLoadId++;this.candidateWorkspace=undefined;this.candidateInputs=[];this.render();}
      else if((action==='candidate-preview'||action==='candidate-retry-preview')&&project&&this.candidateWorkspace){
        if(this.candidateWorkspace.pending||this.candidateWorkspace.uncertain)throw Error('提交结果未明确；先用原确认号查询，不创建新请求');
        const count=action==='candidate-retry-preview'?1:Number(this.field('candidate-count')),feedback=this.field('candidate-feedback'),sourceImageId=this.candidateWorkspace.input.kind==='image'?this.field('candidate-source-image'):undefined;this.candidateInputs=this.candidateInputs.map((input,index)=>({...input,count,feedback,...(input.kind==='image'&&index===0?{sourceImageId:sourceImageId||undefined}:{})}));
        this.candidateWorkspace.input=this.candidateInputs[0];
        this.candidateWorkspace.previews=await Promise.all(this.candidateInputs.map(input=>post<CandidatePreview>(`/api/projects/${project.id}/candidates/preview`,input)));
        this.candidateWorkspace.requestIds=this.candidateInputs.map(()=>crypto.randomUUID());this.candidateWorkspace.confirmed=false;this.candidateWorkspace.submitted=false;this.render();
      }
      else if(action==='candidate-submit'&&project&&this.candidateWorkspace){
        const workspace=this.candidateWorkspace;
        if(!this.querySelector<HTMLInputElement>('[name="candidate-cost-confirmed"]')?.checked)throw new Error('请核对输入、数量与费用未知说明后确认');
        if(Number(this.field('candidate-count'))!==workspace.input.count)throw new Error('数量已修改，请重新查看输入与费用');
        if(this.field('candidate-feedback').trim()!==(workspace.input.feedback||''))throw new Error('视觉偏好已修改，请重新预览确认');
        if(workspace.input.kind==='image'&&this.field('candidate-source-image')!==(workspace.input.sourceImageId||''))throw Error('返修原图已修改，请重新预览确认');
        workspace.confirmed=true;workspace.pending=true;this.render();
        localStorage.setItem('manju-candidate-pending:'+project.id,JSON.stringify({previews:workspace.previews,requestIds:workspace.requestIds}));
        try{for(let i=0;i<workspace.previews.length;i++){const preview=workspace.previews[i];await post(`/api/projects/${project.id}/candidates`,{...preview.input,hash:preview.hash,requestId:workspace.requestIds[i],confirmed:true});}workspace.submitted=true;workspace.uncertain=false;localStorage.removeItem('manju-candidate-pending:'+project.id);this.message='已预约候选，当前选用保持不变。可以关闭面板，进度与结果会保留。';}
        catch(error){workspace.uncertain=true;throw error;}
        finally{workspace.pending=false;this.candidateBatches=await api(`/api/projects/${project.id}/candidates`);this.render();}
      }
      else if(action==='candidate-control'&&project){await post(`/api/projects/${project.id}/candidates/${button.dataset.batchId}/${button.dataset.operation}`,{});this.candidateBatches=await api(`/api/projects/${project.id}/candidates`);this.render();}
      else if(action==='candidate-recover-pending'&&project){const saved=JSON.parse(localStorage.getItem('manju-candidate-pending:'+project.id)||'null') as {previews:CandidatePreview[];requestIds:string[]}|null;if(!saved?.previews?.length||saved.previews.length!==saved.requestIds?.length)throw new Error('没有可恢复的提交记录');const workspace=await this.openCandidates(saved.previews.map(p=>p.input));if(!workspace)return;workspace.previews=saved.previews;workspace.requestIds=saved.requestIds;workspace.uncertain=true;this.message='这是原确认号：查询/重传不会重复创建已预约候选。';this.render();}
      else if(action==='candidate-query-only'&&project){localStorage.removeItem('manju-candidate-pending:'+project.id);if(this.candidateWorkspace){this.candidateWorkspace.uncertain=false;this.candidateWorkspace.previews=[];this.candidateWorkspace.requestIds=[];}this.candidateBatches=await api(`/api/projects/${project.id}/candidates`);this.message='停止重传，只查看服务器已预约批次；可在进度中取消尚未提交的候选。';this.render();}
      else if(action==='candidate-compare'&&this.candidateWorkspace){const ids=this.candidateWorkspace.compareIds,target=button.dataset.id!;this.candidateWorkspace.compareIds=ids.includes(target)?ids.filter(id=>id!==target):[...ids.slice(-2),target];this.render();}
      else if(action==='candidate-use-image'&&project&&this.candidateWorkspace){
        const figure=button.closest('figure')!,[episodeId,segmentId]=this.field('candidate-binding-target',figure).split(':');
        const full=await api<Project>(`/api/projects/${project.id}`),segment=full.episodes.find(e=>e.id===episodeId)?.segments.find(s=>s.id===segmentId),assetId=this.candidateWorkspace.input.assetId!,asset=full.assets?.find(a=>a.id===assetId),image=asset?.images.find(i=>i.id===button.dataset.imageId);
        if(!segment||!image)throw new Error('请选择有效片段和候选图');
        const bindings=structuredClone(segment.assetBindings||[]),binding=bindings.find(b=>b.assetId===assetId)||{assetId};
        if(!bindings.includes(binding))bindings.push(binding);
        binding.stateId=image.stateId||'';binding.imageId=image.id;delete binding.portraitImageId;
        this.candidateWorkspace.input.episodeId=episodeId;this.candidateWorkspace.input.segmentId=segmentId;
        await this.previewAssetChange({type:'segment.assets',episodeId,segmentId,bindings});
      }
      else if(action==='asset-impact-cancel'){this.assetImpact=undefined;this.render();}
      else if(action==='asset-impact-apply'&&project&&this.assetImpact){const impact=this.assetImpact;this.project=await post(`/api/projects/${project.id}/candidates/change`,{action:impact.action,hash:impact.hash});this.assetImpact=undefined;this.message='选用已更新；相关片段需重新核对，不会自动生成。';await this.refreshAudit();this.render();}
      else if(action==='candidate-go-tasks'){this.candidateWorkspace=undefined;this.tab='canvas';this.canvasView='table';this.graphJobsOpen=true;this.render();}
      else if(action==='candidate-go-assets'){this.candidateWorkspace=undefined;if(this.tab==='canvas'){this.graphWorkflow='assets';this.render();}else{this.tab='assets';this.render();}}
      else if((action==='candidate-go-segment'||action==='candidate-review-video')&&this.candidateWorkspace){const input=this.candidateWorkspace.input;this.candidateWorkspace=undefined;this.tab='canvas';this.episodeId=input.episodeId||this.episodeId;this.canvasSelectedSegmentId=input.segmentId||'';this.canvasView='graph';this.graphWorkflow=action==='candidate-review-video'?'review':null;await this.openProject(project!.id);}
      else if(action==='compare-asset'&&project){const card=button.closest<HTMLElement>('[data-asset-id]')!;await this.openCandidates([{kind:'image',assetId:card.dataset.assetId,stateId:this.field('asset-image-state',card),role:this.field('asset-image-role',card),count:1}]);}
      else if(action==='graph-workflow'){this.graphWorkflow=button.dataset.tab as Tab;this.graphAssetFocusId='';if(this.graphWorkflow==='export')await this.loadPreflight();this.render();}
      else if(action==='canvas-edit-asset'){this.graphAssetFocusId=button.dataset.assetId||'';this.graphWorkflow='assets';this.render();}
      else if(action==='canvas-review-video'){this.canvasSelectedSegmentId=button.dataset.segmentId||'';this.graphWorkflow='review';this.render();}
      else if(action==='graph-workflow-close'){this.graphWorkflow=null;this.render();}
      else if(action==='compare-video'&&episode){this.canvasSelectedSegmentId=button.dataset.segmentId||this.canvasSelectedSegmentId;this.canvasSelectedAssetId='';await this.openCandidates([{kind:'video',episodeId:episode.id,segmentId:button.dataset.segmentId,count:1}]);}
      else if(action==='compare-bound-asset'&&episode){this.canvasSelectedSegmentId=button.dataset.segmentId||this.canvasSelectedSegmentId;this.canvasSelectedAssetId=button.dataset.assetId+':'+(button.dataset.role||'main');await this.openCandidates([{kind:'image',assetId:button.dataset.assetId,stateId:button.dataset.stateId,role:button.dataset.role||'main',episodeId:episode.id,segmentId:button.dataset.segmentId,count:1}]);}
      else if (action === 'discard-drafts' && project) {
        this.draftFields.clear(); await this.openProject(project.id);
      } else if (action === 'create-project') {
        const name = this.field('project-name'), mode = this.field('project-mode');
        const created = await post<Project>('/api/projects', { name, mode });
        this.projects = await api('/api/projects'); this.tab = 'settings'; await this.openProject(created.id);
      } else if (action === 'open-project') { this.sidebarOpen=false; this.tab = 'settings'; this.episodeQuery = ''; this.episodePage = 1; await this.openProject(button.dataset.id!); }
      else if (action === 'archive-project' && project) {
        if (!window.confirm(`将项目“${project.name}”移入回收区？之后可以在软件设置中恢复。`)) return;
        await post(`/api/projects/${project.id}/actions`, { type: 'project.archive' });
        this.projects = await api('/api/projects');
        this.project = undefined; this.episodeId = ''; this.tab = 'settings';
        const next = this.projects.find(item => !item.archivedAt);
        if (next) await this.openProject(next.id); else { this.tab = 'provider'; this.render(); }
        this.message = `项目“${project.name}”已移入回收区，可在软件设置中恢复。`; this.render();
      }
      else if (action === 'restore-project') {
        await post(`/api/projects/${button.dataset.id}/actions`, { type: 'project.restore' });
        this.projects = await api('/api/projects'); this.tab = 'settings'; await this.openProject(button.dataset.id!);
        this.message = '项目已恢复。'; this.render();
      }
      else if (action === 'project-settings') {
        this.tab = 'settings'; this.render();
      }
      else if (action === 'project-model-settings') {
        this.projectModelsOpen = true; this.tab = 'settings'; this.render();
      }
      else if (action === 'open-app-settings') { this.sidebarOpen=false; this.tab = 'provider'; this.render(); }
      else if(action==='backup-storage') {
        const result=await post<{directory:string}>('/api/storage/backup',{withMedia:this.querySelector<HTMLInputElement>('[name="backup-media"]')?.checked===true});
        this.backups=await api('/api/storage/backups');this.message=`备份完成：${result.directory}`;this.render();
      } else if(action==='restore-storage') {
        const result=await post<{directory:string;message:string}>('/api/storage/restore',{id:button.dataset.backupId});
        this.message=`${result.message} 新目录：${result.directory}`;this.render();
      }
      else if (action === 'open-style-picker') { this.settingsStylePickerOpen = true; this.render(); }
      else if (action === 'close-style-picker') { this.settingsStylePickerOpen = false; this.render(); }
      else if (action === 'open-model-kind') {
        this.settingsModelKind = button.dataset.kind as 'text' | 'image' | 'video';
        this.settingsModelsOpen = true; this.render();
      }
      else if (action === 'close-model-kind') { this.settingsModelsOpen = false; this.render(); }
      else if (action === 'go-next') { this.tab = button.dataset.tab as Tab;
        if (this.tab === 'export') await this.loadPreflight(); this.render(); }
      else if (action === 'continue-production' && project && episode) {
        const operation = button.dataset.operation;
        if (operation === 'resume') await post(`/api/projects/${project.id}/jobs/resume`, {});
        else if (operation === 'retry') await post(`/api/projects/${project.id}/jobs/retry`, {});
        else if (operation === 'prompts') {
          const ids = episode.segments.filter(item => {
            const readiness=promptReadiness(episode,item,project);
            return readiness.state!=='ready'&&readiness.state!=='candidate';
          }).map(item => item.id);
          if(ids.length)await post(`/api/projects/${project.id}/jobs`, { episodeId: episode.id, segmentIds: ids, kinds: ['prompt'] });
        }
        this.jobs = await api(`/api/projects/${project.id}/jobs`);
        this.message = '已接续可安全恢复的任务。'; this.render();
      }
      else if (action === 'source-plan') { this.tab = 'sourcePlan'; await this.openProject(project!.id); }
      else if (action === 'episode-search') { this.episodeQuery = this.field('episode-search').trim(); this.episodePage = 1; this.render(); this.focusEpisodes(); }
      else if (action === 'episode-page') { this.episodePage = Number(button.dataset.page) || 1; this.render(); this.focusEpisodes(); }
      else if (action === 'archive-episode' && episode) {
        await this.act({ type: 'episode.archive', episodeId: episode.id });
        this.episodeId = this.project!.episodes[0]?.id || '';
        this.tab = 'episodes';
        await this.refreshAudit(); this.message = `分集“${episode.title}”已移入回收区，可在项目分集页恢复。`; this.render(); this.focusEpisodes();
      }
      else if (action === 'restore-episode' && project) {
        await this.act({ type: 'episode.restore', episodeId: button.dataset.id });
        this.episodeId = button.dataset.id!; this.tab = 'episodes'; await this.refreshAudit();
        this.message = '分集已恢复。'; this.render(); this.focusEpisodes();
      }
      else if (action === 'add-episodes') {
        await this.act({ type: 'episode.addMany', count: Number(this.field('episode-count')) });
        this.episodeId = this.project!.episodes.at(-1)!.id; this.tab = 'episodes'; this.episodePage = Math.ceil(this.project!.episodes.length / 20); this.render(); this.focusEpisodes();
      }
      else if (action === 'open-episode') { this.episodeId = button.dataset.id!; this.tab = 'canvas'; this.canvasView='graph'; this.graphWorkflow=null; this.checked.clear(); this.canvasSelectedSegmentId = '';  this.videoFilter = 'all'; this.graphInspectorOpen = false;this.graphOffset={x:48,y:56};this.canvasZoom=1;this.canvasSelectedAssetId='';try{const v=JSON.parse(localStorage.getItem('manju-viewport:'+project!.id+':'+this.episodeId)||'{}');if(Number.isFinite(v.offset?.x)&&Number.isFinite(v.offset?.y)&&Number.isFinite(v.zoom)){this.graphOffset=v.offset;this.canvasZoom=Math.max(.1,Math.min(2.5,v.zoom));this.canvasSelectedSegmentId=v.segmentId||'';this.canvasSelectedAssetId=v.assetId||'';}}catch{} await this.openProject(project!.id); }
      else if (action === 'tab') { this.tab = button.dataset.tab as Tab; if (this.tab === 'effects') { await this.loadEffects(); await this.loadSuggestions(); }
        if(this.tab==='assets')await this.loadAssetCandidate();
        if(this.tab==='tasks'){this.taskDashboard=await api(`/api/projects/${project!.id}/agent/dashboard`);}
        if (this.tab === 'export') await this.loadPreflight(); this.render();
        if (this.tab === 'episodes') this.focusEpisodes(); }
      else if (action === 'canvas-select-segment' && episode) {
        const fromOverview = Boolean(button.closest('.graph-overview'));
        this.canvasSelectedSegmentId = button.dataset.segmentId || episode.segments[0]?.id || '';
        if (this.canvasView === 'graph' && !this.graphReviewMode) this.graphInspectorOpen = true;
        if (button.closest('.graph-shot')) { this.graphReviewMode = null; this.graphInspectorOpen = true; }
        this.render();
        const viewport = this.querySelector<HTMLElement>('.canvas-viewport');
        const track = this.querySelector<HTMLElement>(`.canvas-track[data-segment-id="${this.canvasSelectedSegmentId}"]`);
        if (viewport && track) viewport.scrollTop = Math.max(0, track.offsetTop - viewport.offsetTop - 80);
        if (fromOverview) this.centerGraphOnSegment(this.canvasSelectedSegmentId);
      }
      else if (action === 'canvas-zoom') {
        const value = button.dataset.zoomStep ? this.canvasZoom + Number(button.dataset.zoomStep) : Number(button.dataset.zoom) || 1;
        if (this.canvasView === 'graph') this.graphZoomTo(value);
        else { this.canvasZoom = value; this.render(); }
      }
      else if (action === 'graph-home') { this.graphOffset = { x: 48, y: 56 }; this.canvasZoom = 1; this.applyGraphTransform(); }
      else if (action === 'graph-fit') { this.fitGraph(false); }
      else if (action === 'graph-focus') { this.fitGraph(true); }
      else if (action === 'graph-video-preview') {
        const player=button.closest('.graph-video')?.querySelector('video');
        if(!player?.getAttribute('src'))throw Error('当前节点没有可播放的成片');
        const dialog=document.createElement('dialog');dialog.className='media-preview-dialog';
        const title=document.createElement('p');title.textContent='原文件大窗预览 · 放大不改变源视频分辨率';
        const close=document.createElement('button');close.textContent='关闭';close.addEventListener('click',()=>dialog.close());
        const video=document.createElement('video');video.controls=true;video.preload='metadata';video.src=player.getAttribute('src')!;
        video.addEventListener('loadedmetadata',()=>{video.currentTime=player.currentTime;title.textContent=`原文件 ${video.videoWidth}×${video.videoHeight} · 放大不改变源分辨率`;},{once:true});
        dialog.addEventListener('close',()=>{video.pause();dialog.remove();});dialog.append(close,title,video);this.append(dialog);dialog.showModal();
      }
      else if (action === 'graph-jobs') { this.graphJobsOpen = !this.graphJobsOpen; this.render(); }
      else if (action === 'canvas-view') {
        this.canvasView = button.dataset.view === 'table' ? 'table' : 'graph';
        this.graphPending = undefined;
        this.render();
      }
      else if (action === 'video-filter') {
        this.videoFilter = (button.dataset.filter || 'all') as VideoCategory | 'all';
        this.canvasView = 'table';
        this.graphPending = undefined;
        this.render();
      }
      else if (action === 'graph-reset-layout' && episode && project) {
        localStorage.removeItem(this.graphLayoutKey(project.id, episode.id));
        this.render();
      }
      else if (action === 'graph-toggle-detail') {
        this.graphReviewMode = null;
        this.graphInspectorOpen = !this.graphInspectorOpen;
        this.render();
      }
      else if (action === 'graph-review-references' || action === 'graph-review-anchors') {
        if (button.dataset.segmentId) this.canvasSelectedSegmentId = button.dataset.segmentId;
        this.graphReviewMode = action === 'graph-review-references' ? 'references' : 'anchors';
        this.graphInspectorOpen = false;
        this.graphLightbox = undefined;
        this.render();
      }
      else if (action === 'graph-review-close') { this.graphReviewMode = null; this.graphLightbox = undefined; this.render(); }
      else if (action === 'graph-lightbox') {
        this.graphLightbox = { src: button.dataset.media || '', label: button.dataset.label || '参考图' };
        this.render();
      }
      else if (action === 'graph-lightbox-close') { this.graphLightbox = undefined; this.render(); }
      else if (action === 'graph-port' && episode && project) {
        if (Date.now() < this.graphIgnorePortClickUntil) return;
        const stage = button.dataset.stage as 'shot' | 'video';
        const segmentId = button.dataset.segmentId!;
        if (button.dataset.direction === 'out') {
          if (stage !== 'shot') throw new Error('请先选择片段输出端口');
          this.graphPending = { stage: 'shot', segmentId, nodeId: button.dataset.nodeId! };
          this.render();
        } else {
          const pending = this.graphPending;
          if (!pending || pending.segmentId !== segmentId || stage !== 'video')
            throw new Error('请先点本片段的输出端口，再点同一排视频版本的输入端口');
          await this.connectGraphVersion(segmentId, button.dataset.artifactId!);
        }
      }
      else if (action === 'graph-generate' && episode && project) {
        const segmentId = button.dataset.segmentId!, kind = button.dataset.kind!;
        if(kind==='video'){await this.openCandidates([{kind:'video',episodeId:episode.id,segmentId,count:1}]);return;}
        const segment = episode.segments.find(item => item.id === segmentId);
        await post(`/api/projects/${project.id}/jobs`, { episodeId: episode.id, segmentIds: [segmentId], kinds: [kind],
          regenerate: kind === 'video' && Boolean(segment?.artifacts.some(item => item.kind === 'video')) });
        this.graphPending = undefined;
        await this.openProject(project.id);
        this.message = `片段 ${episode.segments.find(item => item.id === segmentId)?.number} 已提交${({anchor:'锚点板',prompt:'提示词',video:'视频'} as Record<string,string>)[kind]}新版本。`;
        this.render();
      }
      else if (action === 'select-style') {
        const preset = stylePresets.find(item => item.id === button.dataset.id);
        if (!preset) throw new Error('风格预设不存在');
        (this.querySelector('[name="style-preset-id"]') as HTMLInputElement).value = preset.id;
        (this.querySelector('[name="style-name"]') as HTMLInputElement).value = preset.name;
        (this.querySelector('[name="style-description"]') as HTMLTextAreaElement).value = preset.description;
        this.querySelectorAll('.style-card').forEach(card => card.classList.toggle('selected', card.getAttribute('data-id') === preset.id));
      }
      else if (action === 'save-style' && project) {
        const styleAction = { type: 'project.style', presetId: this.field('style-preset-id'), name: this.field('style-name'), description: this.field('style-description') };
        try { await this.act(styleAction); }
        catch (error) {
          // A catalog update can reach the browser while the server is still running jobs.
          // Older servers already accept the same visual requirements as a custom style.
          if (!(error instanceof Error) || error.message !== '未知 3D 风格预设') throw error;
          await this.act({ ...styleAction, presetId: '' });
        }
        this.settingsStylePickerOpen = false;
        this.message = '项目风格已保存。若此前已生成片段，请重新生成提示词并完成核对；建议锚点板可按需重做。'; this.render();
      } else if (action === 'save-aspect' && project) {
        await this.act({ type: 'project.aspectRatio', aspectRatio: this.field('project-aspect') });
      } else if (action === 'add-asset' && project) {
        await this.act({ type: 'asset.add', kind: this.field('new-asset-kind'), name: this.field('new-asset-name'),
          identity: this.field('new-asset-identity'), voice: this.field('new-asset-voice') });
      } else if (action === 'save-asset' && project) {
        const card = button.closest<HTMLElement>('[data-asset-id]')!;
        await this.previewAssetChange({ type: 'asset.update', assetId: card.dataset.assetId, name: this.field('asset-name', card),
          identity: this.field('asset-identity', card), voice: this.field('asset-voice', card) });
      } else if ((action === 'add-asset-state' || action === 'save-asset-state') && project) {
        const card = button.closest<HTMLElement>('[data-asset-id]')!;
        const form = button.closest<HTMLElement>('[data-state-form]')!;
        const [startEpisode, startSegment] = this.field('state-start', form).split(':').map(Number);
        await this.previewAssetChange({ type: 'asset.state', assetId: card.dataset.assetId,
          ...(form.dataset.stateId ? { stateId: form.dataset.stateId } : {}),
          label: this.field('state-label', form), appearance: this.field('state-appearance', form),
          trigger: this.field('state-trigger', form), startEpisode, startSegment });
      } else if (action === 'upload-asset-image' && project) {
        const card = button.closest<HTMLElement>('[data-asset-id]')!;
        const file = card.querySelector<HTMLInputElement>('[name="asset-image-file"]')?.files?.[0];
        if (!file) throw new Error('先选择参考图');
        const stateId = this.field('asset-image-state', card);
        const role = this.field('asset-image-role', card);
        await this.upload(file, `/api/projects/${project.id}/assets/${card.dataset.assetId}/images?stateId=${encodeURIComponent(stateId)}&role=${encodeURIComponent(role)}`);
        await this.openProject(project.id);
      } else if (action === 'generate-asset-image' && project) {
        const card = button.closest<HTMLElement>('[data-asset-id]')!;
        await this.openCandidates([{kind:'image',assetId:card.dataset.assetId,stateId:this.field('asset-image-state',card),role:this.field('asset-image-role',card),count:1}]);
      } else if(action==='repair-asset-image'&&project){
        const card=button.closest<HTMLElement>('[data-asset-id]')!,image=project.assets?.find(a=>a.id===card.dataset.assetId)?.images.find(i=>i.id===button.closest<HTMLElement>('[data-image-id]')?.dataset.imageId);
        if(!image)throw Error('原图不存在');
        await this.openCandidates([{kind:'image',assetId:card.dataset.assetId,stateId:image.stateId||'',role:requiresPortraitReference(project.assets!.find(a=>a.id===card.dataset.assetId)!)?'turnaround':'main',sourceImageId:image.id,count:1}]);
      } else if (action === 'apply-asset-candidate' && project) {
        await this.act({ type: 'episode.applyAssetCandidate', episodeId: button.dataset.episodeId });
        this.message = '已合并建议并保留原有参考图；请核对每个状态，再补齐图片。'; this.render();
      } else if (action === 'asset-image-review' && project) {
        const card = button.closest<HTMLElement>('[data-asset-id]')!;
        const figure = button.closest<HTMLElement>('[data-image-id]')!;
        const reviewedImage=project.assets?.find(a=>a.id===card.dataset.assetId)?.images.find(i=>i.id===figure.dataset.imageId);
        const approving=button.dataset.status==='approved';
        if(approving&&reviewedImage?.role==='turnaround'&&!isCharacterSheet(reviewedImage)&&
          !figure.querySelector<HTMLInputElement>('input[name="asset-review-layout"]')?.checked)
          throw Error('请先核对整张原图确实包含正面、侧面、背面及大头照，再确认完整四视图布局');
        await this.act({ type: 'asset.imageReview', assetId: card.dataset.assetId, imageId: figure.dataset.imageId,
          ...(approving&&reviewedImage?.role==='turnaround'?{layout:'three-view-portrait'}:{}),
          status: button.dataset.status, checks: Object.fromEntries([...figure.querySelectorAll<HTMLInputElement>('input[name="asset-review-check"]')].map(item => [item.value, item.checked])) });
      } else if (action === 'use-project-default-model' && project) {
        const projectId = button.dataset.projectId, kind = button.dataset.modelKind, loadId = this.projectLoadId;
        if (projectId !== project.id || !kind || !['text','image','video'].includes(kind)) throw Error('请刷新后核对当前项目和模型');
        await post(`/api/projects/${projectId}/models/${kind}/default`, {
          expectedModelHash: button.dataset.modelHash, expectedDefaultModelHash: button.dataset.defaultModelHash });
        if (this.project?.id !== projectId || this.projectLoadId !== loadId) return;
        await this.openProject(projectId);
        this.message = `本项目${({text:'文本',image:'图片',video:'视频'})[kind as 'text'|'image'|'video']}模型已切换为 ${this.project?.[`${kind as 'text'|'image'|'video'}Model`]?.modelId}。`;
        this.render();
      } else if (action === 'save-model' && project) {
        const card = button.closest<HTMLElement>('[data-model-kind]')!;
        await this.act({ type: 'project.model', kind: card.dataset.modelKind,
          name: this.field('model-name', card), modelId: this.field('model-id', card),
          adapterPath: this.field('model-adapter', card),
          declaredCapabilities: this.directModels.find(item=>item.id===this.field('model-id',card))?.declaredCapabilities,
          catalogFetchedAt: this.directModelsFetchedAt,
          ...(card.dataset.modelKind === 'video' ? { capabilities: {
            maxDurationSec: this.field('model-max-duration', card),
            minDurationSec: this.field('model-min-duration', card), outputResolution: this.field('model-output-resolution', card),
            fixedDurationSec: this.field('model-fixed-duration', card),
            maxReferences: this.field('model-max-references', card),
            maxPromptChars: this.field('model-max-prompt', card),
            nativeAudio: this.field('model-native-audio', card) === 'unknown' ? null :
              this.field('model-native-audio', card) === 'yes',
            aspectRatios: this.field('model-aspects', card).split(/[,，\s]+/).filter(Boolean),
            resolutions: this.field('model-resolutions',card).split(/[,，\s]+/).filter(Boolean),
            referenceVideo: this.field('model-referenceVideo',card)==='unknown' ? null : this.field('model-referenceVideo',card)==='yes',
            referenceAudio: this.field('model-referenceAudio',card)==='unknown' ? null : this.field('model-referenceAudio',card)==='yes',
          } } : {}) });
        this.message = '模型配置已保存。请测试适配器连接；正式生成仍需按剧情与素材逐步核对。'; this.render();
      } else if (action === 'connect-mumu' && project) {
        await post(`/api/projects/${project.id}/mumu/connect`, {});
        this.mumu = await api('/api/mumu');
        await this.openProject(project.id);
        this.message = '已接入木木工坊当前启用的文本、图片和视频模型；请逐项测试连接。'; this.render();
      } else if (action === 'save-direct-provider') {
        this.directProvider = await post('/api/direct-provider', { apiKey: this.field('direct-api-key') });
        this.billing=await api<ProviderBilling>('/api/direct-provider/billing?refresh=1').catch(()=>undefined);
        try {
          const result = await api<{ fetchedAt: string; models: DirectCatalogModel[] }>('/api/direct-provider/models');
          this.directModels = result.models; this.directModelsFetchedAt = result.fetchedAt;
          this.message = `API Key 已保存；实时读取到 ${result.models.length} 个模型。请设置文本、图片和视频的默认模型。`;
        } catch (error) {
          this.directModels = []; this.directModelsFetchedAt = '';this.directModelsError=error instanceof Error?error.message:String(error);
          this.message = `API Key 已保存，但读取模型目录失败：${error instanceof Error ? error.message : String(error)}`;
        }
        this.settingsModelsOpen = true; this.settingsModelKind = 'text'; this.render();
      } else if (action === 'agent-settings') {
        this.tab = 'provider'; this.render(); this.querySelector('#agent-setup')?.scrollIntoView({block:'start'});
      } else if (action === 'download-agent-skill') {
        const client = this.field('agent-client');
        const link = document.createElement('a'); link.href = `/api/agent/skill?client=${encodeURIComponent(client)}`;
        link.download = `wanling-manju-${client}-skill.zip`; link.click();
      } else if(action==='download-tutorial'){
        const link=document.createElement('a');link.href='/api/agent/tutorial';link.download='万灵漫剧-新手教程.md';link.click();
      } else if (action === 'copy-agent-entry') {
        if (!this.agentEntry) throw Error('接管入口尚未读取，请刷新软件');
        await navigator.clipboard.writeText(`请读取万灵漫剧官方技能：${this.agentEntry.skill}\n使用本机入口：${this.agentEntry.cli}\n按项目默认规则制作：每段30秒、每集${this.productionDefaults.minChapters}–${this.productionDefaults.maxChapters}章，完整保留原文剧情与声音内容。请先读取现有进度，再按我提供的小说、集数、交付目标和本次额度继续。`);
        this.message = '接管说明已复制，可连同小说和本次要求发给 Agent。'; this.render();
      } else if (action === 'download-upscale') {
        this.upscaleError='';
        try{this.upscaleSettings=await post('/api/upscale/setup',{});this.health=await api('/api/health');}
        catch(error){this.upscaleError=(error as Error).message;}
        this.updateUpscaleControls();
      } else if (action === 'save-upscale-settings') {
        const field=this.querySelector('[name="upscale-tool-directory"]') as HTMLInputElement;
        const toolDirectory=field.value,key=this.draftKey(field);
        this.upscaleChecking=true;this.upscaleError='';this.render();
        try {this.upscaleSettings=await post('/api/upscale/settings',{toolDirectory});this.draftFields.delete(key);this.health=await api('/api/health');}
        catch(error){this.upscaleError=(error as Error).message;}
        finally {this.upscaleChecking=false;this.render();}
      } else if (action === 'save-production-rules') {
        this.productionDefaults = await post('/api/production-defaults', {segmentDurationSec:30,
          minChapters:Number(this.field('rule-min-chapters')),maxChapters:Number(this.field('rule-max-chapters')),
          chapterStrategy:this.field('rule-chapter-strategy'),fixedChapters:Number(this.field('rule-fixed-chapters')),
          delivery:this.field('rule-delivery')});
        this.message = '默认制作规则已保存，新项目会自动使用。'; this.render();
      } else if(action==='check-software-update'){
        this.softwareUpdate=await post('/api/software-update/check',{});this.refreshUpdateControls();
      } else if(action==='toggle-software-update'){
        const checkbox=this.querySelector<HTMLInputElement>('[name="software-auto-update"]')!,enabled=checkbox.checked;
        this.updateSettingsSaving=true;this.updateSettingsRevision++;checkbox.disabled=true;
        try{this.softwareUpdate=await post('/api/software-update/settings',{enabled});this.draftFields.delete(this.draftKey(checkbox));}
        finally{this.updateSettingsSaving=false;this.refreshUpdateControls();}
      } else if (action === 'save-global-model') {
        const kind = this.settingsModelKind;
        const field = this.querySelector<HTMLInputElement>('[name="global-model-id"]');
        this.globalModels = await post('/api/direct-provider/defaults', { kind, modelId: this.field('global-model-id') });
        if (field) this.draftFields.delete(this.draftKey(field));
        this.agentEntry = await api<typeof this.agentEntry>('/api/agent').catch(() => this.agentEntry ? { ...this.agentEntry, readiness: undefined } : undefined);
        this.settingsModelsOpen = false;
        this.message = `默认${({text:'文本',image:'图片',video:'视频'})[kind]}模型已保存，新项目会自动使用。${this.project ? `当前项目仍使用 ${this.project[`${kind}Model`]?.modelId || '原配置'}，可在项目模型设置中切换。` : ''}`;
        this.render();
      } else if (action === 'refresh-direct-models') {
        const result = await api<{ fetchedAt: string; models: DirectCatalogModel[] }>('/api/direct-provider/models');
        this.directModels = result.models; this.directModelsFetchedAt = result.fetchedAt;
        this.message = `实时读取到 ${result.models.length} 个模型。`; this.render();
      } else if (action === 'connect-direct' && project) {
        await post(`/api/projects/${project.id}/direct-provider/connect`, {});
        await this.openProject(project.id);
        this.message = '已切换为新软件直连模型接口，不需要运行木木工坊。请逐项测试连接。'; this.render();
      } else if (action === 'test-model' && project) {
        const card = button.closest<HTMLElement>('[data-model-kind]')!;
        const result = await post<{ detail: string }>(`/api/projects/${project.id}/models/${card.dataset.modelKind}/test`, {});
        await this.openProject(project.id);
        this.message = result.detail; this.render();
      }
      else if (action === 'download-corpus') {
        const url = URL.createObjectURL(new Blob([this.field('project-source')], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `${project?.name || '完整原文'}.txt`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      else if (action === 'save-corpus' && project) {
        const field = this.querySelector<HTMLTextAreaElement>('[name="project-source"]')!;
        const sourceText = field.value, key = this.draftKey(field);
        this.draftFields.set(key, { value: sourceText, checked: false });
        if (sourceText.length > MAX_SOURCE_CHARACTERS) throw new Error('原文超过单次 700 万字符限制，请先下载全文备份，再按原文连续分卷建立项目。');
        this.sourceSaving = true; this.message = ''; this.render();
        // A committed local save must not depend on a subsequent audit request.
        this.project = await post(`/api/projects/${project.id}/actions`, { type: 'project.source', sourceText });
        this.draftFields.delete(key);
        this.message = `已保存完整原文，共 ${sourceText.length.toLocaleString()} 字符。`;
      }
      else if (action === 'preview-plan' && project) {
        if (this.field('project-source') !== (project.sourceCorpus || '')) throw new Error('原文有未保存的改动，请先保存完整原文');
        await this.act({ type: 'project.plan', chaptersPerEpisode: Number(this.field('chapters-per-episode')) });
      }
      else if (action === 'apply-plan' && project) {
        if (this.field('project-source') !== (project.sourceCorpus || '') ||
            (project.episodePlan?.method !== 'story' &&
              Number(this.field('chapters-per-episode')) !== project.episodePlan?.chaptersPerEpisode))
          throw new Error('原文或每集章节数已改变，请先保存并重新预览');
        await this.act({ type: 'project.createEpisodes' });
        this.episodeId = this.project!.episodes[0].id; this.tab = 'episodes'; this.render(); this.focusEpisodes();
      }
      else if (action === 'save-source' && episode) await this.act({ type: 'episode.update', episodeId: episode.id, sourceText: this.field('source-text') });
      else if (action === 'confirm-source' && episode) await this.act({ type: 'episode.confirmSource', episodeId: episode.id });
      else if (action === 'apply-highlight' && episode) await this.act({ type: 'episode.applyHighlightCandidate', episodeId: episode.id });
      else if (action === 'save-report' && episode) await this.act({ type: 'episode.update', episodeId: episode.id, highlightReport: this.field('highlight-report') });
      else if (action === 'confirm-report' && episode) await this.act({ type: 'episode.confirmHighlight', episodeId: episode.id });
      else if (action === 'add-beat' && episode) await this.act({ type: 'beat.add', episodeId: episode.id });
      else if (action === 'apply-script' && episode) await this.act({ type: 'episode.applyScriptCandidate', episodeId: episode.id });
      else if (action === 'save-beat' && episode) {
        const card = button.closest<HTMLElement>('[data-beat-id]')!;
        await this.act({ type: 'beat.update', episodeId: episode.id, beatId: card.dataset.beatId,
          sourceQuote: this.field('sourceQuote', card), event: this.field('event', card), reaction: this.field('reaction', card), dialogue: splitLines(this.field('dialogue', card)),
          os: splitLines(this.field('os', card)), floatLabels: splitLines(this.field('floatLabels', card)),
          systemPanels: splitLines(this.field('systemPanels', card)),
          speechOrder: splitLines(this.field('speechOrder',card)).map(line => {
            const match = /^(dialogue|os):(\d+)$/.exec(line.trim());
            if (!match) throw new Error('声音顺序填写 dialogue:1 或 os:1，每行一条');
            return {kind: match[1], index: Number(match[2])-1};
          }) });
      } else if (action === 'delete-beat' && episode) await this.act({ type: 'beat.delete', episodeId: episode.id, beatId: button.closest<HTMLElement>('[data-beat-id]')!.dataset.beatId });
      else if (action === 'lock-script' && episode) await this.act({ type: 'script.lock', episodeId: episode.id });
      else if (action === 'review-story' && episode) {
        const entries = [...this.querySelectorAll<HTMLElement>('[data-story-review-beat]')].map(row => ({
          beatId: row.dataset.storyReviewBeat, sourceStart: Number(this.field('source-start',row)), sourceEnd: Number(this.field('source-end',row)),
          notes: this.field('story-notes',row), highlightIds:[...row.querySelectorAll<HTMLInputElement>('[name="highlight-ref"]:checked')].map(input=>input.value), checks: Object.fromEntries([...row.querySelectorAll<HTMLInputElement>('[name="story-check"]')].map(input => [input.value,input.checked])) }));
        await this.act({ type: 'episode.storyReview', episodeId: episode.id, entries });
      } else if (action === 'review-continuity' && episode) {
        await this.act({type:'episode.continuityReview',episodeId:episode.id,entries:[...this.querySelectorAll<HTMLElement>('[data-boundary-left]')].map(row=>({left:row.dataset.boundaryLeft,right:row.dataset.boundaryRight,notes:this.field('boundary-notes',row),checks:Object.fromEntries([...row.querySelectorAll<HTMLInputElement>('[name="boundary-check"]')].map(input=>[input.value,input.checked]))}))});
      } else if(action==='apply-segment-candidate' && episode) {
        await this.act({type:'episode.applySegmentCandidate',episodeId:episode.id});
      } else if (action === 'apply-segment-plan' && episode) {
        const units = storyUnits(episode);
        const groups = splitLines(this.field('segment-plan')).map(line => line.split(/[,，\s]+/u).filter(Boolean).map(value => {
          const unit = units[Number(value)-1]; if (!unit || !Number.isInteger(Number(value))) throw new Error('剧情单元序号无效'); return unit.id;
        }));
        await this.act({ type: 'episode.segmentPlan', episodeId: episode.id, groups });
      }
      else if (action === 'new-script-version' && episode) {
        await this.act({ type: 'script.newVersion', episodeId: episode.id });
        this.checked.clear(); this.message = '旧版已归档。请修改剧本并重新锁定，新版片段需重新生成和核对。'; this.render();
      }
      else if (action === 'save-segment' && episode) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        await this.act({ type: 'segment.update', episodeId: episode.id, segmentId: row.dataset.segmentId,
          visualPlan: this.field('visualPlan', row), durationSec: Number(this.field('durationSec', row)),
          action: (row.querySelector('[name="action"]') as HTMLInputElement).checked,
          speedOverride: this.field('speedOverride', row) ? Number(this.field('speedOverride', row)) : null,
          anchorPlan: { fromX: Number(this.field('fromX', row)), toX: Number(this.field('toX', row)), level: this.field('level', row) } });
      } else if (action === 'save-segment-assets' && episode) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        const bindings = [...row.querySelectorAll<HTMLElement>('[data-binding-asset-id]')]
          .filter(item => item.querySelector<HTMLInputElement>('[name="binding-enabled"]')?.checked)
          .map(item => {
            const assetId=item.dataset.bindingAssetId!,stateId=this.field('binding-state',item),imageId=this.field('binding-image',item);
            const old=episode.segments.find(s=>s.id===row.dataset.segmentId)?.assetBindings?.find(b=>b.assetId===assetId);
            const image=project?.assets?.find(a=>a.id===assetId)?.images.find(i=>i.id===imageId);
            const unchanged=old?.imageId===imageId&&(old?.stateId||'')===stateId&&!isCharacterSheet(image);
            return {assetId,stateId,imageId,...(unchanged&&old?.portraitImageId?{portraitImageId:old.portraitImageId}:{})};
          });
        await this.previewAssetChange({ type: 'segment.assets', episodeId: episode.id, segmentId: row.dataset.segmentId, bindings });
      } else if (action === 'add-subshot' && episode) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        await this.act({ type: 'segment.subshot.add', episodeId: episode.id, segmentId: row.dataset.segmentId });
      } else if (action === 'delete-subshot' && episode) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        await this.act({ type: 'segment.subshot.delete', episodeId: episode.id, segmentId: row.dataset.segmentId,
          subshotId: button.closest<HTMLElement>('[data-subshot-id]')!.dataset.subshotId });
      } else if (action === 'save-subshot' && episode) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        const shot = button.closest<HTMLElement>('[data-subshot-id]')!;
        const refs = (name: string) => this.field(name, shot).split(/[,，\s]+/).filter(Boolean).map(item => Number(item) - 1);
        await this.act({ type: 'segment.subshot.update', episodeId: episode.id, segmentId: row.dataset.segmentId,
          subshotId: shot.dataset.subshotId, startSec: Number(this.field('shot-start', shot)),
          endSec: Number(this.field('shot-end', shot)), framing: this.field('shot-framing', shot),
          sceneAction: this.field('shot-action', shot), evidence: this.field('shot-evidence', shot),
          location: this.field('shot-location', shot), priorState: this.field('shot-prior', shot),
          result: this.field('shot-result', shot), endFrame: this.field('shot-end-frame', shot),
          assetIds: [...shot.querySelectorAll<HTMLInputElement>('input[name="shot-asset"]:checked')].map(item => item.value),
          lineRefs: { dialogue: refs('shot-dialogue'), os: refs('shot-os'),
            floatLabels: refs('shot-labels'), systemPanels: refs('shot-panels') } });
      } else if (action === 'approve-subshots' && episode) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        await this.act({ type: 'segment.subshots.approve', episodeId: episode.id,
          segmentId: row.dataset.segmentId });
      } else if (action === 'apply-subshot-candidate' && episode) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        await this.act({ type: 'segment.subshots.applyCandidate', episodeId: episode.id,
          segmentId: row.dataset.segmentId });
      } else if (action === 'select-artifact' && episode) {
        await this.act({ type: 'segment.select', episodeId: episode.id, segmentId: button.dataset.segmentId,
          kind: button.dataset.kind, artifactId: button.dataset.artifactId });
      } else if (action === 'prompt-manager-open' && episode && project) {
        if(episode.segments.some(s=>s.id===button.dataset.segmentId))this.canvasSelectedSegmentId=button.dataset.segmentId!;
        this.promptManagerScope=`${project.id}:${episode.id}`;this.graphWorkflow=null;this.render();
        this.querySelector<HTMLButtonElement>('[data-action="prompt-manager-close"]')?.focus();
      } else if (action === 'prompt-manager-close') {
        this.promptManagerScope='';this.render();this.querySelector<HTMLButtonElement>('[data-action="prompt-manager-open"]')?.focus();
      } else if (action === 'prompt-editor-switch' && episode) {
        this.canvasSelectedSegmentId=this.field('prompt-editor-segment');this.render();
      } else if (['prompt-check-unused','prompt-check-active','prompt-check-none'].includes(action)) {
        this.querySelectorAll<HTMLInputElement>('[data-prompt-choice]').forEach(input=>{
          input.checked=action==='prompt-check-active'?input.dataset.stopped==='false':action==='prompt-check-unused'?input.dataset.stopped==='false'&&input.dataset.selected==='false':false;
          this.draftFields.set(this.draftKey(input),{value:input.value,checked:input.checked});
        });
      } else if (action === 'prompt-write-new' && episode) {
        const segment=episode.segments.find(s=>s.id===button.dataset.segmentId)!;
        const editor=this.querySelector<HTMLTextAreaElement>('[data-prompt-replacement]')!,draftKey=this.draftKey(editor);
        const content=this.field(`prompt-replacement-${segment.id}`),archivePrevious=this.querySelector<HTMLInputElement>('[data-prompt-write-archive]')?.checked===true;
        await this.act({type:'segment.writePrompt',episodeId:episode.id,segmentId:segment.id,content,archivePrevious,expectedPromptId:segment.selected.prompt??null});
        this.draftFields.delete(draftKey);this.message='新版已写入并选用；原版按选择保留或停用，请完成本段与本集核对';
      } else if (action === 'prompt-unselect' && episode) {
        await this.act({type:'segment.prompt.unselect',episodeId:episode.id,segmentId:button.dataset.segmentId,artifactId:button.dataset.artifactId,expectedPromptId:button.dataset.artifactId});
        this.message='已取消本段提示词选用；选用新版前不能新提交视频，历史视频记录保留';
      } else if (action === 'prompt-manage-batch' && episode) {
        const operation=button.dataset.operation!,choices=[...this.querySelectorAll<HTMLInputElement>('[data-prompt-choice]:checked')];
        const draftKeys=choices.map(input=>this.draftKey(input));
        if(!choices.length)throw Error('请先勾选明确的提示词版本');
        if(choices.some(input=>operation==='restore'?input.dataset.stopped!=='true':input.dataset.stopped!=='false'))throw Error(operation==='restore'?'恢复时只勾选已停用历史版':'停用或选用时只勾选当前版本');
        const entries=choices.map(input=>({segmentId:input.dataset.segmentId,artifactId:input.dataset.artifactId,expectedPromptId:episode.segments.find(s=>s.id===input.dataset.segmentId)?.selected.prompt??null}));
        const archivePrevious=this.querySelector<HTMLInputElement>('[name="prompt-select-archive"]')?.checked===true;
        await this.act({type:'episode.prompts.manage',episodeId:episode.id,operation,entries,archivePrevious});
        for(const key of draftKeys)this.draftFields.delete(key);
        this.message=`已${operation==='archive'?'停用':operation==='restore'?'恢复':'选用'} ${entries.length} 项提示词；历史来源保留${operation==='select'?'，请完成本集核对':''}`;
      } else if (action === 'inspect-video' && episode && project) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        const version = button.closest<HTMLElement>('[data-artifact-id]')!;
        await post(`/api/projects/${project.id}/episodes/${episode.id}/segments/${row.dataset.segmentId}/videos/${version.dataset.artifactId}?action=inspect`, {});
        await this.openProject(project.id);
      } else if (action === 'video-review' && episode) {
        const row = button.closest<HTMLElement>('[data-segment-id]')!;
        const version = button.closest<HTMLElement>('[data-artifact-id]')!;
        await this.act({ type: 'segment.videoReview', episodeId: episode.id, segmentId: row.dataset.segmentId,
          artifactId: version.dataset.artifactId, status: button.dataset.status,
          notes: this.field('review-notes', version),
          speech: [...version.querySelectorAll<HTMLElement>('[data-speech-id]')].map(item => ({ id: item.dataset.speechId,
            heard: item.querySelector<HTMLInputElement>('[name="speech-heard"]')?.checked === true,
            speaker: item.querySelector<HTMLInputElement>('[name="speech-speaker"]')?.checked === true,
            startSec: Number(this.field('speech-start', item)), endSec: Number(this.field('speech-end', item)) })),
          checks: Object.fromEntries([...version.querySelectorAll<HTMLInputElement>('input[name="review-check"]')]
            .map(item => [item.value, item.checked])) });
      } else if (action === 'generate' && project && episode) {
        const ids = this.checked.size ? [...this.checked] : episode.segments.map(item => item.id);
        if(button.dataset.kind==='video'){await this.openCandidates(ids.map(segmentId=>({kind:'video',episodeId:episode.id,segmentId,count:1})));return;}
        const kinds = button.dataset.kind === 'package' ? ['prompt'] : [button.dataset.kind];
        await post(`/api/projects/${project.id}/jobs`, { episodeId: episode.id, segmentIds: ids, kinds });
        this.jobs = await api(`/api/projects/${project.id}/jobs`); this.message = `已提交 ${ids.length} 个片段`; this.render();
      } else if (action === 'auto-bind-assets' && episode) {
        await this.act({ type: 'episode.autoBindAssets', episodeId: episode.id });
      } else if (action === 'approve-sample' && episode) {
        await this.act({ type: 'episode.sampleApprove', episodeId: episode.id });
      } else if (action === 'export-package' && episode && project) {
        const result = await post<{ folder: string; segments: number }>(`/api/projects/${project.id}/episodes/${episode.id}/package`, {});
        this.message = `已导出 ${result.segments} 个片段生产包：${result.folder}`; this.render();
      } else if (action === 'queue' && project) {
        await post(`/api/projects/${project.id}/jobs/${button.dataset.kind}`, {});
        this.jobs = await api(`/api/projects/${project.id}/jobs`); this.render();
      } else if (action === 'recover-remote' && project) {
        await post(`/api/projects/${project.id}/jobs/${button.dataset.jobId}/recover-remote`, {});
        await this.openProject(project.id);
      } else if(action==='cancel-task' && project) {
        await post(`/api/projects/${project.id}/jobs/${button.dataset.jobId}/cancel`,{});
        await this.openProject(project.id);
      } else if(action==='reconcile-task' && project) {
        const row=button.closest<HTMLElement>('[data-task-review]')!;
        await post(`/api/projects/${project.id}/jobs/${button.dataset.jobId}/reconcile`,{status:this.field('terminal-status',row),
          receipt:this.field('receipt',row),confirmed:row.querySelector<HTMLInputElement>('[name="terminal-confirmed"]')?.checked===true});
        await this.openProject(project.id);
      } else if (action === 'approve-audit' && episode) await this.act({ type: 'audit.approve', episodeId: episode.id });
      else if (action === 'upload-video' && episode) {
        const input = button.closest<HTMLElement>('[data-segment-id]')!.querySelector<HTMLInputElement>('input[type="file"]')!;
        if (!input.files?.[0]) throw new Error('请先选择 MP4 视频');
        await this.upload(input.files[0], `/api/projects/${project!.id}/episodes/${episode.id}/segments/${button.dataset.segmentId}/media`);
        await this.openProject(project!.id);
      } else if (action === 'upload-preview' && episode) {
        const input = this.querySelector<HTMLInputElement>('[name="preview-file"]')!;
        if (!input.files?.[0]) throw new Error('请先选择高光预告 MP4');
        await this.upload(input.files[0], `/api/projects/${project!.id}/episodes/${episode.id}/preview`);
        await this.openProject(project!.id);
      } else if (action === 'save-mode' && project) await this.act({ type: 'project.mode', mode: this.field('project-mode-edit') });
      else if (action === 'preview-mode' && episode) await this.act({ type: 'episode.update', episodeId: episode.id,
        previewOverride: this.field('preview-override') === 'default' ? null : this.field('preview-override') === 'yes' });
      else if (action === 'save-preview-cuts' && episode) {
        const cuts = [...this.querySelectorAll<HTMLElement>('[data-preview-segment-id]')]
          .filter(row => { const input = row.querySelector<HTMLInputElement>('[name="preview-cut-enabled"]');
            return input?.checked && !input.disabled; })
          .map(row => ({ segmentId: row.dataset.previewSegmentId, artifactId: row.dataset.previewArtifactId,
            startSec: Number(this.field('preview-start', row)), durationSec: this.field('preview-duration', row) }));
        await this.act({ type: 'episode.previewCuts', episodeId: episode.id, cuts });
        this.message = cuts.length ? `已保存 ${cuts.length} 段高光；导出草稿时排在正片前。` : '已清空高光片段选择。';
        this.render();
      }
      else if (action === 'export-editing' && episode && project) {
        if(!confirm('导出精剪草稿会使用选定的超分/倍速设置，保留原声和待验收标记，不代表生产验收通过。将新建草稿，不覆盖已有草稿。继续？'))return;
        const artifactIds:Record<string,string>={};
        for(const s of episode.segments){const chosen=this.field('editing-artifact-'+s.id);if(chosen)artifactIds[s.id]=chosen;}
        const useProductionSettings=this.field('editing-settings')!=='original';
        const upscale=(this.querySelector('[name="upscale"]') as HTMLInputElement).checked,onlyBelow1080=(this.querySelector('[name="below1080"]') as HTMLInputElement).checked;
        const result=await post<{draftDir:string;clips:number}>(`/api/projects/${project.id}/episodes/${episode.id}/export`,{editingDraft:true,useProductionSettings,upscale,onlyBelow1080,artifactIds});
        localStorage.setItem('manju-export:'+project.id+':'+episode.id,result.draftDir);
        this.message=`已新建精剪草稿（验收状态未改变）：${result.draftDir}`;this.render();
      }
      else if (action === 'export-mp4' && episode && project) {
        const upscale = (this.querySelector('[name="upscale"]') as HTMLInputElement).checked;
        const onlyBelow1080 = (this.querySelector('[name="below1080"]') as HTMLInputElement).checked;
        this.mp4Running = true;
        this.message = '正在合成 MP4，保留片段原声；完成后会显示预览和下载。'; this.render();
        const result = await post<{url:string;filePath:string;durationSeconds:number}>(`/api/projects/${project.id}/episodes/${episode.id}/export-mp4`, { upscale, onlyBelow1080 });
        localStorage.setItem('manju-mp4-export:'+project.id+':'+episode.id,JSON.stringify(result));
        this.message = `MP4 成片已保存：${result.filePath}`; this.render();
      }
      else if (action === 'export' && episode && project) {
        const upscale = (this.querySelector('[name="upscale"]') as HTMLInputElement).checked;
        const onlyBelow1080 = (this.querySelector('[name="below1080"]') as HTMLInputElement).checked;
        const result = await post<{ draftDir: string; clips: number }>(`/api/projects/${project.id}/episodes/${episode.id}/export`, { upscale, onlyBelow1080 });
        localStorage.setItem('manju-export:'+project.id+':'+episode.id,result.draftDir);
        this.message = `已生成 ${result.clips} 段剪映草稿：${result.draftDir}`; this.render();
      } else if (action === 'export-all' && project) {
        const upscale = (this.querySelector('[name="upscale"]') as HTMLInputElement).checked;
        const onlyBelow1080 = (this.querySelector('[name="below1080"]') as HTMLInputElement).checked;
        const result = await post<{ completed: number; failed: number; results: { episode: number; error?: string }[] }>(`/api/projects/${project.id}/export`, { upscale, onlyBelow1080 });
        this.message = `批量导出：成功 ${result.completed} 集，失败 ${result.failed} 集。${result.results.filter(item => item.error).map(item => `EP${item.episode}：${item.error}`).join('；')}`;
        this.render();
      } else if(action==='save-label-style'&&project) {
        const panel=button.closest('[data-project-label-settings]')!;
        await this.act({type:'project.labelStyle',style:readLabelStyle(panel)});
        this.message='已保存浮签字体偏好；新提示词和本地纠字使用此样式，已有验收保留';this.render();
      } else if(action==='check-label-fonts') {
        this.labelFonts=await api<LabelFontStatus>('/api/label-fonts?refresh=1');this.render();
      } else if(action==='add-effect-cue') {addEffectCue(button);
      } else if(action==='save-execution-plan'&&episode) {
        const panel=button.closest<HTMLElement>('[data-execution-editor]')!;
        await this.act({type:'segment.executionPlan',episodeId:episode.id,segmentId:panel.dataset.segmentId,plan:readExecutionPlan(panel)});
        this.message='已保存本段执行计划；请核对分镜并选用新提示词候选';this.render();
      } else if(action==='clear-execution-plan'&&episode) {
        const panel=button.closest<HTMLElement>('[data-execution-editor]')!;
        await this.act({type:'segment.executionPlan',episodeId:episode.id,segmentId:panel.dataset.segmentId,clear:true});
      } else if (action === 'search-effects') { this.effectQuery = this.field('effect-query'); await this.loadEffects(); this.render(); }
      else if (action === 'apply-effect' && episode) {
        const entry = button.closest<HTMLElement>('[data-effect-id]')!;
        const segmentId = this.effectSegmentId || this.field('effect-segment');
        const target = this.findSegment(segmentId);
        if (!target) throw new Error('先选择目标片段');
        const evidence = this.field('effect-evidence', entry);
        await this.act({ type: 'segment.effects', episodeId: episode.id, segmentId,
          entries: [...target.effectIds.map(id => ({ id, evidence: target.effectEvidence?.[id] || '' })),
            { id: entry.dataset.effectId, evidence }] });
      } else if (action === 'clear-effects' && episode) {
        await this.act({ type: 'segment.effects', episodeId: episode.id, segmentId: button.dataset.segmentId, entries: [] });
      } else if (action === 'apply-effect-candidates' && episode) {
        await this.act({ type: 'segment.applyEffectCandidates', episodeId: episode.id,
          segmentId: this.effectSegmentId || this.field('effect-segment') });
      }
    } catch (error) {
      if((error as Error&{status?:number}).status===400&&(action==='home-start'||action==='home-save-draft'))this.homeRequest=undefined;
      const detail=error instanceof Error?error.message:String(error);
      if(action==='account-login'){this.accountError=detail;this.message='';}
      else {if(action==='refresh-direct-models')this.directModelsError=detail;this.message = `操作失败：${detail}${action==='save-corpus'?' 输入框中的全文已保留，可先下载全文备份；确认保存结果前请勿刷新页面。':''}`;}
      this.render();
    }
    finally { this.busy = false; if(action==='save-corpus'){this.sourceSaving=false;this.render();} if(action==='export-mp4'){this.mp4Running=false;this.render();} }
  }

  private async refreshHome(refresh=false){
    if(this.homePollBusy)return;this.homePollBusy=true;
    try{
      const previous=this.home,next=await api<StudioHome>('/api/studio/home'+(refresh?'?refresh=1':''));this.home=next;
      if(this.tab!=='home')return;
      if(!this.homeChatId||(this.homeProjectId&&next.runs.find(r=>r.id===this.homeChatId)?.projectId!==this.homeProjectId))this.homeChatId=next.runs.find(r=>!this.homeProjectId||r.projectId===this.homeProjectId)?.id||'';
      if(!previous||!this.querySelector('.studio-home')){this.render();await this.loadHomeProgress();return;}
      const live=this.querySelector('.home-live-grid'),hasSessions=next.runs.some(run=>!['completed','cancelled'].includes(run.status))||Boolean(this.homeProjectId&&next.runs.some(run=>run.projectId===this.homeProjectId));
      live?.classList.toggle('idle',!hasSessions);live?.classList.toggle('has-runs',hasSessions);
      const activity=this.querySelector('[data-home-activity]'),projects=this.querySelector('[data-home-projects]');
      if(activity&&JSON.stringify(previous.runs)!==JSON.stringify(next.runs))activity.innerHTML=renderHomeActivity(next);
      if(projects&&(JSON.stringify(previous.projects)!==JSON.stringify(next.projects)||JSON.stringify(previous.deliverables)!==JSON.stringify(next.deliverables)))projects.innerHTML=renderHomeProjects(next,this.homeProjectQuery);
      const chat=this.querySelector('[data-home-chat]');
      if(chat){
        const current=next.runs.find(r=>r.id===this.homeChatId),prior=previous.runs.find(r=>r.id===this.homeChatId);
        if(JSON.stringify(current)!==JSON.stringify(prior)){
          const log=chat.querySelector('.home-chat-messages'),atEnd=!log||log.scrollHeight-log.scrollTop-log.clientHeight<32;
          const template=document.createElement('template');template.innerHTML=renderHomeChat(next,this.homeChatId,this.homeProjectId);
          if(current?.status===prior?.status&&log){
            log.innerHTML=template.content.querySelector('.home-chat-messages')?.innerHTML||'';
            const status=chat.querySelector('.home-chat-status');if(status)status.textContent=template.content.querySelector('.home-chat-status')?.textContent||'';
          }else{
            const draft=this.field('home-chat-text'),focused=chat.contains(document.activeElement),position=(document.activeElement as HTMLTextAreaElement)?.selectionStart,end=(document.activeElement as HTMLTextAreaElement)?.selectionEnd;
            chat.innerHTML=renderHomeChat(next,this.homeChatId,this.homeProjectId);this.restoreDraftFields();
            const input=chat.querySelector<HTMLTextAreaElement>('[name="home-chat-text"]');if(input){input.value=draft;if(focused){input.focus();input.setSelectionRange(position||0,end||0);}}
          }
          const newLog=chat.querySelector('.home-chat-messages');if(newLog&&atEnd)newLog.scrollTop=newLog.scrollHeight;
        }
      }
      const status=this.querySelector('[data-home-codex-status] span');if(status)status.textContent=next.codex.message;
      const start=this.querySelector<HTMLButtonElement>('[data-action="home-start"]');if(start)start.disabled=next.codex.status!=='available';
      await this.loadHomeProgress(previous.projects.find(p=>p.id===this.homeProjectId)?.updatedAt!==next.projects.find(p=>p.id===this.homeProjectId)?.updatedAt);
    }finally{this.homePollBusy=false;}
  }
  private closeRename(){const id=this.renameProjectId;this.renameProjectId='';this.draftFields.delete('rename:'+id);this.querySelector('.home-rename-overlay')?.remove();const trigger=this.renameReturn?.isConnected?this.renameReturn:this.querySelector<HTMLElement>(`[data-action="rename-project"][data-id="${id}"]`);(trigger?.closest('details')?.querySelector<HTMLElement>('summary')||trigger)?.focus();}
  private async handleHomeAction(action:string,button:HTMLElement){
    if(action==='rename-project'){
      this.renameProjectId=button.dataset.id||this.project?.id||'';this.renameOriginal=this.projects.find(p=>p.id===this.renameProjectId)?.name||this.home?.projects.find(p=>p.id===this.renameProjectId)?.name||'';
      this.renameReturn=button;this.render();const field=this.querySelector<HTMLInputElement>('[name="rename-name"]');field?.focus();field?.select();return;
    }
    if(action==='rename-cancel'){this.closeRename();return;}
    if(action==='rename-save'){
      const name=this.field('rename-name').trim();if(!name||name.length>100)throw Error('项目名称须为1–100字');
      const updated=await post<Project>(`/api/projects/${this.renameProjectId}/actions`,{type:'project.rename',name});
      if(this.project?.id===updated.id)this.project.name=updated.name;
      const projectId=this.renameProjectId;this.projects=await api('/api/projects');this.closeRename();await this.refreshHome();this.message='项目名称已保存';this.render();this.querySelector<HTMLElement>(`[data-home-project-id="${projectId}"] .home-project-menu summary`)?.focus();return;
    }
    if(action==='home-project-search'){this.homeProjectQuery=this.field('home-project-search');this.render();this.querySelector<HTMLInputElement>('[name="home-project-search"]')?.focus({preventScroll:true});return;}
    if(action==='home-open-project'){this.sidebarOpen=false;this.tab='settings';await this.openProject(button.dataset.id!);return;}
    if(action==='home-open'){this.tab='home';this.sidebarOpen=false;this.homeLaunchOpen=false;this.selectHomeProject('');await this.refreshHome();return;}
    if(action==='home-create'){this.homeLaunchOpen=true;this.selectHomeProject('');this.querySelector<HTMLInputElement>('[name="home-name"]')?.focus({preventScroll:true});this.querySelector('.home-launch')?.scrollIntoView({block:'start'});return;}
    if(action==='home-close-form'){this.homeLaunchOpen=false;this.selectHomeProject('');this.querySelector<HTMLButtonElement>('[data-action="home-create"]')?.focus({preventScroll:true});return;}
    if(action==='home-refresh'||action==='home-check-codex'){await this.refreshHome(action==='home-check-codex');await this.loadHomeProgress(true);this.homeControlRequest=undefined;return;}
    if(action==='home-new'){this.homeLaunchOpen=true;this.selectHomeProject('');this.querySelector('.home-launch')?.scrollIntoView({block:'start'});return;}
    if(action==='home-select-chat'){const run=this.home?.runs.find(r=>r.id===button.dataset.id);if(run)this.selectHomeProject(run.projectId,run.id);await this.loadHomeProgress(true);this.querySelector('[data-home-chat]')?.scrollIntoView({block:'nearest'});return;}
    if(action==='home-continue-project'){
      const run=this.home?.runs.find(r=>r.projectId===button.dataset.id&&!['completed','cancelled'].includes(r.status));
      this.selectHomeProject(button.dataset.id!,run?.id);this.querySelector('.home-launch')?.scrollIntoView({block:'start'});await this.loadHomeProgress(true);return;
    }
    if(action==='home-progress-refresh'){await this.loadHomeProgress(true);return;}
    if(action==='home-progress-page'){this.homeProgressPage=Math.max(1,Number(button.dataset.page)||1);this.updateHomeProgress();return;}
    if(action==='home-progress-open'){
      this.sidebarOpen=false;this.episodeId=button.dataset.episodeId||'';
      this.tab=button.dataset.tab==='review'?'canvas':button.dataset.tab as Tab;
      this.canvasView='graph';this.graphWorkflow=button.dataset.tab==='review'?'review':null;this.checked.clear();this.canvasSelectedSegmentId=button.dataset.segmentId||'';this.canvasSelectedAssetId='';
      await this.openProject(button.dataset.projectId!);return;
    }
    if(action==='home-start'||action==='home-save-draft'){
      const delivery=this.field('home-delivery')||'package';
      const body:Record<string,unknown>={delivery,name:this.field('home-name')||'新作品',sourceText:this.field('home-source')};
      if(action==='home-start'){
        if(!this.querySelector<HTMLInputElement>('[name="home-confirmed"]')?.checked)throw Error('请先确认本次制作范围、Agent使用和生成次数');
        Object.assign(body,{client:'codex',confirmed:true,projectId:this.homeProjectId||undefined,requirement:this.field('home-requirement'),targetEpisodes:Number(this.field('home-episodes')),acceptUnknownCost:this.querySelector<HTMLInputElement>('[name="home-unknown-cost"]')?.checked===true,limits:{text:Number(this.field('home-limit-text')),image:Number(this.field('home-limit-image')),video:delivery==='video'?Number(this.field('home-limit-video')):0}});
        if(this.homeProjectId){delete body.sourceText;delete body.name;}
      }
      const key=JSON.stringify(body);
      if(this.homeRequest&&(this.homeRequest.key!==key||this.homeRequest.action!==action))throw Error('上次请求结果尚未确认，请使用原内容重试或先刷新核对作品，避免重复创建');
      this.homeRequest??={action,key,body:{...body,requestId:'home-'+crypto.randomUUID()}};
      const result=await post<StudioRun&{projectId:string}>(action==='home-start'?'/api/studio/start':'/api/studio/draft',this.homeRequest.body);
      this.homeRequest=undefined;this.selectHomeProject(result.projectId,action==='home-start'?result.id:'');
      this.projects=await api('/api/projects');await this.refreshHome();this.message=action==='home-start'?'制作会话已建立，可在下方继续沟通。':'完整原文已保存，可稍后交给 Agent。';this.render();if(action==='home-start')this.querySelector('[data-home-chat]')?.scrollIntoView({block:'center'});return;
    }
    if(action==='home-control'||action==='home-send-message'){
      const runId=button.dataset.id!,body=action==='home-control'?{operation:button.dataset.operation}:{operation:'message',text:this.field('home-chat-text')};const key=JSON.stringify(body);
      if(action==='home-control'){const run=this.home?.runs.find(r=>r.id===runId);if(run&&this.homeProjectId!==run.projectId){this.selectHomeProject(run.projectId,run.id);await this.loadHomeProgress(true);}}
      if(this.homeControlRequest&&(this.homeControlRequest.runId!==runId||this.homeControlRequest.key!==key))throw Error('上次会话操作尚未确认，请保留原操作重试或刷新核对');
      this.homeControlRequest??={runId,key,body:{...body,requestId:'chat-'+crypto.randomUUID()}};
      await post(`/api/studio/runs/${runId}/control`,this.homeControlRequest.body);this.homeControlRequest=undefined;
      if(action==='home-send-message'){this.draftFields.delete('home:chat:'+runId);const field=this.querySelector<HTMLTextAreaElement>('[name="home-chat-text"]');if(field)field.value='';}
      await this.refreshHome();return;
    }
  }
  private async importHomeFile(file:File){
    try{
      if(!/\.txt$/i.test(file.name))throw Error('请选择小说 TXT 文件');if(file.size>MAX_SOURCE_FILE_BYTES)throw Error('TXT超过21 MB，请按原文连续分卷导入');
      const source=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(source.length>MAX_SOURCE_CHARACTERS)throw Error('原文超过700万字符');
      const input=this.querySelector<HTMLTextAreaElement>('[name="home-source"]');if(!input)return;input.value=source;this.draftFields.set(this.draftKey(input),{value:source,checked:false});
      const name=this.querySelector<HTMLInputElement>('[name="home-name"]');if(name&&!name.value.trim()){name.value=file.name.replace(/\.txt$/i,'').slice(0,100);this.draftFields.set(this.draftKey(name),{value:name.value,checked:false});}
      const info=this.querySelector('[data-home-source-info]');if(info)info.textContent=`已读取 ${file.name} · ${source.length} 字符`;
    }catch(error){this.message=error instanceof TypeError?'读取失败：请将 TXT 转为 UTF-8 后导入。':'读取失败：'+(error as Error).message;this.render();}
  }
  private async upload(file: File, endpoint: string) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'X-File-Name': file.name }, body: file });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '上传失败');
    this.message = `已导入：${file.name}`;
    return result as {mediaPath:string};
  }

  private async change(event: Event) {
    const target = event.target as HTMLInputElement;
    if(target.name==='workflow-delivery'){const field=this.querySelector<HTMLElement>('[data-workflow-video-limit]');if(field)field.hidden=target.value!=='video';return;}
    if(target.name==='state-episode'&&this.project){
      const form=target.closest<HTMLElement>('[data-state-form]')!,select=form.querySelector<HTMLSelectElement>('[name="state-start"]')!;
      select.innerHTML=segmentOptions(this.project,Number(target.value));
      this.draftFields.set(this.draftKey(select),{value:select.value,checked:false});return;
    }
    if(target.name==='asset-candidate-episode'&&this.project){
      const extraction=this.querySelector<HTMLElement>('.asset-extraction');
      if(extraction)extraction.setAttribute('aria-busy','true');
      this.assetView.candidateEpisodeId=target.value;
      this.assetView.candidatePage=1;
      try{await this.loadAssetCandidate();if(this.project){const template=document.createElement('template');template.innerHTML=renderAssetWorkspace(this.project,this.assetView);const next=template.content.querySelector('.asset-extraction');if(next&&extraction?.isConnected)extraction.replaceWith(next);}}
      catch(error){extraction?.insertAdjacentHTML('beforeend',renderAppNotice('读取建议失败：'+(error as Error).message));}
      finally{extraction?.removeAttribute('aria-busy');}return;
    }
    if(target.name==='home-source-file'&&target.files?.[0]){await this.importHomeFile(target.files[0]);return;}
    if(target.name==='home-delivery'){const field=this.querySelector<HTMLElement>('[data-home-video-limit]');if(field)field.hidden=target.value!=='video';this.homeLimitSummary();this.updateHomeProgress();return;}
    if(target.name==='home-episodes'){this.updateHomeProgress();return;}
    if(target.name.startsWith('home-limit-')){this.homeLimitSummary();return;}
    if (target.name === 'project-source-file' && target.files?.[0]) {
      const file = target.files[0];
      if (file.size > MAX_SOURCE_FILE_BYTES) { this.message = '原文 TXT 文件超过 21 MB，请按原文连续分卷导入。'; this.render(); return; }
      try {
        const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (sourceText.length > MAX_SOURCE_CHARACTERS) throw new Error('原文超过单次 700 万字符限制，请按原文连续分卷导入。');
        const field = this.querySelector<HTMLTextAreaElement>('[name="project-source"]')!;
        field.value = sourceText;
        this.draftFields.set(this.draftKey(field), { value: sourceText, checked: false });
        this.message = `已读取 ${file.name}，请核对并保存完整原文。`;
      } catch (error) {
        this.message = error instanceof TypeError ? '读取失败：请将 TXT 转为 UTF-8 编码后重新导入。' : `读取失败：${error instanceof Error ? error.message : String(error)}`;
      }
      this.render();
      return;
    }
    if (target.matches('[data-check-segment]')) {
      if (target.checked) this.checked.add(target.dataset.checkSegment!);
      else this.checked.delete(target.dataset.checkSegment!);
    }
    if (target.name === 'effect-segment') {
      this.effectSegmentId = target.value;
      await this.loadSuggestions(); this.render();
    }
    if(target.name==='catalog-model-choice'){
      const scope=target.closest<HTMLElement>('[data-model-kind],.global-model-detail');
      const field=scope?.querySelector<HTMLInputElement>(`[name="${target.dataset.target}"]`);
      if(field&&target.value){field.value=target.value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
    }
    if (target.name === 'model-id') {
      const card = target.closest<HTMLElement>('[data-model-kind]');
      if (card?.dataset.modelKind === 'video') {
        const group = this.mumu.models.find(item => item.kind === 'video' && item.models.includes(target.value));
        const capability = group?.capabilities?.[target.value];
        const set = (name: string, value: unknown) => {
          const input = card.querySelector<HTMLInputElement>(`[name="${name}"]`);
          if (input) input.value = value == null ? '' : String(value);
        };
        set('model-max-duration', capability?.duration?.max_seconds);
        set('model-max-references', capability?.references?.max_image_urls);
        set('model-max-prompt', capability?.prompt?.max_unicode_code_points);
        set('model-aspects', capability?.aspect_ratio?.allowed?.filter(value => ['16:9', '9:16', '1:1'].includes(value)).join(','));
      }
    }
  }

  private graphLayoutKey(projectId: string, episodeId: string): string {
    return `manju-node-layout-v2:${projectId}:${episodeId}`;
  }

  private async connectGraphVersion(segmentId: string, artifactId: string) {
    if (!this.project || !this.episode) return;
    const projectId = this.project.id;
    await post(`/api/projects/${projectId}/actions`, { type: 'segment.select', episodeId: this.episode.id,
      segmentId, kind: 'video', artifactId });
    this.graphPending = undefined;
    await this.openProject(projectId);
    this.message = '已选用该片段的视频版本。已有素材内容不会被重新改写。';
    this.render();
  }

  private applyGraphTransform() {
    if(this.project&&this.episode)localStorage.setItem('manju-viewport:'+this.project.id+':'+this.episode.id,JSON.stringify({offset:this.graphOffset,zoom:this.canvasZoom,segmentId:this.canvasSelectedSegmentId,assetId:this.canvasSelectedAssetId}));
    const board = this.querySelector<HTMLElement>('.graph-board');
    if (board) board.style.transform = `translate(${this.graphOffset.x}px, ${this.graphOffset.y}px) scale(${this.canvasZoom})`;
    this.querySelectorAll<HTMLElement>('.graph-node').forEach(n=>n.classList.toggle('multi-selected',this.graphSelection.has(n.dataset.nodeId!)));
    const viewport = this.querySelector<HTMLElement>('.graph-viewport');
    if (viewport) {
      viewport.style.backgroundSize = `${30 * this.canvasZoom}px ${30 * this.canvasZoom}px`;
      viewport.style.backgroundPosition = `${this.graphOffset.x}px ${this.graphOffset.y}px`;
    }
    const readout = this.querySelector<HTMLElement>('.graph-zoom-readout');
    if (readout) readout.textContent = `${Math.round(this.canvasZoom * 100)}%`;
    const slider = this.querySelector<HTMLInputElement>('.graph-zoom-slider');
    if (slider) slider.value = String(Math.round(this.canvasZoom * 100));
  }

  private graphZoomTo(value: number, clientX?: number, clientY?: number) {
    const viewport = this.querySelector<HTMLElement>('.graph-viewport');
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const next = Math.max(.1, Math.min(2.5, value));
    const ratio = next / this.canvasZoom;
    this.graphOffset.x = anchorX - (anchorX - this.graphOffset.x) * ratio;
    this.graphOffset.y = anchorY - (anchorY - this.graphOffset.y) * ratio;
    this.canvasZoom = next;
    this.applyGraphTransform();
  }

  private graphWheel(event: WheelEvent) {
    if (!(event.target as Element).closest('.graph-viewport')) return;
    if((event.target as Element).closest('video,input,textarea,select,.candidate-workbench'))return;
    event.preventDefault();
    this.graphZoomTo(this.canvasZoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX, event.clientY);
  }

  private fitGraph(selectedOnly:boolean) {
    const viewport=this.querySelector<HTMLElement>('.graph-viewport');if(!viewport)return;
    const all=[...this.querySelectorAll<HTMLElement>('.graph-node')];
    const focused=all.filter(node=>this.graphSelection.size?this.graphSelection.has(node.dataset.nodeId||''):this.canvasSelectedAssetId?node.dataset.nodeId?.startsWith('asset:'+this.canvasSelectedAssetId+':'):node.classList.contains('graph-shot')&&node.dataset.segmentId===this.canvasSelectedSegmentId);
    const nodes=selectedOnly&&focused.length?focused:all;if(!nodes.length)return;
    const fitted=fitCanvasNodes(nodes.map(n=>({left:parseFloat(n.style.left),top:parseFloat(n.style.top),width:n.offsetWidth,height:n.offsetHeight})),{width:viewport.clientWidth,height:viewport.clientHeight},selectedOnly?2:1.5);
    if(!fitted)return;this.canvasZoom=fitted.zoom;this.graphOffset=fitted.offset;this.applyGraphTransform();
  }

  private centerGraphOnSegment(segmentId: string) {
    const viewport = this.querySelector<HTMLElement>('.graph-viewport');
    const shot = [...this.querySelectorAll<HTMLElement>('.graph-shot')].find(node => node.dataset.segmentId === segmentId);
    if (!viewport || !shot) return;
    this.graphOffset.x = viewport.clientWidth * .46 - (parseFloat(shot.style.left) + shot.offsetWidth / 2) * this.canvasZoom;
    this.graphOffset.y = viewport.clientHeight * .43 - (parseFloat(shot.style.top) + shot.offsetHeight / 2) * this.canvasZoom;
    this.applyGraphTransform();
  }

  private graphPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.querySelector<HTMLElement>('.graph-viewport')!.getBoundingClientRect();
    return { x: (clientX - rect.left - this.graphOffset.x) / this.canvasZoom,
      y: (clientY - rect.top - this.graphOffset.y) / this.canvasZoom };
  }

  private updateGraphDraft(clientX: number, clientY: number) {
    if (!this.graphConnectDrag) return;
    const source = [...this.querySelectorAll<HTMLElement>('.graph-shot')]
      .find(node => node.dataset.nodeId === this.graphConnectDrag?.nodeId);
    const draft = this.querySelector<SVGPathElement>('.graph-draft-link');
    if (!source || !draft) return;
    const end = this.graphPoint(clientX, clientY);
    const x = parseFloat(source.style.left) + source.offsetWidth;
    const y = parseFloat(source.style.top) + source.offsetHeight / 2;
    const bend = Math.max(65, Math.abs(end.x - x) * .4);
    draft.setAttribute('d', `M ${x} ${y} C ${x + bend} ${y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`);
    draft.style.display = 'block';
  }

  private graphPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement;
    const viewport = target.closest<HTMLElement>('.graph-viewport');
    if (!viewport || ![0,1].includes(event.button)) return;
    if((event.button===1||this.graphSpace)&&!target.closest('video,input,textarea,select,button')){
      this.graphPan={pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:this.graphOffset.x,top:this.graphOffset.y};viewport.setPointerCapture(event.pointerId);viewport.classList.add('panning');event.preventDefault();return;
    }
    const output = target.closest<HTMLElement>('.graph-port.output');
    if (output) {
      this.graphConnectDrag = { pointerId: event.pointerId, segmentId: output.dataset.segmentId!,
        nodeId: output.dataset.nodeId!, x: event.clientX, y: event.clientY, moved: false };
      return;
    }
    const node = target.closest<HTMLElement>('.graph-node');
    if(node&&!target.closest('button,input,textarea,select,video,.graph-port')){
      viewport.focus();
      const id=node.dataset.nodeId!;
      if(event.shiftKey){if(this.graphSelection.has(id))this.graphSelection.delete(id);else this.graphSelection.add(id);}
      else if(!this.graphSelection.has(id)){this.graphSelection.clear();this.graphSelection.add(id);}
      this.querySelectorAll<HTMLElement>('.graph-node').forEach(n=>n.classList.toggle('multi-selected',this.graphSelection.has(n.dataset.nodeId!)));
      if(id.startsWith('asset:'))this.canvasSelectedAssetId=id.split(':')[1];else if(node.dataset.segmentId){this.canvasSelectedSegmentId=node.dataset.segmentId;this.canvasSelectedAssetId='';}
      if(event.shiftKey&&!this.graphSelection.has(id))return;
    }
    if (node && !target.closest('button,input,textarea,select,video,.graph-port')) {
      this.graphGroupOrigins.clear();this.querySelectorAll<HTMLElement>('.graph-node').forEach(n=>{if(this.graphSelection.has(n.dataset.nodeId!))this.graphGroupOrigins.set(n.dataset.nodeId!,{left:parseFloat(n.style.left),top:parseFloat(n.style.top)});});
      this.graphDrag = { nodeId: node.dataset.nodeId!, pointerId: event.pointerId,
        x: event.clientX, y: event.clientY, left: parseFloat(node.style.left), top: parseFloat(node.style.top) };
      viewport.setPointerCapture(event.pointerId);
      node.classList.add('dragging');
      event.preventDefault();
    } else if (!node && !target.closest('button, input, video, details')) {
      this.graphMarquee={pointerId:event.pointerId,start:this.graphPoint(event.clientX,event.clientY),initial:new Set(this.graphSelection),additive:event.shiftKey};
      const box=document.createElement('div');box.className='graph-marquee';this.querySelector('.graph-board')?.append(box);
      viewport.setPointerCapture(event.pointerId);
      viewport.focus();
      event.preventDefault();
    }
  }

  private graphPointerMove(event: PointerEvent) {
    const viewport = this.querySelector<HTMLElement>('.graph-viewport');
    if (!viewport) return;
    if(this.graphMarquee?.pointerId===event.pointerId){const drag=this.graphMarquee,end=this.graphPoint(event.clientX,event.clientY),box=this.querySelector<HTMLElement>('.graph-marquee');if(box)Object.assign(box.style,{left:Math.min(drag.start.x,end.x)+'px',top:Math.min(drag.start.y,end.y)+'px',width:Math.abs(end.x-drag.start.x)+'px',height:Math.abs(end.y-drag.start.y)+'px'});
      const picked=nodesInMarquee([...this.querySelectorAll<HTMLElement>('.graph-node')].map(n=>({id:n.dataset.nodeId!,left:parseFloat(n.style.left),top:parseFloat(n.style.top),width:n.offsetWidth,height:n.offsetHeight})),drag.start,end);this.graphSelection=new Set([...(drag.additive?drag.initial:[]),...picked]);this.applyGraphTransform();return;}
    if (this.graphConnectDrag?.pointerId === event.pointerId) {
      if (!this.graphConnectDrag.moved && Math.hypot(event.clientX - this.graphConnectDrag.x, event.clientY - this.graphConnectDrag.y) > 5) {
        this.graphConnectDrag.moved = true;
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add('connecting');
      }
      if (this.graphConnectDrag.moved) this.updateGraphDraft(event.clientX, event.clientY);
      return;
    }
    if (this.graphDrag?.pointerId === event.pointerId) {
      const node = [...this.querySelectorAll<HTMLElement>('.graph-node')]
        .find(item => item.dataset.nodeId === this.graphDrag?.nodeId);
      if (!node) return;
      node.style.left = `${this.graphDrag.left + (event.clientX - this.graphDrag.x) / this.canvasZoom}px`;
      node.style.top = `${this.graphDrag.top + (event.clientY - this.graphDrag.y) / this.canvasZoom}px`;
      for(const [id,origin] of this.graphGroupOrigins){const other=[...this.querySelectorAll<HTMLElement>('.graph-node')].find(n=>n.dataset.nodeId===id);if(other){other.style.left=`${origin.left+(event.clientX-this.graphDrag.x)/this.canvasZoom}px`;other.style.top=`${origin.top+(event.clientY-this.graphDrag.y)/this.canvasZoom}px`;}}
      this.refreshGraphEdges();
    } else if (this.graphPan?.pointerId === event.pointerId) {
      this.graphOffset.x = this.graphPan.left + event.clientX - this.graphPan.x;
      this.graphOffset.y = this.graphPan.top + event.clientY - this.graphPan.y;
      this.applyGraphTransform();
    }
  }

  private graphPointerUp(event: PointerEvent) {
    const viewport = this.querySelector<HTMLElement>('.graph-viewport');
    if(this.graphMarquee?.pointerId===event.pointerId){const drag=this.graphMarquee,end=this.graphPoint(event.clientX,event.clientY);if(event.type==='pointercancel')this.graphSelection=drag.initial;else if(!drag.additive&&Math.hypot(end.x-drag.start.x,end.y-drag.start.y)<3)this.graphSelection.clear();this.graphMarquee=undefined;this.querySelector('.graph-marquee')?.remove();if(viewport?.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);this.applyGraphTransform();return;}
    if (this.graphConnectDrag?.pointerId === event.pointerId) {
      const drag = this.graphConnectDrag;
      const input = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.graph-port.input');
      if (drag.moved) this.graphIgnorePortClickUntil = Date.now() + 400;
      this.graphConnectDrag = undefined;
      const draft = this.querySelector<SVGPathElement>('.graph-draft-link');
      if (draft) draft.style.display = 'none';
      viewport?.classList.remove('connecting');
      if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (event.type !== 'pointercancel' && drag.moved && input?.dataset.segmentId === drag.segmentId && input.dataset.artifactId)
        void this.connectGraphVersion(drag.segmentId, input.dataset.artifactId).catch(error => {
          this.message = error instanceof Error ? error.message : String(error); this.render();
        });
      return;
    }
    if (this.graphDrag?.pointerId === event.pointerId && this.project && this.episode) {
      const node = [...this.querySelectorAll<HTMLElement>('.graph-node')]
        .find(item => item.dataset.nodeId === this.graphDrag?.nodeId);
      if (node) {
        const key = this.graphLayoutKey(this.project.id, this.episode.id);
        let positions: Record<string, { x: number; y: number }> = {};
        try { positions = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* 使用默认布局。 */ }
        positions[this.graphDrag.nodeId] = { x: Math.round(parseFloat(node.style.left)), y: Math.round(parseFloat(node.style.top)) };
        for(const id of this.graphGroupOrigins.keys()){const other=[...this.querySelectorAll<HTMLElement>('.graph-node')].find(n=>n.dataset.nodeId===id);if(other)positions[id]={x:Math.round(parseFloat(other.style.left)),y:Math.round(parseFloat(other.style.top))};}
        localStorage.setItem(key, JSON.stringify(positions));
        node.classList.remove('dragging');
      }
      this.graphDrag = undefined;
      this.graphGroupOrigins.clear();
    }
    if (this.graphPan?.pointerId === event.pointerId) {
      this.graphPan = undefined;
      viewport?.classList.remove('panning');
    }
    if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  }

  private refreshGraphEdges() {
    const nodes = new Map([...this.querySelectorAll<HTMLElement>('.graph-node')]
      .map(node => [node.dataset.nodeId!, node]));
    this.querySelectorAll<SVGPathElement>('.graph-link').forEach(path => {
      const from = nodes.get(path.dataset.from || ''), to = nodes.get(path.dataset.to || '');
      if (!from || !to) return;
      if (path.classList.contains('anchor')) {
        const x1 = parseFloat(from.style.left) + from.offsetWidth / 2;
        const y1 = parseFloat(from.style.top) + from.offsetHeight;
        const x2 = parseFloat(to.style.left) + to.offsetWidth / 2;
        const y2 = parseFloat(to.style.top);
        const bend = Math.max(30, Math.abs(y2 - y1) * .5);
        path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`);
        return;
      }
      const x1 = parseFloat(from.style.left) + from.offsetWidth;
      const y1 = parseFloat(from.style.top) + from.offsetHeight / 2;
      const x2 = parseFloat(to.style.left);
      const y2 = parseFloat(to.style.top) + to.offsetHeight / 2;
      const bend = Math.max(70, Math.min(230, (x2 - x1) * .42));
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    });
  }

  private async loadEffects() {
    const result = await api<{ summary: { total: number; locallyAdapted: number }; effects: Effect[] }>(`/api/effects?q=${encodeURIComponent(this.effectQuery)}`);
    this.effects = result.effects; this.effectSummary = result.summary;
  }

  private async loadSuggestions() {
    if (!this.project || !this.episode?.segments.length) return;
    if (!this.effectSegmentId || !this.findSegment(this.effectSegmentId)) this.effectSegmentId = this.episode.segments[0].id;
    this.effectSuggestions = await api(`/api/projects/${this.project.id}/episodes/${this.episode.id}/segments/${this.effectSegmentId}/effects/suggest`);
  }

  private render() {
    setStudioAppearancePage(this.tab === 'canvas' ? (this.graphWorkflow || (this.graphJobsOpen ? 'tasks' : 'canvas')) : this.tab);
    // Keep the React root and media elements mounted during task polling and inspector changes.
    this.nativeCanvas?.element.remove();
    const playback=[...this.querySelectorAll<HTMLVideoElement>('video')].map(player=>({src:player.getAttribute('src'),time:player.currentTime,paused:player.paused,rate:player.playbackRate,volume:player.volume,muted:player.muted}));
    const p = this.project, ep = this.episode;
    const headerProjectName=this.tab==='home'?this.home?.projects.find(project=>project.id===this.homeProjectId)?.name:p?.name;
    const canvasViewport = this.querySelector<HTMLElement>('.canvas-viewport, .graph-viewport');
    const canvasScroll = canvasViewport ? { left: canvasViewport.scrollLeft, top: canvasViewport.scrollTop } : null;
    this.innerHTML = `<a class="skip-link" href="#main-content">跳到主要内容</a><div class="shell ${this.tab==='home'?'home-shell':''}"><header><div class="header-brand">${this.tab==='home'?'':`<button class="sidebar-toggle" data-action="toggle-sidebar" aria-label="项目菜单" aria-controls="project-sidebar" aria-expanded="${this.sidebarOpen}">${uiIcon('menu')}</button>`}<button class="brand brand-home" data-action="home-open" aria-label="万灵漫剧，返回首页"><img class="mark app-icon" src="/wanling-icon.png" width="40" height="40" alt="万灵漫剧图标"/><div><strong>万灵漫剧</strong><small>漫剧创作工作台</small></div></button></div>
      <div class="header-right">${renderStudioThemePicker()}${this.draftFields.size ? '<button data-action="discard-drafts" title="丢弃本地未提交编辑并刷新">丢弃本地未提交编辑并刷新</button>' : ''}${p && localStorage.getItem('manju-candidate-pending:'+p.id)?'<button data-action="candidate-recover-pending">恢复未确认的候选提交</button>':''}${headerProjectName?`<span class="chip">${esc(headerProjectName)}</span>`:''}${this.tab==='home'?'<span class="home-header-version">V0.4.10</span>':''}<span class="header-service"><span class="status-dot"></span>本机服务</span>${this.tab==='home'?`<button class="home-header-settings" data-action="open-app-settings" aria-label="打开设置" title="设置">${uiIcon('settings')}</button>`:''}</div></header>
      ${this.tab==='home'?'':`<aside id="project-sidebar" aria-label="项目导航" class="app-sidebar ${this.sidebarOpen?'is-open':''}"><button class="sidebar-home" data-action="home-open">${uiIcon('home')}首页</button><div class="sidebar-top"><span class="side-heading">项目</span><button data-action="open-app-settings" class="app-settings ${this.tab === 'provider' ? 'active' : ''}" title="全局设置">${uiIcon('settings')}设置</button></div>${this.projects.filter(item => !item.archivedAt).map(item => `<button class="side-item ${p?.id === item.id && this.tab !== 'provider' && this.tab !== 'home' ? 'active' : ''}" data-action="open-project" data-id="${item.id}" title="${esc(item.name)}">${esc(item.name)}</button>`).join('')}
      <details class="sidebar-disclosure"><summary>＋ 新建项目</summary><div class="new-project"><label>项目名称<input name="project-name" placeholder="新项目名称"/></label><label>制作类型<select name="project-mode"><option value="standard">常规漫剧</option><option value="douyin-story">抖音推文漫剧</option></select></label><button data-action="create-project">创建项目</button></div></details></aside>`}
      ${this.sidebarOpen&&this.tab!=='home'?'<button class="app-sidebar-scrim" data-action="toggle-sidebar" aria-label="关闭项目菜单"></button>':''}<main id="main-content" tabindex="-1" class="app-main ${this.tab === 'canvas' && this.canvasView === 'graph' ? 'canvas-mode' : ''}">${this.tab === 'home' ? `${renderAppNotice(this.message)}${renderStudioHome(this.home,this.home?.defaults||this.productionDefaults,this.homeProjectId,this.homeChatId,this.homeProjectQuery,this.homeProgress,this.homeProgressLoading,this.homeProgressError,this.homeProgressPage,this.homeLaunchOpen)}` : this.tab === 'provider' ? this.renderProviderSettings() : p && (this.tab === 'settings' || this.tab === 'assets' || this.tab === 'sourcePlan' || this.tab === 'episodes' || this.tab === 'tasks') ? `<div class="project-scope">${this.renderProjectNav(p)}${this.tab === 'settings' || this.tab === 'episodes' ? this.renderSettings(p) : this.tab === 'assets' ? this.renderAssets(p) : this.tab === 'tasks' ? `${renderAppNotice(this.message)}<div data-agent-dashboard>${renderAgentDashboard(this.taskDashboard)}</div>` : this.renderSourcePlan(p)}</div>` : p && ep ? this.renderWork(p, ep) : `<section class="welcome">${uiIcon('film')}<h1>把故事带入画面</h1><p>创建项目，从完整原文开始，逐集完成剧本、资产、分镜和审片。</p><button class="primary" data-action="agent-settings">交给 Agent 制作</button><button data-action="new-project-form">新建第一个项目</button></section>`}</main></div>${p && this.candidateWorkspace ? candidatePanel(p,this.candidateWorkspace,this.candidateBatches,this.message,this.tab==='canvas'&&this.canvasView==='graph') : ''}${this.assetImpact ? `<div class="candidate-overlay"><section class="candidate-workbench" role="dialog" aria-modal="true"><h2>确认资产变更影响</h2><p>${esc(this.assetImpact.message)}</p><p>需重新核对：${this.assetImpact.affected.map(s=>`EP${s.episode} · 片段${s.segment}`).join('；')}</p><button data-action="asset-impact-cancel">返回比较</button><button class="primary" data-action="asset-impact-apply">确认变更，不生成视频</button></section></div>` : ''}`;
    if(this.renameProjectId)this.insertAdjacentHTML('beforeend',`<div class="home-rename-overlay"><section class="home-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title"><h2 id="rename-title">项目改名</h2><label>新名称<input name="rename-name" maxlength="100" value="${esc(this.renameOriginal)}"/></label><p>已有剧本、素材、会话和制作进度继续保留。</p><div class="actions"><button data-action="rename-cancel">取消</button><button class="primary" data-action="rename-save">保存名称</button></div></section></div>`);
    this.restoreDraftFields(true);
    const promptDialog=this.querySelector<HTMLElement>('[data-prompt-manager]');
    if(promptDialog&&!promptDialog.contains(document.activeElement))promptDialog.querySelector<HTMLButtonElement>('[data-action="prompt-manager-close"]')?.focus();
    updateLabelPreviews(this,this.project,this.episode);
    this.updateLabelRepairControls();
    this.updateTextControls();
    if(this.tab==='home')this.updateHomeProgress();
    const videoLimit=this.querySelector<HTMLElement>('[data-home-video-limit]');if(videoLimit)videoLimit.hidden=this.field('home-delivery')!=='video';
    this.homeLimitSummary();
    this.updateUpscaleControls();
    for(const player of this.querySelectorAll<HTMLVideoElement>('video')) {
      const state=playback.find(item=>item.src && item.src===player.getAttribute('src'));
      if(!state) continue;
      const restore=()=>{player.currentTime=Math.min(state.time,Number.isFinite(player.duration)?player.duration:state.time);player.playbackRate=state.rate;player.volume=state.volume;player.muted=state.muted;if(!state.paused)void player.play().catch(()=>{});};
      if(player.readyState>=1)restore();else player.addEventListener('loadedmetadata',restore,{once:true});
    }
    if (canvasScroll) {
      const viewport = this.querySelector<HTMLElement>('.canvas-viewport, .graph-viewport');
      if (viewport) { viewport.scrollLeft = canvasScroll.left; viewport.scrollTop = canvasScroll.top; }
    }
    const canvasHost = this.querySelector<HTMLElement>('[data-studio-canvas-host]');
    if (canvasHost && p && ep) {
      this.nativeCanvas ||= new StudioCanvasMount();
      canvasHost.replaceWith(this.nativeCanvas.element);
      this.nativeCanvas.update({project:p,episode:ep,selectedSegmentId:this.canvasSelectedSegmentId,
        activeTab:this.graphWorkflow||'canvas',auditLabel:this.approved?'五层核对已放行':this.auditIssues.length?`待修正 ${this.auditIssues.length} 项`:'待人工核对',
        onGenerate:async(node,options)=>{
          const input=node.type==='asset'?{kind:'image' as const,assetId:node.assetId,stateId:node.stateId||'',role:node.role||'main',episodeId:ep.id,segmentId:node.segmentId||this.canvasSelectedSegmentId,...options}:{kind:'video' as const,episodeId:ep.id,segmentId:node.segmentId,...options};
          if(node.segmentId)this.canvasSelectedSegmentId=node.segmentId;
          await this.openCandidates([input]);
        },
        onCreateAsset:async(input)=>{
          if(this.busy)throw new Error('当前操作尚未完成，请稍后添加');
          this.busy=true;
          try{
            const before=new Set((this.project?.assets||[]).map(a=>a.id));
            await this.act({type:'asset.add',...input});
            const created=this.project?.assets?.find(a=>!before.has(a.id));
            if(!created)throw new Error('未找到新建资产，请在资产库检查');
            return created.id;
          }finally{this.busy=false;}
        },
        onSelect:node=>{
          const changed = node.segmentId && node.segmentId !== this.canvasSelectedSegmentId;
          if (node.segmentId) this.canvasSelectedSegmentId=node.segmentId;
          this.canvasSelectedAssetId=node.assetId?`${node.assetId}:${node.role}`:'';
          if (changed) this.render();
        },
        onConnect:async(from,to)=>{
          if (from.type==='asset' && to.type==='shot' && from.assetId && to.segmentId) {
            if (!from.imageId) throw new Error('请先导入并核对资产参考图');
            const segment=ep.segments.find(s=>s.id===to.segmentId)!;
            const bindings=structuredClone(segment.assetBindings||[]);
            const binding=bindings.find(b=>b.assetId===from.assetId)||{assetId:from.assetId};
            if(!bindings.includes(binding))bindings.push(binding);
            binding.stateId=from.stateId||'';
            binding.imageId=from.imageId;delete binding.portraitImageId;
            this.canvasSelectedSegmentId=to.segmentId;
            await this.previewAssetChange({type:'segment.assets',episodeId:ep.id,segmentId:to.segmentId,bindings});
            return;
          }
          const action=canvasConnectionAction(studioCanvas(p,ep,this.canvasSelectedSegmentId).nodes,from.id,to.id);
          if(!action)throw new Error('资产图连接片段；片段只连接本片段未判废的视频版本');
          await this.connectGraphVersion(action.segmentId,action.artifactId);
        },
        onImport:async(file,node)=>{
          if(this.busy)throw new Error('当前操作尚未完成，请稍后导入');
          this.busy=true;
          try{
            let importedMediaPath:string|undefined;
            if(node.type==='asset' && node.assetId) {
              if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('参考图支持 PNG、JPEG、WebP');
              importedMediaPath=(await this.upload(file,`/api/projects/${p.id}/assets/${node.assetId}/images?stateId=${encodeURIComponent(node.stateId||'')}&role=${encodeURIComponent(node.role||'main')}`)).mediaPath;
            } else if((node.type==='shot'||node.type==='video')&&node.segmentId) {
              if(!file.name.toLowerCase().endsWith('.mp4'))throw new Error('片段导入支持 MP4');
              importedMediaPath=(await this.upload(file,`/api/projects/${p.id}/episodes/${ep.id}/segments/${node.segmentId}/media`)).mediaPath;
            } else throw new Error('请把图片拖到资产节点，把 MP4 拖到片段节点');
            await this.openProject(p.id);
            if(node.type==='asset')return this.project?.assets?.find(a=>a.id===node.assetId)?.images.find(i=>i.mediaPath===importedMediaPath)?.id;
            return importedMediaPath?this.project?.episodes.find(e=>e.id===ep.id)?.segments.find(s=>s.id===node.segmentId)?.artifacts.find(a=>a.kind==='video'&&a.mediaPath===importedMediaPath)?.id:undefined;
          }finally{this.busy=false;}
        }});
    } else if (this.nativeCanvas) {this.nativeCanvas.destroy();this.nativeCanvas=undefined;}
  }

  private focusEpisodes() {
    this.querySelector('#project-episodes')?.scrollIntoView({ block: 'start' });
  }

  private renderProjectNav(project: Project): string {
    return `<div class="project-heading"><div><span class="eyebrow">项目</span><div class="project-name-line"><h1>${esc(project.name)}</h1><button data-action="rename-project" data-id="${project.id}">改名</button><details class="project-options"><summary aria-label="删除项目" title="删除项目（移至回收区）">${uiIcon('trash')}</summary><div><button class="danger" data-action="archive-project">删除项目</button></div></details></div></div><span class="chip">${project.mode === 'standard' ? '常规漫剧' : '抖音推文漫剧'}</span></div><nav class="project-nav">
      <button class="${this.tab === 'settings' || this.tab === 'episodes' ? 'current' : ''}" data-action="project-settings">项目概览</button>
      ${project.mode === 'standard' ? `<button class="${this.tab === 'sourcePlan' ? 'current' : ''}" data-action="source-plan">原文自动分集</button>` : ''}
      <button class="${this.tab === 'assets' ? 'current' : ''}" data-action="tab" data-tab="assets">资产与状态</button>
      <button class="${this.tab === 'tasks' ? 'current' : ''}" data-action="tab" data-tab="tasks">Agent 任务</button>
    </nav>`;
  }

  private renderProviderSettings(): string {
    const archived = this.projects.filter(item => item.archivedAt);
    const roles = [
      { kind: 'text', label: '文本模型' }, { kind: 'image', label: '图片模型' },
      { kind: 'video', label: '视频模型' },
    ] as const;
    const currentRole = roles.find(item => item.kind === this.settingsModelKind)!;
    const options = this.directModels.filter(item => item.kind === currentRole.kind).map(item => item.id);
    return `<div class="provider-page"><div class="page-title"><div><span class="eyebrow">软件设置</span><h1>全局设置</h1><p>API Key 保存在本机；默认模型供新项目继承，现有项目保留各自配置。</p></div></div>
      ${renderAppNotice(this.message)}
      ${renderSoftwareUpdate(this.softwareUpdate)}
      ${renderAgentSettings(this.productionDefaults,this.agentEntry?.readiness)}
      <section class="panel" aria-label="本机超分"><h2>本机超分</h2><p>启动时自动识别已有组件；导出时勾选真实 2 倍超分即可。</p><div data-upscale-status>${this.renderUpscaleStatus()}</div><details data-upscale-advanced ${this.upscaleAdvancedOpen?'open':''}><summary>高级设置：连接其他超分目录</summary><label>工具目录<input name="upscale-tool-directory" value="${esc(this.upscaleSettings.mode==='custom'?this.upscaleSettings.toolDirectory:'')}" placeholder="留空使用自动识别"/></label><p class="muted">已有独立工具可填写包含 upscale-tool.json 的目录。留空保存恢复自动识别。</p><button data-action="save-upscale-settings" ${this.upscaleChecking||this.upscaleSettings.setup.status==='preparing'?'disabled':''}>${this.upscaleChecking?'正在检查…':'保存并检查'}</button></details></section>
      <section class="panel"><div class="panel-head"><div><h2>木木工坊 API</h2><p>接口已内置。填写 API Key 后可实时获取模型列表；本地参考图由模型接口自动转为可访问素材。</p></div><span class="chip ${this.directProvider.configured ? 'green' : ''}">${this.directProvider.configured ? '已保存' : '待配置'}</span></div>
        <div class="provider-links"><button data-action="account-login">${this.billing?.account?.connected?'切换木木账户':'登录木木 API'}</button>${this.billing?.account?.connected?'<button data-action="account-logout">取消连接</button>':''}<a class="button-link" href="https://api.mumugofe.com/console/token" target="_blank" rel="noopener noreferrer">管理密钥</a></div>${this.accountError?`<div class="notice error" role="alert" aria-label="木木登录错误">登录失败：${esc(this.accountError)}</div>`:''}<p class="muted">点击登录后将进入木木网页，完成登录并授权后自动返回软件。账户余额自动更新，生成所用密钥在下方单独保存。</p><div class="settings-key-row"><label>API Key<input name="direct-api-key" type="password" autocomplete="new-password" placeholder="${this.directProvider.hasKey ? '已保存；留空保持原密钥' : '填写你的 API Key'}"/></label><button class="primary" data-action="save-direct-provider">${this.directProvider.configured ? '更新并读取模型' : '保存并读取模型'}</button>${this.directProvider.configured ? '<button data-action="refresh-direct-models">刷新模型列表</button>' : ''}</div>
        <p class="muted">${this.directModelsFetchedAt ? `最近读取：${esc(new Date(this.directModelsFetchedAt).toLocaleString())}，共 ${this.directModels.length} 个模型。` : '保存后自动读取模型列表。'}密钥保存在本机加密配置中。</p>${billingPanel(this.billing)}<div class="provider-prices-head"><h3>默认模型价格</h3>${this.directProvider.configured?'<button data-action="refresh-billing">刷新余额与价格</button>':''}</div>${this.billing?`<dl class="provider-prices">${(['text','image','video'] as const).map(kind=>`<div class="provider-model-price" data-price-kind="${kind}"><dt><span>${({text:'文本',image:'图片',video:'视频'})[kind]}</span><strong>${esc(this.globalModels[kind]?.modelId||'尚未选择模型')}</strong></dt><dd>${esc(modelPriceLabel(this.billing,this.globalModels[kind]?.modelId||'',kind))}</dd></div>`).join('')}</dl><p class="muted provider-pricing-error" ${this.billing.pricingError?'':'hidden'}>价格暂未读取，请刷新重试。</p>`:''}</section>
      <section class="panel"><h2>本机预检与备份恢复</h2><p>${this.runtime?.tools.map(tool=>`${tool.name}：${tool.available?'可用':'缺失'}`).join('；')}</p><p>数据：${esc(this.runtime?.dataDirectory)}；备份：${esc(this.runtime?.backupDirectory)}</p><p>${esc(this.runtime?.notes)}</p><label><input type="checkbox" name="backup-media">包含素材（会额外复制素材占用磁盘）</label><button data-action="backup-storage">创建一致备份</button>${this.backups.map(backup=>`<p>${esc(backup.createdAt)} · ${backup.mediaIncluded?'包含素材':'仅数据库'} <button data-action="restore-storage" data-backup-id="${backup.id}">恢复到新目录</button></p>`).join('')}<p>恢复只创建新目录，保留当前数据；备份不含API密钥。切换数据目录需关闭本实例后重新启动。</p></section>
      <section class="panel"><h2>默认生成模型</h2>${this.directProvider.configured?catalogFeedback(this.directProvider.catalogMode,this.directModelsError,this.directModels.length,this.directModels.length):'<p class="muted">三个默认模型已预置。保存自己的密钥后可开始生成，也可以读取目录改选其他模型。</p>'}${this.project?'<button data-action="project-model-settings">查看／更改当前项目模型</button>':''}<p>新项目自动继承这三个选择；已有项目保留自己的模型配置。</p>
        <div class="model-role-list">${roles.map(item => `<button class="model-role ${this.settingsModelsOpen && this.settingsModelKind === item.kind ? 'active' : ''}" data-action="open-model-kind" data-kind="${item.kind}" ${this.directProvider.configured ? '' : 'disabled'}><span>${item.label}</span><strong>${esc(this.globalModels[item.kind]?.modelId || '待选择')}</strong><small>选择 →</small></button>`).join('')}</div>
        ${this.settingsModelsOpen && this.directProvider.configured ? `<div class="settings-expand global-model-detail"><div class="settings-expand-head"><h3>选择${currentRole.label}</h3><button data-action="close-model-kind">收起</button></div>${modelPicker(options,this.globalModels[currentRole.kind]?.modelId||'','global-model-id')}${catalogFeedback(this.directProvider.catalogMode,this.directModelsError,this.directModels.length,options.length)}<label>模型 ID<input name="global-model-id" list="global-catalog-${currentRole.kind}" value="${esc(this.globalModels[currentRole.kind]?.modelId || '')}" placeholder="${options.length ? '点击选择或输入搜索模型' : '可手动输入模型 ID'}"/><datalist id="global-catalog-${currentRole.kind}">${options.map(item => `<option value="${esc(item)}"></option>`).join('')}</datalist></label><p class="muted">${options.length ? `实时目录中有 ${options.length} 个${currentRole.label}可选。` : '模型目录尚未读取或无法判断类型，可手动输入 ID。'}</p><button class="primary" data-action="save-global-model">保存${currentRole.label}</button></div>` : ''}</section>
      ${archived.length ? `<section class="panel"><h2>项目回收区 <span class="chip">${archived.length}</span></h2><p>恢复后项目及其中的分集、原文和素材仍可使用。</p><div class="archived-projects">${archived.map(item => `<div><strong>${esc(item.name)}</strong><button data-action="restore-project" data-id="${item.id}">恢复项目</button></div>`).join('')}</div></section>` : ''}
    </div>`;
  }

  private renderEpisodeList(project: Project): string {
    const query = this.episodeQuery.toLocaleLowerCase();
    const matches = (item: Episode) => !query || String(item.number).includes(query.replace(/^ep\s*/i, '')) || item.title.toLocaleLowerCase().includes(query);
    const episodes = project.episodes.filter(matches);
    const pageCount = Math.max(1, Math.ceil(episodes.length / 20));
    const page = Math.min(pageCount, Math.max(1, this.episodePage));
    const visible = episodes.slice((page - 1) * 20, page * 20);
    const archived = (project.archivedEpisodes || []).filter(matches);
    return `<section id="project-episodes" class="episode-list-page"><div class="episode-section-head"><div><span class="eyebrow">项目内容</span><h2>分集</h2><p>共 ${project.episodes.length} 集。选择一集进入原文、剧本、片段画布和导出流程。</p></div></div>
      ${project.mode === 'douyin-story' ? `<section class="episode-add"><div><strong>新增分集</strong><small>每次最多创建 100 集，可多次追加。</small></div><input name="episode-count" type="number" min="1" max="100" value="1" aria-label="本次创建集数"/><button data-action="add-episodes">创建分集</button></section>` : project.episodes.length === 0 ? '<section class="episode-add"><span>先从完整原文规划分集。</span><button data-action="source-plan">前往原文自动分集</button></section>' : ''}
      <div class="episode-list-toolbar"><label>查找分集<input name="episode-search" value="${esc(this.episodeQuery)}" placeholder="输入集数或标题"/></label><button data-action="episode-search">搜索</button><span>${episodes.length} 条结果</span></div>
      <div class="episode-list">${visible.map(item => `<button class="episode-list-row" data-action="open-episode" data-id="${item.id}"><span class="episode-number">EP ${item.number}</span><span class="episode-title" title="${esc(item.title)}">${esc(item.title)}</span><span class="chip ${item.scriptLockedHash ? 'green' : ''}">${item.scriptLockedHash ? '剧本已锁定' : item.sourceReviewedHash ? '原文已确认' : '待处理'}</span><span class="episode-open">进入制作 →</span></button>`).join('') || '<div class="episode-list-empty">没有匹配的分集。</div>'}</div>
      ${pageCount > 1 ? `<div class="episode-pagination"><button data-action="episode-page" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>上一页</button><span>第 ${page} / ${pageCount} 页</span><button data-action="episode-page" data-page="${page + 1}" ${page === pageCount ? 'disabled' : ''}>下一页</button></div>` : ''}
      ${project.archivedEpisodes?.length ? `<details class="episode-recycle"><summary>分集回收区 · ${project.archivedEpisodes.length}</summary>${archived.slice(0, 20).map(item => `<div class="episode-recycle-row"><span>EP ${item.number}　${esc(item.title)}</span><button data-action="restore-episode" data-id="${item.id}">恢复</button></div>`).join('') || '<p>没有匹配的分集。</p>'}${archived.length > 20 ? '<p class="muted">仅显示前 20 条；可按集数或标题搜索。</p>' : ''}</details>` : ''}
    </section>`;
  }

  private renderWork(project: Project, episode: Episode): string {
    if (this.tab === 'canvas' && this.canvasView === 'graph') return `${renderAppNotice(this.message,'graph-notice')}${this.renderCanvas(episode)}${this.graphWorkflow ? `<div class="graph-workflow-overlay"><section class="graph-workflow-panel"><header><strong>当前剧集 · ${({source:'原文与高光',script:'正式剧本与分段',assets:'资产与状态',export:'审片放行与导出',effects:'特效',review:'逐句审片与版本详情'} as Record<string,string>)[this.graphWorkflow]||'制作准备'}</strong><button data-action="graph-workflow-close">返回画布</button></header>${this.graphWorkflow==='source'?this.renderSource(episode):this.graphWorkflow==='script'?this.renderScript(episode):this.graphWorkflow==='assets'?this.renderAssets(project):this.graphWorkflow==='export'?this.renderExport(project,episode):this.graphWorkflow==='review'?this.renderVersionTable(episode):this.renderEffects(episode)}</section></div>` : ''}`;
    const next = this.nextStep(episode);
    return `<button class="back-to-project" data-action="tab" data-tab="episodes">← 返回 ${esc(project.name)} / 分集</button><div class="page-title"><div><span class="eyebrow">${project.mode === 'standard' ? '常规漫剧' : '抖音推文漫剧'} · EP ${episode.number}</span><h1>${esc(episode.title)}</h1></div><div class="page-tools"><div class="audit-pill ${this.approved ? 'ok' : ''}">${this.approved ? '五层核对已放行' : this.auditIssues.length ? `待修正 ${this.auditIssues.length} 项` : '待人工核对'}</div><button class="danger" data-action="archive-episode">移除本集</button></div></div>
      <section class="next-step"><span>下一步：${esc(next.label)}</span><button data-action="go-next" data-tab="${next.tab}">前往处理</button>${next.operation ? `<button data-action="continue-production" data-operation="${next.operation}">继续制作</button>` : ''}</section>
      <nav class="tabs">${(['source', 'script', 'canvas', 'export', 'effects'] as Tab[]).map(tab => `<button class="${this.tab === tab ? 'current' : ''}" data-action="tab" data-tab="${tab}">${({source:'原文与高光',script:'正式剧本',canvas:'制作关系图',export:'剪映导出',effects:'特效库'} as Record<string,string>)[tab]}</button>`).join('')}</nav>
      ${renderAppNotice(this.message)}
      ${this.tab === 'source' ? this.renderSource(episode) : this.tab === 'script' ? this.renderScript(episode) : this.tab === 'canvas' ? this.renderCanvas(episode) : this.tab === 'export' ? this.renderExport(project, episode) : this.renderEffects(episode)}`;
  }

  private renderCanvasJourney(project:Project,ep:Episode):string {
    const next=this.nextStep(ep);
    const steps=[{tab:'source',label:'1 原文与高光',done:Boolean(ep.highlightReviewedHash)},{tab:'script',label:'2 剧本与分段',done:Boolean(ep.scriptLockedHash)},{tab:'assets',label:'3 资产与选图',done:Boolean(project.assets?.length)},{tab:'canvas',label:'4 生成与审片',done:this.sampleApproved},{tab:'export',label:'5 放行与导出',done:this.approved}];
    return `<section class="graph-journey"><div>${steps.map(step=>`<button data-action="${step.tab==='canvas'?'graph-workflow-close':'graph-workflow'}" data-tab="${step.tab}">${step.done?'✓ ':''}${step.label}</button>`).join('')}</div><small>下一步：${esc(next.label)}。图片与视频均在节点内生成、比较、选用；准备资料在此展开。</small></section>`;
  }

  private nextStep(ep: Episode): { tab: Tab; label: string; operation?: 'resume' | 'retry' | 'prompts' } {
    if (!ep.sourceReviewedHash) return { tab: 'source', label: '完整阅读并确认原文' };
    if (!ep.highlightReviewedHash) return { tab: 'source', label: '核对高光剧情报告' };
    if (!ep.scriptLockedHash) return { tab: 'script', label: '完成并锁定正式剧本' };
    const jobs = this.jobs.filter(job => job.episode_id === ep.id);
    if (jobs.some(job => job.status === 'running' || job.status === 'queued'))
      return { tab: 'canvas', label: '等待后台任务完成，可在画布查看逐段进度' };
    if (jobs.some(job => job.status === 'paused'))
      return { tab: 'canvas', label: '后台任务已暂停，可安全继续', operation: 'resume' };
    if (jobs.some(job => job.status === 'failed' && job.kind === 'video'))
      return { tab: 'canvas', label: '视频任务失败或远端状态不明，请先查询并找回，避免重复付费' };
    if (jobs.some(job => job.status === 'failed'))
      return { tab: 'canvas', label: '本地生成任务失败，可重试未完成项', operation: 'retry' };
    if (ep.assetCandidate || !(this.project?.assets || []).length)
      return { tab: 'assets', label: '提取并核对人物、场景、道具及外观状态' };
    try {
      if (ep.segments.some(segment => {
        const refs = segmentReferences(this.project!, ep, segment);
        const video = videoReferences(this.project!, ep, segment);
        return refs.some(ref => !ref.mediaPath) || refs.some(ref => requiresPortraitReference(ref) &&
          !video.some(item => item.assetId === ref.assetId && item.referenceLayout === 'three-view-portrait'));
      })) return { tab: 'assets', label: '补齐本集已绑定人物的完整四视图与场景、道具参考' };
    } catch { return { tab: 'assets', label: '修正片段资产绑定与剧情状态' }; }
    if (ep.segments.some(segment => !segment.visualPlan.trim()))
      return { tab: 'canvas', label: '补齐片段视觉计划与机位' };
    if (ep.segments.some(segment => !segment.subshotsReviewed))
      return { tab: 'canvas', label: '让模型规划子镜并逐镜核对节奏、声音与末帧' };
    const promptStates=ep.segments.map(segment=>({segment,...promptReadiness(ep,segment,this.project!)}));
    const pendingPrompt=promptStates.find(item=>item.state==='candidate');
    if(pendingPrompt)return {tab:'canvas',label:`片段 ${pendingPrompt.segment.number} 的新版已生成，请核对并选用`};
    if(promptStates.some(item=>item.state!=='ready'))
      return { tab: 'canvas', label: '补齐缺失或需要修正的片段提示词', operation: 'prompts' };
    if (this.auditIssues.length) return { tab: 'canvas', label: `修正 ${this.auditIssues.length} 项分镜、参考图或提示词问题` };
    if (!this.approved) return { tab: 'export', label: '人工完成五层无损核对' };
    if (ep.segments.some(segment => !segment.artifacts.some(item => item.id === segment.selected.video &&
      item.review?.status === 'approved'))) return { tab: 'canvas', label: '试片、批量出片并逐段审片' };
    return { tab: 'export', label: '核对高光与导出剪映草稿' };
  }

  private renderProjectSpotlight(project:Project):string {
    const episode=project.episodes.find(e=>e.id===this.episodeId)||project.episodes[0];
    if(project.demo&&episode)return `<section class="project-spotlight demo-spotlight"><div class="spotlight-copy"><div class="spotlight-status"><span class="chip">演示样片</span></div><h2>从文字到成片</h2><p>${esc(project.demo.description)}</p><p class="muted">示例已保存在本机，可以直接观看和查看制作过程。</p><button class="primary" data-action="open-episode" data-id="${episode.id}">${uiIcon('film')}查看制作画布</button></div><figure class="demo-preview"><video src="${esc(mediaUrl(project.demo.previewMediaPath))}" controls playsinline preload="metadata" aria-label="万灵漫剧演示样片"></video><figcaption>原文与高光 → 资产与分镜 → 视频 → 合成预览</figcaption></figure></section>`;
    if(!episode)return `<section class="project-spotlight"><div class="spotlight-copy"><h2>从完整故事开始制作</h2><p>导入原文，核对高光剧情，再建立分集。</p><button class="primary" data-action="${project.mode==='standard'?'source-plan':'add-episodes'}">${project.mode==='standard'?'规划第一集':'创建第一集'}</button>${project.mode==='douyin-story'?'<input name="episode-count" type="hidden" value="1"/>':''}</div></section>`;
    const clips=episode.segments.slice(0,3).map(segment=>({segment,video:segment.artifacts.find(a=>a.id===segment.selected.video&&a.kind==='video')}));
    const ready=episode.segments.filter(s=>s.artifacts.some(a=>a.id===s.selected.video&&a.kind==='video'&&(a.userAcceptance?.status==='accepted'||a.review?.status==='approved'))).length;
    return `<section class="project-spotlight"><div class="spotlight-copy"><div class="spotlight-status"><span>当前剧集</span><span class="chip ${episode.scriptLockedHash?'green':''}">${episode.scriptLockedHash?'剧本已锁定':'待完成剧本'}</span></div><h2>EP ${episode.number}<br>${esc(episode.title)}</h2><p>${episode.segments.length} 个片段，${ready} 个选用视频已审核或验收通过。</p><button class="primary" data-action="open-episode" data-id="${episode.id}">${uiIcon('film')}继续制作</button></div><div class="spotlight-reel" aria-label="当前剧集片段预览">${clips.map(({segment,video})=>`<figure><div class="reel-media">${video?.mediaPath?`<video src="${esc(mediaUrl(video.mediaPath))}#t=0.1" controls preload="metadata" aria-label="片段 ${segment.number} 预览"></video>`:`<div class="reel-empty">${uiIcon('film')}<span>待生成视频</span></div>`}</div><figcaption><strong>片段 ${segment.number}</strong><span>${video?video.userAcceptance?.status==='accepted'?'验收通过':video.review?.status==='approved'?'审核通过':video.review?.status==='rejected'?'需重做':'待审片':'尚无选用'}</span></figcaption></figure>`).join('')||'<div class="reel-empty">完成正式剧本后建立分镜片段</div>'}</div></section>`;
  }

  private renderSettings(project: Project): string {
    const style = project.visualStyle || { name: '', description: '' };
    const categories = ['古风仙侠', '都市悬疑', '末世科幻', '卡通通用'];
    const selectedPreset = stylePresets.find(item => item.id === style.presetId) ||
      (!style.presetId ? stylePresets.find(item => item.name === style.name) : undefined);
    const aspect = project.aspectRatio || '16:9';
    return `<div class="settings-page">
      ${renderAppNotice(this.message)}
      ${this.renderProjectSpotlight(project)}
      <details class="project-config" data-project-config ${this.projectConfigOpen||this.settingsStylePickerOpen?'open':''}><summary><strong>项目画面设置</strong><span>${esc(style.name||'待选择风格')} / ${esc(aspect)}</span></summary><div class="overview-config-grid"><section class="panel overview-card"><div class="overview-card-head"><div><span class="eyebrow">项目设置</span><h2>画面风格</h2></div><span class="chip ${style.name ? 'green' : ''}">${style.name ? '已选择' : '待选择'}</span></div>
        <div class="overview-style-preview"><div class="overview-style-art">${selectedPreset ? `<img src="/style-thumbs/${esc(selectedPreset.thumb)}" alt="${esc(selectedPreset.name)}预览"/>` : '<span>3D</span>'}</div><div><strong>${esc(style.name || '还没有选择风格')}</strong><p>${esc(style.description || '为整个项目选择统一的画面风格。')}</p></div></div><button data-action="open-style-picker">${style.name ? '更换风格' : '选择风格'}</button></section>
        <section class="panel overview-card"><div class="overview-card-head"><div><span class="eyebrow">项目设置</span><h2>画面格式</h2></div><span class="chip green">${esc(aspect)}</span></div><div class="overview-aspect-preview"><div class="aspect-shape ${aspect === '9:16' ? 'portrait' : aspect === '1:1' ? 'square' : 'landscape'}"></div><span>${aspect === '9:16' ? '竖版 9:16' : aspect === '1:1' ? '方形 1:1' : '横版 16:9'}</span></div><div class="overview-aspect-controls"><select name="project-aspect" aria-label="项目画面格式"><option value="16:9" ${aspect === '16:9' ? 'selected' : ''}>横版 16:9</option><option value="9:16" ${aspect === '9:16' ? 'selected' : ''}>竖版 9:16</option><option value="1:1" ${aspect === '1:1' ? 'selected' : ''}>方形 1:1</option></select><button data-action="save-aspect">保存格式</button></div></section>
        ${this.settingsStylePickerOpen ? `<section class="panel overview-picker"><div class="settings-expand-head"><h2>选择项目风格</h2><button data-action="close-style-picker">收起</button></div><div class="style-workspace"><div class="style-browser">${categories.map(category => `<div class="style-category-group"><h3 class="style-category">${category}</h3><div class="style-gallery">${stylePresets.filter(item => item.category === category).map(item => `<button type="button" class="style-card ${selectedPreset?.id === item.id ? 'selected' : ''}" data-action="select-style" data-id="${esc(item.id)}"><img src="/style-thumbs/${esc(item.thumb)}" alt="${esc(item.name)}预览" loading="lazy"/><strong>${esc(item.name)}</strong></button>`).join('')}</div></div>`).join('')}</div><div class="style-editor"><span class="eyebrow">风格细节</span><input type="hidden" name="style-preset-id" value="${esc(style.presetId || selectedPreset?.id || '')}"/><label>风格名称<input name="style-name" value="${esc(style.name)}" placeholder="从左侧图卡选择风格"/></label><label>统一视觉要求<textarea name="style-description" class="style-text" placeholder="人物造型、色彩、光影和场景质感；不要添加剧情。">${esc(style.description)}</textarea></label><p class="muted">只调整画面。剧情仍以原文和正式剧本为准。</p><button class="primary" data-action="save-style">保存项目风格</button></div></div></section>` : ''}
      </div></details>
      <details class="panel project-model-settings" data-project-model-settings ${this.projectModelsOpen?'open':''}><summary><strong>本项目生成模型</strong> · ${esc(project.textModel?.modelId || '文本待选择')} / ${esc(project.imageModel?.modelId || '图片待选择')} / ${esc(project.videoModel?.modelId || '视频待选择')}</summary><p>这些模型用于本项目的实际请求与 Agent 制作。新项目默认模型单独保存；可逐项选择，或将本项目改用已保存的默认模型。</p><div class="model-grid">
        ${this.renderModelCard('text','文本模型','剧情分析、剧本和分镜建议实际使用的模型。',project.textModel)}
        ${this.renderModelCard('image','图片模型','人物、场景和道具图片实际使用的模型。',project.imageModel)}
        ${this.renderModelCard('video','视频模型','分镜视频实际使用的模型。',project.videoModel)}
      </div></details><section class="panel" data-project-label-settings><h2>浮签字体</h2>${renderLabelStyle(project.labelStyle,this.labelFonts)}<div class="actions"><button data-action="check-label-fonts">检测本机字体</button><button class="primary" data-action="save-label-style">保存字体偏好</button></div></section>${this.renderEpisodeList(project)}
    </div>`;
  }

  private renderModelCard(kind: 'text' | 'image' | 'video', label: string, purpose: string,
    current?: VideoModel): string {
    const model = current || { name: '', modelId: '', adapterPath: '' };
    const ready = Boolean(model.adapterPath || kind === 'video' && this.health.videoAdapter);
    const legacy = model.adapterPath?.endsWith(`mumu-${kind}.mjs`);
    const check = this.project?.modelChecks?.[kind];
    const connected = Boolean(check && check.adapterPath === model.adapterPath && check.modelId === model.modelId);
    const options = this.directModels.filter(item => item.kind === kind).map(item => item.id);
    const defaultModel = this.globalModels[kind];
    const defaultSwitch = this.project && this.directProvider.hasKey && defaultModel &&
      (current?.modelId !== defaultModel.modelId || current?.adapterPath !== defaultModel.adapterPath) ?
      `<button data-action="use-project-default-model" data-project-id="${esc(this.project.id)}" data-model-kind="${kind}" data-model-hash="${digest(current ?? null)}" data-default-model-hash="${digest(defaultModel)}">本项目改用 ${esc(defaultModel.modelId)}</button>` : '';
    return `<div class="model-card" data-model-kind="${kind}"><div class="panel-head"><div><h3>${label}</h3><p>${purpose}</p></div><span class="chip ${connected && !legacy ? 'green' : ''}">${legacy ? '旧联动配置' : connected ? '直连已测试' : ready ? '适配器已配置' : '待接入'}</span></div>
      <label>模型名称<input name="model-name" value="${esc(model.name)}" placeholder="例如：服务商给出的模型名"/></label>
      ${modelPicker(options,model.modelId||'','model-id')}${catalogFeedback(this.directProvider.catalogMode,this.directModelsError,this.directModels.length,options.length)}<label>模型 ID<input name="model-id" list="catalog-${kind}" value="${esc(model.modelId)}" placeholder="${options.length ? '点击选择或输入搜索模型' : '先读取模型列表，也可手填 ID'}"/><datalist id="catalog-${kind}">${options.map(item => `<option value="${esc(item)}"></option>`).join('')}</datalist></label>
      ${options.length ? `<small>实时目录中有 ${options.length} 个${label}可选</small>` : ''}
      ${kind === 'video' ? `<label>固定片段秒数（可变时长留空）<input name="model-fixed-duration" type="number" min="1" value="${current?.capabilities?.fixedDurationSec ?? ''}" placeholder="例如 30"/></label>` : ''}
      ${kind === 'video' ? `<details><summary>生成能力与提交限制（需人工确认）</summary><p>目录声明、人工确认和试片结果分别保存；目录未知的能力保持待确认。连接检查不代表成片验收。</p><pre>目录声明：${esc(JSON.stringify(this.directModels.find(item=>item.id===model.modelId)?.declaredCapabilities || model.declaredCapabilities || {}))}</pre><p>人工确认时间：${esc(model.capabilities?.confirmedAt || '待确认')}；当前试片状态：${this.sampleApproved ? '当前版本已放行' : '当前版本未放行'}</p><label>最短秒数<input name="model-min-duration" type="number" value="${model.capabilities?.minDurationSec ?? ''}"/></label><label>输出分辨率<input name="model-output-resolution" placeholder="1920x1080" value="${esc(model.capabilities?.outputResolution)}"/></label><label>单段最长秒数<input name="model-max-duration" type="number" min="1" value="${current?.capabilities?.maxDurationSec ?? ''}" placeholder="由服务商提供"/></label><label>最多参考图数<input name="model-max-references" type="number" min="1" value="${current?.capabilities?.maxReferences ?? ''}" placeholder="人物、场景、道具"/></label><label>完整提示词字数上限<input name="model-max-prompt" type="number" min="100" value="${current?.capabilities?.maxPromptChars ?? ''}" placeholder="超限时拆分片段"/></label><label>原生对白/OS声音<select name="model-native-audio"><option value="unknown" ${current?.capabilities?.nativeAudio == null ? 'selected' : ''}>待确认</option><option value="yes" ${current?.capabilities?.nativeAudio === true ? 'selected' : ''}>支持</option><option value="no" ${current?.capabilities?.nativeAudio === false ? 'selected' : ''}>不支持</option></select></label><label>固定秒数<input name="model-fixed-duration" type="number" value="${current?.capabilities?.fixedDurationSec ?? ''}"></label><label>支持分辨率（逗号分隔）<input name="model-resolutions" value="${esc(current?.capabilities?.resolutions?.join(','))}"></label>${(['referenceVideo','referenceAudio'] as const).map(key=>`<label>${key === 'referenceVideo' ? '参考视频' : '参考音频'}<select name="model-${key}"><option value="unknown">待确认</option><option value="yes" ${current?.capabilities?.[key]===true ? 'selected' : ''}>支持</option><option value="no" ${current?.capabilities?.[key]===false ? 'selected' : ''}>不支持</option></select></label>`).join('')}<label>支持画幅（逗号分隔）<input name="model-aspects" value="${esc(current?.capabilities?.aspectRatios?.join(',') || '')}" placeholder="16:9,9:16"/></label></details>` : ''}
      <details><summary>高级：本机适配器</summary><label>适配器绝对路径<input name="model-adapter" value="${esc(model.adapterPath)}" placeholder="E:\\...\\${kind}-adapter.mjs"/></label><small>这是本机文件路径，不是 API 地址；没有适配器时留空。</small></details>
      <button data-action="save-model">保存本项目${label}选择</button>${defaultSwitch}<button data-action="test-model" ${model.adapterPath ? '' : 'disabled'}>测试连接</button></div>`;
  }

  private async loadAssetCandidate(){
    if(!this.project)return;
    const projectId=this.project.id;
    const target=this.project.episodes.find(ep=>ep.id===this.assetView.candidateEpisodeId&&ep.scriptLockedHash)||this.project.episodes.find(ep=>ep.scriptLockedHash);
    if(!target)return;
    this.assetView.candidateEpisodeId=target.id;
    if(target.id===this.episodeId)return;
    const result=await api<Project>(`/api/projects/${projectId}/view?episodeId=${encodeURIComponent(target.id)}`);
    if(this.project?.id!==projectId||this.assetView.candidateEpisodeId!==target.id)return;
    const current=this.project.episodes.find(ep=>ep.id===target.id),loaded=result.episodes.find(ep=>ep.id===target.id);
    if(current&&loaded)current.assetCandidate=loaded.assetCandidate;
  }

  private renderAssets(project: Project): string {
    const focusedId=this.tab==='canvas'&&this.graphWorkflow==='assets'?this.graphAssetFocusId:'';
    return renderAppNotice(this.message)+renderAssetWorkspace(project,this.assetView,focusedId);
  }

  private renderAnalysisBudget(project: Project): string {
    try {
      const budget=analysisBudget(project.sourceCorpus || '',project.textModel?.adapterPath || '',project.textModel?.modelId);
      return `<section class="panel"><h3>分析前输入与请求预算</h3><p>${budget.characters}字符 · ${budget.chapters.length}个识别章节/范围 · ${budget.batches.length}批；至少${budget.minimumRequests}次请求，含递归汇总预计最多${budget.estimatedMaximumRequests}次。服务商单价未知，无法据此承诺金额。继续/重试会保留已完成批次，远端未知须先对账。</p><details><summary>核对每批完整范围</summary>${budget.batches.map((batch,index)=>`<p>批${index+1}：${batch.start}–${batch.end}，${batch.characters}字符，${esc(batch.titles.join(' / '))}</p>`).join('')}</details><label><input type="checkbox" name="analysis-budget-confirmed">已核对章节识别、批次范围与请求预算，允许提交当前模型分析</label></section>`;
    } catch(error) { return `<p class="notice">规划预检：${esc((error as Error).message)}</p>`; }
  }

  private renderSourcePlan(project: Project): string {
    const plan = project.episodePlan, locked = project.episodes.length > 0 || Boolean(project.archivedEpisodes?.length);
    const progress = this.storyPlanProgress;
    const analyzing = progress?.status === 'running';
    if (locked && !project.sourceCorpus) return `<div class="page-title"><div><span class="eyebrow">常规漫剧 · 已有项目</span><h1>逐集原文项目</h1></div></div><section class="panel"><p>这个项目是在自动分集功能加入前建立的，已有 ${project.episodes.length} 集。原文保存在各集的“原文与高光”中。新项目可从完整原文自动规划集数；现有分集不会被自动重排。</p></section>`;
    return `<div class="page-title"><div><span class="eyebrow">常规漫剧 · 项目原文</span><h1>从原文提取分集</h1></div><span class="audit-pill ${locked ? 'ok' : ''}">${locked ? `已生成 ${project.episodes.length} 集${project.archivedEpisodes?.length ? `，回收区 ${project.archivedEpisodes.length} 集` : ''}` : plan ? `建议 ${plan.ranges.length} 集` : '待导入原文'}</span></div>
      ${renderAppNotice(this.message)}
      <section class="panel"><h2>完整原文</h2><p>粘贴全文或选择 UTF-8 TXT。保存后识别明确的章节标题，按原文连续切分；每个字都保留在对应集的原文里。生成后每集仍需亲自阅读并完成高光剧情报告。</p>
      ${locked ? '' : `<label>导入 TXT 文件<input name="project-source-file" type="file" accept=".txt,text/plain" ${this.sourceSaving ? 'disabled' : ''}/></label><p class="muted">全文最多 700 万字符；UTF-8 TXT 文件最多 21 MB。</p>`}
      <textarea name="project-source" class="long" ${locked || this.sourceSaving ? 'readonly' : ''} placeholder="在这里粘贴完整原文…">${esc(project.sourceCorpus || '')}</textarea>
      ${locked ? '<p class="muted">已有分集，项目原文已锁定。要调整章节组合，请新建项目重新规划。</p>' : `<div class="actions"><button data-action="save-corpus" ${this.sourceSaving ? 'disabled' : ''}>${this.sourceSaving ? '正在保存…' : '保存完整原文'}</button><button data-action="download-corpus" ${this.sourceSaving ? 'disabled' : ''}>下载全文备份</button></div>`}</section>
      ${project.episodePlanProgress?.results.length ? `<details class="panel"><summary>全书人物/事件索引与跨批依据</summary>${project.episodePlanProgress.results.flatMap(result=>result.events || []).map(event=>`<p>${event.sourceStart}–${event.sourceEnd} · ${esc(event.characters.join('、'))} · ${esc(event.summary)}</p><blockquote>${esc(event.sourceQuote)}</blockquote>`).join('')}</details>` : ''}<section class="panel"><h2>分集建议</h2><p>默认每集 ${productionRules(project.productionRules).minChapters}–${productionRules(project.productionRules).maxChapters} 章，由 Agent 完整阅读后按剧情选择章节边界。下方可手动按固定章节数预览，再一次性创建。章节标题无法识别时请先核对边界。</p>
      <label>每集原文章节数<input name="chapters-per-episode" type="number" min="1" max="10" value="${plan?.chaptersPerEpisode || productionRules(project.productionRules).fixedChapters}" ${locked ? 'disabled' : ''}/></label>
      ${locked ? '' : `<div class="actions"><button data-action="preview-plan" ${analyzing ? 'disabled' : ''}>按章节预览</button><button data-action="suggest-plan" ${project.textModel?.adapterPath && !analyzing ? '' : 'disabled'}>${progress?.status === 'failed' || progress?.status === 'interrupted' ? '继续分批分析' : analyzing ? '分批分析中' : '用文本模型建议剧情分集'}</button></div>
      ${project.sourceCorpus && project.textModel?.adapterPath ? this.renderAnalysisBudget(project) : ''}
      <p class="muted">模型分析默认每批 5 章；章节过长时自动缩小批次。逐批核对边界，完成后才能确认分集。</p>
      ${progress ? `<p class="${progress.status === 'failed' ? 'notice' : 'muted'}">${progress.status === 'running' ? `已完成 ${progress.completedBatches}/${progress.totalBatches} 批，正在分析第 ${progress.completedBatches + 1} 批。` : progress.status === 'completed' ? `已完成 ${progress.totalBatches} 批分析。` : `已完成 ${progress.completedBatches}/${progress.totalBatches} 批；${progress.status === 'interrupted' ? '服务曾中断，可点击继续。' : esc(progress.error)}`}</p>` : ''}`}
      ${plan ? `<p class="muted">${plan.method === 'story' ? '文本模型建议的剧情边界，请对照原文核实' : plan.hasHeadings ? '根据原文章节标题识别' : '未识别到章节标题；当前仅为完整原文单集'} · 共 ${plan.ranges.length} 集 · 范围连续覆盖全文</p><div class="episode-plan-list">${plan.ranges.map((range, index) => `<article class="episode-plan-row"><strong>EP ${index + 1}</strong><span>${esc(range.chapters.join(' → '))}</span><small>${range.charCount} 字 · 原文位置 ${range.start + 1}–${range.end}</small></article>`).join('')}</div>${locked ? '' : `<div class="actions"><button class="primary" data-action="apply-plan" ${analyzing ? 'disabled' : ''}>确认并生成这些分集</button></div>`}` : ''}</section>`;
  }

  private renderSource(ep: Episode): string {
    return `<div class="two-col"><section class="panel"><div class="panel-head"><h2>01 原文章节</h2><span class="chip ${ep.sourceReviewedHash ? 'green' : ''}">${ep.sourceReviewedHash ? '已确认阅读' : '待阅读确认'}</span></div><p>${ep.sourceRange ? `项目全文位置 ${ep.sourceRange.start + 1}–${ep.sourceRange.end}，包含 ${esc(ep.sourceRange.chapters.join('、'))}。原文由自动分集生成，请完整阅读并确认。` : '粘贴拟改编章节的完整原文，读完后确认。锁定剧本后原文不能静默改动。'}</p><textarea name="source-text" class="long" ${ep.scriptLockedHash || ep.sourceRange ? 'readonly' : ''} placeholder="完整原文章节…">${esc(ep.sourceText)}</textarea><div class="actions">${ep.sourceRange ? '' : `<button data-action="save-source" ${ep.scriptLockedHash ? 'disabled' : ''}>保存原文</button>`}<button class="primary" data-action="confirm-source" ${ep.scriptLockedHash ? 'disabled' : ''}>我已完整阅读</button></div></section>
      <section class="panel"><div class="panel-head"><h2>02 高光剧情报告</h2><span class="chip ${ep.highlightReviewedHash ? 'green' : ''}">${ep.highlightReviewedHash ? '已核对' : '待核对'}</span></div><p>记录章节范围、事件因果、人物目的与反应、必须保留的名场面和金句、专名映射、留待后续的素材。</p><button data-action="suggest-highlight" ${ep.sourceReviewedHash && !ep.scriptLockedHash && this.project?.textModel?.adapterPath ? '' : 'disabled'}>文本模型生成待核对报告</button>
      ${ep.highlightCandidate ? `<details class="candidate"><summary>查看模型建议的报告</summary><pre>${esc(ep.highlightCandidate.content)}</pre><button data-action="apply-highlight" ${ep.scriptLockedHash ? 'disabled' : ''}>采用为可编辑报告</button></details>` : ''}
      <textarea name="highlight-report" class="long" ${ep.scriptLockedHash ? 'readonly' : ''} placeholder="章节范围：&#10;事件因果：&#10;人物目的与反应：&#10;名场面与原文金句：&#10;专名映射：&#10;未采用素材：">${esc(ep.highlightReport)}</textarea><div class="actions"><button data-action="save-report" ${ep.scriptLockedHash ? 'disabled' : ''}>保存报告</button><button class="primary" data-action="confirm-report" ${ep.scriptLockedHash ? 'disabled' : ''}>确认报告</button></div></section></div>`;
  }

  private renderScript(ep: Episode): string {
    return `${this.renderStoryReview(ep)}<section class="panel"><div class="panel-head"><div><h2>正式剧本 v${ep.scriptVersion ?? 1}</h2><p>正式剧本是唯一剧情依据；锁稿后可另行规划固定30秒分段，合并或拆分均须完整保留剧情单元。对白与 OS 请逐行写“角色：内容”。</p></div><span class="chip ${ep.scriptLockedHash ? 'green' : ''}">${ep.scriptLockedHash ? '已锁定' : '编辑中'}</span></div>
      ${ep.scriptBeats.map((beat, index) => this.renderBeat(beat, index, Boolean(ep.scriptLockedHash))).join('') || '<div class="empty">完成原文和高光报告后，开始添加剧本节点。</div>'}
      <div class="actions"><button data-action="suggest-script" ${ep.highlightReviewedHash && !ep.scriptLockedHash && this.project?.textModel?.adapterPath ? '' : 'disabled'}>文本模型建议剧本节点</button><button data-action="add-beat" ${ep.scriptLockedHash ? 'disabled' : ''}>＋ 添加剧情节点</button><button class="primary" data-action="lock-script" ${ep.scriptLockedHash ? 'disabled' : ''}>锁定正式剧本并建立画布（自动适配明确特效）</button>${ep.scriptLockedHash ? '<button data-action="new-script-version">归档当前版并建立修订版</button>' : ''}</div>
      ${ep.scriptCandidate ? `<details class="candidate"><summary>查看模型建议的 ${ep.scriptCandidate.beats.length} 个剧本节点</summary><pre>${esc(ep.scriptCandidate.beats.map((beat, index) => `${index + 1}. ${beat.event}\n原文依据：${beat.sourceQuote || '缺失'}\n反应：${beat.reaction}\n${beat.dialogue.join('\n')}\n${beat.os.join('\n')}\n浮签：${beat.floatLabels.join('、')}\n系统：${beat.systemPanels.join('、')}`).join('\n\n'))}</pre><button data-action="apply-script" ${ep.scriptLockedHash ? 'disabled' : ''}>采用为可编辑剧本</button></details>` : ''}
      ${(ep.scriptHistory || []).map(item => `<details class="beat"><summary>已归档剧本 v${item.version} · ${item.scriptBeats.length} 个节点 · ${item.segments.length} 个片段</summary><pre>${esc(item.scriptBeats.map((beat, index) => `${index + 1}. ${beat.event}\n反应：${beat.reaction}\n${beat.dialogue.map(line => `对白：${line}`).join('\n')}\n${beat.os.map(line => `OS：${line}`).join('\n')}\n${beat.floatLabels.map(line => `浮签：${line}`).join('\n')}\n${beat.systemPanels.map(line => `面板：${line}`).join('\n')}`).join('\n\n'))}</pre></details>`).join('')}</section>`;
  }

  private renderStoryReview(ep: Episode): string { return reviewPanel(ep,Boolean(this.project?.textModel?.adapterPath)); }

  private renderBeat(beat: ScriptBeat, index: number, locked: boolean): string {
    const read = locked ? 'readonly' : '';
    return `<article class="beat" data-beat-id="${beat.id}"><div class="beat-title"><strong>节点 ${String(index + 1).padStart(2, '0')}</strong><span>事件与反应是必填项</span></div><div class="form-grid"><label>原文逐字依据<textarea name="sourceQuote" ${read} placeholder="从本集原文复制至少 6 字">${esc(beat.sourceQuote || '')}</textarea></label><label>事件<textarea name="event" ${read}>${esc(beat.event)}</textarea></label><label>人物反应<textarea name="reaction" ${read}>${esc(beat.reaction)}</textarea></label><label>对白（每行一条）<textarea name="dialogue" ${read}>${esc(beat.dialogue.join('\n'))}</textarea></label><label>内心 OS（每行一条）<textarea name="os" ${read}>${esc(beat.os.join('\n'))}</textarea></label><label>声音事件顺序（dialogue:1 / os:1，每行一条）<textarea name="speechOrder" ${read}>${esc(orderedSpeech(beat).map(ref=>`${ref.kind}:${ref.index+1}`).join("\n"))}</textarea></label><label>浮签（每行一条）<textarea name="floatLabels" ${read}>${esc(beat.floatLabels.join('\n'))}</textarea></label><label>系统面板信息（每行一条）<textarea name="systemPanels" ${read}>${esc(beat.systemPanels.join('\n'))}</textarea></label></div>${locked ? '' : '<div class="actions"><button data-action="save-beat">保存节点</button><button class="danger" data-action="delete-beat">删除节点</button></div>'}</article>`;
  }

  private renderCanvas(ep: Episode): string {
    const view=this.canvasView === 'table' ? this.renderVersionTable(ep) : this.renderToolflowGraph(ep);
    return view+(this.promptManagerScope===`${this.project?.id}:${ep.id}`?renderPromptManager(this.project!,ep,this.canvasSelectedSegmentId):'');
  }

  private renderGraphReview(ep: Episode, seg: Segment): string {
    const referenceTab = `<button class="${this.graphReviewMode === 'references' ? 'active' : ''}" data-action="graph-review-references">出片参考图</button>`;
    const anchorTab = `<button class="${this.graphReviewMode === 'anchors' ? 'active' : ''}" data-action="graph-review-anchors">动作示意板</button>`;
    let references: ReturnType<typeof videoReferences> = [], referenceError = '';
    try { references = videoReferences(this.project!, ep, seg); }
    catch (error) { referenceError = error instanceof Error ? error.message : String(error); }
    const referenceBody = referenceError ? `<p class="graph-review-warning">${esc(referenceError)}</p>` :
      references.length ? `<p class="graph-review-note">按当前绑定，下次生成视频依次使用人物、场景、道具参考图；下方轻量动作示意板只用于核对，默认不上传。已有视频可能使用旧图；图和状态不对，请到资产页或片段详情修改。</p>${references.map((ref, index) => {
        const asset = this.project?.assets?.find(item => item.id === ref.assetId);
        const image = asset?.images.find(item => item.id === ref.imageId);
        const explicit = seg.assetBindings?.find(item => item.assetId === ref.assetId)?.imageId;
        return `<section class="graph-reference-card"><div class="graph-reference-heading"><strong>${index + 1}. ${esc(ref.name)}</strong><span>${ref.kind === 'character' ? ref.referenceLayout === 'three-view-portrait' ? '完整四视图＋大头照' : '人物参考' : ({scene:'场景',prop:'道具'} as const)[ref.kind]}</span></div>${ref.mediaPath ? `<button class="graph-reference-image" data-action="graph-lightbox" data-media="${esc(mediaUrl(ref.mediaPath))}" data-label="${esc(ref.name)} · ${esc(ref.stateLabel || '基础状态')}"><img src="${esc(mediaUrl(ref.mediaPath))}" alt="${esc(ref.name)}当前使用的参考图"/></button>` : '<div class="graph-reference-missing">当前状态缺少参考图</div>'}<small>剧情状态：${esc(ref.stateLabel || '基础状态')} · ${explicit ? '手动指定' : '按状态自动选图'}</small><small>图片：${esc(ref.imageId?.slice(0, 8) || '未选中')} · ${image?.source === 'model' ? '模型生成' : image?.source === 'upload' ? '本地导入' : '待补充'}</small>${ref.appearance ? `<p>${esc(ref.appearance)}</p>` : ''}</section>`;
      }).join('')}` : '<p class="graph-review-warning">本片段尚未绑定任何资产参考图。</p>';
    const anchors = seg.artifacts.filter(item => item.kind === 'anchor');
    const selected = seg.artifacts.find(item => item.kind === 'anchor' && item.id === seg.selected.anchor);
    const selectedSvg = selected?.content ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(selected.content)}` : '';
    const anchorBody = `<p class="graph-review-warning">这是可选的无字 SVG 动作建议板，只供核对站位、动作方向和末帧；它不是 3D 演绎图，也不会随视频请求提交。没有建议板仍可完成核对和出片。</p>${selectedSvg ? `<button class="graph-reference-image graph-anchor-large" data-action="graph-lightbox" data-media="${esc(selectedSvg)}" data-label="片段 ${seg.number} 动作示意板"><img src="${esc(selectedSvg)}" alt="片段${seg.number}当前选用的无字动作示意板"/></button><small>当前版本：${esc(selected!.id.slice(0, 8))} · ${anchors.length} 个版本</small>` : '<div class="graph-reference-missing">尚未生成动作建议板（可跳过）</div>'}<div class="graph-review-actions"><button data-action="graph-generate" data-kind="anchor" data-segment-id="${seg.id}">${anchors.length ? '重生成建议板' : '生成建议板'}</button><button data-action="canvas-view" data-view="table">查看全部版本</button></div>`;
    return `<aside class="graph-review"><div class="graph-review-head"><div><small>片段 ${String(seg.number).padStart(2, '0')} · 素材核对</small><strong>${this.graphReviewMode === 'references' ? '当前绑定参考图' : '当前动作示意板'}</strong></div><button data-action="graph-review-close">关闭</button></div><div class="graph-review-tabs">${referenceTab}${anchorTab}</div><div class="graph-review-body">${this.graphReviewMode === 'references' ? referenceBody : anchorBody}<div class="graph-review-actions"><button data-action="tab" data-tab="assets">打开资产与状态</button><button data-action="graph-toggle-detail">片段绑定设置</button></div></div></aside>`;
  }

  private renderVideoCategories(ep: Episode): string {
    const counts = videoCounts(ep);
    const options: { key: VideoCategory | 'all'; label: string; count: number }[] = [
      { key: 'all', label: '全部版本', count: counts.success + counts.waste + counts.pending },
      { key: 'success', label: '成功片段', count: counts.success },
      { key: 'waste', label: '废片段', count: counts.waste },
      { key: 'pending', label: '待审片段', count: counts.pending },
    ];
    return `<div class="video-categories" aria-label="视频版本分类">${options.map(item =>
      `<button class="video-category-filter ${item.key} ${this.canvasView === 'table' && this.videoFilter === item.key ? 'active' : ''}" data-action="video-filter" data-filter="${item.key}">${item.label} <strong>${item.count}</strong></button>`).join('')}<small>按视频版本计数；生成失败任务另见后台任务。</small></div>`;
  }

  private renderToolflowGraph(ep: Episode): string {
    const selected = ep.segments.find(seg => seg.id === this.canvasSelectedSegmentId) || ep.segments[0];
    if (selected) this.canvasSelectedSegmentId = selected.id;
    return `<div class="graph-workspace"><div data-studio-canvas-host></div>
      ${this.graphInspectorOpen ? `<div class="graph-detail"><button data-action="graph-toggle-detail">关闭详情</button>${this.renderSegmentInspector(ep, selected!)}</div>` : ''}
      ${this.graphReviewMode ? this.renderGraphReview(ep, selected!) : ''}
      ${this.graphJobsOpen ? `<section class="graph-jobs panel jobs"><div class="panel-head"><h2>生成任务</h2><button data-action="graph-jobs">关闭</button></div>${agentPanel(this.workflows,ep.id,this.billing,this.project?.productionRules?.delivery||'package')}<h3>后台任务</h3><div class="actions"><button data-action="queue" data-kind="pause">暂停待执行</button><button data-action="queue" data-kind="resume">继续</button><button data-action="queue" data-kind="retry">重试失败</button></div>${this.jobs.slice(0, 30).map(job => `<div class="job"><span>${esc(job.kind)} · ${esc(ep.segments.find(s => s.id === job.segment_id)?.number || '')}</span><b class="${job.status}">${esc(job.status)}</b><small>${esc(job.error || '')}</small>${this.renderTaskControls(job)}${job.kind === 'video' && job.status === 'failed' ? `<button data-action="recover-remote" data-job-id="${job.id}">查询并找回远端视频</button>` : ''}</div>`).join('') || '<p>暂无任务</p>'}</section>` : ''}
      ${this.graphLightbox ? `<div class="graph-lightbox"><div><header><strong>${esc(this.graphLightbox.label)}</strong><button data-action="graph-lightbox-close">关闭大图</button></header><img src="${esc(this.graphLightbox.src)}" alt="${esc(this.graphLightbox.label)}"/></div></div>` : ''}</div>`;
  }

  private renderVersionTable(ep: Episode): string {
    if (!ep.segments.length) return '<section class="panel empty">请先完成高光报告和正式剧本锁定。</section>';
    const directVideo = this.project?.videoModel?.adapterPath?.endsWith('direct-video.mjs');
    const mumuVideo = this.project?.videoModel?.adapterPath?.endsWith('mumu-video.mjs');
    const selected = ep.segments.find(seg => seg.id === this.canvasSelectedSegmentId) || ep.segments[0];
    this.canvasSelectedSegmentId = selected.id;
    const width = (kind: Artifact['kind']) => Math.max(1, ...ep.segments.map(seg => seg.artifacts.filter(item => item.kind === kind && (kind !== 'prompt' || !item.promptArchive)).length)) * 218 + 32;
    const boardStyle = `--anchor-track:${width('anchor')}px;--prompt-track:${width('prompt')}px;--video-track:${width('video')}px;zoom:${this.canvasZoom}`;
    const videoReady = ep.segments.filter(seg => seg.artifacts.some(item => item.kind === 'video' && item.id === seg.selected.video && item.review?.status === 'approved')).length;
    return `<section class="panel canvas-command"><div><span class="eyebrow">EP ${ep.number} · 制作流程</span><h2>版本表 <span class="chip ${this.sampleApproved ? 'green' : ''}">${this.sampleApproved ? '试片已放行' : '待试片验收'}</span></h2><p>按片段查看占位站位示意、提示词和视频版本，并逐个审片。</p></div><div class="canvas-actions"><button data-action="canvas-view" data-view="graph">返回制作关系图</button><button data-action="auto-bind-assets">匹配资产</button><button data-action="generate" data-kind="package">批量生成提示词</button><button data-action="prompt-manager-open">提示词管理</button><button data-action="export-package" ${this.approved ? '' : 'disabled'}>导出生产包</button><button data-action="approve-sample" ${this.sampleApproved ? 'disabled' : ''}>试片放行</button><button class="primary" data-action="generate" data-kind="video">${directVideo ? '生成所选视频' : '生成所选/整集视频'}</button></div></section>
      ${directVideo ? '<p class="canvas-note">视频生成会消耗模型服务额度并上传本段参考图；提示词超限时停止提交，不删减剧情。</p>' : ''}${mumuVideo ? '<p class="canvas-note">当前项目使用木木工坊联动适配器，可在项目设置切换为新软件直连。</p>' : ''}
      <section class="canvas-overview"><div><strong>本集轨道</strong><small>${ep.segments.length} 个片段 · ${videoReady} 个成功视频已选</small></div><div class="canvas-overview-tracks">${ep.segments.map(seg => `<button class="canvas-overview-track ${selected.id === seg.id ? 'active' : ''} ${segmentVideoCategory(seg)}" data-action="canvas-select-segment" data-segment-id="${seg.id}" title="片段 ${seg.number} · ${segmentVideoCategory(seg) === 'empty' ? '尚无视频' : videoCategoryName[segmentVideoCategory(seg) as VideoCategory]}">${String(seg.number).padStart(2, '0')}</button>`).join('')}</div><div class="canvas-zoom"><span>缩放</span>${[0.8, 1, 1.2].map(value => `<button class="${this.canvasZoom === value ? 'active' : ''}" data-action="canvas-zoom" data-zoom="${value}">${Math.round(value * 100)}%</button>`).join('')}</div></section>
      ${this.renderVideoCategories(ep)}
      <div class="canvas-workspace"><div class="canvas-viewport" aria-label="片段版本表" tabindex="0"><div class="canvas-board" style="${boardStyle}"><div class="canvas-axis"><div>正式剧情</div><div>01 · 占位站位示意</div><div>02 · 视频提示词</div><div>03 · 视频版本</div></div>${ep.segments.map(seg => this.renderSegment(ep, seg)).join('')}</div></div>${this.renderSegmentInspector(ep, selected)}</div>
      <section class="panel jobs"><div class="panel-head"><h2>后台任务</h2><div class="actions"><button data-action="queue" data-kind="pause">暂停待执行</button><button data-action="queue" data-kind="resume">继续</button><button data-action="queue" data-kind="retry">重试失败</button></div></div>${this.jobs.slice(0, 30).map(job => `<div class="job"><span>${esc(job.kind)} · ${esc(ep.segments.find(s => s.id === job.segment_id)?.number || '')}</span><b class="${job.status}">${esc(job.status)}</b><small>${esc(job.error || '')}</small>${this.renderTaskControls(job)}${job.kind === 'video' && job.status === 'failed' ? `<button data-action="recover-remote" data-job-id="${job.id}">查询并找回远端视频</button>` : ''}</div>`).join('') || '<p>暂无任务</p>'}</section>`;
  }

  private renderTaskControls(job: Job): string {
    if(['queued','paused'].includes(job.status)) return `<button data-action="cancel-task" data-job-id="${esc(job.id)}">取消未提交任务</button>`;
    if(job.status==='remote_unknown' || (job.status==='failed' && ['video','image'].includes(job.kind))) return `<details data-task-review="${esc(job.id)}"><summary>供应商终态人工对账</summary><p>先核对供应商记录；未知状态不能释放计费保护。保存凭据不会自动重出。</p><select name="terminal-status"><option value="failed">已确认失败</option><option value="cancelled">已确认取消</option><option value="not_submitted">已确认未提交</option></select><textarea name="receipt" placeholder="供应商任务ID、核对时间及终态凭据（至少8字）"></textarea><label><input type="checkbox" name="terminal-confirmed">已核对上述凭据及终态</label><button data-action="reconcile-task" data-job-id="${esc(job.id)}">保存对账记录</button></details>`;
    return '';
  }

  private renderSegment(ep: Episode, seg: Segment): string {
    const beat = beatFor(ep, seg);
    const versions = (kind: Artifact['kind']) => seg.artifacts.filter(item => item.kind === kind)
      .map((item, index) => ({ item, index })).filter(({ item }) => (kind !== 'prompt' || !item.promptArchive) && (kind !== 'video' || this.videoFilter === 'all' || videoCategory(item) === this.videoFilter))
      .map(({ item, index }) =>
      `<article class="version canvas-node ${kind === 'video' ? videoCategory(item) : ''} ${seg.selected[kind] === item.id ? 'chosen' : ''}" data-artifact-id="${item.id}"><div class="version-top"><strong>${kind === 'anchor' ? '锚点板' : kind === 'prompt' ? '提示词' : '视频'} v${index + 1}</strong>${seg.selected[kind] === item.id ? '<em>已选</em>' : kind === 'video' && videoCategory(item) === 'waste' ? '' : `<button data-action="select-artifact" data-segment-id="${seg.id}" data-kind="${kind}" data-artifact-id="${item.id}">选用</button>`}</div>${kind === 'video' ? `<span class="video-category-label ${videoCategory(item)}">${videoCategoryName[videoCategory(item)]}</span>` : ''}${kind === 'video' && item.modelName ? `<small class="canvas-model">${esc(item.modelName)}${item.modelId ? ` · ${esc(item.modelId)}` : ''}</small>` : ''}
      ${kind === 'anchor' ? `<img alt="无文字占位站位示意" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.content || '')}"/>` : kind === 'prompt' ? `<small>${esc(promptVersionStatus(this.project!, ep, seg, item))}</small><details><summary>查看完整提示词</summary><pre>${esc(item.content)}</pre></details>` : `<video controls preload="metadata" src="${mediaUrl(item.mediaPath || '')}"></video><div class="video-review"><small>技术检查：${item.technical?.inspectedAt ? '完成' : '待检查'}</small>${item.technical?.warnings.length ? `<small class="warning">${esc(item.technical.warnings.join('；'))}</small>` : ''}<button data-action="inspect-video">检查文件/黑帧/冻结</button><details><summary>逐项审片核对</summary>${speechChecklist(ep, seg).map(line => { const evidence = item.review?.speech?.find(value => value.id === line.id); return `<div data-speech-id="${line.id}"><p>${esc(line.kind)} · ${esc(line.text)}（计划起点 ${line.startSec}s）</p><label><input name="speech-heard" type="checkbox" ${evidence?.heard ? 'checked' : ''}/>完整听到</label><label><input name="speech-speaker" type="checkbox" ${evidence?.speaker ? 'checked' : ''}/>角色声线正确</label><label>实测开始<input name="speech-start" type="number" min="0" max="30" step="0.1" value="${evidence?.startSec ?? line.startSec}"/></label><label>实测结束<input name="speech-end" type="number" min="0" max="30" step="0.1" value="${evidence?.endSec ?? ''}"/></label></div>`; }).join('')}${([['story','剧情动作与结果'],['voice','对白/OS内容和角色声线'],['assets','人物外观与服饰状态'],['labels','浮签与系统信息'],['pacing','首秒钩子与镜头节奏'],['continuity','空间、末帧和下一段衔接']] as const).map(([key,label]) => `<label><input type="checkbox" name="review-check" value="${key}" ${item.review?.checks?.[key] ? 'checked' : ''}/> ${label}</label>`).join('')}</details><input name="review-notes" placeholder="废片原因或审片备注" value="${esc(item.review?.notes || '')}"/><div class="actions"><button data-action="video-review" data-status="approved" ${item.demo ? 'disabled' : ''}>标为成功片段</button><button data-action="video-review" data-status="rejected">标为废片段</button></div></div>`}</article>`).join('');
    const stage = (kind: Artifact['kind'], fallback: string) => `<div class="canvas-stage canvas-stage-${kind}">${versions(kind) || `<div class="canvas-empty-node">${fallback}</div>`}</div>`;
    return `<section class="canvas-track segment ${this.canvasSelectedSegmentId === seg.id ? 'active' : ''}" data-segment-id="${seg.id}"><div class="canvas-beat"><div class="canvas-beat-top"><label><input type="checkbox" data-check-segment="${seg.id}" ${this.checked.has(seg.id) ? 'checked' : ''}/> 片段 ${String(seg.number).padStart(2, '0')}</label><span>${seg.durationSec} 秒</span></div><button data-action="canvas-select-segment" data-segment-id="${seg.id}" class="canvas-beat-select">${esc(beat.event)}</button><small>${esc(beat.reaction)}</small><span class="canvas-beat-status">${segmentVideoCategory(seg) === 'empty' ? '尚无视频' : videoCategoryName[segmentVideoCategory(seg) as VideoCategory]} · ${seg.artifacts.filter(item => item.kind === 'video').length} 个版本</span></div>${stage('anchor', '可选建议板')}${stage('prompt', '等待提示词')}${stage('video', this.videoFilter === 'all' ? '等待视频或导入' : '此类暂无视频')}</section>`;
  }

  private renderVoiceSummary(beat: ScriptBeat): string {
    const group = (title: string, lines: string[]) => `<div><strong>${title} · ${lines.length} 句</strong>${lines.length ?
      lines.map((line, index) => `<p>${index + 1}. ${esc(line)}</p>`).join('') : '<p>本片段无</p>'}</div>`;
    return `<div class="canvas-voice-summary">${group('对白', beat.dialogue)}${group('内心 OS', beat.os)}<small>正式剧本声音内容。下方子镜只标记每句从哪一镜开始，未标记的子镜不重复发声。</small></div>`;
  }

  private renderSegmentInspector(ep: Episode, seg: Segment): string {
    const beat = beatFor(ep, seg);
    return `<aside class="canvas-inspector segment" data-segment-id="${seg.id}"><div class="canvas-inspector-head"><span class="eyebrow">当前片段 · ${String(seg.number).padStart(2, '0')}</span><h3>正式分镜与计划</h3><p>这里修改所选片段；正式剧情以锁定剧本为准。</p></div><div class="plan"><div class="canvas-inspector-story"><strong>事件</strong><p>${esc(beat.event)}</p><strong>人物反应</strong><p>${esc(beat.reaction)}</p></div>${this.renderVoiceSummary(beat)}<label>视觉、站位、机位和末帧<textarea name="visualPlan" placeholder="按正式剧情写视觉计划，不改事件与反应">${esc(seg.visualPlan)}</textarea></label><div class="settings"><label>秒数<input name="durationSec" type="number" min="30" max="30" readonly value="30"/></label><label>起点<input name="fromX" type="number" min="10" max="90" value="${seg.anchorPlan.fromX}"/></label><label>终点<input name="toX" type="number" min="10" max="90" value="${seg.anchorPlan.toX}"/></label><label>景别<select name="level"><option value="wide" ${seg.anchorPlan.level === 'wide' ? 'selected' : ''}>远景</option><option value="medium" ${seg.anchorPlan.level === 'medium' ? 'selected' : ''}>中景</option><option value="close" ${seg.anchorPlan.level === 'close' ? 'selected' : ''}>近景</option></select></label></div><div class="settings"><label><input name="action" type="checkbox" ${seg.action ? 'checked' : ''}/>动作片段（默认1.5倍）</label><label>手动倍速<input name="speedOverride" type="number" min="0.1" max="4" step="0.05" placeholder="跟随规则" value="${seg.speedOverride ?? ''}"/></label></div><button data-action="save-segment">保存片段设置</button>${this.renderSubshots(beat, seg)}${renderExecutionPanel(this.project!,ep,seg)}${this.renderAssetBindings(ep, seg)}${seg.effectIds.length ? `<small>已适配特效：${esc(seg.effectIds.map(id => `${id}〔依据：${seg.effectEvidence[id] || '待核对'}〕`).join('、'))} <button data-action="clear-effects" data-segment-id="${seg.id}">撤销本段特效</button></small>` : ''}</div><div class="upload"><input type="file" accept="video/mp4,.mp4"/><button data-action="upload-video" data-segment-id="${seg.id}">导入视频到本排</button></div></aside>`;
  }

  private renderAssetBindings(ep: Episode, seg: Segment): string {
    const assets = this.project?.assets || [];
    if (!assets.length) return '<p class="muted">参考资产可在“资产与状态”中建立。</p>';
    return `<details class="binding-list"><summary>片段资产与剧情状态（已绑定 ${seg.assetBindings?.length || 0}）</summary>
      ${assets.map(asset => {
        const binding = seg.assetBindings?.find(item => item.assetId === asset.id);
        const state = effectiveState(asset, ep, seg, binding?.stateId);
        return `<div class="binding-row" data-binding-asset-id="${asset.id}"><label><input name="binding-enabled" type="checkbox" ${binding ? 'checked' : ''}/> ${esc(asset.name)}</label>
          <select name="binding-state"><option value="">按剧情时间线${state ? `：${esc(state.label)}` : ''}</option>${asset.states.map(item => `<option value="${item.id}" ${binding?.stateId === item.id ? 'selected' : ''}>指定：${esc(item.label)}（回忆/特例）</option>`).join('')}</select>
          <select name="binding-image"><option value="">${requiresPortraitReference(asset)?'请选择已审完整四视图＋大头照':'请选择已审主图'}</option>${asset.images.filter(item => item.role !== 'portrait' && item.review?.status === 'approved' && (!requiresPortraitReference(asset) || isCharacterSheet(item) || item.id === binding?.imageId)).map(item => `<option value="${item.id}" ${binding?.imageId === item.id ? 'selected' : ''}>${esc(asset.states.find(s => s.id === item.stateId)?.label || '基础图')} · ${isCharacterSheet(item) ? '完整四视图＋大头照' : requiresPortraitReference(asset) ? '历史参考（需更新四视图）' : '主图'} · ${item.id.slice(0, 8)}</option>`).join('')}</select></div>`;
      }).join('')}<button data-action="save-segment-assets">保存片段资产</button></details>`;
  }

  private renderSubshots(beat: ScriptBeat, seg: Segment): string {
    const refs = (values: number[]) => values.map(value => value + 1).join(', ');
    const lines = (label: string, values: string[]) => values.length ?
      `<p><b>${label}：</b>${values.map((value, index) => `${index + 1}. ${esc(value)}`).join('；')}</p>` : '';
    return `<details class="subshot-list"><summary>正式多子镜（${seg.subshots?.length || 0}）${seg.subshotsReviewed === false ? (seg.subshotsAuto ? ' · 自动初稿，须逐镜核对' : ' · 修改待核对') : ''}</summary>
      <p>逐镜核对剧情动作、人物反应与景别。对白/OS序号标记开始镜，声音可跨镜说完；时间从 0 秒连续覆盖整段。自动草案中如出现占位动作，须按正式剧情补足。</p>
      ${pacingWarnings(beat, seg).length ? `<div class="subshot-candidate"><strong>当前节奏提示</strong><ul>${pacingWarnings(beat, seg).map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}
      <button data-action="suggest-subshots">用文本模型规划子镜</button>${seg.subshotCandidate ? `<div class="subshot-candidate"><strong>待核对的分镜建议 · ${seg.subshotCandidate.shots.length} 镜</strong>${seg.subshotCandidate.warnings?.length ? `<ul>${seg.subshotCandidate.warnings.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}${seg.subshotCandidate.shots.map((shot, index) => `<p>${index + 1}. ${shot.startSec}–${shot.endSec} 秒 · ${esc(shot.location || '')} · ${esc(shot.framing)}<br/>动作：${esc(shot.action)}<br/>结果：${esc(shot.result || '')} · 末帧：${esc(shot.endFrame || '')}<br/><small>正式依据：${esc(shot.evidence || '')}</small></p>`).join('')}<button data-action="apply-subshot-candidate">采用建议并继续核对</button></div>` : ''}
      ${lines('对白', beat.dialogue)}${lines('OS', beat.os)}${lines('浮签', beat.floatLabels)}${lines('系统面板', beat.systemPanels)}
      ${(seg.subshots || []).map((shot, index) => `<div class="subshot-form" data-subshot-id="${shot.id}"><strong>子镜 ${index + 1}</strong>
        <div class="subshot-times"><label>起点<input name="shot-start" type="number" min="0" step="0.1" value="${shot.startSec}"/></label><label>终点<input name="shot-end" type="number" min="0" step="0.1" value="${shot.endSec}"/></label></div>
        <label>景别/机位<input name="shot-framing" value="${esc(shot.framing)}"/></label>
        <label>正式剧情逐字依据<input name="shot-evidence" value="${esc(shot.evidence || '')}"/></label>
        <label>唯一物理场景<input name="shot-location" value="${esc(shot.location || '')}"/></label>
        <label>前置状态<input name="shot-prior" value="${esc(shot.priorState || '')}"/></label>
        <label>画面动作与反应<textarea name="shot-action">${esc(shot.action)}</textarea></label>
        <label>可见结果<input name="shot-result" value="${esc(shot.result || '')}"/></label>
        <label>停止边界与末帧<input name="shot-end-frame" value="${esc(shot.endFrame || '')}"/></label>
        <div class="shot-assets"><strong>本镜实际参考资产</strong>${(seg.assetBindings || []).map(binding => { const asset = this.project?.assets?.find(item => item.id === binding.assetId); return asset ? `<label><input type="checkbox" name="shot-asset" value="${esc(asset.id)}" ${(shot.assetIds || []).includes(asset.id) ? 'checked' : ''}/> ${esc(asset.name)}</label>` : ''; }).join('') || '<small>请先在片段资产中绑定角色、场景或道具</small>'}</div>
        <div class="subshot-times"><label>对白序号<input name="shot-dialogue" value="${esc(refs(shot.lineRefs.dialogue))}"/></label><label>OS序号<input name="shot-os" value="${esc(refs(shot.lineRefs.os))}"/></label><label>浮签序号<input name="shot-labels" value="${esc(refs(shot.lineRefs.floatLabels))}"/></label><label>系统面板序号<input name="shot-panels" value="${esc(refs(shot.lineRefs.systemPanels))}"/></label></div>
        <button data-action="save-subshot">保存子镜</button>${index === (seg.subshots?.length || 0) - 1 && index >= 2 ? '<button data-action="delete-subshot">删除末尾空子镜</button>' : ''}</div>`).join('')}
      <button data-action="add-subshot">${seg.subshots?.length ? '＋ 新增子镜' : '建立多子镜'}</button>${seg.subshotsReviewed === false ? '<button data-action="approve-subshots">逐镜核对完成，确认分镜</button>' : '<small>分镜已核对；改动后需重新确认。</small>'}</details>`;
  }

  private renderExport(project: Project, ep: Episode): string {
    const exported=localStorage.getItem('manju-export:'+project.id+':'+ep.id)||'';
    let mp4:{url:string;filePath:string;durationSeconds:number;draftError?:string}|undefined;
    try {mp4=JSON.parse(localStorage.getItem('manju-mp4-export:'+project.id+':'+ep.id)||'null');}catch{/* Invalid old local result is ignored. */}
    const mp4Panel=mp4?.url?.startsWith('/media/exports/')?`<section class="panel mp4-result"><h2>MP4 成片</h2><video controls preload="metadata" src="${esc(mp4.url)}"></video><p>${Number(mp4.durationSeconds).toFixed(1)} 秒 · 片段原声已保留</p><div class="actions"><a class="button primary" href="${esc(mp4.url)}" download>下载 MP4</a><button data-action="copy-export-path" data-path="${esc(mp4.filePath)}">复制成片路径</button></div><p class="muted export-file-path">${esc(mp4.filePath)}</p>${mp4.draftError?`<p class="error" role="alert">MP4 已保存，剪映草稿未保存：${esc(mp4.draftError)}</p>`:''}</section>`:'';
    const previewRows = ep.segments.map(seg => {
      const selected = seg.artifacts.find(item => item.id === seg.selected.video && item.kind === 'video');
      const cut = ep.previewCuts?.find(item => item.segmentId === seg.id);
      const ready = Boolean(selected?.mediaPath && !selected.demo);
      return `<div class="preview-row" data-preview-segment-id="${seg.id}" data-preview-artifact-id="${esc(selected?.id || '')}">
        <label><input name="preview-cut-enabled" type="checkbox" ${cut ? 'checked' : ''} ${ready ? '' : 'disabled'}/>片段 ${seg.number}</label>
        <span>${ready ? esc(beatFor(ep,seg).event.slice(0, 45)) : '请先在画布选定正式视频'}</span>
        <label>起点（秒）<input name="preview-start" type="number" min="0" max="180" step="0.1" value="${cut?.startSec ?? 0}" ${ready ? '' : 'disabled'}/></label>
        <label>长度（秒，留空到结尾）<input name="preview-duration" type="number" min="0.1" max="180" step="0.1" value="${cut?.durationSec ?? ''}" ${ready ? '' : 'disabled'}/></label></div>`;
    }).join('');
    return `${mp4Panel}${exported?`<section class="panel"><h3>最近导出结果</h3><p>新草稿已保存；请在剪映实际打开核验，未自动改变验收。</p><input readonly aria-label="导出草稿目录" value="${esc(exported)}"/><button data-action="copy-export-path" data-path="${esc(exported)}">复制草稿目录</button></section>`:''}<section class="panel"><h2>精剪草稿（保留验收状态）</h2><p>按片段顺序复制原声素材，不追加高光、字幕或浮签轨道，不代表生产验收通过。</p><label>精剪导出设置<select name="editing-settings"><option value="configured">使用下方超分选项及画布逐段倍速</option><option value="original">原速备份（不超分）</option></select></label>${ep.segments.map(s=>`<label>片段 ${s.number}<select name="editing-artifact-${s.id}">${s.artifacts.filter(a=>a.kind==='video'&&a.mediaPath&&!a.demo&&a.userAcceptance?.status!=='withdrawn'&&(a.review?.status!=='rejected'||a.userAcceptance?.status==='accepted')&&(!s.selected.video||a.id===s.selected.video)).map(a=>`<option value="${a.id}">${a.userAcceptance?.status==='accepted'?'用户已通过':'待验收'} · ${esc(a.id.slice(0,8))}</option>`).join('')}</select></label>`).join('')}<button data-upscale-export data-export-blocked="false" data-action="export-editing">按当前配置新建本集精剪草稿</button></section><section class="panel"><div class="panel-head"><h2>正式成片导出预检</h2><span class="chip ${this.exportIssues.length ? '' : 'green'}">${this.exportIssues.length ? `待处理 ${this.exportIssues.length} 项` : '可导出'}</span></div><p>这里列出正式成片的验收要求。若先进入剪映精剪，可使用上方“精剪草稿”，保留当前验收状态。</p><button data-action="export-review">前往画布检查文件与逐句审片</button>${this.exportIssues.length ? `<ul class="issues">${this.exportIssues.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="success">片段选版、文件、声音轨、审片与五层核对均已就绪。</p>'}</section><div class="two-col"><section class="panel"><h2>成片与草稿设置</h2><p>默认仅排片、保留原声、设置倍速。字幕由你在剪映中识别；不分离音轨。</p><label>项目类型<select name="project-mode-edit"><option value="standard" ${project.mode === 'standard' ? 'selected' : ''}>常规漫剧：仅首集高光</option><option value="douyin-story" ${project.mode === 'douyin-story' ? 'selected' : ''}>抖音推文漫剧：每集高光</option></select></label><button data-action="save-mode">保存项目类型</button>
      <label>本集高光预告<select name="preview-override"><option value="default" ${ep.previewOverride == null ? 'selected' : ''}>跟随项目规则</option><option value="yes" ${ep.previewOverride === true ? 'selected' : ''}>强制加入</option><option value="no" ${ep.previewOverride === false ? 'selected' : ''}>不加入</option></select></label><button data-action="preview-mode">保存本集规则</button>
      <h3>从正片选高光</h3><p>勾选已选定的视频，填写起点和长度；按正片顺序排在成片及草稿开头，保留原声。请先审看片段并确认高光内容。</p>
      <div class="preview-list">${previewRows || '<p>请先建立片段画布。</p>'}</div><button data-action="save-preview-cuts">保存高光选择</button>
      <details class="legacy-preview"><summary>已有独立预告 MP4</summary><label>高光预告视频（MP4）<input name="preview-file" type="file" accept="video/mp4,.mp4"/></label><button data-action="upload-preview">导入已核对预告</button>${ep.previewMediaPath ? `<p class="success">已导入：${esc(ep.previewMediaPath)}</p>` : ''}<p class="muted">若同时保存了正片高光选择，优先使用所选正片。</p></details>
      <hr/><label class="check"><input name="upscale" type="checkbox"/>导出前使用真实 2 倍超分</label><div data-upscale-status>${this.renderUpscaleStatus()}</div><label class="check"><input name="below1080" type="checkbox"/>仅处理低于 1080p 的素材</label><p>普通对白默认 1.15 倍，动作默认 1.5 倍；逐段设置在画布中修改。</p>${this.exportWarnings.length?`<div class="playback-warnings"><strong>最终倍速可读/可听检查</strong><ul>${this.exportWarnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul><p>先调整对应片段倍速，再听看最终成片预览；不需要重做付费视频。</p></div>`:''}<div class="actions"><button class="primary" data-upscale-export data-export-blocked="${Boolean(this.exportIssues.length||this.mp4Running)}" data-action="export-mp4" ${this.exportIssues.length || this.mp4Running ? 'disabled' : ''}>${this.mp4Running?'正在合成…':'合成并导出 MP4'}</button><button data-upscale-export data-export-blocked="${Boolean(this.exportIssues.length)}" data-action="export" ${this.exportIssues.length ? 'disabled' : ''}>导出剪映草稿</button><button data-upscale-export data-export-blocked="false" data-action="export-all">按集数批量导出</button></div><p class="muted">草稿位置：${esc(this.health.draftsRoot)}</p></section>
      <section class="panel"><div class="panel-head"><h2>五层无损核对</h2><span class="chip ${this.approved ? 'green' : ''}">${this.approved ? '已放行' : '待放行'}</span></div><p>原文报告 → 正式剧本 → 正式分镜 → 导入版 → 最终视频提示词。自动检查文字和版本；请人工核对因果、表演及镜头。</p>${this.auditIssues.length ? `<ul class="issues">${this.auditIssues.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="success">自动核对未发现缺项。请人工核对后放行。</p>'}<button data-action="approve-audit" ${this.auditIssues.length ? 'disabled' : ''}>人工核对完成并放行</button><hr/><p>视频模型适配器：${project.videoModel?.adapterPath || this.health.videoAdapter ? '已配置' : '未配置，可先导入已有视频'}<br/>本机超分：<span data-upscale-availability>${this.health.upscaleAdapter ? '已就绪' : '未就绪'}</span></p></section></div>`;
  }

  private renderEffects(ep: Episode): string {
    const candidate = ep.segments.find(item => item.id === this.effectSegmentId)?.effectCandidates;
    return `<section class="panel"><div class="panel-head"><div><h2>特效库</h2><p>共 ${this.effectSummary.total} 条，其中 ${this.effectSummary.locallyAdapted} 条有正式分镜适配描述。锁定剧本时按正式事件与反应的明确字面证据自动绑定，可在画布中查看和撤销；其他条目供人工核对。</p></div></div><button data-action="suggest-effects-model" ${this.project?.textModel?.adapterPath && ep.scriptLockedHash ? '' : 'disabled'}>文本模型按正式事件建议特效</button><div class="effect-search"><input name="effect-query" value="${esc(this.effectQuery)}" placeholder="搜索名称、分类、用途"/><button data-action="search-effects">搜索</button><select name="effect-segment">${ep.segments.map(seg => `<option value="${seg.id}" ${this.effectSegmentId === seg.id ? 'selected' : ''}>片段 ${seg.number}</option>`).join('')}</select></div><div class="suggestions">${this.effectSuggestions.length ? `正式动作字面候选：${this.effectSuggestions.map(item => `<span class="chip green">${esc(item.name)}</span>`).join(' ')}。已自动绑定的无需重复添加；请核对效果是否符合正式剧情。` : '当前片段没有明确字面匹配；可搜索目录并人工核对。'}</div>${candidate ? `<div class="suggestions">模型待确认候选：${candidate.entries.length ? candidate.entries.map(item => `${esc(this.effects.find(effect => effect.id === item.id)?.name || item.id)}〔依据：${esc(item.evidence)}〕`).join('；') : '无'} <button data-action="apply-effect-candidates" ${candidate.entries.length ? '' : 'disabled'}>确认绑定本段候选</button></div>` : ''}${this.project && ep.segments.find(s=>s.id===this.effectSegmentId) ? renderExecutionPanel(this.project,ep,ep.segments.find(s=>s.id===this.effectSegmentId)!) : ''}<div class="effect-list">${this.effects.slice(0, 70).map(effect => `<article class="effect" data-effect-id="${effect.id}"><div><strong>${esc(effect.name)}</strong><span class="chip">${esc(effect.category)}</span>${effect.localAdaptation ? '<span class="chip green">可适配</span>' : '<span class="chip">创作参考</span>'}</div><p>${esc(effect.notes || effect.prompt.slice(0, 180))}</p>${effect.localAdaptation ? `<div class="actions"><input name="effect-evidence" value="${esc(this.effectSuggestions.find(item => item.id === effect.id)?.evidence || '')}" placeholder="粘贴正式事件或反应中的原文证据"/><button data-action="apply-effect">绑定到所选片段</button></div>` : ''}</article>`).join('') || '<p>无匹配条目</p>'}</div></section>`;
  }
}

customElements.define('manju-app', ManjuApp);
