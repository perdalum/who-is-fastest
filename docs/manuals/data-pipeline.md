# Data pipeline manual

## What it produces

```
data/
  catalog.json          race list used by the picker
  manifest.json         SHA-256 of outputs, git SHA, request count, timestamp
  races/<session_key>.json
  LICENSE               CC BY-NC-SA 4.0 notice for the derived data
```

The browser never calls OpenF1. The JSON is a committed snapshot; rebuilding is
an explicit, rate-limited batch job.

## Commands

```bash
npm run build:data -- --session 11396        # one race (Austin), fastest lap
npm run build:average -- --sessions 11396     # add clean-lap averages
npm run build:curated                        # all five, both bases
npm run build:data -- --year 2026            # every completed 2026 race
npm run build:data -- --session 11396 --force
```

Options for `build:data`: `--session`, `--year`, `--out` (default `data`),
`--force`, `--limit`, `--delay` (default 2200 ms). Options for
`build:average`: `--sessions` (comma-separated), `--force`, `--delay`.

The fastest-lap five-race build is about 245 requests and 9–10 minutes at the
free tier. The average build additionally reads one whole-session `location`
and `car_data` stream per driver (about 44 requests per race) and caches them,
so the first run is network-bound and later runs are local. Raw responses are
cached under `tmp/cache/openf1/` and both builds are resumable.

## Rate limits

OpenF1 allows roughly 3 requests/second and 30/minute. The client makes **one
request at a time**, waits at least 2.2 s, retries 429/5xx with exponential
backoff, and caches successful responses by URL hash. Do not lower the delay.

## Method (short)

1. Choose the fastest lap per driver with usable `location` + `car_data`.
2. Validate: ≥2 Hz, ≥97 % lap span, no `(0,0)`, GPS length within 10 % of the
   field median. Gaps >0.6 s make the affected 25 m bins `null`; >15 % affected
   rejects the lap. Monaco fails every candidate and is excluded.
3. Build one **shared** centreline from the fastest valid lap, resampled at 5 m.
4. Project each speed sample onto it, interpolate speed at 5 m, integrate
   `dt = 5 / v`, then scale the lap so its total equals the official lap time.
5. Aggregate to 25 m bins; the client sums four bins per 100 m section.
6. Store `null` for untrustworthy bins. Never bridge a gap.

### Average profile

`scripts/build-average.mjs` adds a second profile per driver:

1. Use the same shared centreline built from the stored 10 m track polyline.
2. Read one whole-session stream per driver and slice it by each lap's
   `date_start` / `lap_duration`.
3. Keep clean laps: valid sectors, not `is_pit_out_lap`, within 110 % of the
   driver's median lap, and at least 60 % telemetry coverage.
4. Project every clean lap, average its 5 m `dt` bins where at least one lap
   has data, then normalise the mean to the mean official lap time.
5. Store `average.dt` at 25 m, plus `lap_count`, `lap_numbers`, mean sectors,
   coverage and scale factor. `sum(average.dt)` equals the mean lap time when
   coverage is 100 %; otherwise the declared coverage applies.

The average is not a single fabricated lap: it is a mean of independently
projected laps. Lap 1 usually fails the 110 % filter; the exact included lap
numbers are in the JSON.

The pre-scale integral is logged (expected 1–2 % short). The **total after
scaling is official by construction**; spatial trust comes from sector checks
and the same-driver control, not from the total.

## Validation and failure behaviour

- A lap without two streams is skipped; a race needs ≥2 valid drivers.
- If a race fails, the build logs the reason and (unless it is the only
  requested race) continues.
- `manifest.json` records every output hash, the base build script git SHA,
  request count and as-of time so a snapshot can be audited. The average pass
  adds `average_build` counters without rewriting the base build's audit.

## Adding a race

Add the session key to the curated list in `scripts/build-data.mjs` and run:

```bash
npm run build:data -- --session <key>
```

Then check:

```bash
npm test
```

The catalog is rebuilt from the files present. Do not hand-edit race JSON.

## Troubleshooting

| Problem | Cause / fix |
| --- | --- |
| `404` for every date window | Date filter encoding; keys must be `date>` / `date<` encoded as `date%3E` / `date%3C`. |
| Driver missing | No lap passed validation; check coverage in the log. |
| File unexpectedly large | Values may be unrounded; write minified JSON and round `dt` to 4 decimals. |
| Build interrupted | Re-run; cache is resumable. |
| Wrong race count | `session_name` must be `Race`; Sprints also use `Race`, so filter `session_name === "Race"` and use the meeting round. |
