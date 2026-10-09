import type { ProductionRules } from './production-rules.js';
export type StudioRunStatus = 'starting'|'running'|'waiting_input'|'paused'|'interrupted'|'completed'|'failed'|'cancelled';
export interface StudioRun {
  id:string; projectId:string; requestId:string; inputHash:string; client:'codex';
  status:StudioRunStatus; createdAt:string; updatedAt:string; threadId?:string; turnId?:string;
  targetEpisodes:number; delivery:'package'|'video'; limits:{text:number;image:number;video:number};
  acceptUnknownCost:boolean; statement:string; requirement:string; taskId?:string;
  message:string; error?:string; logs:{at:string;text:string}[];
}
export interface CodexAvailability {status:'checking'|'available'|'not_installed'|'login_required'|'error';message:string;version?:string}
export interface StudioHome {
  codex:CodexAvailability; defaults:ProductionRules;
  projects:{id:string;name:string;updatedAt:string;episodes:number;demo:boolean;rules?:ProductionRules}[];
  runs:(StudioRun & {projectName:string;remaining?:StudioRun['limits'];step?:string})[];
  deliverables:{projectId:string;projectName:string;episodeNumber:number;kind:string;path:string;url?:string;available:boolean}[];
}
