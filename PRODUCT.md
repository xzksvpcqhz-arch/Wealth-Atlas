# Wealth Atlas

## Product truth

Wealth Atlas is a local-first personal wealth management control panel for a user who earns in Singapore, moves money from SGD to MYR, and tracks USD investments converted to SGD. It combines budgeting, cashflow forecasting, savings goals, net worth, physical asset value, Obsidian journaling, and exports without placing personal financial data in Git.

## Operating mode

Operate. The user opens the app to make a decision or record a financial event quickly. Visual expression must never obscure amounts, currency, timing, or recovery from errors.

## First surface

The homepage must make the user's available discretionary money, future 30-day balance, currency rates, goals, asset value, and actionable reminders visible within seconds.

## Obsidian sync truth

Obsidian is an explicit, local-first workflow. Wealth Atlas remembers the selected Vault name and directory handle locally, but never reads private files in the background. A sync always moves through scan, preview, confirmation, backup, and write. Markdown outside the `WEALTH_ATLAS_AUTO_START` / `WEALTH_ATLAS_AUTO_END` region belongs to the user and must remain untouched. Permission errors fall back to ZIP downloads, and sync logs store counts and errors rather than private file content.

## Multi-currency truth

v0.5.0 keeps manual FX data local and versioned. New rates append history; they never overwrite prior rates or change a transaction's saved FX snapshot. The FX center exposes direct and reverse SGD/MYR and USD/SGD pairs, transfer effective rates after fees, the USD investment conversion path, currency exposure, future MYR demand, stale-rate warnings, and scenario-only calculations. Real-time FX APIs and automatic exchange execution are out of scope.

## Asset management truth

v0.6.0 uses the existing local `assets` collection for physical and digital items. Each item preserves purchase currency/date, current valuation currency, optional sale price, usage days, status, and notes. Daily cost is a use-value indicator, not an account transaction, and must never mutate balances, FX snapshots, or private Git-tracked data.

## v0.7.0 recovery and asset calculation truth

Transactions and transfers are never removed by the normal delete action. They carry `deleted` and `deletedAt`, disappear from all financial calculations, remain in the local Recycle Bin, and can be restored. Permanent deletion is an explicit second step. A transfer remains one linked record so restoring or deleting it reverses both account-side effects together.

Asset usage is derived from `usageStartMode`, `usageStartDate`, status, and optional `saleDate`. `usageDays` is a retained calculated snapshot, while `legacyUsageDays` and `assetMigrationBackups` preserve old manual values during migration. A future start date produces zero days and a visible warning; daily cost never emits `NaN` or `Infinity`.

## v0.8.0 cash flow and watchlist truth

Future cash flow is a decision aid derived from the current non-deleted ledger and explicitly planned payments. The forecast must show current balance, projected balance, safety balance, and free-to-spend as distinct values. Recurring payments are previewed on a calendar before they affect a forecast; no forecast creates transactions automatically.

Watchlists are local rules over existing transactions. They can filter by category, merchant, tag, account, currency, or item type and show current-month spend, warning amount, budget, trailing twelve-month average, spend rate, and projected month-end spend. Alerts are descriptive and never place, transfer, or exchange funds automatically.

## v0.9.0 reporting truth

Reports are an audit surface over the local snapshot. Excel must preserve source fields and historical FX snapshots; PDF and PNG downloads are derived artifacts only. Export actions need visible success and failure feedback, work without network access, and must never change accounts, transactions, balances, budgets, or saved rates.

## v0.10.0 analysis truth

Debt scenarios are calculations, not recommendations and never write to liabilities or accounts. The flow view explains existing categories of money movement, while net-worth decomposition distinguishes observed cash, investment, physical asset, liability, savings, FX, and other components; unavailable decomposition inputs remain explicit rather than being invented.

## v0.11.0 mobile truth

The PWA is an installable shell around the local-first app, not a cloud sync channel. Offline status is explicit, recent local data remains in IndexedDB, and any offline capture is a local pending action until the browser can persist it. Quick actions must be reachable by touch and keyboard without horizontal scrolling.

## v0.12.0 integration truth

External integrations are capability boundaries, not hidden background behavior. Bank and live-FX adapters are opt-in, permission-gated, disconnectable, and must import into review before formal data. CSV and Excel remain valid local import/export paths; duplicate detection and undo are required.

## v1.0.0 stable truth

The stable product is local-first and recovery-oriented. All derived reports, forecasts, scenarios, charts, and exposure views are read models over the local snapshot. A release must preserve existing user records across migrations and rollbacks, keep historical FX snapshots immutable, protect Obsidian hand-written regions, and make download, permission, offline, empty, and error states visible.

## v1.1.0 enhancement truth

Navigation is an operational state, not decoration: the current section has a visible treatment, `aria-current="page"`, keyboard focus, and refresh persistence. The home quick-capture toolbar is the first action surface after the header and has no duplicate lower action panel.

Accounts are stable identities. Renaming an account changes its label and related read models while retaining the same ID, linked transactions, transfers, FX snapshots, Obsidian references, and export rows. Account groups may show raw per-currency totals alongside a report-currency equivalent. Deactivation and deletion are reversible local status changes; linked history is never silently removed.

Transaction categories are first-class records. Existing string categories are migrated to stable category IDs, but the original category label remains on each transaction for audit compatibility. Deactivated categories remain visible on historical rows and are unavailable for new records. Budgets match only the same category identity, raw currency, and period, so MYR, SGD, and USD budgets never mix.

Goal cycles are explicit and support weekly, monthly, quarterly, yearly, custom, and once cadences with start/end dates, amount per cycle, priority, automatic-plan preference, and status. Stopping a cycle changes future planning only; saved contributions and historical records remain intact.

Schema 10 migration creates an IndexedDB snapshot before changing v1.0 data. The migration is additive, records notices for assumptions such as missing budget currency, and does not delete user data. Git history and the v1.0.0 tag remain unchanged.
