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
