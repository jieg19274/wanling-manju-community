export type WorkflowStep = {
  key:string; kind:'gate'|'text'|'image'|'video'|'local'|'export'|'done';
  label:string; message:string; tab:'source'|'script'|'assets'|'review'|'export';
  task?:'highlight'|'script'|'assets'|'semantic'|'storyboard'|'prompts'|'package'|'character-references';
  segmentId?:string; input?:Record<string,unknown>; preview?:unknown;
  submissions:number; model?:string; hash?:string;
};
export type AgentWorkflow = {
  id:string; projectId:string; episodeId:string; status:'running'|'waiting_budget'|'waiting_review'|'paused'|'failed'|'completed'|'cancelled';
  createdAt:string; updatedAt:string; step:WorkflowStep; error?:string;
  delivery?: 'package' | 'video';
  taskId?: string;
  limits:Record<'text'|'image'|'video',number>; used:Record<'text'|'image'|'video',number>;
  history:{key:string;label:string;status:'running'|'completed'|'failed';at:string;submissions:number;kind:string;model?:string;taskId?:string;batchId?:string;jobIds?:string[];error?:string}[];
  exportResult?:unknown;
};
