# Wealth Atlas v{{VERSION}} Windows 安装说明

发布状态：**{{SIGNATURE_STATUS}}**  
数字签名发布者：**{{PUBLISHER}}**

1. 只从分享者指定的 Google Drive 文件夹下载 `Wealth-Atlas-Setup.exe` 或对应 ZIP。
2. 下载后先使用 Windows Defender 扫描文件。
3. 按 `SECURITY.md` 核对 SHA-256，并查看数字签名发布者。
4. 不要安装来自转发、陌生网盘或无法核对校验值的副本。
5. 运行安装程序，按提示选择安装位置。

桌面版资料独立保存在 `%APPDATA%\Wealth Atlas`。更新安装和正常卸载不会主动删除该资料目录。网页版浏览器资料不会被安装程序读取或清除。

首次使用新版本时，Wealth Atlas 会在 `%APPDATA%\Wealth Atlas\backups` 建立带 App version 与 schema version 的本地 snapshot。请不要删除该资料目录；需要回退时可重新安装上一版，schema 未改变时上一版仍可读取原有资料。

Google Drive 可能因文件大小或可执行文件类型提示无法扫描。该提示不能通过应用代码强行取消，也不代表文件已经获得安全认证。
