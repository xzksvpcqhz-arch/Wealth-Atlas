---
version: 1
slug: "desktop-investment-workbench-cjs"
primary_target: "desktop/investment/workbench.cjs"
related_targets: ["desktop/investment/native.css"]
---

Mode: Operate. Approved broker CSV mapping extension to the v1.7.12 investment import surface. User confirmed the interactive preview on 2026-11-21.

## Direction contract

THESIS: Match a broker's column names once, then reuse the mapping without mistaking a template action for an investment-record write.

OWN-WORLD: Preserve Wealth Atlas's dark starfield, existing type, cyan actions, restrained borders, 22px panel padding and 24px section gaps. Native controls, not a new navigation or visual identity.

STORY: Choose a snapshot or transaction CSV, select source columns beside their required target fields, save a named mapping, explicitly apply it next time, then use the unchanged ledger validation, reconciliation and explicit save. Missing, repeated or changed columns block progress. Draft replacement and template deletion require confirmation.

FIRST VIEWPORT: Preserve the existing investment tabs, account/source fields and CSV input, then join the approved template selector and source-to-target mapping rows immediately before the existing check/save actions. A compact explanation distinguishes mapping-only persistence from financial writes. On phones all regions stack, with full-width selects and reachable actions.

FORM: Code-led local extension; no seed or comp for an existing surface. The approved preview is the interaction reference, not a replacement page. Store mapping rules only in a new local, profile-scoped template database with compare-and-swap protection. Never store CSV rows/account/amount/rate values in templates. Snapshot and transaction schemas remain separate; no guessed FX, dates, signs or trade types. Test production components only with invented records and isolated profiles.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

PRODUCT.md and DESIGN.md are protected and unchanged. Preview samples are not compatibility claims for actual IBKR/moomoo files. User approved production CSV integration and conditional release; this contract does not authorize investment cloud schema changes or automatic upload of existing financial records. QA screenshots are evidence, not shipping assets. Investment cloud controls require their own approved preview and cloud authorization.
