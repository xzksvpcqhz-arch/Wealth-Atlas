# 本机账号投资空间

本功能是投资工作台的独立本机保存位置，不是投资云同步，也不是新的登录账号。

## 使用与保护范围

- 使用已有 Wealth Atlas 账号；首次启用须完成现有账号验证并在确认框勾选本机范围说明。
- 新空间初始为空，不扫描、搬移或自动导入原 Vault。
- 保存位置与资料按账号隔离；已保存的位置选择在重新打开后保留。
- 切换 Vault / 账号空间不会丢弃本页尚未保存的表单；离开整个页面或切换登录账号前仍应先保存需要保留的输入。
- 账号空间只保存在本机，不同步到 Mac 或其他设备，不自动创建 Obsidian 笔记。
- 原 Vault 工作台保持原流程；已选择账号空间时，重开不会在后台读取 Vault 投资记录。
- 不改账户、历史交易、预算、净资产、汇率或现有收支同步。投资计算继续使用既有校验与计算模型。

## 保存与错误处理

独立数据库 `wealth-atlas-investment-local-v1` 不迁移或写入现有 `wealth-atlas` 财务数据库。启用标志、位置选择及当前索引按账号保存；版本正文按账号和版本号不可变追加。

提交采用完整状态及版本比较；两窗口竞争时一方收到冲突，不按最后写入者静默覆盖。版本正文和当前索引在同一事务写入，失败时全部回滚。

读取时核对索引覆盖、每条历史记录及其前驱、版本顺序和正文摘要。缺项、损坏或不支持的版本只显示错误；不会用空白空间替代，也不会自动修复、恢复或清理资料。

原财务 JSON/云端快照不包含这个独立空间。不要通过清缓存、清数据库、删除应用个人目录或恢复原财务 JSON 来处理投资空间问题。安装新版本前仍建议另行导出原财务 Excel 和 Obsidian ZIP 备份。

## 验证命令

```text
node --test tests/local-investment-space.test.mjs tests/local-investment-ui.test.mjs
npm test
npm run build
npm run desktop:build
npm run desktop:test
```

隔离测试使用虚构账号、临时 Chromium profile 和测试 Vault；拒绝真实后端请求。覆盖重复启用、并发提交、去重、旧版本保留、空间不足回滚、索引缺项、同数量版本损坏、账号 A→B→新 A 的迟到请求、账号验证变化、读取失败及重试、进程重启、四种屏幕尺寸，以及原财务/Obsidian 哨兵保持不变。它们不等于真实账号、macOS 实机或最终安装包验收。

## 修改范围

- `components/InvestmentWorkbench.tsx`
- `components/InvestmentSpaceChooser.tsx` / `.module.css`
- `desktop/investment/local-space.cjs` / `.d.cts`
- `desktop/investment/workbench.cjs` / `.d.cts`、`investment-features.cjs`：仅新增保存位置参数及账号模式文案，默认 Vault 行为保留。
- 两组本机投资测试及 npm 测试入口；无依赖升级。

跨设备投资同步、CSV 映射模板和多套命名 DIY 方案未在本次接入。
