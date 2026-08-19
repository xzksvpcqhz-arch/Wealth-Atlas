# Wealth Atlas v{{VERSION}} Windows 发布说明

- 发布状态：**{{SIGNATURE_STATUS}}**
- 发布者：**{{PUBLISHER}}**
- 安装类型：Windows x64 NSIS 安装程序
- 桌面资料目录：`%APPDATA%\Wealth Atlas`
- 首次安装：独立空白桌面资料
- 更新安装：保留现有桌面资料
- 卸载配置：不主动删除桌面资料目录
- 网页版资料：安装程序不读取浏览器 IndexedDB 或 localStorage

本发布不会改变既有页面、财务计算或 Obsidian 工作流程；更新前会在本地建立资料快照备份。
## v{{VERSION}} startup stability

- Missing FX paths now fail safely without recursive render crashes.
- Startup diagnostics use browser clipboard, secure Electron IPC, manual selection, and local-file fallbacks.
- IndexedDB failures preserve the original snapshot and provide retry and backup-location actions.
- Identical short-window startup backups are verified and reused; older backups are never deleted.
