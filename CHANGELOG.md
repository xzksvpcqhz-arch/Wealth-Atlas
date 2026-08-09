# Changelog

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
