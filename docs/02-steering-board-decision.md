# Steering-board decision: OpenF1 as the data source

- **Date:** 2026-10-30
- **Board:** five independent reviewing agents (Chair, Data Engineering, Frontend/UX, Quality & Risk, Product/Strategy)
- **Input:** [Data-source assessment](01-data-source-assessment.md) and the evidence in `tmp/` (raw API samples, coverage survey, prototype code)
- **Question:** Can OpenF1 support the CEO's goal, or are more resources needed before implementation?

## 1. Decision

> **GO WITH CONDITIONS (5 votes for, 0 against, 0 abstentions).**
> OpenF1 is sufficient. No additional external data source is required.
> Implementation may start only after the revised plan closes the board's
> conditions and the board approves that plan.

No board member voted NO-GO. The Quality & Risk member explicitly recorded that
their vote would become **NO-GO** if the visual does not encode uncertainty; the
Chair's vote would become NO-GO if the sector inconsistency or telemetry
spot-checks could not be resolved. Both conditions are addressed in the revised
method and plan.

## 2. Votes

| Role | Vote | Confidence | Decisive argument |
| --- | --- | --- | --- |
| **Chair** | GO WITH CONDITIONS | High on data availability; medium on method | Data exists and is usable, but the evidence had arithmetic/provenance defects that must be corrected before a build. |
| **Data Engineering** | GO WITH CONDITIONS | Medium-high | Source adequate; the first ETL idea compared each driver on his own distance axis, which can make racing-line differences look like pace. Requires one centreline and equal-arc-length comparison. |
| **Frontend / UX** | GO WITH CONDITIONS | Medium | Static SVG + precomputed JSON is right; 25 m binary colouring is too fine for the noise floor and colour-only encoding fails accessibility. |
| **Quality & Risk** | GO WITH CONDITIONS | 0.75 | Same-driver control showed segment winners are dominated by GPS jitter; the visual must show "too close to call", not false precision. |
| **Product / Strategy** | GO WITH CONDITIONS | 0.75 | The core loop fits the CEO goal, but v1 should prove the picture on a few races before scaling to the whole calendar. |

**For: 5. Against: 0. Abstain: 0.**

## 3. What the board verified

- 2026 calendar: 25 Grands Prix, 18 completed, 2 cancelled, 5 future. The
  session feed also contains six Sprints with `session_type: Race`; the race
  picker must use `session_name === "Race"`, not `session_type`.
- Austin lap/sector figures for Leclerc and Verstappen match the API exactly.
- Coordinates are decimetres; Austin elevation range ≈30 m.
- Raw `location` is ~4.5 MB per driver per weekend; precomputation is mandatory.
- Monaco's position stream stops at 14:00 for a 13:00–15:00 race (verified for
  two drivers), and is sparse (~1–2 Hz effective).
- OpenF1 is licensed **CC BY-NC-SA 4.0**, not merely attribution. The project
  must carry the licence, attribute OpenF1, stay non-commercial and share
  derivative data under the same licence.
- The example image could not be visually decoded by the agent runtime; only
  the concept (track-only, two-driver colour split) is confirmed.

## 4. Defects found in the assessment (corrected in v1.1)

The board's review was adversarial and found real problems. They are recorded
here rather than hidden:

1. **Sector arithmetic was presented incorrectly.** The numbers +0.40, −0.60,
   −1.21 were *cumulative* deltas at sector ends, not per-sector gains; summing
   them double-counts. The corrected comparison uses per-sector deltas.
2. **Reported GPS lap lengths were inflated** by including samples before the
   start and after the finish. With lap-bounded samples, Austin lengths are
   ~5,395 m, not 5,485 m; the official length is 5,513 m.
3. **The coverage survey sampled only driver #1.** The Monaco truncation was
   later confirmed on a second driver, but the report should not have implied
   all-driver coverage without checking.
4. **The original 25 m classification was noise-dominated.** A same-driver
   control (Norris laps 42 and 44, both 99.887 s) produced 81 lead changes and
   188/218 "decided" 25 m segments. That method is rejected.
5. **The image interpretation was not visually verified.** The file was only
   inspected programmatically; visual sign-off remains a CEO action.

## 5. Corrected method (evidence)

The revised pipeline compares **car speed on a shared centreline**, not
independent position-derived time axes:

1. Build one reference centreline from the faster lap, resampled every 5 m.
2. Project each car's speed samples onto that centreline, so segment *i* is the
   same physical piece of track for both drivers.
3. Integrate `ds / v` over 5 m, scale the lap uniformly to the official lap time,
   aggregate to 25 m bins.
4. The browser sums four bins per **100 m segment**, smooths the delta over
   three segments, and treats |Δ| < **0.03 s** as "too close to call".

Calibration on Austin:

| Check | Result |
| --- | --- |
| Same driver, two laps (Norris 42 vs 44, both 99.887 s) | RMS 0.014 s per 100 m; 46/53 segments inside ±20 ms |
| Leclerc vs Verstappen (official gap 1.255 s) | 32/53 segments beyond ±20 ms; 11 lead changes |
| Sector deltas (estimate vs official) | +0.21 vs +0.32; −0.70 vs −0.81; −0.76 vs −0.76 |
| GPS length vs official | 5,395 m vs 5,513 m (−2.1 %); corrected by uniform time scaling |

This is accurate enough for an *indicative* track-dominance visual. It is not
timing-grade, and the UI will say so.

## 6. Consolidated must-have conditions

The board's individual conditions collapse to these:

1. **Shared centreline and equal-arc-length comparison**, with the start/finish
   crossing handled explicitly and truncation disclosed.
2. **Uncertainty-aware rendering:** 100 m visual segments, calibrated neutral
   band (≥0.03 s), minimum run length, no colour-only encoding.
3. **Per-driver, per-lap telemetry validation:** density, coverage, gaps, length;
   fall back to the fastest *covered* lap and disclose when it is not the
   official fastest; exclude pit-out/in and outlier laps.
4. **Official lap/sector times as fact**, spatial split labelled
   "GPS-derived, indicative"; show lap number, time, tyre compound/age and
   coverage.
5. **A one-race sizing spike** before building the batch: measure JSON size,
   build time, load time, and demonstrate the Monaco fallback.
6. **Scope cut for v1:** 3–5 curated races with known-good data, not 18.
   Additional races/seasons are a documented one-command expansion.
7. **CC BY-NC-SA 4.0 compliance:** licence text, attribution, share-alike,
   non-commercial use, no F1 logos/marks.
8. **Snapshot reproducibility:** raw responses cached, source manifest/checksums,
   "as of" date, no runtime API calls.
9. **CEO visual sign-off** on the wireframe/example interpretation before the
   final release (the board cannot see the image).

## 7. Scope decision taken on the board's behalf

The CEO delegated the go/no-go to the board and asked not to be blocked on the
plan. The board's product and risk members both recommended 3–5 races. The
project therefore adopts:

- **v1: five 2026 races** — United States (Austin), Italy (Monza), Belgium (Spa),
  Singapore, and Great Britain (Silverstone). These have end-of-race position
  coverage and visually distinct circuits.
- **Monaco is excluded from v1** (truncated/sparse position stream); the build
  tool can include it with a common-window restriction later.
- The pipeline supports any year/session via CLI; generating the full 2026
  calendar is a documented stretch step once the visual is signed off.

This keeps the promise ("choose a race") true within a curated season while
respecting the board's "prove it before scaling" condition.

## 8. Next step

Rewrite the implementation plan to incorporate §5–§7 and resubmit it to the
board (step 4). Implementation does not start until that approval is recorded.
