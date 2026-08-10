# Wealth Atlas

个人财富星图的本地优先 Web App。

## Run

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。

## Obsidian 同步

v0.4.0 通过设置页连接本地 Obsidian Vault。连接动作只会创建缺失的 `财富理财师/` Folder 和模板；读取与写入只发生在用户明确点击“开始扫描并生成预览”或“确认同步”之后。

同步会先显示新增、更新、无变化和冲突文件。确认后才写入，并在 Vault 内生成 `backups/obsidian/YYYY-MM-DD-HHmm/` 备份。没有文件夹权限时，可以使用每日、每月、每年或完整文件夹 ZIP 下载。

自动生成区域使用 `WEALTH_ATLAS_AUTO_START` 和 `WEALTH_ATLAS_AUTO_END` 标记；标记以外的手写内容不会被覆盖。同步日志、Vault 名称、模板和金融数据保存在本地 IndexedDB，私人 Markdown 内容不会进入 Git。

## v0.5.0 FX center

The FX center keeps SGD/MYR, USD/SGD, MYR/SGD, and SGD/USD history locally. Every manual entry appends a new version instead of overwriting the old rate. Transactions and transfers save the original amount, conversion direction, rate date, source, fees, and effective rate snapshot so future rates cannot rewrite historical results.

It also provides currency exposure, the next-30-day MYR gap, the USD → SGD → MYR investment path, stale/missing-rate alerts, and scenario-only simulations. Wealth Atlas does not call a live FX API or execute exchanges automatically.

## Data privacy

## v0.6.0 物品资产

物品资产继续使用本地 IndexedDB 的 `assets` 结构，记录名称、分类、买入价格与货币、买入日期、当前价值与货币、卖出价格、使用天数和状态。系统按“（买入价格 − 当前价值或卖出价格）÷ 使用天数”计算日均成本，并支持新增、编辑、删除、分类筛选和状态筛选。

应用数据保存在浏览器 IndexedDB。真实财务数据不应该提交到 Git；导出文件和私人 Vault 已加入 `.gitignore`。

## v0.7.0 recovery and asset usage

Income, expense, and transfer rows now have edit, detail, and delete actions. Deletes are soft deletes (`deleted` and `deletedAt`), so balances, budgets, income/expense totals, and FX usage exclude them while the local Recycle Bin keeps them available for restore. Permanent deletion requires a second confirmation.

Asset usage is now date-driven. Choose purchase date or a custom usage start date; active items calculate through today, sold items stop at the sale date, and invalid future dates show a warning without producing `NaN` or `Infinity`. Daily cost and optional cost-per-use are calculated fields. Legacy assets are migrated in place and their old manual usage days are retained in a local migration backup.

## v0.8.0 cash flow and watchlists

The operations workspace now projects 7, 30, 60, and 90-day balances from current local balances, recurring planned payments, savings, investments, and transfers. It separates current balance, projected balance, safety balance, and free-to-spend amount, and keeps a readable future payment calendar.

Planned payments support one-time, monthly, and yearly cadence, account and currency context, fixed-payment and annual-reserve flags, income/expense/saving/investment direction, and an explicit next date. Watchlists can track category, merchant, tags, account, currency, and item type, with month-to-date spend, 12-month average, spend rate, month-end forecast, warning state, and over-budget state.

The new alerts layer is derived locally and reports cash-flow safety shortfalls, upcoming fixed payments, Watchlist attention, and stale FX rates. It does not call external services or mutate historical financial data.

## v0.9.0 reports and exports

The reports workspace exports an Excel workbook with Transactions, Transfers, Monthly Summary, Annual Summary, Goals, Accounts, Investments, Investment Transactions, Asset Items, Liabilities, Net Worth History, Subscriptions, FX Rates, Watchlists, Cash Flow Forecast, Settings, and preserved Annual Plans. Transaction and transfer rows retain original amounts, converted values, FX direction/rate/date/source, fees, effective rates, notes, and soft-delete state.

Monthly, annual, net-worth, investment, asset, FX, and cash-flow PDF downloads are available alongside PNG chart downloads for income/expense, savings, net worth, assets, currency, FX, investment, Watchlist, and cash flow views. Exports are generated from the current local snapshot and never write back to IndexedDB.

## v0.10.0 analysis and reviews

The analysis workspace compares three debt strategies: paying an extra MYR 300 each month, paying an extra MYR 600, or prioritizing an emergency reserve. It shows payoff month, total interest, term length, and the simulated result without mutating the liability.

It also presents a readable SGD-to-MYR-to-USD flow map, separates cash, savings, investment, FX, liabilities, physical assets, and other net-worth movement, and stores monthly review notes locally for good decisions, overspending, largest expense, goals, investment/FX changes, and next-month actions.

## v0.11.0 PWA and quick capture

Wealth Atlas now includes a web app manifest and a small service worker shell for installable desktop/mobile use and offline access to the recent app shell. Online/offline state is shown in the integrations page; IndexedDB remains the source of truth and no private data is cached into Git.

Quick capture keeps record income/expense, SGD transfer, manual FX update, account balance, purchase, investment, and Excel export close to the operator. The home page adds mobile shortcuts for today’s spending, free-to-spend, goal progress, FX pairs, and the next 30-day balance.

## v0.12.0 optional integrations

The integration page now documents the optional BankSyncAdapter and FxRateAdapter contracts while keeping both disabled by default. Permission explanations are shown before any future connection, manual rates remain primary, and no external provider is contacted by this build.

CSV import is a local review workflow: parse, duplicate warning, pending review, explicit apply, and soft-delete undo. Applied imports retain their generated transaction IDs so the import can be reversed without permanently removing the user’s local records.

## v1.0.0 stable release

Wealth Atlas v1.0.0 is the stable local-first release line. It keeps the v0.7 account, transaction recovery, budget, FX, Obsidian, asset-use, investment, liability, net-worth, responsive, and dark celestial foundations while adding cash-flow planning, Watchlists, reporting, analysis, PWA/mobile capture, and opt-in integration boundaries.

The final data migration is additive and reversible in intent: schema version 9 adds optional integration settings without deleting existing collections or personal records. Build artifacts, exports, Vault files, and local IndexedDB snapshots are not committed to Git.

### Final acceptance checklist

- Core account, transaction, transfer, budget, goal, asset, investment, liability, net-worth, FX, and recovery flows remain available.
- Forecast horizons, planned-payment calendar, Watchlist metrics, debt scenarios, flow/decomposition analysis, reviews, Excel/PDF/PNG exports, PWA shell, CSV review, Obsidian sync, and mobile shortcuts are available.
- Desktop, tablet, and 390px mobile layout checks pass without document-level horizontal overflow.
- Real-device validation remains necessary for native folder permissions, installed PWA behavior, downloaded file opening, and the user’s own Obsidian Vault.

## v1.1.0 navigation, accounts, categories, budgets and goal cycles

v1.1.0 keeps the v1.0.0 local-first data model and adds an operation-first home toolbar plus a persisted, keyboard-visible navigation state. The active section is stored as UI preference only and restores after refresh; it does not contain private financial data.

Accounts now support rename/edit without changing IDs or history, institution, group, parent account, net-worth inclusion, active/inactive/deleted status, per-currency group totals, report-currency equivalents, and local account recovery. Inactive accounts leave the homepage flow while their linked transactions and transfers remain auditable.

Transactions use local income/expense categories with add, edit, deactivate, restore, and searchable keyboard-selectable form choices. Monthly budgets carry `categoryId`, `currency`, `period`, and `budgetAmount`; spend is matched only when category, raw currency, and month all match. Budgets and goal cycles can be edited, deactivated, restored, and kept out of active projections without deleting history.

The schema 10 migration is additive. It creates category records from existing transaction strings, adds missing budget currency using the report currency with a migration notice, adds goal cycle status/dates, normalizes account status, and stores a pre-migration snapshot in IndexedDB. It never overwrites transaction records, rates, Obsidian notes, or personal files. Run `npm.cmd run test` (PowerShell) and `npm.cmd run build` to verify the release.
