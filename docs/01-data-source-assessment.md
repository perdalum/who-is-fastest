# Data-source assessment: can OpenF1 support "Who is the fastest?"

- **Prepared:** 2026-10-30
- **Author:** Lead agent (project office)
- **Source under review:** <https://github.com/br-g/openf1> — the OpenF1 API, <https://api.openf1.org/v1>
- **Decision needed from:** Steering board (step 2 of the CEO brief)

## 1. Executive summary

**Verdict: OpenF1 can support the goal.** No additional external data source is
required. The source provides, for every race since 2023, per-driver lap times,
sector times, car telemetry and high-frequency car positions. That is exactly
the raw material needed to reconstruct where one driver is faster than another
around a circuit.

The source cannot, however, be used directly from the browser, and it is not
complete for every lap of every race. Two conditions are therefore attached to
the go decision:

1. **A build-time data pipeline is mandatory.** Raw telemetry is ~4.5 MB per
   driver per session (~100 MB per race). The deliverable must pre-compute a
   compact, track-relative JSON snapshot per race (target: < 200 KB/race) and
   ship those files with the static page.
2. **Lap selection must be telemetry-aware.** The position stream is occasionally
   truncated (observed: Monaco 2026 stops after 60 of 120 minutes). The pipeline
   must pick the fastest lap *that has usable position data*, validate it, and
   disclose the choice in the UI.

With those conditions the source supports the full requested experience: choose
a race, choose two drivers by name and team, and colour every part of the
circuit by the faster driver.

## 2. What the product needs

| Requirement (setup.md) | Data needed |
| --- | --- |
| Choose a race | Season calendar, race session IDs, circuit names |
| Choose two drivers by name and team | Driver number, full name, acronym, team, team colour |
| Compare "fast" per part of the circuit | Position (`x`, `y`) and time at sufficient frequency for each driver's lap |
| Show lap-level context | Lap time, sector times, top speed |
| Static single page + JSON, no backend | Small, pre-computed, browser-friendly files |

## 3. What OpenF1 provides (verified 2026-10-30)

OpenF1 is a free, unofficial, community-run API. Access requires **no key and no
sign-up**; CORS is open (`access-control-allow-origin: *`). Historical data is
available from the 2023 season onwards. The documented free-tier limits are
**3 requests/second and 30 requests/minute**; supporter tiers raise them.

Relevant endpoints observed:

| Endpoint | Contents | Use in this project |
| --- | --- | --- |
| `/v1/sessions` | Session key, type, circuit, start/end, year | Race picker |
| `/v1/meetings` | Grand Prix names and weekend dates | Race picker labels |
| `/v1/drivers` | Number, full name, acronym, team, team colour | Driver picker, colours |
| `/v1/laps` | Lap time, three sector times, `date_start`, pit-out flag, speed trap | Lap selection, official totals |
| `/v1/location` | `x`, `y` (track plane) and `z` (elevation) at ~3.7 Hz | Track geometry and time/distance |
| `/v1/car_data` | Speed, RPM, gear, throttle, brake, DRS at ~3.7 Hz | Optional speed context |
| `/v1/session_result` | Classification, laps, points, status | Optional context |
| `/v1/position`, `/v1/intervals` | Running order / gaps | Not needed for v1 |

### Verified properties

- The 2026 calendar returns 25 race sessions: 18 completed, 2 cancelled, 5 future
  (as of the assessment date). Each completed race has 22 drivers.
- `location` samples arrive every ~0.27 s (3.7 Hz), occasionally 0.5–0.8 s apart.
- Track coordinates are **decimetres**: dividing `x` and `y` by 10 reproduces
  known circuit lengths (Austin 5.49 km vs 5.51 km official; Melbourne 5.35 km vs
  5.28 km official). `z` is elevation (Austin range ≈ 30 m).
- `laps[].date_start` is the lap start timestamp and is accurate enough to slice
  the position stream.
- Official lap and sector times are present and internally consistent.
- Position coverage was checked for all 18 completed races. **17 of 18** have
  samples through the end of the race. **Monaco is truncated**: the stream stops
  at 14:00 despite a 15:00 session end (8,087 samples vs 33k–39k elsewhere), so
  only the first ~60 minutes of that race can be compared. Kuala Lumpur has an
  unusually long stream (57k samples), which is harmless but further evidence
  that coverage must be validated per race rather than assumed.

## 4. Feasibility prototype (evidence)

A prototype was run against the 2026 United States Grand Prix (Austin, session
`11396`) comparing the fastest laps of Charles Leclerc (16) and Max Verstappen
(3):

| Metric | Leclerc | Verstappen |
| --- | --- | --- |
| Lap time | 97.976 s | 99.231 s |
| Sector 1 / 2 / 3 | 26.289 / 38.906 / 32.781 | 25.972 / 39.715 / 33.544 |
| GPS-derived lap length | 5,485 m | 5,479 m |
| Position samples | 377 | 386 |

Method: smooth `x`/`y` over three samples, accumulate distance, interpolate
elapsed time on a 25 m grid, compare per-segment times, smooth the delta over
five segments, classify each segment.

Results:

- The telemetry-derived cumulative delta over the lap was **−1.11 s** vs the
  official **−1.255 s** (error 0.15 s, 12 % of the gap).
- Sector pattern matched: Leclerc loses S1 (+0.40 s estimated vs +0.32 s
  official), then gains through S2 (−0.60 vs −0.81) and S3 (−1.21 vs −0.76).
- On a second pair (Norris vs Verstappen, official gap 0.580 s) the estimate was
  0.63–0.84 s depending on start alignment; the absolute error is 0.05–0.26 s.
- Segment-level classification is visually stable after smoothing, with roughly
  20–35 lead changes around a 5.5 km lap — plausible corner-by-corner behaviour.

**Interpretation:** the source is accurate enough for an indicative track
dominance visualisation. It is *not* a timing-grade tool; the UI must present
the official lap times as fact and the spatial breakdown as "based on GPS
telemetry, indicative".

### Data volume and runtime

- `location` for one driver over a full race weekend session: **~4.5 MB**
  (32k–42k samples including pre-session running).
- `car_data`: **~5.9 MB** per driver.
- All 22 drivers: **~100 MB per race** raw. Fetching and computing a race takes
  ~1–2 minutes at the free-tier rate limit; all 18 completed 2026 races ≈
  15–20 minutes, run offline and cached. A coverage survey of one full driver
  stream per race took ~1.5 minutes for 18 races at 27 requests/minute.
- Pre-computed output: ~50–100 KB per race; the page loads one race file on
  demand.

## 5. Gaps and limitations

| Gap | Impact | Mitigation |
| --- | --- | --- |
| Position stream not guaranteed for the whole race (Monaco 2026 ends at 60 min) | The outright fastest lap may have no telemetry | Try the 3 fastest candidate laps per driver; accept only laps with validated coverage; label the chosen lap |
| No track outline, sector-distance or corner metadata | Geometry must be derived | Build the centreline from the reference lap; keep sector times official and show sector *time* wins, not spatial sector lines |
| Coordinates noisy and in decimetres | Length and delta error | Smooth, validate length against the field median, reject outliers |
| No `is_pit_in_lap` flag | Pit laps could be selected | Filter by duration band, pit-out flag, and telemetry validation |
| Different fuel loads, tyres, traffic and track evolution | "Faster" is lap-condition-dependent | Compare each driver's fastest available lap; disclose method |
| Rate limits (30 req/min) | Slow first build | Persistent cache in `tmp/`, one request at a time, resumable builds |
| Unofficial source, no SLA | Data may change or disappear | Snapshot JSON in the repo; rebuild script; attribution; no runtime dependency |
| F1 trademarks / data ownership | Redistribution constraints | Personal, non-commercial use; attribution; no official logos; note in README |

### Image reference

`IMG_1141.PNG` is a phone screenshot containing the example track visualisation
plus text/background scaffolding. The brief explicitly asks for **the track
itself only**. The project will therefore reproduce the *concept* — a circuit
drawn as a continuous line whose sections take the colour of the faster driver —
without copying the surrounding UI, photography or typography. (The agent
runtime cannot decode images; the interpretation is based on `setup.md` and the
colour/structure analysis of the file.)

## 6. Alternatives considered

| Option | Why not chosen |
| --- | --- |
| **FastF1** (Python library) | Richer telemetry and track status, but needs a Python backend or a more complex build, and duplicates what OpenF1 already exposes. Reasonable future upgrade. |
| **Official F1 timing/data** | Paid, licensed, overkill for a personal project. |
| **Jolpica/Ergast** | Results and lap times only; no position telemetry, so cannot colour the track. |
| **Scraping F1.com** | Fragile, legally murkier, no advantage. |

## 7. Recommendation

**GO**, with the two mandatory conditions in §1 and the mitigations in §5.

Scope recommendation for v1:

- 2026 season, all completed races with usable data (18 at assessment time).
- Two-driver comparison from each driver's fastest telemetry-covered lap.
- Track-only hero visual (SVG), team-coloured segments, hover deltas, official
  lap/sector context, clear methodology note.
- Build script + cached snapshots; no runtime API calls, no backend.

The board is asked to vote **GO / GO WITH CONDITIONS / NO-GO** on this basis.
