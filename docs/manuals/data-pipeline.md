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
npm run build:data -- --session 11396        # one race (Austin)
npm run build:data                           # the five curated races
npm run build:data -- --year 2026            # every completed 2026 race
npm run build:data -- --session 11396 --force
```

Options: `--session`, `--year`, `--out` (default `data`), `--force`,
`--limit`, `--delay` (default 2200 ms).

A five-race build is about 245 requests and 9–10 minutes at the free tier.
Raw responses are cached under `tmp/cache/openf1/` and the build is resumable.

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

The pre-scale integral is logged (expected 1–2 % short). The **total after
scaling is official by construction**; spatial trust comes from sector checks
and the same-driver control, not from the total.

## Validation and failure behaviour

- A lap without two streams is skipped; a race needs ≥2 valid drivers.
- If a race fails, the build logs the reason and (unless it is the only
  requested race) continues.
- `manifest.json` records every output hash, the build script git SHA, request
  count and as-of time so a snapshot can be audited.

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
