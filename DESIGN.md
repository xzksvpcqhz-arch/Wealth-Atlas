# Wealth Atlas design system

## Direction

Wealth Atlas is an operate-mode personal finance console: quiet, precise, local-first, and designed for repeated daily use. The star field is a restrained spatial metaphor for goals and money paths, not a decorative wallpaper layer.

## Tokens

- Canvas: `#040b15` / `#06101d`
- Surfaces: `rgba(10, 23, 40, .90)` and `rgba(13, 30, 51, .68)`
- Primary text: `#eef6ff`
- Secondary text: `#8292ab`
- Accent: `#3cd9f5` star-light cyan
- Positive: `#8fe1b4`
- Attention: `#e8bc75`
- Focus: cyan outline with a 3px offset

## Layout

- Desktop: persistent 242px navigation rail with a dense working canvas.
- Main hierarchy: page header → free-to-spend hero → supporting stats and goals → forecast strip → assets and insights → watchlist and quick actions.
- Mobile: navigation becomes a fixed bottom bar; dashboard surfaces collapse to a single column while preserving the same reading order.

## Components

- Panels are structural containers with a subtle blue border, controlled translucency, and no decorative gradients on data surfaces.
- One primary action is available per context; quick actions use clear labels and supporting microcopy.
- Goal progress uses constellation nodes and lines to connect planning to the visual theme.
- Numeric displays use tabular figures and explicit currency labels. Mixed-currency values show the source currency and the report-currency equivalent.

## Interaction

- All primary controls expose visible keyboard focus.
- Entry flows use small focused modal forms: amount, currency, category, merchant/remark, rate, and fee.
- Toasts confirm local persistence and export outcomes.
- `prefers-reduced-motion` removes transitions and chart animation.

## States

The implementation reserves the same panel language for empty, loading, import-error, stale-rate, Obsidian-permission, and export-error states so later modules can extend the console without changing its visual grammar.

## Obsidian workbench

- The sync page is an operate-mode workbench: connection status and permission recovery come first, file previews second, and ZIP fallback remains visible without competing with the primary action.
- File rows use restrained semantic states: cyan for new/update, green for unchanged/success, and amber for protected conflicts or permission attention.
- A sync never jumps directly from scan to write. The preview is the focus boundary, and the confirmation action is explicit.
- Mobile collapses the preview into readable file rows and keeps the connection, retry, cancel, confirm, and ZIP actions keyboard reachable.

## FX center

- The FX page is a calculation workbench, not a trading screen: rate history and source metadata stay visually primary.
- Cyan marks the current conversion path and trend line; muted green indicates a favorable result; amber marks stale, missing, or scenario-risk states.
- Pair cards, history rows, exposure bars, future-demand calculations, and scenario outputs collapse to one readable column on small screens.
- Scenario results are always labeled as non-advice and are isolated from IndexedDB writes.

## Asset management

- The asset ledger is a calm value-use workspace: current value, accumulated purchase value, daily cost, and usage days come before secondary notes.
- Asset rows use structural data blocks rather than decorative tiles; edit and delete actions stay at the row edge and remain reachable at touch sizes.
- The homepage metric grid always uses `minmax(0, 1fr)`, visible overflow, and breakable amount text. At 640px and below it becomes a single column so currency values remain readable.

## Recovery and asset usage

- Delete is a protected workflow: the confirmation surface shows date, amount, category, account, and the effect on balances and budgets. The toast offers a visible restore action, while the Recycle Bin owns recovery and the second confirmation for permanent removal.
- Asset forms keep the purchase and current-value fields in the existing two-column rhythm, then isolate the date-driven usage calculation in a read-only calculation panel. Long modal forms scroll inside the panel and keep the save action reachable.
- Future usage dates use the attention amber state and zero-value fallback. Green is reserved for a valid calculated result, and no calculation displays `NaN` or `Infinity`.
