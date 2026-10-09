const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function modelPicker(options:string[],current:string,target:string){
  const entries=[...new Set([current,...options].filter(Boolean))];
  return `<label>选择模型<select name="catalog-model-choice" data-target="${esc(target)}"><option value="">${entries.length?'请选择模型':'目录无可选项，可在下方手动填写 ID'}</option>${entries.map(id=>`<option value="${esc(id)}" ${id===current?'selected':''}>${esc(id)}${id===current&&!options.includes(id)?'（当前已保存，未在目录验证）':''}</option>`).join('')}</select></label>`;
}
export function catalogFeedback(mode:string|undefined,error:string,total:number,matched:number){
  if(error)return `<p class="warning" role="alert">模型目录读取失败：${esc(error)}。${mode==='local'?'当前连接隔离/本地模型地址，不能取得真实服务商目录。':''}已保存的项目模型保持不变；可重试刷新，或在项目模型设置中查看现有本地模型。</p>`;
  if(total&&!matched)return `<p class="warning">目录已读取 ${total} 项，但没有识别出此类型；未识别项没有被当作已验证模型。可手动填写已确认的 ID。</p>`;
  if(!total)return '<p class="muted">尚无可用模型目录。请选择刷新模型列表；读取失败会在此明确显示。</p>';
  return `<p class="muted">当前类型 ${matched} 个模型可选。</p>`;
}
