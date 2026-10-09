export function candidatePrompt(prompt:string,feedback?:string){
  const preference=feedback?.trim();
  return preference?prompt+'\n【本次候选视觉偏好】\n'+preference+'\n上述偏好只调整视觉表现，不得覆盖正式剧情、对白/OS、人物状态、可见信息、声音顺序和固定30秒合同。':prompt;
}
