# 特效目录来源记录

## 创作与用户使用授权（2026-10-01）

用户在本会话确认：软件中的素材图片由用户自行使用 AI 重新生成，特效描述由本项目助理为用户编写；素材和特效可以提供给软件用户使用。用户版可包含这些图片、风格预览和特效描述。下文路径记录技术迁移来源，不代表第三方创作来源。

本目录的三个 JSON 数据文件来自本机 `ManjuFlow-Studio-V2/backend-node/src/data/`，于新项目建立时复制，未复制其服务、前端或匹配引擎代码。

- `effect-library-source.json`：187 条，原数据逐项标有 `authorship`；本会话已确认创作来源及用户使用授权。
- `effect-library-frame-local.json`：10 条木木工坊本地新增项。
- `effect-library-frame-adaptations.json`：上述 10 条的原始视觉适配描述。
- `effect-library-adaptations.json`：从旧项目 `effectLibraryService.catalog()` 一次性提取的 101 条可适配描述、ID 和别名。运行新软件不依赖旧项目代码。

首版只让已有适配描述的 101 条进入正式提示词；其余条目可浏览，不能把原始独立模板直接套入已锁定剧情。目录版本按内容哈希绑定，目录变化不自动重写已有片段。

## 3D 风格目录

`shared/style-presets.ts` 的 15 个风格名称、分组依据与 `web/public/style-thumbs/` 中的预览图，从用户本机木木工坊 `ManjuFlow-Studio-V2/frontweb/src/constants/styleOptions.js` 和 `frontweb/public/style-thumbs/` 迁移。图片是用户自行用 AI 重新生成的素材，已获用户在软件用户版中使用的授权。只迁入风格数据与预览图，运行时不依赖旧软件的前端或服务代码。视觉描述为本项目重新整理：删除“所有文字禁止”、旧作品专名、特定模型名和无原文依据的剧情元素，以免覆盖浮签、系统面板和正式剧本。
