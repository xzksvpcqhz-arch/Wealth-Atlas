# Changelog
## [1.4.4] - 2026-08-14

- Fixed the missing-FX-path recursion that could raise RangeError: Maximum call stack size exceeded during the first desktop render.
- Added browser clipboard, safe Electron IPC clipboard, selectable manual text, and local diagnostic-file fallbacks without relaxing renderer sandbox permissions.
- Split IndexedDB open/read failure states into retryable startup stages that never replace an unreadable snapshot with blank data.
- Added SHA-256 backup manifests and short-window cross-process duplicate-backup prevention while retaining all existing backups.
- Added synthetic FX, migration, diagnostic fallback, IndexedDB failure, responsive error-page, and v1.4.3 upgrade regression coverage.
## [1.4.3] - 2026-08-14

- Unified package, Electron, static page, error screen, installer metadata, release notes, and release checks on the package.json application version.
- Added ten-stage desktop startup reporting with bounded, local-only, privacy-filtered diagnostics.
- Added local snapshot backup before app-version updates or schema repair/migration, without changing schema version 10 or deleting older backups.
- Added guarded restart and backup-location actions to the existing dark startup error page.
- Added independent versioned Windows release directories plus v1.4.2 upgrade and rollback compatibility tests.

## [1.4.2] - 2026-08-14

- Refined the existing Obsidian disconnect action with a protected confirmation flow while preserving Vault files, finance snapshots, and sync logs.

## [1.4.1] - 2026-08-13

- Hardened Windows first launch for missing, empty, partial, and legacy IndexedDB snapshots without deleting the original local data.
- Added a protected React startup error screen with a non-financial diagnostic ID and copy action.
- Added bounded UTF-8 main and renderer logs plus startup status under `%APPDATA%\Wealth Atlas\logs\`, created before the first window loads.
- Added production asset, custom-protocol, localStorage, service-worker, Obsidian-disconnected, migration, process-crash, persistence, and update-install verification.

## [1.4.0] - 2026-08-13

- Added a protected Windows desktop build and NSIS installer while preserving the approved dark celestial interface and existing finance features.
- Isolated desktop storage under the Wealth Atlas application profile so a new desktop installation starts blank without clearing or changing browser data.
- Added secure native Obsidian Vault folder access through the desktop bridge, with explicit user actions, path validation, previews, and existing backup safeguards.
- Added desktop persistence, restart, responsive-layout, edit, recycle-bin, restore, and permanent-delete verification.
- Disabled browser-only PWA service-worker registration inside the packaged desktop application.

## [1.1.0] - 2026-08-10

- Added persisted left-navigation active state with visible keyboard/focus treatment, `aria-current`, and mobile navigation alignment.
- Moved the six primary quick-capture actions to the top of Home and removed the duplicate lower action area.
- Enhanced accounts with editable names and metadata, parent/group/institution fields, net-worth inclusion, per-currency group totals, inactive/deleted states, and recovery.
- Added first-class income/expense categories with add, edit, deactivate, restore, and transaction-form selection; historical transaction labels remain intact.
- Added category-aware monthly budgets with raw-currency matching, edit/deactivate/delete/recovery controls, and additive `categoryId`, `period`, and `budgetAmount` fields.
- Enhanced savings goals with weekly/monthly/quarterly/yearly/custom/once cycles, start/end dates, per-cycle amounts, priority, automatic-plan preference, and reversible lifecycle states.
- Added schema 10 additive migration with IndexedDB pre-migration snapshot, category conversion, budget currency notices, account normalization, and goal-cycle defaults.
- Updated Excel Accounts export with group, institution, parent account, current balance, activity count, net-worth inclusion, and status fields.

## [1.0.0] - 2026-08-10

- Completed the stable Wealth Atlas release line from v0.7.0 through v0.12.0.
- Completed final responsive layout, local recovery, immutable FX snapshot, protected Obsidian, Excel/PDF/PNG, PWA, offline, and optional-integration acceptance surfaces.
- Added additive schema version 9 migration for optional integration settings without removing personal data.
- Documented the final acceptance checklist and real-environment validation boundaries.

## [0.8.0] - 2026-08-10

- Added a local future cash-flow workspace with 7, 30, 60, and 90-day forecasts, month-end projection, safety balance, and free-to-spend calculations.
- Added planned payment calendar entries for one-time, monthly, and yearly income, expenses, savings, investments, and transfers.
- Added Watchlists with category, merchant, tags, account, currency, and item-type filters plus budget, warning, trailing-average, spend-rate, and month-end metrics.
- Added derived finance alerts for forecast shortfalls, upcoming fixed payments, Watchlist attention, and stale FX rates.
- Preserved deleted-record exclusions, historical FX snapshots, local IndexedDB persistence, and the dark celestial responsive design.

## [0.9.0] - 2026-08-10

- Expanded Excel export with monthly and annual summaries, accounts, investments, investment transactions, liabilities, net-worth history, subscriptions, Watchlists, cash-flow forecasts, Settings, and complete FX snapshot fields.
- Added downloadable monthly, annual, net-worth, investment, asset, FX, and cash-flow PDF reports.
- Added downloadable PNG chart artifacts for income/expense, savings, net worth, assets, currency, FX, investment, Watchlist, and cash flow.
- Added export inventory, loading-through-toast success/error feedback, and mobile-friendly compact export controls.

## [0.10.0] - 2026-08-10

- Added debt repayment simulations for extra MYR 300, extra MYR 600, and emergency-reserve-first scenarios.
- Added a compact cash-flow map and net-worth decomposition for cash, savings, investments, FX, physical assets, liabilities, and other movement.
- Added local monthly financial reviews with the requested good, overspend, largest expense, goal, investment/FX, and next-month plan fields.
- Kept simulations and reviews local-only; simulated values never alter real liabilities, accounts, or transactions.

## [0.11.0] - 2026-08-10

- Added a PWA manifest and offline service-worker shell with explicit online/offline status and install action.
- Added global service-worker registration so the app can be installed without first opening a settings page.
- Added mobile quick shortcuts for today’s spending, free-to-spend, savings goals, FX pairs, and 30-day cash flow.
- Preserved local IndexedDB as the source of truth and kept offline/weak-network behavior visible.

## [0.12.0] - 2026-08-10

- Added explicit optional BankSyncAdapter and FxRateAdapter interfaces with both providers disabled by default.
- Added permission guidance, manual-rate priority messaging, and no-provider/no-upload behavior.
- Added CSV duplicate count, review history, explicit apply, and soft-delete undo for imported transactions.
- Added a small install icon asset without adding any external service or personal data.

## [0.7.0] - 2026-08-10

- Added soft deletion for income, expense, and transfer records with edit, detail, restore, local Recycle Bin, undo toast, and second confirmation before permanent deletion.
- Deleted records are excluded from account balances, budgets, income/expense totals, and FX usage while preserving the original record locally.
- Added configurable asset usage start mode, custom usage start date, sale date, automatic usage days, daily cost, optional cost-per-use, future-date warnings, and migration backups for legacy manual usage days.
- Updated Obsidian asset notes and sync plans with usage start metadata and automatic calculations.
- Updated the Excel `Asset Items` sheet with usage start/end dates, calculated usage days, daily cost, and cost per use.

## [0.6.0] - 2026-08-10

- Fixed homepage income, expense, net-worth, and remaining-budget metrics so long currency values wrap fully without horizontal overflow or clipping on desktop and 390px mobile layouts.
- Added asset management on the existing `assets` data structure with purchase/current currencies, purchase date, optional sale price, usage days, status, notes, category/status filters, edit and delete flows.
- Added daily cost and value-change calculations, responsive asset summary metrics, and an Assets worksheet in Excel export.

## [0.5.0] - 2026-08-10

- Added the local-first multi-currency FX center for SGD/MYR, USD/SGD, MYR/SGD, and SGD/USD.
- Added append-only FX history with source, effective date, entered time, default/active state, notes, use counts, filters, trend bars, and delete confirmation.
- Added immutable FX snapshots for transactions and transfers, including transfer input, actual, and fee-inclusive effective rates.
- Added currency exposure, future MYR exchange demand, USD investment conversion path, stale/missing-rate alerts, and scenario-only simulation.
- Extended Excel export with FX history and complete transaction/transfer snapshot fields while preserving Obsidian and local IndexedDB flows.

## [0.4.0] - 2026-08-10

- Upgraded the basic Obsidian ZIP export into a local-first Vault connection and sync workbench.
- Added remembered Vault connection state, explicit permission handling, reconnect and disconnect flows, and automatic non-destructive folder/template creation.
- Added daily, monthly, and yearly Markdown generation with complete frontmatter, cross-links, currency summaries, budgets, watchlists, goals, cashflow forecasts, and review areas.
- Added sync preview, protected `WEALTH_ATLAS_AUTO_START` / `WEALTH_ATLAS_AUTO_END` regions, conflict warnings, confirmation-only writes, local backups, and retryable sync logs.
- Added editable daily, monthly, yearly, savings goal, asset, and review templates, plus daily/monthly/yearly/full ZIP fallbacks.

## [0.3.0] - 2026-08-10

- Added savings goal management with current amount, target amount, status, due date, and monthly / quarterly / yearly / custom cycles.
- Added goal progress, remaining months, gap, and recommended contribution calculations.
- Added annual plans with month, amount, status, notes, and optional goal linkage.
- Added annual plan totals and reserved amount summaries, plus Excel export coverage.

## [0.2.0] - 2026-08-10

- Added account management with derived balances from opening balances, transactions, and transfers.
- Added income, expense, and transfer record lists with account association.
- Added monthly budgets with remaining-limit tracking and upcoming fixed commitments.
- Replaced the homepage free-to-spend placeholder with a report-currency calculation based on liquid balances, remaining budgets, and commitments.
- Preserved SGD, MYR, USD, manual FX rates, goals, assets, watchlists, exports, and local-first persistence.

## [0.1.0] - 2026-08-10

- Added the Wealth Atlas responsive homepage.
- Added local-first IndexedDB persistence.
- Added SGD/MYR transfer and USD/SGD manual FX flows.
- Added transactions, savings goals, assets, watchlists, cashflow preview, Obsidian ZIP export, and Excel export entry points.
- Added dark celestial design system and responsive navigation.
