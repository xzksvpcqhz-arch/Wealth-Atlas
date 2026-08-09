# Wealth Atlas

## Product truth

Wealth Atlas is a local-first personal wealth management control panel for a user who earns in Singapore, moves money from SGD to MYR, and tracks USD investments converted to SGD. It combines budgeting, cashflow forecasting, savings goals, net worth, physical asset value, Obsidian journaling, and exports without placing personal financial data in Git.

## Operating mode

Operate. The user opens the app to make a decision or record a financial event quickly. Visual expression must never obscure amounts, currency, timing, or recovery from errors.

## First surface

The homepage must make the user's available discretionary money, future 30-day balance, currency rates, goals, asset value, and actionable reminders visible within seconds.

## Obsidian sync truth

Obsidian is an explicit, local-first workflow. Wealth Atlas remembers the selected Vault name and directory handle locally, but never reads private files in the background. A sync always moves through scan, preview, confirmation, backup, and write. Markdown outside the `WEALTH_ATLAS_AUTO_START` / `WEALTH_ATLAS_AUTO_END` region belongs to the user and must remain untouched. Permission errors fall back to ZIP downloads, and sync logs store counts and errors rather than private file content.
