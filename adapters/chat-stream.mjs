export function parseChatStream(raw) {
  let content='',reasoning='',model,id,usage,finishReason,done=false;
  for(const block of raw.split(/\r?\n\r?\n/u)){
    const data=block.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n').trim();
    if(!data)continue;
    if(data==='[DONE]'){done=true;continue;}
    const item=JSON.parse(data);
    if(item.error)throw Error(String(item.error.message||item.error));
    if(item.id)id=item.id;
    if(item.model){if(model&&model!==item.model)throw Error('流式响应模型中途变化');model=item.model;}
    if(item.usage)usage=item.usage;
    const choice=item.choices?.find(c=>c.index===0)??item.choices?.[0];
    if(!choice)continue;
    const delta=choice.delta||{};
    if(typeof delta.content==='string')content+=delta.content;
    if(typeof delta.reasoning_content==='string')reasoning+=delta.reasoning_content;
    if(choice.finish_reason)finishReason=choice.finish_reason;
  }
  if(!done||!finishReason)throw Error('流式响应未确认完整结束；已保存接收内容，远端状态须对账，禁止自动重发');
  return {id,model,usage,streamComplete:true,choices:[{index:0,finish_reason:finishReason,message:{role:'assistant',content,...(reasoning?{reasoning_content:reasoning}:{})}}]};
}
