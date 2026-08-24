# Wealth Atlas 开发流程

## 修改前

1. 每次修改代码前，必须先检查当前 Git 状态。
2. 不得覆盖或删除用户未要求修改的功能、真实财务数据或历史记录。
3. 涉及真实数据删除、数据库迁移或其他破坏性操作时，必须先要求人工确认。

## 修改与验证

1. 完成功能修改后，必须运行：
   - `npm test`
   - `npm run build`

删除项目文件时，必须先移入 `D:\Trash`；如果无法移入，则停止并要求人工确认。

## 桌面版发布（GitHub 自动更新）—— 每次发布都要记住

> 仓库现在是**公开**的：`xzksvpcqhz-arch/Wealth-Atlas`。公开仓库的自动更新**不需要 token**（electron-updater 走 GitHub 公开 feed + 下载 URL）；token 只在发布上传时需要。

1. 先验证：`npm test` + `npm run build`。
2. 版本号必须比当前已发布版本高（否则已安装应用不会触发更新）。
3. 发布到 GitHub：先设 `GH_TOKEN` 环境变量，再运行 **`npm run release:publish`**，electron-builder 会上传安装包 + `latest.yml` 到 GitHub Releases 作为该 tag 的资产。
   - **token 不会嵌入安装包**（默认关闭；只有显式设 `WEALTH_ATLAS_EMBED_TOKEN=1` 才嵌入，仅私有仓库场景需要）。
   - 发布用 token 建议每次临时创建 fine-grained token（只授权 `Wealth-Atlas`、Contents 读写），发布完即吊销，绝不嵌进包或发到聊天。
   - 未签名包（UNSIGNED）Windows 会显示 SmartScreen"未知发布者"警告，属预期。
4. **已知坑：electron-builder 偶尔不上传 `.blockmap`**。发布后必须核对 release 资产，缺 blockmap 就手动补传（endpoint 用 `uploads.github.com`，不是 `api.github.com`）：
   `curl -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/octet-stream" --data-binary "@desktop-dist/vX.Y.Z/Wealth-Atlas-Setup.exe.blockmap" "https://uploads.github.com/repos/xzksvpcqhz-arch/wealth-atlas/releases/<release_id>/assets?name=Wealth-Atlas-Setup.exe.blockmap"`
5. 发布成功后，已安装应用会在下次启动时自动检查并下载更新（electron-updater）。
