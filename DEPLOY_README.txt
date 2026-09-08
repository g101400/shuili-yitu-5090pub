水利工程一张图 - iOS 可托管 HTTPS PWA 模式包
============================================
版本：3.62_20260908
来源：多端一键打包技能（multi-platform-app-pack）

【这是什么】
  本 ZIP 是「水利工程一张图」的 PWA（渐进式 Web 应用）资源包，可托管到任意
  HTTPS 服务器后，在 iPhone/iPad 的 Safari 中「添加到主屏幕」，获得类原生 App
  的体验，且首次加载后可离线查看（Service Worker 缓存 App Shell）。

【部署步骤】
  1. 解压本 ZIP 到 HTTPS 站点的一个目录（如 https://your.domain/shuili/）。
     注意：必须是 HTTPS（iOS 的 PWA / Service Worker 仅在安全上下文生效）。
  2. 确保目录内含：index.html / manifest.webmanifest / sw.js / icons/。
  3. 用 iOS Safari 打开该 index.html 地址。
  4. 点「分享」→「添加到主屏幕」，图标即出现在主屏，点击以全屏独立 App 运行。

【平台差异（允许不同）】
  - GPS 定位：浏览器授权可用；离线 WebView 同 Android 限制（v3.23 已修复 confirm→ask）。
  - 导航唤起：以打开地图网页为主（Android 走 geo: 深链，iOS 受限）。
  - 圈选虚线圆动画：以高亮标记替代 transform 虚线圆动画。
  - 导入/导出文件访问：受 iOS 沙盒限制，走 Web 文件选择器做轻量导入。

【与 Android 版核心一致】
  Leaflet 地图、筛选/查询、类型规范清单(CANONICAL_TYPES)、测距/周边搜索、
  离线对话框(ask) 等核心前端逻辑四端与 Android 3.62_20260908 完全一致。

生成时间：2026-08-21
作者：小七 AI 万能助理 / 炎冰
