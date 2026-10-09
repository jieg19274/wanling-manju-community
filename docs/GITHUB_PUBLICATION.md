# 社区版源码与发布

源码：https://github.com/jieg19274/wanling-manju-community

下载：本源码仓库 Releases。原下载仓库提供同版本入口。

社区版采用 Apache-2.0，第三方部分保留原始许可。仓库从干净快照创建，旧私有仓库的开发历史不进入公开 Git 历史；历史 MVP、逐版开发说明和设计规范不发布。生产小说、剧本、素材、任务账本、供应商记录、预算授权、账户、密钥和本机部署配置也不发布。

`package.json` 的 `private: true` 仅阻止误发布到 npm，不代表 GitHub 仓库私有。发行边界由 `npm run audit:source` 和通用发行测试检查。

```powershell
npm ci
npm run check
npm run build
npm test
npm run test:smoke
npm run audit:source
npm run package:community
```

`package:community` 生成尚未验收的候选目录，包含 Apache-2.0、NOTICE 和第三方许可；不捆绑下载的原生运行库。Windows 安装器使用 WiX Toolset 编译，指定工具目录和候选目录：

```powershell
$env:MANJU_WIX_DIR = 'C:\tools\wix'
npm run package:installer -- '候选目录绝对路径'
```

安装器只安装应用文件和快捷方式，运行环境由首次启动时从固定上游地址获取并校验；不捆绑 FFmpeg 或 sharp/libvips 二进制。每个候选必须独立检查安装、首次联网准备、无密钥启动、演示素材与卸载；验收通过后才将 `shareReady` 标记为 true，并生成 ZIP、MSI 和 SHA256SUMS.txt。

社区版默认关闭旧发行渠道自动更新，防止来源与许可不同的包覆盖本地社区版。源码构建版本和安装器均为 0.4.24，发行标签使用 `v0.4.24-community.1`。
