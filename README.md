# Who is the fastest?

A single-page, no-backend visualisation that answers one question for a chosen
Formula 1 race: **which of two drivers was faster, and where?**

Pick a race and two drivers, then choose **Fastest lap** or **Average**. The
circuit is drawn in 100 m sections; each section is coloured in the team colour
of the driver who covered that part in less time. Hover or tap a section to see
the times and delta. Official lap and sector times are shown as facts; the
spatial split is GPS-derived and labelled indicative.

> **Status: v1.1.0 — five curated 2026 races, fastest and average bases.** See
> [`docs/07-ceo-report.md`](docs/07-ceo-report.md) for the release decision and
> known limits. This is a personal, non-commercial project.

## Quick start

```bash
npm run dev        # serve at http://127.0.0.1:5173
npm test           # 43 unit + data-contract tests
npm run test:e2e   # 22 browser core + 8 adversarial checks (needs npm install)
node tests/audit/audit.mjs   # independent data audit
```

No API key is required. The page reads pre-built JSON, so it does not call
OpenF1 at runtime.

### Rebuild data

```bash
npm install
npm run build:data -- --session 11396     # one race, fastest lap
npm run build:average -- --sessions 11396 # add the clean-lap average
npm run build:curated                     # rebuild all five (both bases)
```

The build is rate-limited (2.2 s between requests), has a hashed disk cache and
retries 429/5xx responses. A fresh five-race fastest-lap build takes roughly 8 minutes and
about 240 logical requests; the average pass adds one whole-session stream
pair per driver (roughly 8 more minutes on a cold cache). See the
[data pipeline manual](docs/manuals/data-pipeline.md).

## Ships with

| Race | Session | Round |
|---|---|---:|
| British Grand Prix, Silverstone | 11326 | 9 |
| Belgian Grand Prix, Spa | 11334 | 10 |
| Italian Grand Prix, Monza | 11361 | 13 |
| Singapore Grand Prix, Marina Bay | 11388 | 17 |
| United States Grand Prix, Austin | 11396 | 18 |

Monaco is excluded: its position stream has no complete lap. The pipeline can
add other races after the same coverage/calibration checks.

## Honest reading

- **Fastest lap** uses the quickest valid lap. **Average** uses the mean of
  clean laps: valid sectors, not pit-out, and within 110 % of the driver’s
  median lap. The count and rule are shown above the map; lap 1 is normally
  excluded by that filter.
- **Official:** lap time, sector times, lap number, tyre and top speed.
  **Indicative:** the 100 m spatial split, from ~4 Hz GPS speed projected onto a
  shared centreline. It is not timing-loop data.
- A section is neutral when **|Δ| < 0.03 s**; it is **no telemetry** when either
  driver has a missing 25 m bin. No-data is dashed, never a team colour, and is
  excluded from the tally. Gaps are never bridged.
- If the chosen lap is not the official best, or coverage is below 100 %, the
  page says so and shows the lap/coverage. It never claims a complete comparison
  from partial telemetry.
- Laps are not matched for fuel, tyre age or traffic; a later, lighter lap can
  look faster everywhere.

## Documentation

- [Documentation index](docs/README.md)
- [User guide](docs/manuals/user-guide.md)
- [Data pipeline manual](docs/manuals/data-pipeline.md)
- [Architecture](docs/manuals/architecture.md)
- [Data-source assessment](docs/01-data-source-assessment.md)
- [Steering-board decisions](docs/02-steering-board-decision.md)
- [Test report](docs/06-test-report.md)
- [CEO report](docs/07-ceo-report.md)

## Licence / data notice

Source code is MIT-licensed (see [`LICENSE`](LICENSE)). Formula 1 data from
[OpenF1](https://openf1.org/) is used under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); see
[`data/LICENSE`](data/LICENSE). Formula 1 and related marks belong to their
owners. This project is unofficial and not affiliated with Formula 1.
