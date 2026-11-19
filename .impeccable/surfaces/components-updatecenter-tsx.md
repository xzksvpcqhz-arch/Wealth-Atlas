---
version: 1
slug: "components-updatecenter-tsx"
primary_target: "components/UpdateCenter.tsx"
related_targets: ["components/UpdateCenter.module.css","lib/update-center.ts"]
---

# Settings update center

Mode: Operate. Local extension of the approved Wealth Atlas v1.7.8 design.
The user approved the working preview before production integration.

## Direction contract

THESIS: Make software update readiness legible without touching financial synchronization or interrupting work.

OWN-WORLD: Keep the approved dark star field, existing font, night-blue panel, cyan action, muted secondary text, green readiness and amber recovery. Reuse existing buttons and 22px panel padding.

STORY: Read actual current/latest versions, check safely, see download progress and a real retry wait, then save work and close normally when installation is ready.

FIRST VIEWPORT: One normal-width Settings panel before existing settings sections; two version columns, one live status, conditional progress, check and release-note actions. Actions stack on phones without clipping.

FORM: Code-led implementation of the user-confirmed prototype, not a new visual world. Native button/progress semantics, no additional animation, no seed for this narrow extension. Prototype controls and simulated values do not ship.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Boundaries

Updates use only a fixed public release source. No financial records, authentication, profile changes, local database, Vault, migrations, real-user installation or data reset. No arbitrary URL/path/command IPC. Review screenshots cover 1440,1280,390,320 widths. Existing settings and all other pages remain.

Panel padding follows the existing responsive convention: 22px normally, 18px below 620px. This is a local phone adaptation, not a change to global tokens or the approved theme.
