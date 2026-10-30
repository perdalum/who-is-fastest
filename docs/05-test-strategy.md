# Test strategy

## Goal

Prove that the page is usable, the dataset is internally consistent, and the
spatial comparison is no more confident than the evidence allows. Testing is
independent of the implementation team: the test lead does not edit product
code; defects go to the lead with a reproduction.

## Layers

| Layer | Tool | What it proves |
| --- | --- | --- |
| Unit | `node --test` | Telemetry math, geometry, deadband, null handling, formatting |
| Data contract | `node --test` | Schema, driver counts, `dt` sums, nulls, sector marks, manifest hashes |
| Browser E2E | Playwright + installed Chrome | Load, controls, SVG, tooltip, keyboard, deep links, responsive layouts, console clean |
| Independent audit | Python/Node from raw API | One Austin section and one same-driver control reproduce within tolerance |
| Accessibility | Manual + DOM checks | Labels, focus, keyboard, contrast, colour-not-only |
| Adversarial | Playwright | Same team, same driver attempt, missing race file, 390 px, reduced motion |

## Acceptance thresholds

| Check | Pass condition |
| --- | --- |
| Race file size | < 150 KB |
| Cold load, five races | < 2 s locally |
| `dt` integrity | `sum(dt) + null_duration = lap_time`; < 0.05 s only for 100 % coverage |
| Same-driver neutral share (0.03 s, 100 m) | ≥ 90 % |
| Selected-lap duration coverage | ≥ 90 %; one null run ≤ 2 s |
| No-data state | distinct hatch/dash; excluded pairwise from the tally |
| Austin sector delta error (LEC/VER) | ≤ 0.20 s per sector |
| Pre-scale integral | 0–2 % short of official (sanity) |
| Console errors / failed requests | 0 |
| Horizontal overflow at 390 / 1440 | 0 |
| Tooltip / keyboard | Section, both times, delta visible |
| Telemetry-limited fixture | badge + official best shown |
| Five-minute usability | unfamiliar user answers “who was quicker where?” in < 10 s |

## Data audit method

1. Pick Austin, LEC (16) and VER (3).
2. Recompute one 100 m section from the raw `location` + `car_data` windows
   using the documented method, independently of `scripts/lib`.
3. Compare the section times to the JSON within 0.05 s.
4. Run the same-driver control (NOR laps 42/44) and count neutral sections at
   0.03 s; expect ≥ 90 %.
5. Check every race JSON: driver count ≥ 2, `dt` length × 25 m ≈ track length,
   sums, sector marks ordered, no `null` inside a coloured segment.

## Browser matrix

- 1440 × 1000 desktop, 390 × 844 phone.
- Chrome (installed), headless. Firefox/WebKit not required for v1; note if
  unavailable.
- Reduced-motion emulation.
- Keyboard-only pass: Tab to track, ←/→, Esc.
- Touch pass: tap to pin, tap elsewhere to dismiss.

## Reporting

`docs/06-test-report.md` records commands, environment, results, screenshots
(paths), defects (P1/P2/P3), and a Go/No-Go recommendation. A P1 (wrong result,
crash, no colour key) or P2 (broken mobile layout, inaccessible control) blocks
release. P3s are listed with owners.

## What is not tested

- Real-time/live data.
- Every race of the season.
- F1 timing-grade accuracy (the product explicitly labels GPS as indicative).
- Commercial use/licence beyond the non-commercial notice.
