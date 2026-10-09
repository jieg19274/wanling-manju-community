import {createHash} from 'node:crypto';
import {readFileSync,openSync,readSync,closeSync} from 'node:fs';
import {videoReferences} from '../shared/asset-references.js';
import type {Project, Episode, Segment, Artifact} from '../shared/model.js';
import {mediaPath} from './media.js';

export function referenceHashes(project: Project, episode: Episode, segment: Segment) {
  return videoReferences(project,episode,segment).map(ref=> {
    const hash=createHash('sha256').update(readFileSync(mediaPath(ref.mediaPath!))).digest('hex');
    const image=project.assets?.find(asset=>asset.id===ref.assetId)?.images.find(image=>image.id===ref.imageId);
    if(!image?.fileHash) throw new Error('旧审图记录没有文件哈希，须重新审图后才能生成或验收视频');
    if(image.fileHash!==hash) throw new Error('已审参考图文件内容已变化，须重新审图');
    return {imageId:ref.imageId,hash};
  });
}
export function verifyReferenceProvenance(project: Project, episode: Episode, segment: Segment, artifact: Artifact) {
  if (!artifact.referenceHashes || JSON.stringify(artifact.referenceHashes)!==JSON.stringify(referenceHashes(project,episode,segment)))
    throw new Error('视频参考图文件缺少追溯记录或内容已变化，请重新核对生成输入');
  if(artifact.labelRepair) {
    const repair=artifact.labelRepair,source=segment.artifacts.find(a=>a.id===repair.sourceArtifactId);
    const hashFile=(file:string)=>{
      const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024),handle=openSync(file,'r');
      try{let count:number;while((count=readSync(handle,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));return hash.digest('hex');}finally{closeSync(handle);}
    };
    if(!source?.mediaPath||!artifact.mediaPath||hashFile(mediaPath(source.mediaPath))!==repair.sourceFileHash||hashFile(mediaPath(artifact.mediaPath))!==repair.outputFileHash)throw Error('文字修正版或原片文件哈希已变化，请重新核对');
  }
}
