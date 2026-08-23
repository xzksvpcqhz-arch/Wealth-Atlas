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

1. 先验证：`npm test` + `npm run build`。
2. `npm run release:windows` → 生成 `desktop-dist/vX.Y.Z/` 下的：
   - `Wealth-Atlas-Setup.exe`（安装包）
   - **`latest.yml`**（自动更新元数据，必须随安装包上传）
   - `Wealth-Atlas-Setup.exe.blockmap`（增量更新块）
3. 发布到 GitHub（让应用自动更新）：先设 `GH_TOKEN` 环境变量，再运行 **`npm run release:publish`**，electron-builder 会把安装包 + `latest.yml` + `.blockmap` 一起上传到 GitHub Releases 作为该 tag 的资产。
   - 若构建时报 GH_TOKEN 缺失/无效，属正常（需要先配置 token）。
   - 未签名包（UNSIGNED）Windows 会显示 SmartScreen"未知发布者"警告，属预期。
4. 发布成功后，已安装应用会在下次启动时自动检查并下载更新（electron-updater）。
