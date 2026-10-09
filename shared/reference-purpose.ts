export function referencePurpose(ref: {assetId:string;kind:string;role:string;referenceLayout?:string}, povAssetId?:string):string {
  if(ref.assetId===povAssetId)return '主角本人就是摄影机主人；此图只锁定视线下缘的手与衣袖，不展示主角正脸；图中背景与机位不能代替本镜正式场景。';
  if(ref.kind==='scene')return '只定义本镜场景空间，不定义人物身份或摄影机主人；其他人物参考图中的背景不能覆盖此场景。';
  if(ref.kind==='prop')return '只定义该道具外形与材质，不定义人物身份、摄影机主人或场景。';
  if(ref.referenceLayout==='three-view-portrait')return '完整四视图中的正面、侧面、背面和大头照都是同一角色，用整图锁定五官、发型、体态与当前服装的一致性；按本镜正式分镜选择机位和动作，不能把多个视角演成多个人或把拼图版式、背景搬进场景。';
  return '只锁定该角色本人身份与衣装；该角色不是摄影机主人；图中背景不能代替本镜正式场景。';
}
