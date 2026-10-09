const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

export const noticeIsError=(message:string)=>/失败|错误|异常|超过|超限/u.test(message);

// Only completed operations expire. Errors and recovery instructions stay readable.
export function noticeAutoDismissMs(message:string):number|undefined {
  if(!message||noticeIsError(message)||/未确认|不确定|中断|重传/u.test(message))return undefined;
  return /^(已|项目.*已移入回收区|分集.*已移入回收区|项目已恢复|分集已恢复|.+已保存|备份完成|实时读取到|选用已更新|旧版已归档)/u.test(message)?6000:undefined;
}

export function renderAppNotice(message:string,className:'notice'|'graph-notice'='notice'):string {
  if(!message)return '';
  return `<div class="${className} app-notice${noticeIsError(message)?' error':''}" data-app-notice role="${noticeIsError(message)?'alert':'status'}"><span>${escapeHtml(message)}</span><button data-action="dismiss-notice" aria-label="关闭提示" title="关闭提示"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>`;
}
