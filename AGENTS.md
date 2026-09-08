# Wealth Atlas 开发流程

## 统一 UI 间距规范（每个页面都按这个来）

- **模块之间间距：24px**（和首页 react-grid `margin:[24,24]` 一致）
- **面板内边距：22px**（统一）
- 页面主体内容区（`.main-content`）padding 保持当前值。
- 改任何页面的排版时，先按这套间距，再用「示例页 → 确认 → 再全面应用」的方式推进。
- ⚠️ **CSS 坑**：`gap` 只在 **flex / grid** 容器上生效。给"区块之间"加间距时，容器必须是 `display: grid` 或 `display: flex`，否则写了 `gap` 也无效（报表页曾因此看起来"没变化"）。
- 📌 **说明文字/次要文案**：`archived-records` 等区块的说明文字（如"停用可恢复；…"）字号要**明显可读（≥13px）**，且与下方列表/空态**留出间距**（`margin-bottom ≈18px`）。不要只 +1px（用户会说"还是一样的"）。
- 📌 **改字号/间距要够明显**：用户反馈"还是一样的"时，很可能是改动太细微（比如 11px→12px 看不出区别）。UI 文本大小或间距调整尽量一次到位、肉眼可辨。
- 📌 **archived / 说明区块的标准排版**（照"本月可自由使用"面板的干净节奏）：标题（如"已停用与已删除预算"）→ 一句话说明（13px、淡色、行距 1.7、左对齐、与标题留 8px）→ 内容列表/空态；说明文字**与右上角 icon 留 ≥28px**、**文字限宽**（不贴近 icon）、**与下方列表留 ≥18px**。整体左对齐、留白舒适，不要上下大空隙。
- 📌 **多个模块绝不要并排挤成窄列**：`app-shell` 是 `display:flex`，如果 render 里把两个 `<main class="main-content module-page">`（或 main + section）直接并列返回，它们会被 flex 挤成**左右两列**（各只有 3xx px 宽），看起来"紧凑/压扁"。凡是"一个页面里有多个模块/区块"（设置页、资产页的「已删除物品资产」等），**必须用一个 `display:grid; gap:24px` 的 `.module-stack` 容器把它们上下堆叠全宽**（`.settings-stack` 是在此基础上再收敛分节标题）。这是反复踩过的坑，改动前先确认没有把多个模块并列。
- 📌 **archived 区块要给足内边距**：`.archived-records` 这类面板**默认没有 padding**（`.panel` 基类不带头内边距）。每个页面的 archived 区块都要显式给 `padding:22px 24px`（手机端 18px）+ 标题行 `gap:28px; margin-bottom:18px` + 行 `padding:16px 0`，否则内容贴边、显得紧凑。资产页曾因此返工两次。
- 📌 **UI 改动必须"先 preview → 用户确认 → 才写码 → 才发版"**：任何界面改动（哪怕只改一个数字）都要先给用户看网页 preview，确认后再动，绝不跳步。

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

> **完整 Step-by-step 流程见 `RELEASE.md`，发布前先读它。**
> 仓库是**公开**的：`xzksvpcqhz-arch/Wealth-Atlas`。公开仓库的自动更新**不需要 token**（electron-updater 走 GitHub 公开 feed + 下载 URL）；token 只在发布上传时需要。

1. 先验证：`npm test` + `npm run build`。
2. 版本号必须比当前已发布版本高（否则已安装应用不会触发更新）。
3. 发布到 GitHub：先设 `GH_TOKEN` 环境变量，再运行 **`npm run release:publish`**，electron-builder 会上传安装包 + `latest.yml` 到 GitHub Releases 作为该 tag 的资产。
   - **token 不会嵌入安装包**（默认关闭；只有显式设 `WEALTH_ATLAS_EMBED_TOKEN=1` 才嵌入，仅私有仓库场景需要）。
   - 发布用 token 建议每次临时创建 fine-grained token（只授权 `Wealth-Atlas`、Contents 读写），发布完即吊销，绝不嵌进包或发到聊天。
   - 未签名包（UNSIGNED）Windows 会显示 SmartScreen"未知发布者"警告，属预期。
4. **已知坑：electron-builder 偶尔不上传 `.blockmap`**。发布后必须核对 release 资产，缺 blockmap 就手动补传（endpoint 用 `uploads.github.com`，不是 `api.github.com`）：
   `curl -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/octet-stream" --data-binary "@desktop-dist/vX.Y.Z/Wealth-Atlas-Setup.exe.blockmap" "https://uploads.github.com/repos/xzksvpcqhz-arch/wealth-atlas/releases/<release_id>/assets?name=Wealth-Atlas-Setup.exe.blockmap"`
5. 发布成功后，已安装应用会在下次启动时自动检查并下载更新（electron-updater）。
