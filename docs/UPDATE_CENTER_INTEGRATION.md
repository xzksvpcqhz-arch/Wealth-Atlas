# 更新中心接入与候选验收（2026-11-20）

发布授权补充：用户已于2026-11-20明确确认发布v1.7.9。以下保留此前候选验收历史；正式发布将仅提交本次相关源码和模板，从匹配commit/tag的清洁副本重新构建、验收，再上传。候选安装包本身不会晋升为正式资产。

## 范围与版本

- 用户已确认代码预览，之后接入真实设置页。只处理程序更新，不处理其余四项功能。
- 工作分支 `codex/cloud-edit-conflict-guard`；原 HEAD `f1bfb6f529e59fa6af20fce0b9ac69622ead4700`，标签 `v1.7.8`。
- 根目录 package 仍是未提交的 `1.7.8` 工作树。单独准备 `1.7.9` 本地候选，不代表正式发布、已安装或已创建 tag。
- 2026-11-20 只读查询公开 GitHub API，最新正式版仍为 `v1.7.8`。未上传或修改远端。

## 接入内容

- `components/WealthAtlasV2.tsx` 的实际 `renderSettings` 路径只新增一个 UpdateCenter，原有显示设置、云端同步、Obsidian 和备份区保持原样。资产/汇率分支不变。
- 新面板读取真实 `app.getVersion()`、更新器最新版本、检查时间及下载进度。100% 下载仍等待校验，只有 SDK 的下载完成状态才显示等待正常退出安装。
- 明示错误重试冷却；配置失败要求重新启动；读接口超时/失败可重新读取。网页版、开发和隔离模式不能假装执行安装。
- 面板请求有超时和卸载取消保护、状态世代防乱序及重复点击保护。没有立即安装/强制退出入口。
- 保留既有星空主题、字体、颜色和按钮；正常 padding 22px，手机 18px，模块间距24px。仅使用局部 CSS module，没有修改全局样式、依赖、财务模型或计算。
- `tsconfig.json` 排除生成的 `work/` 临时源码，避免旧构建副本的重复全局桥接声明冲突；没有删除副本。

## 桌面接口边界

新 preload 只暴露三个无参数方法，对应 `updates:get-state`、`updates:check`、`updates:open-release-notes`。

- 主进程严格核对当前窗口、主 frame 和解析后的本地 origin；拒绝子 frame、不同窗口、前缀伪造和额外参数。
- 只返回10个白名单原始值字段，版本/时间/进度/错误枚举均有边界。不会返回 SDK notes、URL、路径、请求头或错误原文。
- 发布说明只打开固定的本项目公开 GitHub Releases 地址；不接收任意 URL、路径或命令，带重复请求节流。
- 不修改其他财务/Vault IPC，也没有提供资料读取、登录、恢复、清空或迁移操作。

## 验证结果

| 命令或范围 | 结果与限制 |
| --- | --- |
| `npm test` | 最终371/371通过，随后 TypeScript 检查通过。最初受限环境中的9个 Electron/loopback 启动失败在正常 Windows 环境原样重跑通过，没有弱化断言。 |
| `npm run build` | 无私密文件代码副本中生产静态构建通过。最终副本 `work/update-center-desktop-7abbabc9-c60c-45ca-ac86-9d423b523d01`。 |
| `node --test tests/update-center-adversarial.test.mjs` | 28/28通过，UC-001至005原始断言保留，无 skip/todo。 |
| `node --test tests/auto-updater.test.mjs tests/update-center-adversarial.test.mjs tests/update-center.test.mjs` | 54/54通过，包括14项新接口/状态/取消/超时测试；已纳入默认测试。 |
| `node scripts/updater-feed-test.cjs` | 真实 NSIS SDK、loopback 合成下载，6个场景通过。安装动作始终替换为测试桩，未执行安装器。 |
| `node scripts/update-center-desktop-test.cjs --stage=<上述副本绝对路径>` | 最终11组通过，真实 main、preload、静态设置页，更新器响应为测试注入。全新虚构 profile、外部网络阻断，未连接真实资料服务。证据 `work/update-center-tests/2a4eba11-4d1f-4086-8538-88df40935300/result.json`。 |
| 布局 | 1440×900、1280×800、390×844、320×720均通过；无横向溢出，按钮45px。手机滚动后两按钮中心命中自身，没有被底部导航遮挡。 |
| 键盘与异常 | Tab焦点环、Enter、Space；100次点击只检查一次；100%仍待校验；校验失败和冷却；固定发布说明失败重试；IPC失败/超时恢复；迟到响应不覆盖新检查；卸载后重开；隔离/浏览器禁用均通过。 |
| 代码检查 | `git diff --check`、新增 CJS 语法检查通过。 |

截图位于 `.impeccable/review/`，包括四个真实视口、全页和两张手机操作区。截图中 `9.0.0` 是独立测试驱动注入的合成更新版本，未写入生产组件或安装包更新源。

独立视觉复核发现一处可见文字和读屏名称不一致，已改为同一个 `actionLabel` 并加入实际 DOM 回归断言。复核将该项评为 resolved，disposition 为 ship；这是针对该修复的结论，不等于线上安装链路已验收。文档一致性检查确认属于旧设计的局部扩展；没有重写 PRODUCT.md、DESIGN.md 或新增设计系统。

## 本次文件

新增：

- `components/UpdateCenter.tsx`
- `components/UpdateCenter.module.css`
- `desktop/update-ipc.cjs`
- `lib/update-center.ts`
- `tests/update-center.test.mjs`
- `scripts/update-center-desktop-test.cjs`
- `.impeccable/surfaces/components-updatecenter-tsx.md`
- 本说明文件。

修改：`components/WealthAtlasV2.tsx`、`desktop/main.cjs`、`desktop/preload.cjs`、`desktop/updater.cjs`、`lib/desktop.ts`、`package.json`（只改测试命令）、`tsconfig.json`。

前轮已有的 `AGENTS.md`、更新器/对抗测试及对应报告修改继续保留；其他未跟踪 QA 文档没有覆盖、删除或提交。

## 发布边界

候选安装包的独立结果会另行追加。未签名包不得声称有可信发布者。NSIS payload 隔离测试不等于实际安装向导、注册表、快捷方式或最终线上自动更新验收。正式 commit/tag/发布前仍需用户确认并使用匹配的清洁源码重新构建；本地候选不能直接晋升为正式发布资产。

没有读取或清理真实用户数据库、财务资料、Obsidian Vault或私密环境文件；没有安装/卸载正式应用、改快捷方式、创建 commit/tag 或发布 GitHub。其余四项功能仍未开始。

## v1.7.9 安装候选结果

- 位置：`desktop-dist/release-candidates/v1.7.9-update-center-242c04e1/Wealth-Atlas-Setup.exe`。
- SHA-256：`815AA566F12064502E8E2DCB998C9B3B77289D5EC4F7104BB6EE6D65BE6CD78C`。
- `UNSIGNED`，没有经过验证的 Authenticode 发布者。
- 候选中包版本、Windows 文件版本和检查报告均为1.7.9。ASAR 内 main/preload/updater/update-ipc 与本次已审核源码哈希一致。
- 打包脚本及 release-check 完成；最终 `runtimeAcceptanceVerified=true`、`localCandidate=true`、`distributionReady=false`。后者为有意保留的发布门槛，不是正式分发包。
- 安装包 payload 运行测试完整通过：40个既有阶段覆盖空白启动、诊断、布局、编辑、保存、删除、恢复、Vault及账号隔离，另外验证1.7.8→1.7.9升级与测试资料保留、1.7.9→1.7.8回退兼容以及再次启动1.7.9。实际NSIS安装向导与注册表未执行，不能称为真实用户系统安装验收。
- 原始运行失败也已保留：深层构建副本下测试 profile 为201字符，加 LevelDB 文件名达到264字符，空白 IndexedDB 打开失败。没有改程序、安装包或弱化用例；把测试工作根设为新的短目录后，对同一SHA-256安装包原样重跑全部用例并通过。这支持测试路径长度限制的判断；未修改真实资料路径。
- 成功测试根：`C:\Users\J\Documents\Codex\wa179-qa-de32cc36`；失败现场仍在原构建副本的 `work/installed-release-tests/` 内，均为本次新建虚构环境。
- 最终报告：候选目录的 `update-center-candidate.json`、`installed-release-test.json`、`release-check.json`。204份输入源码在打包和验收后复核哈希一致，原1.7.8安装包未变。
- 候选只沿用进程环境中的既有公开云端构建配置，未加载 `.env*`；未继承发布或签名秘密，也没有连接或登录真实财务服务。

正式发布仍待用户确认版本保存/发布后，用匹配的已提交源码及tag重新构建并验收。候选本身不得上传为正式资产。剩余四项：投资工作台跨设备同步、备份恢复差异预览、券商CSV映射模板、多个具名DIY显示方案。
