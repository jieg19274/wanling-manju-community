import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { dataDir, db } from './store.js';

export interface AgentModelRequest {
  id: string; task: string; status: string; model?: string; submittedAt: string;
  http?: { status: number; model?: string; requestId?: string; receivedAt?: string };
}
const modelId = (value: unknown) => typeof value === 'string' ? value :
  value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined;

function httpReceipt(output: string): AgentModelRequest['http'] {
  try {
    const receipt = output + '.provider-http-receipt.json';
    if (!existsSync(receipt) || statSync(receipt).size > 65536) return;
    const http = JSON.parse(readFileSync(receipt, 'utf8'));
    if (Number.isInteger(http.status) && http.status >= 100 && http.status <= 599)
      return { status: http.status, model: modelId(http.model),
        ...(typeof http.requestId === 'string' ? { requestId: http.requestId.slice(0, 200) } : {}),
        ...(typeof http.receivedAt === 'string' ? { receivedAt: http.receivedAt.slice(0, 40) } : {}) };
  } catch { /* An incomplete receipt does not hide the saved request snapshot. */ }
}

// Expose only request identity/model metadata, never prompts, keys or URLs.
export function agentModelRequests(projectId: string): AgentModelRequest[] {
  const adapters = db.prepare("SELECT id,task,status,snapshot,output_path,created_at FROM adapter_tasks WHERE project_id=? AND task<>'health' ORDER BY rowid DESC LIMIT 12")
    .all(projectId).map(row => {
      const snapshot = JSON.parse(String(row.snapshot));
      const value: AgentModelRequest = { id: String(row.id), task: String(row.task), status: String(row.status),
        model: modelId(snapshot.request?.model), submittedAt: String(row.created_at) };
      const output = path.resolve(String(row.output_path));
      if (path.dirname(output) === path.join(dataDir, 'adapter-jobs')) value.http = httpReceipt(output);
      return value;
    });
  const videos = db.prepare("SELECT j.id,j.episode_id,j.segment_id,j.status,j.created_at,g.payload FROM jobs j JOIN generation_specs g ON g.id=j.id AND g.project_id=j.project_id WHERE j.project_id=? AND j.kind='video' ORDER BY j.rowid DESC LIMIT 12")
    .all(projectId).flatMap(row => {
      const folder = path.resolve(dataDir, 'media', 'generated', String(row.episode_id), String(row.segment_id));
      const generated = path.join(dataDir, 'media', 'generated') + path.sep;
      if (!folder.startsWith(generated) || !/^[-\w]{1,100}$/u.test(String(row.id)) || !existsSync(path.join(folder, `${row.id}.json`))) return [];
      const frozen = JSON.parse(String(row.payload));
      return [{ id: String(row.id), task: 'video', status: String(row.status), model: frozen.project?.videoModel?.modelId,
        submittedAt: String(row.created_at), http: httpReceipt(path.join(folder, `${row.id}.mp4`)) } satisfies AgentModelRequest];
    });
  return [...adapters, ...videos].sort((a,b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0,12);
}
