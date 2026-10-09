import {existsSync} from 'node:fs';
import {db,getProject} from './store.js';
import {mediaPath} from './media.js';
import {summarizeProjectProgress} from '../shared/project-progress.js';

export function projectProgress(projectId:string){
  const project=getProject(projectId);
  if(project.archivedAt)throw Error('项目已移入回收区，请先恢复。');
  const media=new Map<string,boolean>();
  const progress=summarizeProjectProgress(project,file=>{
    if(!media.has(file)){try{media.set(file,existsSync(mediaPath(file)));}catch{media.set(file,false);}}
    return media.get(file)!;
  });
  for(const row of db.prepare('SELECT episode_id,payload FROM agent_workflows WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId)){
    const flow=JSON.parse(String(row.payload));
    if(!progress.episodes.some(e=>e.id===row.episode_id))continue;
    if(!progress.workflows.some(w=>w.episodeId===row.episode_id)&&!['completed','cancelled'].includes(flow.status))progress.workflows.push({episodeId:String(row.episode_id),status:flow.status,label:flow.step?.label||'',message:flow.step?.message||'',...(flow.error?{error:String(flow.error)}:{})});
    const result=flow.exportResult;
    for(const [kind,file] of [['package',result?.package?.folder],['mp4',result?.mp4?.filePath],['draft',result?.draftDir]]){
      if(typeof file==='string')progress.deliverables.push({episodeId:String(row.episode_id),kind,available:existsSync(file)});
    }
  }
  return progress;
}
