---
name: wanling-manju
description: 操作已安装的万灵漫剧，从小说原文完成分集、剧本、资产、分镜、生产包或授权范围内的视频制作，并继续已有项目。适用于“用万灵漫剧制作/继续漫剧”；不用于改软件源码。
---

# 万灵漫剧接管

模型来源：制作请求使用当前 context 中的 `project.textModel/imageModel/videoModel`；全局准备检查与软件默认选择只描述新项目默认值。检查已有项目时传 projectId 或读取 dashboard，不把默认模型当作本项目已经使用的模型。模型不一致时如实报告两者；用户可在 Agent 准备检查点击“本项目改用…”或到“本项目生成模型”切换。切换后重新读取 context 并沿用任务配置校验，不能自动替用户修改模型或重置额度。

切换模型后的核对：先比对 context.connection 的软件版本、安装目录、数据目录和 project.id，确认正在操作用户界面中的同一项目。旧工作流的 error/history 描述上次提交，不能把旧 Fable 报错当作新 Opus 请求的结果。查询 context.modelRequests：model 是适配器请求快照，http.model 是实际 HTTP 请求中的模型，http.status/requestId 用于对账。没有新增请求记录时如实报告“切换后尚未提交”。新模型请求仍报错时保留其请求 ID 与 HTTP 回执，不凭历史模型名判断当前配置；不自动重试或重建额度。

旧版已有剧本的补核对：读取 context.scriptReadiness（大项目按 episodeId），保留所有现有 scriptBeats、节点 ID、对白/OS、浮签、系统信息和人物反应。缺原文时请求完整原文；有原文时完整阅读并用 episode.confirmSource 记录范围。缺高光报告时优先导入已有报告，或基于实际完整阅读用 episode.update.highlightReport 写出报告并以 episode.confirmHighlight 核对；这两个本地动作不调用软件收费模型。软件生成高光候选仍需本次任务额度。核对已有节点与高光、原文逐字依据后，沿用 script.lock 锁定现有剧本，不重新调用 episode.writeScript 或生成整部剧本。补依据只使用 beat.update.sourceQuote 等实际需要的字段；缺漏或矛盾须列出具体集/节点，不编造证据或绕过核对。核验使用本次零生成额度任务也可执行，不能伪造历史审核。

软件自带技能与教程随签名自动更新升级。每次连接后，先读取返回的 `skill` 最新文件与 `tutorial`（当前制作教程），以 `softwareVersion/resourcesVersion` 确认版本；不要沿用旧客户端缓存的制作顺序。外部客户端已导入的副本需重新下载导入。教程也包含在本技能的 `references/workflow-guide.md`。

使用本机万灵漫剧的业务接口制作。先调用 MCP `agent_connect`；没有连接器时，用当前技能目录的 `scripts/run.mjs`：`node <技能绝对路径>/scripts/run.mjs connect`。它自动启动或复用正确安装目录的服务，并返回本机准备检查。其他命令为 `readiness/projects/create/context/dashboard/task/command/defaults`，JSON 参数写到本机文件后将其绝对路径作为第二参数。安装目录由 `installation.json` 记录；移动软件后重新运行安装入口。

若系统找不到 `node`，读取技能目录的 `installation.json`，使用 `<root>/tools/node/node.exe` 执行上述脚本；免安装包已包含运行时，无需另外安装。图片制作先核对基础身份图，再用它生成剧情状态图。已有且已核验的状态图继续复用。

## 开始与续跑

1. 查询已有项目，匹配用户所指作品；有多个同名项目时先澄清。复用原项目、任务、资产和成功版本。新项目通过 `agent_create_project`/CLI `create` 创建，`requestId` 固定，重发复用。读取 `agent_context` 获取完整原文、`stateHash`、任务与工作流状态；大项目按 `episodeId` 读取本集完整内容，不用摘要冒充完整阅读。
   先查看 `agent_readiness`/CLI `readiness` 与 `agent_dashboard`/CLI `dashboard`；只提示当前交付步骤缺少的原文、配置或额度。配置检查不代表远端连接成功，不调用收费模型试探。轻量进度轮询用 dashboard，修改或核验前仍须读取 context。软件“Agent 任务”页保存进度、剩余额度、交付文件和核验记录。
2. 制作规则从接口继承：默认每段30秒、每集1–3章按剧情断点分集，完成分镜生产包后停止。用户指定制作视频时，本次任务才设 `delivery: video`。保存新偏好用CLI `defaults`，只影响以后新建项目；改变已有项目规则需显式要求。
3. 常规小说用 `project.source` 保存全文。完整读完原文后，按自然剧情确定每集采用章节，用 `project.planChapterGroups` 的 `chapterEnds`（1-based章末序号，如 `[3,5,8]`）提交边界，再 `project.createEpisodes`。分集必须完整、连续覆盖全文，不编造章节、不固定按3章截断因果。识别失败就定位并澄清原文章节。用户只提供本集原文时，建立推文类型分集保存完整原文，不能虚构全书计划。
4. 一次说明本次集数、交付边界、生成额度与费用口径。根据用户明确任务建立 `agent_task`（CLI `task`）：`requestId, agent, statement, confirmed:true, episodeIds, delivery, allowGeneration, limits:{text,image,video}`。`statement`记录用户授权原话。只有明确接受未知费用时才设`acceptUnknownCost:true`；金额上限还须`maxAmount,currency`，无法可靠证明不超额就暂停。次数上限不是金额承诺。授权有效24小时，不从历史任务继承费用授权。仅写草稿和核验可用零生成额度；生成图、视频或软件文本调用须有本次额度。

## 执行协议

修改前读取最新 `agent_context`。`agent_command`/CLI `command` 参数含`projectId, requestId, expectedHash:stateHash, command, taskId`以及相关ID。同一操作固定requestId；收到结果未知先查原记录，不改requestId重复生成。可用`command`：`action/start/continue/pause/cancel/inspect/recover/revoke`。

- `action`使用`agent_connect.actions`列出的业务动作，动作正文放`action`中。草稿动作可准备原文与分集。`episode.writeScript`一次写完整`beats`，每项含`event,reaction,sourceQuote,dialogue[],os[],floatLabels[],systemPanels[]`，可含`speechOrder`，原文证据须原样存在。锁稿后严禁下游改剧情；修订须另行明确要求。
- 核验动作必须携带`review:{stateHash,notes}`，notes写具体比对依据、结论和不足；使用Agent身份记录，不声称用户已审片。确认原文还须`sourceHash`（本集`sourceText`的JSON SHA256，可由context.sourceHashes读取）、`readStart:0,readEnd:完整原文字数`。只有实际读完才确认。
- `start`指定`episodeId`，任务工作流从已有进度开始。`continue`指定`workflowId`；调用后查询工作流和任务，等待模型/本地任务完成。额度内步骤通过此命令执行，无需每步回软件确认。碰到`waiting_review`就完成对应内容核验与业务动作，再继续。禁止以“字段final”或结构检查通过代替剧情核对。
- 工作流可生成高光、剧本、资产和子镜候选；也可由接手Agent依据完整原文直接写草稿。高光报告须记录章节范围、起因/目的/反应/结果、名场面/原文金句、专名映射、未采用素材。然后核对高光、锁定正式剧本，先完成逐节点原文语义与高光覆盖核对（`episode.storyReview`），再提取资产或付费出图。核对记录过期时先重核；候选不能代替正式确认。资产先查已有身份/服装状态，审图后显式绑定参考图。保存`segment.update.visualPlan`，逐镜按正式稿核对，必要时用`segment.writeSubshots`写全部子镜（完整lineRefs覆盖对白、OS、浮签和系统信息），最后`segment.subshots.approve`。
- 核验链固定为完整原文高光报告→正式剧本→正式分镜→导入版→最终视频提示词。保留事件顺序、原因/人物反应/结果、所有对白/OS、浮签和系统信息。对照context.layers中的正式分镜、导入版和已选提示词逐项检查，核验记录包含这五层的实际依据。需要原文覆盖和跨段衔接时用`episode.storyReview/continuityReview`记录相应范围和引用。过载拆段；提示词2200–2600字仅为软目标。
- 人物统一生成、导入和绑定`turnaround`完整四视图＋大头照：依次正面全身、90°侧面全身、背面全身、正面大头近照，同一脸、发型、服饰和当前形态；第四格不是45°全身图。实际查看后才审图，错误布局或身份先返修。已核验含大头照的整图（`layout: three-view-portrait`）直接显式绑定`imageId`，整张作为一个角色参考传递；禁止独立全身照、独立头图、裁切提取及`portraitImageId`新绑定。导入旧整图后可在`asset.imageReview`中以`layout: three-view-portrait`记录已实际核验的布局。提示词说明各视角属于同一角色，不把拼图版式搬入剧情。不能看片时等待有能力的核验者。
- 旧独立主图、头图和裁图仅作为历史记录保留，不进入新制作流程；后续制作应先补选并审查完整四视图，不自动重新付费生成。剧情状态沿用已审基础身份参考，不提前加入其他状态。返修在原图上点“以此图返修”，核对原图ID、指纹、参考用途与费用；人物返修输出仍为完整四视图，未通过原图只继承明确正确部分。模型出错不自动付费重试，不能改剧情迁就错图。
- 无字动作锚点板仅用于站位、构图、动作方向、空间与末帧；错误重做，不能改剧情迁就图。对白和OS声音由视频模型用对应角色声线生成；后期文字覆盖不替代声音。图片/视频实际查看后才批准；审片先用`inspect`做技术检查，再实际听看并逐句提供声音时间证据，`segment.videoReview`携带checks和speech，随后选用并放行首片。不会看片/听音或缺工具时报告具体阻断，不能全填true。
- `inspect`仅检查文件时长、分辨率、音轨、黑帧和静止风险，不能判断剧情、角色表演、对白内容、声线或口型。内置 Agent 没有视频/音频观看工具时，须等待实际听看的用户或有相应能力的外部工具核验，不能以技术检查结果批准审片。
- 模型请求未知、断网或重启后保留原任务ID，通过context查询或`recover`找回已生成结果。失败记录不触发自动付费重试。生成额度消耗在提交前预留，未知结果也计入上限。`revoke`撤回授权并取消关联流程；暂停同时锁住关联任务，重启仍有效。恢复必须由用户在软件任务面板操作，不能自行解除暂停或另建额度绕过；恢复不重置消耗，已提交请求可能继续返回结果。用户恢复后，外部 Agent 继续运行才会进行后续核验与制作。

## 提示词版本更新与清理

已有 `segment.writePrompt` 接口可写入完整新版并选用；可传 `archivePrevious:true` 停用原选版，`expectedPromptId` 对应刚读取的选版ID（未选用时为null），不能跳过正式剧情、对白／OS、浮签及逐镜结构校验。合规旧版不因模板措辞或版本更新自动失效。

单段管理使用 `segment.prompt.unselect`、`segment.prompt.archive`、`segment.prompt.restore`，携带 episodeId、segmentId、artifactId。停用版退出当前版本列表并禁止新选用，完整正文保留为历史来源；恢复不自动选用或审核放行。取消选用后，新编译候选不会自动选回；须主动核对并选用。

同分集批量更新使用 `episode.prompts.manage`，携带 episodeId、operation 和明确的 entries。operation 为 archive／restore／unselect／select 时，每项提供 segmentId、artifactId；replace 时每项提供 segmentId、完整 content；可附 expectedPromptId 校验选版快照。select／replace 可传 archivePrevious:true。全部项目验证通过后一次落盘；同段不能一次选用或写入两个版本，任一项失败整批不改。用稳定 requestId 提交 action，丢失响应先查询或重放原请求，不另写一批重复版本。

清理不修改已提交任务的冻结正文、生成签名或已验收视频的原始记录。不要绕过接口删除历史正文、视频来源或数据库记录；不能把“停用”报告成“原记录已物理删除”。软件界面在制作画布／版本表提供“提示词管理”，支持全文写入、取消选用、批量换选、停用及恢复。

## 交付

生产包任务导出后结束；视频任务先验证首片，再逐片审片并选用，最后导出MP4和剪映草稿。只报告实际生成且核验过的文件和绝对路径，给出未解决项。保存projectId、taskId、workflowId及下一步，便于一句“继续这个项目”续跑。默认不发布、不覆盖旧视频或用户精剪工程。
