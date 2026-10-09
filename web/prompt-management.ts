import { selectedArtifact, type Episode, type Project } from '../shared/model';
import { promptVersionStatus } from './prompt-status';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderPromptManager(project: Project, episode: Episode, segmentId: string): string {
  const selected = episode.segments.find(s => s.id === segmentId) || episode.segments[0];
  if (!selected) return '';
  const current = selectedArtifact(selected, 'prompt');
  const active = episode.segments.flatMap(segment => segment.artifacts.filter(a => a.kind === 'prompt' && !a.promptArchive).map(artifact => ({ segment, artifact })));
  const stopped = episode.segments.flatMap(segment => segment.artifacts.filter(a => a.kind === 'prompt' && a.promptArchive).map(artifact => ({ segment, artifact })));
  const row = ({ segment, artifact }: typeof active[number]) => {
    const version = segment.artifacts.filter(a => a.kind === 'prompt').findIndex(a => a.id === artifact.id) + 1;
    return `<article class="prompt-management-row"><label><input type="checkbox" name="prompt-choice-${esc(artifact.id)}" data-prompt-choice data-segment-id="${esc(segment.id)}" data-artifact-id="${esc(artifact.id)}" data-stopped="${Boolean(artifact.promptArchive)}" data-selected="${segment.selected.prompt === artifact.id}"/>片段 ${segment.number} · 提示词 v${version} ${segment.selected.prompt === artifact.id ? '· 当前选用' : ''}</label><small>${esc(promptVersionStatus(project, episode, segment, artifact))}</small><details><summary>核对完整正文</summary><pre>${esc(artifact.content)}</pre></details>${artifact.promptArchive ? `<small>停用说明：${esc(artifact.promptArchive.reason)}</small>` : ''}</article>`;
  };
  return `<div class="prompt-management-backdrop"><section class="prompt-management-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-management-title" data-prompt-manager>
    <header><div><h2 id="prompt-management-title">提示词版本管理</h2><p>本集当前 ${active.length} 项 · 已停用 ${stopped.length} 项</p></div><button data-action="prompt-manager-close" aria-label="关闭提示词版本管理">关闭</button></header>
    <p>停用后从当前版本表移出，不能再选用；原文和已生成视频的来源保留，可在历史区恢复。取消选用后须主动选用新版，后台编译不会自动替你选回。已提交任务保留其冻结输入。</p>
    <section class="prompt-management-editor"><h3>片段 ${selected.number} · 写入新版</h3><label>查看其他片段<select name="prompt-editor-segment">${episode.segments.map(s => `<option value="${esc(s.id)}" ${s.id === selected.id ? 'selected' : ''}>片段 ${s.number}</option>`).join('')}</select></label><button data-action="prompt-editor-switch">查看该片段</button>
    <label>完整提示词<textarea name="prompt-replacement-${esc(selected.id)}" data-prompt-replacement spellcheck="false">${esc(current?.content || [...selected.artifacts].reverse().find(a => a.kind === 'prompt' && !a.promptArchive)?.content || '')}</textarea></label>
    <label><input type="checkbox" name="prompt-write-archive-${esc(selected.id)}" data-prompt-write-archive checked/>写入新版时停用本段原选版</label><div class="actions"><button data-action="prompt-write-new" data-segment-id="${esc(selected.id)}">写入并选用新版</button>${current ? `<button data-action="prompt-unselect" data-segment-id="${esc(selected.id)}" data-artifact-id="${esc(current.id)}">取消本段选用</button>` : '<span>本段尚未选用提示词</span>'}</div><p>写入前核对正式剧情、对白／OS、浮签及镜头结构；成功后仍须完成本段及本集人工核对。此处不提交视频生成。</p></section>
    <section><h3>本集批量管理</h3><div class="actions"><button data-action="prompt-check-unused">勾选未选用版本</button><button data-action="prompt-check-active">勾选全部当前版本</button><button data-action="prompt-check-none">清空勾选</button></div><label><input type="checkbox" name="prompt-select-archive" checked/>批量换选时停用各段原选版</label><div class="actions"><button data-action="prompt-manage-batch" data-operation="archive">停用勾选版本</button><button data-action="prompt-manage-batch" data-operation="select">选用勾选版本（每段一个）</button><button data-action="prompt-manage-batch" data-operation="restore">恢复勾选历史版</button></div>
    <div class="prompt-management-list">${active.map(row).join('') || '<p>当前列表为空，写入新版或恢复历史版后可选用。</p>'}</div><details class="prompt-management-history"><summary>已停用历史 · ${stopped.length} 项</summary>${stopped.map(row).join('') || '<p>没有已停用版本。</p>'}</details></section>
  </section></div>`;
}
