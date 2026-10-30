# Test report — v1.0.1

**Date:** 2026-10-30  
**Scope:** five curated 2026 races (Silverstone, Spa, Monza, Singapore,
Austin); Monaco excluded.  
**Verdict:** **PASS for the structural/data contract, with documented visual
limits and three open P3 conditions.** The independent recompute, browser
suites, error/retry path, keyboard, touch, same-team and colour-blind checks
all pass. This is a personal, indicative visualisation, not timing-grade.

## 1. What was tested

| Layer | Command | Result |
|---|---|---|
| Unit + data contract | `npm test` | **42 pass / 0 fail** |
| Browser core | `node tests/e2e/run.mjs` | **21 pass / 0 fail / 0 skip** |
| Adversarial / accessibility | `node tests/e2e/adversarial.mjs` | **8 pass / 0 fail / 0 skip** |
| Independent audit | `node tests/audit/audit.mjs` | **43 pass / 0 fail / 13 warnings** |

The browser suites use real Chrome headless (Playwright `chromium` channel),
not a mock DOM. Screenshots: `tmp/e2e/desktop.png` (1440×1000),
`tmp/e2e/mobile.png` (390×844), `tmp/e2e/tooltip.png`.

## 2. Dataset

| Session | Race | Round | Drivers | File |
|---|---|---:|---:|---:|
| 11326 | British Grand Prix | 9 | 22 | 51,064 B |
| 11334 | Belgian Grand Prix | 10 | 21 | 57,694 B |
| 11361 | Italian Grand Prix | 13 | 21 | 48,491 B |
| 11388 | Singapore Grand Prix | 17 | 22 | 44,231 B |
| 11396 | United States Grand Prix | 18 | 22 | 47,983 B |

- All six manifest outputs (catalog + five races) match SHA-256 and byte size.
- Largest race file 57,694 B (56.3 KB), under the 150 KB budget.
- All schemas, grids (25 m), segments (100 m), deadband (0.03 s), dt lengths,
  sector marks, official-best fields and colour values validate.
- `sum(dt) + null_duration = lap_time` (within 0.06 s) for every driver; the
  full-lap sum is within 0.01 s only for 100 %-covered laps.
- Duration coverage 90.5–100 %; selected-lap floor is 90 %. The 97 % line in
  the original plan was incompatible with nulling local gaps; see §5.
- Longest contiguous null run is **1.5 s** (6 × 25 m bins), below the 2 s cap.

## 3. Independent recompute

Austin, section 20 (2000–2100 m), shared 5 m centreline, 5,395 m:

| Driver | Audit | JSON | Difference |
|---|---:|---:|---:|
| LEC (16) | 1.5688 s | 1.5666 s | **+0.0022 s** |
| VER (3) | 1.5807 s | 1.5798 s | **+0.0009 s** |

Both are far inside the 0.05 s tolerance. The audit used its own projection and
integration code, reading only the raw cached OpenF1 windows.

## 4. Calibration and honesty checks

| Race | Pair | Max sector-delta error | Status |
|---|---|---:|---|
| Silverstone | LEC / VER | 0.033 s | pass |
| Spa | LEC / VER | 0.114 s | pass |
| Singapore | LEC / VER | 0.099 s | pass |
| Austin | LEC / VER | **0.159 s** | pass (≤ 0.20 s) |
| Monza | — | — | **not independently calibrated**; LEC lap 1 had a 46 % gap |

- Austin error vector: **−0.159 / +0.118 / +0.041 s**.
- Official lap and sector times are facts. The spatial split is GPS-derived and
  labelled indicative; the page does not claim timing-grade telemetry.
- Coverage, lap number, tyre and top speed are shown in the driver cards.
- Null sections never take a team colour. They are dashed/hollow and excluded
  from the A/B tally; the tally publishes the compared percentage and the
  no-data count. The legend has four states: A, B, too close, no telemetry.
- Same-team pairs keep a secondary dash/outline distinction; a forced
  same-colour proxy still distinguishes A from B.

## 5. Board amendment and condition status

The implementation found three original gates arithmetically incompatible with
the null-never-bridge rule. The steering board voted **5–0 YES** to a narrow
amendment (A: `dt` identity; B: 90–100 % coverage; C: 0–2 % pre-scale sanity;
D: Monza labelled uncalibrated). Conditions are tracked here, not silently
closed:

| Condition | Status | Evidence / gap |
|---|---|---|
| Null is a fourth visual state, never a team colour | **closed** | `.is-nodata` dashed grey path, legend item, no-colour underlay; 13–21 no-data sections per race. |
| Pairwise nulling and tally denominators | **closed** | A segment is null if either driver lacks any 25 m bin; tally says “x % compared” and excludes no-data. |
| Coverage visible | **closed** | Per-driver `% telemetry`, partial-telemetry badge, caption “Best covered laps”, coverage text in tally. |
| Integrity identity | **closed** | `data.test.mjs` asserts `sum(dt) ≈ lap_time × coverage`; audit independently checks null counts. |
| One contiguous null run ≤ 2 s | **closed** | Measured max 1.5 s. |
| Monza explicit | **closed** | Method panel says the race is not independently calibrated; no LEC option is offered. |
| One scale factor per comparison | **partial** | Per-driver `scale_factor` is now persisted, but each lap is still scaled to its own official time; a shared factor is an open P3. |
| Prefer 100 %-covered lap within 0.3 s | **open P3** | Build takes the fastest valid lap; no coverage-preference pass. |
| Touch target at 320 px | **closed** | 96-unit hit stroke → 25.2 CSS px at 320; 76 → 25.2 at 390. |
| Alternate Monza calibration | **accepted as n/a** | Board allowed an explicit uncalibrated label. |

The independent audit reproduced the structural contract and the Austin
section. It did **not** reproduce the older same-driver 0.014 s RMS / 50-of-53
claim from the development calibration run; that claim is now labelled as
historical evidence in `docs/01`, not a shipped-test result.

## 6. Browser / interaction results

- Cold load: title, Austin race title, 54 segments, 2 driver cards, 4-state
  legend, official delta 1.110 s.
- Default pair: fastest lap plus a contrasting rival (LEC + ANT), not the two
  fastest laps. This is a deliberate product choice; docs were corrected.
- Swap updates both selects and the URL hash; deep link restores the pair.
- The other driver's option is disabled in each select.
- Real SVG-path hover (not bbox centre) shows section, both raw times and a
  delta/neutral/no-data line.
- Keyboard: Tab reaches race, drivers, swap and SVG; ←/→ moves; Escape hides
  and clears the selected segment. Focus no longer jumps to the SVG on load.
- Touch at 390×844: tap pins, tap another segment updates, tap outside
  dismisses; no horizontal overflow.
- Error path: a 404 race file shows `role="alert"` and a working “Try again”;
  retry recovers. Normal run has zero console/page/request errors.
- Reduced motion: content loads; the hidden spinner no longer keeps the 2.4 s
  infinite override.
- Same-team (LEC/HAM, both Ferrari) and forced same-colour proxy: B stays
  dashed/outlined; no colour-only claim.
- ARIA: labelled selects, SVG title/desc, live regions, named buttons, unique
  IDs.

## 7. Known limitations

1. **GPS, not timing loops.** 100 m splits are indicative. Sector chips use
   official sector times; the spatial split does not.
2. **No data is not neutral.** Missing telemetry is dashed and excluded from
   the tally; the page does not guess through it. A 3-section smoothing guard
   widens each gap visually.
3. **Partial coverage.** Fastest available laps can have 90–100 % duration
   coverage. The UI shows the percentage and “best covered laps”; it does not
   claim a complete-lap comparison.
4. **Monza has no calibration block.** No LEC lap passed the gap rule; the
   method panel states this.
5. **Open P3s:** the coverage-preference fallback and a shared calibration
   factor are recorded, not hidden. The touch target is now ~25 CSS px at both
   320 and 390 px.
6. **Monaco** is excluded from v1 because its position stream has no complete
   lap; this is a scope cut, not a data-quality pass.

## 8. Release recommendation

**GO for personal, non-commercial use**, with the limitations above visible in
the product and the remaining P3 conditions scheduled before any wider release. No P1/P2 defect remains in the tested paths.
