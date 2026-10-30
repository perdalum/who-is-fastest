# Architecture

## Shape

```
index.html
assets/app.js        state, fetch, controls, stats, URL hash
assets/track.js      pure geometry: projection, segments, smoothing, classes
assets/styles.css    dark responsive shell, SVG track styling
data/*.json          committed OpenF1 snapshot
scripts/serve.mjs    zero-dependency static server
scripts/build-data.mjs + scripts/lib/*
```

No framework, no bundler, no CDN, no backend. ES modules load directly from the
browser. Fonts are system fonts. The page is one HTML file plus three assets and
one JSON file per race.

## Request flow

1. `app.js` fetches `data/catalog.json`.
2. The race picker loads `data/races/<session_key>.json`.
3. Drivers are grouped by team; defaults are the fastest available lap plus a contrasting rival.
4. `track.js` normalises the shared centreline, cuts it into 100 m segments,
   sums four 25 m `dt` bins per segment, smooths the delta over three segments,
   applies the ±0.03 s deadband, and merges one-segment runs.
5. `app.js` draws the SVG, legend, stats and tooltip; state lives in the URL
   hash.

## Why these choices

- **Shared centreline:** the only way to compare the same physical piece of
  track. Comparing each driver's own distance axis was rejected by the board.
- **Speed integration:** position-only timing was too noisy at 25 m. Speed is
  integrated over 5 m and scaled to the official lap.
- **100 m sections + deadband:** calibrated to same-driver noise (0.014 s RMS);
  0.03 s is about 2σ. This avoids 25 m “confetti”.
- **Null bins:** a gap is never interpolated; the section is neutral.
- **Official times as facts:** the map never overrides timing.

## Data model

See [implementation plan §3](../03-implementation-plan.md). Key points:
`grid_m: 25`, `segment_m: 100`, `deadband_s: 0.03`, `dt` is seconds per 25 m
bin (or `null`), `track.points` is a 10 m polyline, `sector_marks_m` are
distances from the start line.

## Accessibility and performance

- Native selects, visible labels, focus rings, `aria-live` summary, SVG
  title/desc, keyboard arrow inspection, tap-to-pin tooltip.
- Colour is not the only channel: neutral is visually distinct, same/close
  team colours get a dash pattern, tooltips give numbers.
- Initial JS/CSS budget <250 KB; race file <150 KB. No runtime API calls, no
  images besides the favicon, no web fonts.

## Tests

- `node --test` — telemetry math, track geometry, data contract.
- Playwright + installed Chrome — desktop/mobile rendering, interactions,
  console errors, deep links.
- Independent audit recomputes one Austin section from the raw API and checks
  the same-driver control.

## Known limits

- GPS length is ~2 % short of the official circuit.
- One lap per driver; fuel/tyre/traffic differences are not modelled.
- 2026 only in v1; the CLI accepts other years but the catalog is curated.
- Monaco is excluded (no complete position lap).
