# Changelog

All notable changes to **Who is the fastest?** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.1] — 2026-10-30

### Fixed
- Persist a per-driver `scale_factor` and the reference factor in every race
  JSON, so the GPS-to-official scaling is auditable.
- Raise the 320 px touch hit lane to ~25 CSS px.

### Added
- `npm run build:curated` rebuilds the five shipped races from the cache.
- Independent audit updated to the current raw LEC/VER counts.

## [1.0.0] — 2026-10-30

### Added
- Five curated 2026 races: Silverstone (11326), Spa (11334), Monza (11361),
  Singapore (11388), Austin (11396), with catalog and SHA-256 manifest.
- Static page with race/driver selectors, swap, deep links and URL hash.
- Shared-centreline, 100 m section visualisation with team colours, secondary
  dash/outline for close colours, neutral band and a distinct no-telemetry
  state.
- Hover, touch, keyboard and screen-reader interaction; responsive layouts at
  1440, 1024, 768, 390 and 320 px.
- Build pipeline: throttled/cached OpenF1 client, 25 m `dt` bins, null gaps,
  reference-lap selection, catalog/manifest, `--session` / `--sessions` /
  `--year` / `--force` / `--delay`.
- Tests: 42 unit/data, 21 browser core, 8 adversarial/accessibility, plus an
  independent raw-data audit.
- Manuals for users, the data pipeline and architecture; test report and CEO
  report.

### Changed
- Board-approved measurement-gate amendment (5–0): `dt` identity with nulls,
  90–100 % duration coverage, 0–2 % pre-scale sanity.
- Default pair is the fastest lap plus a contrasting rival, not necessarily the
  two fastest laps; documented in the manuals.
- `sum(dt)` excludes null bins; no-data is reported separately and never
  counted as neutral or as a win.

### Fixed
- Error panel stayed visible after a failed load and retry recovers.
- Single-race picker is no longer disabled.
- Tapping outside a pinned tooltip dismisses it; Escape clears the selection.
- Tooltip and track agree on the 0.03 s boundary (`|Δ| < 0.03` neutral).

### Known limits
- GPS split is indicative; Monaco is excluded; Monza has no calibration block;
  three P3 conditions remain open (see `docs/06-test-report.md`).

## [0.3.0] — 2026-10-30

### Added
- Implementation of the visual page and track geometry module.
- Austin real-data build, then the five-race dataset.
- Browser and data test foundations.

## [0.2.0] — 2026-10-30

### Added
- Implementation plan v1.1 and board plan review (5–0 approve with minor edits).
- Calibrated speed-integration method, null/gap rule, coverage gates.

## [0.1.0] — 2026-10-30

### Added
- Data-source assessment, steering-board GO WITH CONDITIONS decision (5–0).
- Project scaffold, docs structure, changelog.
