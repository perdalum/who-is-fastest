# Implementation plan v1.1 — Who is the fastest?

- **Prepared:** 2026-10-30
- **Status:** resubmitted for steering-board approval after [board decision](02-steering-board-decision.md)
- **Supersedes:** v1.0 (position-based 25 m method; rejected by the board)
- **Baseline:** [data-source assessment v1.1](01-data-source-assessment.md)

## 1. Objective and success criteria

Ship a personal, static web page where a user chooses a Formula 1 race and two
drivers and sees a circuit map whose sections are coloured in the team colour of
the driver who was quicker there.

Release acceptance criteria:

1. `npm run dev` serves the page; no runtime API calls, no backend.
2. Race picker lists the five curated 2026 races; drivers are grouped by team
   and can be chosen by name/number.
3. The track is split into 100 m sections. A section is coloured only when the
   estimated time delta is ≥ 0.03 s; otherwise it is neutral ("too close to
   call"). This rule is visible in the legend.
4. Official lap times, sector results, lap number, tyre and coverage are shown
   as facts. The spatial split is labelled "GPS-derived, indicative".
5. Hover, tap and keyboard (←/→) expose a section's distance, both times and
   the delta. Colour is never the only encoding.
6. Works at 390 px and 1440 px, no horizontal scroll, no console errors.
7. `npm test` passes unit, data-contract and browser tests.
8. A sizing spike (Austin) shows < 150 KB per race file and < 2 s load locally.
9. README, user guide, data-pipeline manual, architecture, CHANGELOG and licence
   notices are current; release is tagged `v1.0.0`.

**Out of scope:** live sessions, qualifying comparisons, >2 drivers, tyre/fuel
modelling, deployment, accounts, backend, full-calendar build (documented CLI
expansion only).

## 2. Architecture

```
OpenF1 API (build time only)
  │ throttled, cached fetch (~2.2 s/request)
  ▼
scripts/build-data.mjs ──► data/catalog.json
  │                        data/races/<session_key>.json
  │                        data/manifest.json (hashes, as-of)
  ▼
index.html + assets/app.js + assets/track.js (vanilla ES modules)
  │ fetch local JSON
  ▼
SVG track + controls + stats + tooltip
```

No frontend framework, no CDN, system fonts. Data is a committed snapshot; raw
responses live in `tmp/cache/` (gitignored). `scripts/serve.mjs` (Node, zero
dependencies) serves the static files.

## 3. Data contract

### `data/catalog.json`

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-30T12:00:00Z",
  "source": { "name": "OpenF1", "url": "https://openf1.org/",
              "licence": "CC BY-NC-SA 4.0", "unofficial": true },
  "races": [{
    "session_key": 11396, "name": "United States Grand Prix",
    "circuit": "Circuit of the Americas", "location": "Austin",
    "country": "United States", "date": "2026-10-25", "year": 2026,
    "round": 18, "driver_count": 22, "file": "data/races/11396.json"
  }]
}
```

### `data/races/<session_key>.json`

```json
{
  "schema_version": 1, "session_key": 11396,
  "name": "United States Grand Prix", "circuit": "Circuit of the Americas",
  "location": "Austin", "country": "United States",
  "date": "2026-10-25", "year": 2026, "round": 18,
  "generated_at": "2026-10-30T12:00:00Z",
  "grid_m": 25, "segment_m": 100, "deadband_s": 0.03,
  "track": {
    "length_m": 5395.0,
    "points": [[x, y]],
    "sector_marks_m": [1620, 3835]
  },
  "drivers": [{
    "number": 16, "acronym": "LEC", "name": "Charles Leclerc",
    "team": "Ferrari", "colour": "E8002D",
    "lap_number": 42, "lap_time": 97.976,
    "official_best_lap": 42, "official_best_time": 97.976,
    "sectors": [26.289, 38.906, 32.781],
    "top_speed": 341, "compound": "SOFT", "tyre_age": 8,
    "coverage_pct": 100,
    "dt": [/* seconds per 25 m bin, scaled to lap_time; null = no data */]
  }],
  "analysis": {
    "lap_rule": "fastest lap with validated speed + position telemetry",
    "position_hz": 4.2,
    "note": "Spatial split derived from GPS speed; indicative, not timing-grade."
  }
}
```

`dt` is the time to traverse one **25 m** bin. The client sums **four** bins per
**100 m** visual segment; `segment_m / grid_m = 4` is fixed and tested. A `null`
bin means no trustworthy data: the client draws the segment neutral and never
interpolates across it.
`coverage_pct` is the share of the lap duration covered by both streams.
`official_best_*` lets the UI flag a telemetry-limited lap choice. `data/LICENSE`
carries the CC BY-NC-SA 4.0 notice for the derived data; the source code carries
its own licence file.

## 4. Build pipeline

1. **Calendar:** `/sessions?year=2026` plus `/meetings`; keep
   `session_name === "Race"`, not cancelled, already started. Round number is
   the index among non-cancelled Grands Prix.
2. **Per race:** fetch `/drivers`, `/laps`, `/stints`. Validate lap data
   (sectors sum to lap; duration plausible relative to session median).
3. **Candidate lap per driver:** valid laps (duration, not pit-out, within a
   session-relative band) sorted by time. Try up to 8 candidates until one
   passes telemetry validation:
   - `location`: ≥ 2 samples/s, span ≥ 97 % of lap, no `(0,0)`, lap-bounded.
     Gaps > 0.6 s are allowed only locally: the affected 25 m bins become
     `null` (neutral); if > 15 % of the lap is affected, reject the lap.
     (Monaco fails every candidate; it is excluded.)
   - `car_data`: ≥ 2 samples/s, span ≥ 97 %; same gap rule and neutral bins.
   - GPS length within 10 % of the field median.
4. **Start-line interpolation:** interpolate position and speed at
   `date_start` from the samples straddling the line; record the residual in the
   metadata. Drop samples outside `[date_start, +duration]`.
5. **Reference centreline:** fastest valid driver lap; smooth positions
   (3-sample), resample every 5 m, keep the lap-bounded length.
6. **Speed profile:** project each `car_data` sample's interpolated position
   onto the centreline (monotonic ±30-point window, with a wrap guard at the
   start/finish seam). Interpolate speed at 5 m.
7. **dt:** `5 / max(v, 5 km/h)` per 5 m; record the pre-scale integral (expected
   1–2 % short of the official lap), then scale the whole lap so the sum equals
   the official lap time; aggregate to 25 m bins. The total is **defined** to
   equal the official time; spatial trust comes from the sector/calibration
   checks, not the total.
8. **Track geometry:** reference centreline at 10 m for the SVG (GPS-derived
   length, ~2 % short; labelled as such); sector marks from cumulative `dt` at
   the official sector times.
9. **Write + manifest:** race JSON, catalog rebuilt from files present,
   `manifest.json` with SHA-256 of every file, the build script's git SHA,
   request count and "as of" timestamp. Raw cache is checksummed and retained
   locally so a snapshot can be audited/rebuild.
10. **Fail loudly:** a race with < 2 valid drivers is skipped with a clear log;
    a season build fails if fewer than the requested races succeed.

Rate limiting: one request at a time, ≥2.2 s apart, exponential backoff on
429/5xx, persistent cache keyed by URL hash. `--force` bypasses cache. Request
count for five races ≈ 245, build time ≈ 9–10 minutes.

## 5. Algorithm details that must not be lost

- **Same physical point:** both drivers share the reference centreline; never
  compare each driver's own cumulative distance.
- **Start/finish:** lap windows are `[date_start, date_start + duration]`;
  positions outside are dropped. Scale compensates for the first sample being
  ~0.2 s after the line.
- **Uncertainty:** deadband **0.03 s** per 100 m (≈2σ; same-driver RMS 0.014 s,
  50/53 neutral); delta smoothing over 3 segments; no colour inside the band;
  uncovered bins are neutral and never bridged.
- **Minimum run:** merge single-segment runs into the neighbourhood colour to
  avoid 100 m confetti; document this rule.
- **Round number:** sequential count of non-cancelled Grands Prix (Austin is
  round 18, not 19).
- **Edge bins:** the first/last partial bins use the nearest valid speed and are
  flagged in the metadata; the start/finish shape remains GPS-derived.
- **Official facts:** lap/sector times are never derived from GPS. If the
  chosen lap is slower than the official best, show "telemetry-limited lap".

## 6. UI specification

- **Look:** dark, calm, typographic; team colours are the only strong colours.
  Track-only hero; no photos, logos or copied scaffolding.
- **Controls:** race select; two driver selects grouped by team (chip, number,
  name, team); swap; deep-link hash (`#race=…&a=…&b=…`); prefetch next race.
- **Track:** SVG viewBox 0 0 1000 1000, aspect preserved, base casing + coloured
  100 m segments (round caps, slight overlap), subtle wide translucent underlay
  for glow, neutral "too close" colour, start/finish tick, sector marks.
- **Interaction:** hover/focus shows tooltip with distance, both segment times,
  signed delta and ±0.03 s caveat; touch pins; ←/→ moves selection when the
  track has focus; Esc clears.
- **Method panel:** visible in the UI (not only README): source, "quicker on
  their best available laps", 100 m/0.03 s/calibration, coverage caveat, licence
  and attribution.
- **Primary copy:** "Quicker on their best available laps" appears next to the
  track; if the chosen lap differs from the official best, a
  **telemetry-limited** badge shows the official best lap/time.
- **Stats:** driver cards (colour, name, lap, gap, top speed, compound/age,
  coverage); sector result chips from official times; segment tally
  (A / neutral / B); distance-won bar; "telemetry-limited" badge.
- **States:** skeleton, error + retry, no-telemetry race, same-driver prevention.
- **Accessibility:** labels, `aria-live` summary, keyboard, 3:1 contrast;
  secondary encoding (pattern/outline/dash) for **any** pair whose colours are
  too close (same team or ΔE below threshold), not only same-team; colour never
  the only channel.
- **Rendering:** butt caps/joins per segment to avoid colour bleed; no adjacent
  overlap. Glow comes from a wide translucent underlay.
- **Budget:** initial JS/CSS < 250 KB uncompressed; race file < 150 KB.
- **Responsive:** side-by-side ≥ 960 px; stacked below; tooltip becomes a fixed
  panel on touch widths.

## 7. Workstreams and agents

| # | Workstream | Owner | Files (exclusive) |
| --- | --- | --- | --- |
| W1 | Data pipeline + tests | Data agent | `scripts/**`, `tests/telemetry.test.mjs`, `tests/data.test.mjs`, `package.json` |
| W2 | Track geometry module + tests | Visualisation agent | `assets/track.js`, `tests/track.test.mjs` |
| W3 | UI shell + styling | Frontend agent | `index.html`, `assets/styles.css` |
| W4 | Integration/state | Lead | `assets/app.js`, `scripts/serve.mjs` |
| W5 | Dataset (5 races) | Lead + W1 | `data/**`, `data/manifest.json` |
| W6 | Independent testing | 3 test agents | `tests/e2e/**`, `docs/05`, `docs/06` |
| W7 | Release/docs | Lead | `README.md`, `CHANGELOG.md`, `docs/**`, tag |

Agents do not commit; the lead reviews, integrates and commits logical units.
File ownership avoids simultaneous edits.

## 8. Milestones

| Milestone | Exit criterion | Tag |
| --- | --- | --- |
| M0 Assessment | Board GO WITH CONDITIONS | `v0.1.0` |
| M1 Plan approved | Board approves v1.1 | `v0.2.0` |
| M2 Skeleton | Page loads; fixture race renders; CEO wireframe/visual checklist issued | — |
| M3 Pipeline spike | Austin built; size/time measured; Monaco fallback shown | — |
| M4 Feature complete | Controls/track/stats/tooltip/states | `v0.3.0` |
| M5 Dataset | Five races + manifest validated | `v0.4.0` |
| M6 Tested | Independent report; no P1/P2 | `v0.9.0` |
| M7 Release | CEO report, docs, tag | `v1.0.0` |

## 9. Test strategy

- **Unit:** smoothing, projection, speed→dt, scaling, aggregation, deadband,
  run merging, sector marks, hash parsing.
- **Data:** schema, ≥2 drivers, dt sums ≈ lap_time (±0.05 s), monotonic bins,
  track length 2–8 km, coverage ≥ 97 %, sector marks ordered, manifest hashes.
- **Browser (Playwright + installed Chrome):** load, change race/drivers,
  neutral band rendering, tooltip, keyboard, deep link, mobile 390 px, no
  console errors, no clipping.
- **Independent audit:** recompute one segment from raw API for Austin; compare
  to the app's JSON. Same-driver control included as a regression fixture.
- **Adversarial:** same team, same driver, stale/missing race file, tiny screen,
  colour-blind DOM check.

### Acceptance thresholds

| Metric | Threshold |
| --- | --- |
| Race file size | < 150 KB |
| Local load (cold, 5 races) | < 2 s |
| dt sum vs official lap | < 0.05 s |
| Same-driver neutral share at 100 m (0.03 s band) | ≥ 90 % |
| Austin sector delta error (LEC/VER) | ≤ 0.20 s per sector |
| Pre-scale speed integral vs official | 1–2 % short (sanity, not equality) |
| Telemetry-limited badge fixture | badge + official best lap/time visible |
| Five-minute usability check | unfamiliar user answers "who was quicker where?" in < 10 s |
| CEO visual sign-off | recorded before release |
| Console errors / failed requests | 0 |

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| GPS noise produces false dominance | Shared centreline, speed integration, 100 m, 0.03 s band, published calibration |
| Coverage gaps / truncated streams | Candidate fallback, per-lap validation, flag chosen lap, Monaco excluded |
| Rate limits slow the build | Cache, 2.2 s spacing, resumable, only 5 races |
| Different lap conditions | Explicit "best available lap", lap/tyre/coverage shown |
| Unofficial API / licence | Snapshot + manifest; CC BY-NC-SA notice; no F1 marks |
| Visual target unconfirmed | CEO sign-off on wireframe before release |
| Scope creep | Fixed v1 scope; expansion CLI documented |

## 11. Definition of done

All §1 criteria met, board approves this plan and later the test report, no
P1/P2 issues, docs/changelog/README/licence complete, CEO visual sign-off and
usability check recorded, `v1.0.0` tagged, and the CEO report states what works,
how it was verified, measured limitations and the one-command path to add races.
The report must explicitly record the five-race scope decision and the expansion
command, since the CEO did not pre-approve that cut.
