# Wealth Atlas — 上下文交接文档（Codex → DeepSeek）

> 本文件由迁移工具自动整理生成（2026-08-15）。原始 Codex 会话时间线见 `_migration/codex-timeline.md`，解析脚本见 `_migration/parse-codex-rollouts.mjs`。
> 交接深度：**近期（8/13 之后）详细 + 早期（8/12 之前）里程碑摘要**。

---

## 1. 项目概览

| 项 | 值 |
|---|---|
| 名称 | Wealth Atlas（我的财富星图） |
| 版本 | 1.4.4（package.json），v1.4.0 为桌面版 approved baseline |
| 定位 | 本地优先（local-first）的多币种个人财务工作台 |
| 目标用户 | 在新加坡工作、收入 SGD、资金流动 SGD↔MYR、持有 USD 投资折算 SGD |
| 技术栈 | Next.js 15 + React 19 + Tailwind 4 + TypeScript 5.9 + Electron 43（桌面壳）+ Dexie/IndexedDB（本地存储）+ Recharts + react-grid-layout + zod + exceljs + jszip |
| 代码位置 | `E:\DeepSeek Project\Deepseek info\WealthAtlas\`（自 `C:\Users\J\Documents\Codex\2026-08-10\new-chat` 迁移） |
| Git | 完整历史已保留，最后提交 `c868146`（08-13，打包为受保护 Windows 桌面应用） |
| 桌面应用 | NSIS 安装包，产品名 "Wealth Atlas"，已装桌面快捷方式（指向旧路径的安装版） |

**当前工作区有未提交改动（见第 7 节）** —— 对应 Codex 最后一次请求（8/15"新增主账户 + 小账户紧凑排版"），属于进行中的工作。

---

## 2. 开发规则（AGENTS.md，必须遵守）

1. **修改前**：先检查当前 Git 状态。
2. 不得覆盖/删除用户未要求修改的功能、真实财务数据或历史记录。
3. 涉及**真实数据删除、数据库迁移、破坏性操作**时，必须先要求人工确认。
4. **修改后**必须运行：`npm test`、`npm run build`。
5. 删除项目文件时，必须先移入 `D:\Trash`；无法移入则停止并询问。

## 3. 产品核心原则（PRODUCT.md 摘要）

- **操作模式**：打开应用即做决策/记录，视觉永远不掩盖金额、币种、时间、错误恢复。
- **首页**：数秒内展示可支配资金、未来 30 天余额、汇率、目标、资产值、待办提醒。
- **Obsidian 同步**：显式、本地优先。只记得 Vault 名与目录句柄；同步永远走 扫描→预览→确认→备份→写入；`WEALTH_ATLAS_AUTO_START/END` 标记外的 Markdown 绝不触碰；权限错误回退 ZIP 下载。
- **多币种**：手动 FX 本地化且版本化，只追加不覆盖；交易保存 FX 快照不可变；实时 API 与自动换汇不在范围内。
- **软删除**：交易/转账删除 = 标记 `deleted`+`deletedAt`，从所有计算消失，进本地回收站，可恢复；永久删除是显式第二步。
- **只读模型**：报表、预测、场景、图表全部是本地快照之上的读模型；导出（Excel/PDF/PNG）绝不改写数据。
- **数据保护**：发布必须跨迁移/回滚保留用户记录、FX 快照不可变、保护 Obsidian 手写区、下载/权限/离线/空态/错误全部可见。

## 4. 设计系统（DESIGN.md 摘要）

- 深空蓝黑画布 `#040b15/#06101d`，半透明面板，青色星芒强调 `#3cd9f5`，正绿 `#8fe1b4`，琥珀警示 `#e8bc75`，文字 `#eef6ff/#8292ab`。
- 桌面 242px 左侧导航栏；移动端固定底栏。
- 数字用等宽数字（tabular figures）+ 显式币种标签；混合币种显示源币种+报表币种折算。
- 所有主控件有键盘焦点；`prefers-reduced-motion` 生效；不用紫色 AI 渐变/赛博霓虹。
- 删除是受保护流程：确认面显示日期、金额、类别、账户及对余额/预算的影响；toast 提供恢复入口；回收站负责恢复与二次确认。

## 5. 版本演进（CHANGELOG 摘要）

- **v0.1–0.3**：响应式首页、IndexedDB 本地持久化、SGD/MYR 转账与手动 FX、记账、储蓄目标、年度计划、深空蓝黑设计系统。
- **v0.4**：Obsidian Vault 连接与同步工作台（预览、受保护区域、备份、模板、ZIP 回退）。
- **v0.5**：多币种 FX 中心（SGD/MYR、USD/SGD、不可变快照、币种敞口、未来 MYR 需求、场景模拟）。
- **v0.6**：资产管理（购买/当前币种、使用天数、每日成本、状态）。
- **v0.7**：软删除+回收站+永久删除二次确认；资产使用起始模式。
- **v0.8**：未来现金流（7/30/60/90 天、安全余额、可支配）、计划付款日历、Watchlist、财务提醒。
- **v0.9**：Excel 扩展导出、PDF 报告、PNG 图表、导出反馈。
- **v0.10**：债务场景模拟、现金流地图、净资产分解、月度回顾。
- **v0.11**：PWA 壳、离线状态、移动端快捷入口。
- **v0.12**：可选银行/FX 适配器接口（默认禁用）、CSV 导入去重审查。
- **v1.0.0**：稳定版（8/10），最终验收清单。
- **v1.1.0**（8/10）：导航持久化、首页快捷捕获工具条、账户可改名/分组/机构/停用、一级收入支出类别、类别感知预算、目标周期、schema 10 增量迁移。
- **v1.4.0**（8/13）：**Windows 桌面版 + NSIS 安装包**（桌面存储隔离、原生 Obsidian Vault 访问桥、启动日志、PWA 禁用），成为新 approved baseline。
- **v1.4.1–1.4.4**（8/13–8/14）：首启加固、启动错误页+诊断 ID、IndexedDB 打开/读取失败分阶段、SHA-256 备份清单、Obsidian 断开连接受保护确认流、缺失 FX 路径递归修复、跨进程去重备份。

## 6. 用户需求与决策历史（Codex 会话）

### 6.1 早期（7/25 – 8/12，里程碑摘要）

- **7/25–7/30**：配置 CC Switch 接入 DeepSeek/Gemini、Codex resume、多模型 agent 协作咨询（与项目无关的基建对话）。
- **8/9 15:03**：把"提取关键帧/视频下载"切到 DeepSeek（当时在做别的小工具）。
- **8/9 19:06**：**项目起点** —— "我想要设计一个只属于自己的财富理财师"；补充：在新加坡上班、增加多一个（需求）。随后搜索 top 5 记账软件找可借鉴功能，按 P0/P1/P2 排出完整 proposal 并 review。
- **8/9 – 8/10**：连续迭代 v0.1 → v0.7 → **v1.0.0**（"直接做完最后一版，我再去 test 每个功能"）。期间用户反复要求"下一步"、逐个 review。
- **8/10 13:48**：修复所有"删除"相关按钮 → **8/10 21:29**：完整删除功能 + 全项目排版修复（"一步完成，不要只加表面按钮"）。
- **8/10 14:59**：接入 **DeepSeek V4 Pro 代码审核**功能；**8/12 01:30**：之后不再需要 DeepSeek pass/fail，全部在 Codex 内完成（review 流程改为 Hermes ↔ Codex 文件桥，见 `docs/HERMES_CODEX_WORKFLOW.md`）。
- **8/12 11:33**：把当前版本设为"已确认的设计基准版本"（approved baseline）；随后仅对账户管理页做局部微调。

### 6.2 近期详细（8/13 – 8/15）

- **8/13 02:29**：收支记录里月份不能按 → 修复月份选择器；8/13 03:13 仍不能选 → 再 review（最终产出共享月份选择器提交 `b39137b`）。
- **8/13 04:39**："我想要再加多一页报表的"——想知道开支/收入来源及占比以便调整；**04:44**：先做 sample 看，认可后按截图写 prompt；**04:49**：报表页排在"账户总览"和"收支记录"中间（产出 `5f5bf87` 简明财务星座报表）。
- **8/13 10:31**：问以后只更新功能/排版、不动资料（含 Obsidian）是否可行 → 确认数据保护规则。
- **8/13 10:40**："我要怎么把这个变成软件放桌面" → **v1.4.0 桌面版**（8/13 12:24 完成，设为新 approved baseline）。
- **8/13 12:28**：想分享给朋友怎么办 → 出安装包/分享说明。
- **8/13 13:06**：v1.4.0"安全发布与 Windows 安装包签名准备"；13:31 问安装包是否有更新；14:02 与 14:55：修复桌面版首次启动错误（→ v1.4.1）。
- **8/14 00:57**：从 approved baseline 出发，只改 Obsidian 同步工作台的"断开连接"按钮与确认流程（→ v1.4.2）。
- **8/14 04:05 / 04:34**：调试 IndexedDB 初始化失败，准备 v1.4.4 修复版（→ v1.4.3/v1.4.4）。
- **8/14 06:10**：问是否要先卸载旧版再装新版 → 发布说明中说明升级路径。
- **8/15 00:38 / 00:41**（**最近一次任务，进行中**）：
  > "再加上一个功能 我自己可以增加主账户" / "请继续修改 Wealth Atlas，本次增加**『新增主账户』**功能，并完成**『小账户紧凑排版』**。"

### 6.3 旁支对话（非本项目，供参考不跟进）

- 8/13 13:19：帮查电脑是否有病毒（单独咨询）。
- 8/13 14:43–14:53：马来西亚金价 560 MYR / S&P 500 / ASNB 理财咨询（个人财务问答）。
- 8/14 05:11–06:04 与 15:48+：Obsidian"动物小卡片"功能重构（**另一个项目**，位于 `E:\DeepSeek Project\Obsidian 动物小卡片`，不在本项目内）。

## 7. 当前状态（重要）

### 7.1 Git 状态
- 最后提交：`c868146 feat: package wealth atlas as protected windows desktop app`（8/13 20:20）
- **18 个已跟踪文件有未提交改动（+1816/-131）**，另有多个未跟踪文件。

### 7.2 未提交内容分析
- **v1.4.2–v1.4.4 发布工作**（部分未提交）：`CHANGELOG.md`（v1.4.2/3/4 条目）、`docs/WINDOWS_RELEASE.md`、`desktop/main.cjs`（+960：启动日志、备份清单、诊断）、`desktop/preload.cjs`、`lib/desktop.ts`、`lib/diagnostics.ts`（新）、`components/AppErrorBoundary.tsx`/`RuntimeDiagnostics.tsx`（新）、`scripts/windows-release*.mjs`（新）、`tests/`（新）。
- **8/15 主任务（"新增主账户 + 小账户紧凑排版"）已部分实现**：
  - `lib/account-hierarchy.ts`（新，未跟踪）—— 账户层级逻辑
  - `components/WealthAtlasV2.tsx`（+225）—— 账户弹窗已出现 `isMainCreation`/`entryMode:"main"`/`parentAccountId` 主账号表单、无主账户提示与"新增主账户"入口
  - `app/globals.css`（+258）—— 疑含小账户紧凑排版样式
  - `lib/finance.ts`、`lib/storage.ts`、`lib/migrations.ts`、`lib/types.ts`、`components/ObsidianWorkbench.tsx` 亦有改动
- **未验证**：此进行中的改动尚未跑 `npm test` / `npm run build`，也未 commit。

### 7.3 已知环境事实
- `.env.local` 含 `DEEPSEEK_API_KEY`（项目自己的审核脚本用）——**敏感，勿写入任何文档/提交**。
- `desktop-dist/`（2.1GB 构建产物）、`node_modules/`、`.next/`、`work/`（测试 profile）**未迁移**；需要时在项目内重跑 `npm install` / 构建。
- 桌面快捷方式指向旧安装路径 `C:\Users\J\Documents\Codex\2026-08-10\new-chat\work\installed-release-tests\...\upgrade-app\Wealth Atlas\Wealth Atlas.exe`（安装版应用数据在 `%APPDATA%\Wealth Atlas\`）。

## 8. 下一步建议

1. **完成/验证"新增主账户 + 小账户紧凑排版"**：检查 `lib/account-hierarchy.ts` 与 WealthAtlasV2 主账号表单的完整性（新增主账户 → 子账户可关联、层级展示、紧凑排版响应式），再按 AGENTS.md 跑 `npm test` + `npm run build`。
2. **处理未提交的 v1.4.x 发布文件**：确认后与主任务一起提交，或单独提交。
3. 如需继续桌面版工作：`npm install`（首次需下载 Electron，约数百 MB）→ `npm run desktop:build` / `npm run release:windows`（注意签名变量未配置时产出 `UNSIGNED` 候选包，见 `docs/WINDOWS_RELEASE.md`）。
4. 与用户确认下一个功能需求。

## 9. 常用命令

```text
npm run dev            # Next.js 开发服务器
npm test               # 回归/迁移/账户层级测试 + tsc 检查
npm run build          # Next 生产构建
npm run desktop:dev    # Electron 桌面开发
npm run desktop:build  # 桌面构建
npm run release:windows  # NSIS 安装包 + 校验 + SHA-256 + 分享包（desktop-dist/v<版本>/）
npm run release:check / release:test-installed  # 独立校验
npm run prepare:review / read:review  # Hermes ↔ Codex 审核桥
```

## 10. 交接注意事项

- 我（DeepSeek 侧）已通读 PRODUCT.md / DESIGN.md / CHANGELOG.md / docs / AGENTS.md 与 14 个 Codex 会话记录。
- 任何涉及删除、迁移、真实数据操作，先暂停并询问用户（AGENTS.md 规则）。
- 本 CONTEXT.md 只是交接说明，不属于产品文档；如不需要可删除（删除时按规则移入 `D:\Trash`）。
