import type {SoftwareUpdate} from '../shared/software-update';
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]!);
export function renderSoftwareUpdate(s:SoftwareUpdate){
  const busy=s.status==='checking'||s.status==='downloading';
  return `<section class="panel" aria-label="软件更新"><div class="panel-head"><div><h2>软件更新</h2><p>当前版本 ${esc(s.currentVersion)}。更新只替换程序，保留项目、素材和账户设置。</p></div><button data-action="check-software-update" ${busy||!s.configured?'disabled':''}>${busy?'正在更新…':'检查更新'}</button></div><label class="software-update-toggle"><input type="checkbox" name="software-auto-update" data-action="toggle-software-update" ${s.enabled?'checked':''}/>自动检查并下载更新</label><p data-software-update-message role="status" aria-live="polite">${esc(s.message)}${s.status==='downloading'?`（${s.progress||0}%）`:''}</p><p class="muted">下载期间可继续制作。新版本会在下次启动前安装，启动失败时自动恢复旧版。</p></section>`;
}
