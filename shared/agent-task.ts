import type { ModelKind } from './model.js';

export interface AgentTask {
  id: string; projectId: string; requestId: string; inputHash: string;
  agent: string; statement: string; episodeIds: string[];
  delivery: 'package' | 'video'; allowGeneration: boolean; acceptUnknownCost: boolean;
  limits: Record<ModelKind, number>; used: Record<ModelKind, number>;
  maxAmount?: number; currency?: string; reservedAmount: number;
  configurationHash: string; createdAt: string; expiresAt: string; revokedAt?: string; pausedAt?: string;
}
export type AgentTaskStatus = 'active' | 'paused' | 'expired' | 'revoked' | 'configuration_changed';
