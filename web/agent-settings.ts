import type { ProductionRules } from '../shared/production-rules';
import type { AgentReadiness } from '../shared/agent-dashboard';
import { renderAgentReadiness } from './agent-dashboard';

export function renderAgentSettings(rules: ProductionRules, readiness?: AgentReadiness): string {
  return `<section id="agent-setup" class="panel agent-setup">
    ${renderAgentReadiness(readiness)}
    <div class="panel-head"><h2>交给 Agent 制作</h2><span class="chip">30 秒 / 片段</span></div>
    <p>安装一次接管技能，之后把小说和制作要求交给 Agent。它会启动软件、读取进度并继续制作。</p>
    <div class="agent-setup-entry"><label>使用的客户端<select name="agent-client"><option value="codex">Codex</option><option value="workbuddy">WorkBuddy</option><option value="trae">TRAE</option></select></label>
      <button class="primary" data-action="download-agent-skill">下载接管技能 ZIP</button><button data-action="copy-agent-entry">复制接管说明</button><button data-action="download-tutorial">下载最新版教程</button></div>
    <p class="muted">软件自带的技能与教程随自动更新升级。已导入其他客户端的技能需重新下载导入；连接后读取接口返回的最新版技能。</p>
    <p class="muted">告诉 Agent 要做哪几集、交付生产包还是成片，以及本次生成额度。核验记录和提交次数会保存在项目里。</p>
    <details><summary>首次安装方法</summary><p>TRAE：设置 → 技能与命令 → 创建全局技能 → 导入 ZIP。WorkBuddy：技能 → 添加技能 → 上传 ZIP。Codex：解压技能到本机 .codex/skills，或把复制的接管说明发给 Codex。</p>
      <p>技能内的入口可自动启动本机软件，也可使用随软件提供的 MCP 配置。软件搬到其他目录后，请重新下载技能。首次生成前需要配置自己的模型密钥。</p></details>
    <details><summary>默认制作规则 · 每集 ${rules.minChapters}–${rules.maxChapters} 章 · ${rules.chapterStrategy === 'story' ? '按剧情分集' : '固定章节分集'}</summary>
      <p>保存后用于新项目，已有项目保留原规则。默认交付${rules.delivery === 'package' ? '生产包' : '成片'}。</p>
      <div class="agent-rule-fields"><label>每集最少章节<input name="rule-min-chapters" type="number" min="1" max="10" value="${rules.minChapters}"/></label>
      <label>每集最多章节<input name="rule-max-chapters" type="number" min="1" max="10" value="${rules.maxChapters}"/></label>
      <label>分集方式<select name="rule-chapter-strategy"><option value="story" ${rules.chapterStrategy === 'story' ? 'selected' : ''}>按剧情选章节边界</option><option value="fixed" ${rules.chapterStrategy === 'fixed' ? 'selected' : ''}>固定章节数</option></select></label>
      <label>固定方式每集章节<input name="rule-fixed-chapters" type="number" min="1" max="10" value="${rules.fixedChapters}"/></label>
      <label>默认交付<select name="rule-delivery"><option value="package" ${rules.delivery === 'package' ? 'selected' : ''}>生产包</option><option value="video" ${rules.delivery === 'video' ? 'selected' : ''}>成片</option></select></label></div>
      <button data-action="save-production-rules">保存默认规则</button><p class="muted">每个片段固定 30 秒，内容过载时拆段。完整保留剧情、对白、OS、浮签和人物反应；付费生成使用本次任务额度。</p></details>
  </section>`;
}
