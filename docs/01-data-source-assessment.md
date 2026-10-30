# Data-source assessment: can OpenF1 support "Who is the fastest?"

- **Version:** 1.1 (corrected after steering-board review)
- **Prepared:** 2026-10-30
- **Source under review:** [OpenF1](https://openf1.org/) — repository
  <https://github.com/br-g/openf1>, API <https://api.openf1.org/v1>
- **Decision:** recorded in [02-steering-board-decision.md](02-steering-board-decision.md)

## 1. Executive summary

**OpenF1 can support the goal.** No additional external data source is needed.
It supplies, for every race since 2023, per-driver lap and sector times, car
speed/throttle/brake telemetry and ~4 Hz car positions. That is enough to
reconstruct, for two drivers, which one was quicker along each part of the
circuit.

Three facts shape the design:

1. **A build-time pipeline is mandatory.** Raw position data is ~4.5 MB per
   driver per session; a race is ~100 MB. The static site must read a compact,
   pre-computed snapshot (target < 100 KB per race).
2. **Telemetry coverage is not guaranteed.** Monaco 2026 stops at 14:00 for a
   15:00 race and is sparse (~1–2 Hz). Lap choice must be coverage-aware and
   disclosed.
3. **A naive position-based segment comparison is noise-dominated.** A
   same-driver control produced 81 lead changes and 188/218 "decided" 25 m
   segments. The revised method compares **car speed on a shared centreline**
   and uses a 0.03 s neutral band; only then is the picture honest.

The board accepted these findings and voted **GO WITH CONDITIONS** (5–0) with
the conditions in §8.

## 2. What the product needs

| Requirement (setup.md) | Data needed |
| --- | --- |
| Choose a race | Season calendar, race session IDs, circuit names |
| Choose two drivers by name and team | Driver number, full name, acronym, team, team colour |
| Compare "fast" per part of the circuit | Position and speed at sufficient frequency for each driver's lap |
| Lap-level context | Official lap time, sector times, top speed, tyre |
| Static page + JSON, no backend | Small, pre-computed, browser-friendly files |

## 3. What OpenF1 provides (verified 2026-10-30)

OpenF1 is a free, unofficial, community-run API. Access needs **no key or
sign-up**; CORS is open (`access-control-allow-origin: *`). Historical data
starts in 2023. The free tier allows **3 requests/second and 30 requests/minute**.

| Endpoint | Contents | Use |
| --- | --- | --- |
| `/v1/sessions` | Session key, type, circuit, start/end, year | Race calendar |
| `/v1/meetings` | Grand Prix names and weekend dates | Race labels |
| `/v1/drivers` | Number, name, acronym, team, team colour | Driver picker, colours |
| `/v1/laps` | Lap time, 3 sector times, `date_start`, pit-out flag, speed trap | Lap selection, official facts |
| `/v1/location` | `x`, `y` track plane, `z` elevation, ~4 Hz | Centreline and position |
| `/v1/car_data` | Speed, RPM, gear, throttle, brake, DRS | Speed profile (core) |
| `/v1/stints` | Compound and stint lap range | Tyre context |
| `/v1/session_result` | Classification, laps, status | Optional context |

Verified properties:

- 2026: **25 Grands Prix** — 18 completed, 2 cancelled, 5 future. Six Sprints
  also have `session_type: "Race"`; filter with `session_name === "Race"`.
- `location` median interval **0.24 s** (~4.2 Hz), p90 0.38 s, occasional gaps
  up to 1.1 s. It is not a steady 3.7 Hz stream.
- Coordinates are **decimetres**: `x/10`, `y/10` metres reproduce known circuit
  lengths within ~2 %. `z` is absolute elevation.
- Lap and sector times are internally consistent (S1+S2+S3 = lap duration in
  all 1,166 Austin rows).
- Position coverage through the end of the race is present for **17 of 18**
  completed races. **Monaco is not usable**: its stream covers only 13:02–13:09
  inside the race (plus a few samples at 13:59–14:00), so no complete 79 s lap
  has continuous position data, even though 8,087 samples exist. It is excluded.
  The other candidates (Austin, Monza, Spa, Singapore, Silverstone) end at the
  chequered flag.

## 4. Volume, rate limits and access

| Item | Measured |
| --- | --- |
| `location`, one driver, one race weekend | ~4.5 MB (32k–42k samples) |
| `car_data`, one driver | ~5.9 MB |
| All 22 drivers, one race | ~100 MB raw |
| Free-tier rate | 30 requests/minute → ~22 s per driver pair |
| Pre-computed race file | target < 100 KB, measured at milestone M3 |
| Free licence | **CC BY-NC-SA 4.0**, no authentication |

A build for five races needs ~5 × (sessions, meetings, drivers, laps, stints,
22 × [location + car_data]) ≈ 245 requests, roughly 9–10 minutes at the free
tier. Raw responses are cached; the build is resumable.

## 5. Method: how "faster" is computed

The first prototype compared each driver on his own position-derived distance
axis. The board's review and a same-driver control showed this is not reliable:
lap lengths differ by ~1–2 %, grid index *i* is not the same physical point, and
GPS jitter dominates 25 m deltas. **That method is rejected.**

The accepted method:

1. Build one **reference centreline** from the faster lap (resampled every 5 m).
2. Project each driver's `car_data` samples onto that centreline. Segment *i*
   is now the same physical track for both drivers.
3. Integrate `ds / v` over 5 m, scale the whole lap to the official lap time,
   then aggregate into 25 m bins.
4. The client sums four bins per **100 m visual segment**, smooths the delta
   over three segments, and colours a segment only when |Δ| ≥ **0.03 s**
   (≈2σ of the same-driver control). Otherwise it is neutral ("too close to
   call"). Uncovered bins stay neutral; gaps are never bridged.
5. Official lap and sector times are displayed as fact. The spatial split is
   labelled "GPS-derived, indicative".

### Calibration and accuracy (Austin 2026)

| Check | Result |
| --- | --- |
| Same driver, two laps (Norris 42 vs 44, both 99.887 s) | RMS **0.014 s** per 100 m; 50/53 segments within ±30 ms (94 %); 14 sign changes |
| Leclerc vs Verstappen (official gap 1.255 s) | Raw: 24 of 49 covered sections beyond ±30 ms, 25 neutral, 5 no data. Final map after smoothing/merge: 21 coloured (17 LEC, 4 VER), 22 too close, 11 no data; 9 lead changes. |
| Sector deltas, estimate vs official | **+0.16 vs +0.32 s**, **−0.69 vs −0.81 s**, **−0.72 vs −0.76 s** |
| Sector delta errors | **−0.16 / +0.12 / +0.04 s** (all within the 0.20 s gate) |
| GPS lap length vs official | 5,395 m vs 5,513 m (−2.1 %); corrected by uniform time scaling |
| Speed-integrated total vs official | ~1.1–1.4 % short before scaling |

**Caveat:** each lap's `dt` is scaled so its sum equals the official lap time.
The lap total therefore matches *by construction*; it is not independent proof.
What the table validates is the **spatial distribution** (which sector gains
where) and the same-driver repeatability. The GPS length (5,395 m vs 5,513 m)
remains a geometry approximation; the UI labels the track distance as
GPS-derived and never claims the scaling corrects the shape.

This is accurate enough for an **indicative** dominance map, not for timing
analysis. The UI must show the deadband and the official times separately.

## 6. Gaps and limitations

| Gap | Impact | Mitigation |
| --- | --- | --- |
| Position stream may be truncated/sparse (Monaco) | Official fastest lap may be undrawable | Try candidate laps; require ≥2 Hz, coverage ≥97 %, no gap >1.2 s; publish chosen lap and flag if not the official fastest. Monaco has **no** fully covered lap and is excluded. |
| No track outline or corner metadata | Geometry must be derived | Centreline from reference lap; sector marks from official sector times |
| GPS noise / racing-line differences | False precision | Shared centreline, speed integration, 100 m segments, 0.03 s neutral band, published error |
| Different fuel/tyre/traffic conditions | "Faster" is lap-condition-dependent | Show lap number, time, tyre compound/age, coverage; say "best available lap" |
| Speed data is ~4 Hz and integer km/h | Local error | Integrate 5 m bins, scale to official lap time, 100 m visual segments |
| Unofficial API, no SLA; CC BY-NC-SA | Availability and licensing | Snapshot JSON in repo, cache + checksum manifest, attribution, non-commercial, share-alike |
| Example image not visually decoded | Visual target uncertain | Track-only concept implemented; CEO visual sign-off before release |

### Evidence provenance

The coverage survey in `tmp/coverage.json` queried **driver 1 only** for each
race, then spot-checked Monaco with a second driver. It proves the Monaco
truncation and general coverage; it does **not** prove that every driver's
stream is complete. The build therefore validates every driver/lap pair.
Early prototype lengths quoted in v1.0 (5,485 m) were inflated by including
pre-start and post-finish samples; all values here are lap-bounded.

### Image reference

`IMG_1141.PNG` is a 1170×2532 phone screenshot. The agent runtime cannot decode
images, so the visual target is interpreted from `setup.md`: a circuit drawn as
a continuous line, sections coloured by the faster driver, without the
screenshot's text, photography or scaffolding. Dimensions and palette were
inspected programmatically, but **the visual design requires CEO confirmation**
before release.

## 7. Alternatives considered

| Option | Why not chosen |
| --- | --- |
| **FastF1** (Python) | Richer telemetry/track status, but requires a Python backend or heavier build; sensible future upgrade. |
| **Official F1 data** | Paid/licensed, overkill for a personal project. |
| **Jolpica/Ergast** | Results and lap times only; no speed/position, cannot colour the track. |
| **Scraping F1.com** | Fragile, legally murkier, no advantage. |

## 8. Recommendation and board conditions

**GO** with these conditions (consolidated from the five board votes):

1. Shared centreline, equal-arc-length comparison, explicit start handling and
   truncation disclosure.
2. Uncertainty-aware rendering: 100 m segments, ≥0.03 s neutral band, minimum
   run length, non-colour encoding.
3. Per-driver/per-lap telemetry validation; fall back to fastest *covered* lap
   and disclose; exclude pit/outlier laps.
4. Official lap/sector times as fact; show lap, time, tyre, coverage; label the
   split indicative.
5. One-race sizing spike before the batch (size, build time, load time, Monaco
   fallback).
6. v1 = 3–5 curated races, not the whole calendar.
7. CC BY-NC-SA 4.0 compliance and no F1 marks.
8. Reproducible snapshot (cache, manifest, "as of", no runtime API).
9. CEO visual sign-off on the wireframe/example interpretation.
