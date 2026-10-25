# Wealth Atlas v{{VERSION}} Windows 发布说明

本候选版本修复跨币种子账户在币种栏中被漏显示的问题。主子关系、账户余额、交易和历史汇率保持不变。
发布前须核对源码 commit、版本 tag、构建配置和三项自动更新资产；未确认候选包不得上传为正式版本。

- GitHub 自动更新仅使用公开稳定版本，不要求使用者提供发布 Token，不自动降级。
- 后台下载完成后不会立即关闭应用；正常退出后安装，重新打开使用新版本。
- 网络失败不会阻止启动，返回应用时按间隔重试。
- 发布前校验安装包、清单和 blockmap，全部上传文件通过服务器 SHA-256 核对后才公开。
- 本次不改变页面视觉、财务计算或跨设备财务同步逻辑。

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
