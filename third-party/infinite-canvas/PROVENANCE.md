# Infinite Canvas 画布组件

来源：https://github.com/basketikun/infinite-canvas

锁定提交：`dab19adc0847e32e39b7fc8ff90cb392561fb826`，作者 basketikun，MIT；许可全文见同目录 LICENSE。

木木本地创作台的前端页面注明使用 Infinite Canvas。Studio 直接内置以下上游源码：

- `web/src/components/canvas/infinite-canvas.tsx`
- `web/src/components/canvas/canvas-connections.tsx`
- `web/src/components/canvas/canvas-mini-map.tsx`
- `web/src/types/canvas.ts`
- `web/src/lib/canvas-theme.ts`

本地位置：`web/vendor/infinite-canvas/`。改动：导入改为相对路径，Tailwind 类换为局部 CSS 类；应用级主题和节点注册表改为 Studio 适配器。以下记录对应组件的修改范围，原作者入口保留在画布底部。

2026-10-01：视口使用定位与内部 CSS zoom，移除 transform scale / will-change 整体位图缓存，确保高倍缩放时文字重新排版与栅格化。连线与拖动继续按同一世界坐标换算。节点编辑、工作节点、素材收集和固定大小浮动工具条是本地业务扩展。

分镜/资产/版本节点、布局历史、Studio 操作回调和持久化适配由本项目实现；没有复制上游生成、账户、Agent、插件和网络接口。第三方组件在 Vite 构建时打入 Studio，运行无需木木服务。

2026-10-01：dark 主题中的背景、网格、选区、节点及小地图颜色适配万灵漫剧统一深蓝/青色规范。连接的命中区域保留；Studio 只突出选中节点的直接关联线，并关闭线条的泛光效果。
