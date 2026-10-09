# 第三方许可与来源

万灵原创部分采用根目录 LICENSE 中的 Apache-2.0 开源许可，署名见 NOTICE。以下第三方部分仍适用其各自许可，不改为万灵的许可证。

| 部分 | 许可 | 随附记录 |
| --- | --- | --- |
| Infinite Canvas 画布组件，锁定提交 dab19adc0847e32e39b7fc8ff90cb392561fb826 | MIT，Copyright (c) 2026 basketikun | third-party/infinite-canvas/LICENSE、PROVENANCE.md |
| React、React DOM、Scheduler 19.2.5 系列运行代码 | MIT，Meta Platforms, Inc. and affiliates | 下载包 third-party/REACT-LICENSE、REACT-DOM-LICENSE、SCHEDULER-LICENSE；源码依赖安装后的各包 LICENSE |
| Vite 7.3.6 生成的前端辅助代码 | MIT 及其文件列出的第三方声明 | 下载包 third-party/VITE-LICENSE.md；源码依赖安装后的 vite/LICENSE.md |
| LocalMiniDrama 的本机迁移来源 | MIT，Copyright (c) 2026 xuanyustudio | third-party/local-mini-drama/LICENSE、PROVENANCE.md；数据迁移范围见 catalog/PROVENANCE.md |
| sharp 0.35.5 | Apache-2.0 | 使用者从官方 npm 安装后 sharp/LICENSE |
| @img/sharp-win32-x64 0.35.5 原生依赖 | 包元数据为 Apache-2.0 AND LGPL-3.0-or-later；实际组件分别适用各自许可 | 使用者从官方 npm 取得的包内许可与上游 notices |

源码构建依赖（TypeScript、tsx 等）与传递依赖的精确版本和完整性哈希在 package-lock.json 中锁定，其各自许可证保留在官方 npm 包内。此表不能替代相应许可全文。

依赖安装型下载包没有附带 node_modules、Node.js、FFmpeg、sharp/libvips DLL、Real-ESRGAN 或模型。使用者自行从官方渠道取得这些运行依赖。FFmpeg 的许可取决于具体构建，可能为 LGPL 或 GPL；本应用以独立命令行工具调用，不内嵌其库。

内置风格预览及特效描述的创作和用户使用授权记录见 catalog/PROVENANCE.md。公开演示项目的媒体文件以 examples/promo-demo/manifest.json 中的哈希标识。私人小说、正式制作素材和账户记录不属于下载包。

参考上游：

- https://github.com/basketikun/infinite-canvas
- https://github.com/xuanyustudio/LocalMiniDrama
- https://github.com/facebook/react
- https://github.com/vitejs/vite
- https://github.com/lovell/sharp
- https://github.com/lovell/sharp-libvips
- https://ffmpeg.org/legal.html

## 社区版首次启动取得的工具

社区 MSI 与 ZIP 不捆绑第三方运行工具。使用者首次启动时从 Node.js 官方下载 Node.js 24.21.0，保留完整发行目录中的 LICENSE 与 npm 许可；从官方 npm registry 安装 package-lock.json 锁定的 sharp 及原生依赖，保留各包许可；从 FFmpeg 官方下载页推荐的 Gyan 构建仓库取得 FFmpeg/FFprobe 9.0.2，保留其 LICENSE、README 和文档。Gyan 该构建采用 GPLv3，应用通过独立命令行调用它，不把 FFmpeg 库链接进应用。固定下载地址与 SHA-256 见 scripts/community-runtime.json，成功准备后的来源记录保存在本机 runtime/setup/provenance.json。

Windows MSI 由 WiX Toolset 编译，仅含 Windows Installer 表与应用文件，不含 WiX 自定义动作或工具运行库。WiX 编译工具不随安装包分发。
