# 万灵漫剧社区版 · Wanling Manju

**在自己的 Windows 电脑上，把原文、剧本、角色、分镜和视频制作放进同一个工作台。**

[下载安装包](https://github.com/jieg19274/wanling-manju-community/releases/tag/v0.4.24-community.1) · [安装与使用](docs/社区版安装说明.md) · [制作教程](docs/新手制作全流程.md) · [反馈问题](https://github.com/jieg19274/wanling-manju-community/issues) · [Apache-2.0](LICENSE)

## 可以做什么

- 原文分集、剧本与分镜编辑，核对对白、OS、浮签和人物反应的连续性。
- 角色、场景、道具参考管理，完整角色四视图绑定，画布查看与候选比较。
- 文本、图片、视频模型接入，费用确认、生成任务跟踪、失败恢复与审片。
- 成片合成、MP4 和剪映草稿导出，以及 Codex、WorkBuddy、TRAE 的 Agent 接入。
- 内置一个可直接查看的公开演示项目和样片，体验演示无需模型密钥。

软件数据保存在使用者本机。生成自己的内容需要配置自己的模型账户；模型服务按供应商实际用量计费。软件支持的模型以当前设置列表为准。

## 普通用户：下载安装

在 [Releases](https://github.com/jieg19274/wanling-manju-community/releases) 下载 Windows x64 的 `wanling-manju-0.4.24-community-windows-x64.msi`，安装后打开桌面的“万灵漫剧 社区版”。

首次启动会联网从官方渠道准备 Node.js、锁定的 npm 图片依赖及 FFmpeg，并校验下载完整性；不必手动安装 Node.js，不更改系统 PATH。网络准备失败时保留错误记录，修复网络后可以重试。准备完成后在默认浏览器打开本机界面。

需要 Windows 10/11 x64、Windows PowerShell 5.1 或更新版本。首次准备约需下载 170 MB，至少预留 1 GB 可用空间；查看内置样片无需模型密钥。详细说明见 [社区版安装说明](docs/社区版安装说明.md)。

## 开发者：运行源码

需要 Node.js 24；视频制作和导出还需要 FFmpeg/FFprobe。

```powershell
git clone https://github.com/jieg19274/wanling-manju-community.git
cd wanling-manju-community
npm ci
npm run check
npm run build
npm start
```

打开 `http://127.0.0.1:5698`，开发模式使用 `npm run dev`。本地数据库与素材默认位于 `data/`。不要把自己的数据和密钥提交到仓库。

```powershell
npm test
npm run test:smoke
npm run audit:source
npm run package:community
```

测试在独立目录运行，阻断真实模型请求。Windows CI 运行类型检查、构建、通用业务测试与无密钥启动检查。安装器构建见 [发布说明](docs/GITHUB_PUBLICATION.md)。

## 制作与 Agent 接入

锁定正式剧本后，下游分镜和提示词须保持剧情、对白、OS、浮签、系统信息与因果动作一致；过载时拆段。候选选用、参考图审核与视频审片分别完成。远端结果未知时先恢复原任务，避免重复收费。

使用流程见 [新手制作全流程](docs/新手制作全流程.md) 和 [演示教程](docs/试用版演示教程.md)。Agent 接入使用 `npm run agent -- connect` 或 `npm run mcp`，见 [AGENT_START.md](AGENT_START.md)。

## 参与和许可

欢迎提交可复现的问题和改进：[贡献说明](CONTRIBUTING.md)。分享万灵时请使用本官方仓库链接，让使用者容易找到更新与反馈入口。

万灵原创程序和文档按 [Apache License 2.0](LICENSE) 发布，版权及归属声明见 [NOTICE](NOTICE)。第三方代码、依赖和素材保留各自适用的许可：[第三方许可](THIRD_PARTY_NOTICES.md)、[依赖与来源](docs/依赖与来源.md)、[素材来源](catalog/PROVENANCE.md)。用户导入的原文、素材和生成作品不因本软件开源而取得授权或转让版权。

当前公开仓库从整理后的发行快照创建，未复制旧私有仓库历史；不含旧开发记录、私人制作项目、账户、密钥或制作人专用付费授权。社区版默认关闭旧发行渠道的自动更新，通过本仓库 Releases 获取新版。
