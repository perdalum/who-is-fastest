# CEO report — Who is the fastest? v1.0.0

**To:** CEO / product owner  
**From:** delivery team  
**Date:** 2026-10-30  
**Decision requested:** accept v1.0.0 for personal use, and give the visual
sign-off against `IMG_1141.PNG`.

## 1. Executive summary

The page is built and working: pick a 2026 race and two drivers, and the
circuit is drawn in 100 m sections coloured by the driver who was quicker
through that section. Official lap and sector times are shown as facts; the
spatial split is GPS-derived and labelled indicative.

**Five curated races ship:** Silverstone, Spa, Monza, Singapore and Austin.
Monaco is excluded because its position stream has no complete lap. This is a
scope cut from "any race" to five races; it was **not** pre-approved by the CEO
and is surfaced here for acceptance. The pipeline can add races with one
command, but each new race needs a data check.

**Board result:** data source GO WITH CONDITIONS 5–0; implementation plan
APPROVE WITH MINOR EDITS 5–0; measurement-gate amendment **5–0 YES**. All P1/P2
test defects are fixed. Three P3 conditions remain open and are listed in §6.

## 2. What was delivered

- Static single page: `index.html`, ES modules, CSS, pre-built JSON; no backend,
  no runtime API, no key.
- Five race files (43.6–57.1 KB each) plus catalog and manifest.
- Build pipeline with hashed disk cache, 2.2 s request spacing, 429/5xx backoff,
  raw OpenF1 → 25 m `dt` bins → catalog/manifest.
- Shared 5 m centreline; speed projected and integrated; 3-section smoothing;
  0.03 s neutral band; nulls never bridged; secondary dash/outline when team
  colours are close.
- Four visual states: A quicker, B quicker, too close, **no telemetry**.
  No-data sections are dashed/hollow and excluded from the tally.
- Unit/data tests, two browser suites, independent audit, manuals and this
  report.

## 3. Evidence

| Check | Result |
|---|---|
| Unit + data contract | 42 / 42 pass |
| Browser core | 21 / 21 pass |
| Adversarial / accessibility | 8 / 8 pass |
| Independent audit | 42 pass, 0 fail, 14 P3 warnings |
| Independent section (Austin, 2000–2100 m) | LEC +0.0022 s, VER +0.0009 s vs JSON |
| Austin sector errors (LEC/VER) | −0.159 / +0.118 / +0.041 s (≤ 0.20) |
| Other calibrated races, max sector error | 0.114 s |
| Largest race file | 57,056 B (55.7 KB), budget 150 KB |
| Console errors / failed requests | 0 |
| Horizontal overflow at 390 / 1440 | 0 |
| Cold load, five race entries | < 2 s locally |

The independent audit recomputed one 100 m section from raw cached OpenF1
`location` + `car_data` with its own code and matched the shipped JSON within
2.2 ms. It also verified all manifest SHA-256/byte counts.

## 4. Board amendment — why it was needed

Three original gates could not coexist with "nulls are never bridged":

1. `sum(dt)` must be within 0.05 s of the lap time — impossible when up to
   15 % of bins are null and excluded.
2. Coverage ≥ 97 % — would discard most fastest laps because local gaps are
   deliberately nulled; measured coverage is 90.5–100 %.
3. Pre-scale integral 1–2 % short — lower integration error is better, not a
   failure; measured 0.19–1.39 %.

The board voted **5–0 YES** to replace these with: the identity
`sum(dt) + null_duration = lap_time`; 90–100 % duration coverage with a 2 s
single-run cap; and 0–2 % pre-scale sanity. The amendment and conditions are in
[docs/02](02-steering-board-decision.md); closure status is in
[docs/06](06-test-report.md).

## 5. Scope cut and what the user sees

- Five 2026 Grands Prix: rounds 9, 10, 13, 17, 18.
- Monaco (and other races) can be added by the pipeline, but only after the
  same checks. Monaco is known to fail the position-coverage gate.
- The default pair is the fastest lap plus a contrasting rival (e.g. LEC +
  ANT), not necessarily the two fastest laps. The user can choose any two
  drivers from the menus. This was changed so the first view is not two
  near-identical reds and is documented in the user guide.
- If a chosen lap is not the official best, or coverage is below 100 %, a
  "telemetry-limited" / "partial telemetry" badge appears; the driver card
  shows the lap number and coverage. The page never fills a gap with a guess.
- Monza has no LEC (lap 1 had a 46 % gap) and no calibration block. Its method
  panel explicitly says it is not independently calibrated.

## 6. Open conditions / limitations

**Open P3s (not release blockers for personal use):**

1. The build scales each lap to its own official time but does not persist a
   separate `scale_factor` field. A future build should record it.
2. Selection takes the fastest valid lap; it does not yet prefer a
   100 %-covered lap within 0.3 s. This can change which lap is shown.
3. At 320 px the effective touch lane is below 24 CSS px; at 390 px it is
   ~24 px after the hit-stroke increase. The exact-centre tap works.
4. The older same-driver 0.014 s RMS / 50-of-53 result is historical
   development evidence; the independent audit did not reproduce it from the
   committed files. The shipped validation is the sector/segment audit above.

**Known limits visible in the product:** GPS is ~4 Hz and indicative; official
sector boundaries are estimated from speed; laps are not fuel/tyre/traffic
matched; a 3-section guard widens each no-data gap; no-data is not a tie.

## 7. Visual sign-off — required from the CEO

The reference `IMG_1141.PNG` is a track-only visual: no text, background or
scaffolding. The delivered page keeps the track as the hero, uses team colours
as the only strong hues, and adds the controls, legend, delta card and method
panel needed for the product.

I could not decode the reference image with the available tools, so I cannot
claim a pixel-level match. **Please confirm one of:**

- accept the current dark, track-first treatment as the visual direction, or
- list the specific visual changes needed (track weight, colour, spacing,
  typography) against `IMG_1141.PNG`.

Screenshots for review: `tmp/e2e/desktop.png` (1440×1000),
`tmp/e2e/mobile.png` (390×844), `tmp/e2e/tooltip.png`.

## 8. Recommendation and next actions

**Recommendation: GO for personal, non-commercial use as v1.0.0**, with the
limitations above accepted and the visual sign-off completed.

Next, in order:

1. CEO visual sign-off; adjust track treatment if needed.
2. Close the three P3s (scale factor, coverage-preference fallback, 320 px
   touch target).
3. Add races with `npm run build:data -- --session <key>`; verify coverage,
   calibration and file size before adding to the catalog.
4. If the project is ever shared publicly, re-check the OpenF1 CC BY-NC-SA 4.0
   attribution and the non-commercial scope.

## 9. Reproduce

```bash
npm run dev                       # http://127.0.0.1:5173
npm test                          # 42 tests
npm run test:e2e                  # browser core + adversarial
node tests/audit/audit.mjs        # independent audit
npm run build:data -- --session 11396
```

Artifacts: [README](../README.md), [changelog](../CHANGELOG.md),
[docs index](README.md), [test report](06-test-report.md).
