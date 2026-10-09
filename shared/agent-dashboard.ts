import type { AgentTask, AgentTaskStatus } from './agent-task.js';
import type { AgentWorkflow } from './agent-workflow.js';
import type { ProductionRules } from './production-rules.js';
import type { ScriptReadiness } from './script-readiness.js';

export interface AgentReadiness {
  projectId?: string;
  draftReady: boolean; generationReady: boolean;
  checks: { key: string; label: string; ready: boolean; message: string;
    modelId?: string; modelHash?: string; defaultModelId?: string; defaultModelHash?: string; canUseDefault?: boolean }[];
  missing: string[];
  note: string;
}
export interface AgentDashboard {
  projectId: string; projectName: string; archived: boolean; rules: ProductionRules;
  readiness: AgentReadiness;
  scriptRecovery?: ScriptReadiness[];
  modelRequests?: { id: string; task: string; status: string; model?: string; submittedAt: string;
    http?: { status: number; model?: string; requestId?: string; receivedAt?: string } }[];
  tasks: (AgentTask & { status: AgentTaskStatus; remaining: AgentTask['limits'];
    episodes: { id: string; number: number; title: string }[] })[];
  workflows: { id: string; taskId?: string; episodeId: string; episodeNumber: number;
    status: AgentWorkflow['status']; step: { label: string; message: string; tab: string; segmentId?: string; model?: string };
    lastAttempt?: { model?: string; at: string; status: string };
    error?: string; completedSteps: number; updatedAt: string }[];
  deliverables: { workflowId: string; episodeId: string; episodeNumber: number; kind: 'package' | 'mp4' | 'draft'; path: string; available: boolean; url?: string }[];
  reviews: { requestId: string; status: string; reviewer: string; notes: string; at: string; taskId?: string; action?: string }[];
}
