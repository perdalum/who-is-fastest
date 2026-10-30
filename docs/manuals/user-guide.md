# User guide

## Run it

```bash
npm install        # only for the browser test tools
npm run dev        # http://127.0.0.1:5173
```

The page is a static site. It needs a local web server because browsers block
`fetch()` of local JSON from `file://`. `npm run dev` is a zero-dependency Node
server; there is no backend and no runtime API call.

## Make a comparison

1. **Race** — choose one of the five curated 2026 races.
2. **Driver A / Driver B** — pick two drivers, grouped by team. The page opens
   on the fastest lap and a contrasting rival; pick anyone else from the menus.
3. Read the map:
   - **Driver A's colour** — A was quicker through that 100 m section.
   - **Driver B's colour** — B was quicker.
   - **Neutral** — the estimated difference is below 0.03 s (`|Δ| < 0.03 s`), so
     the page will not call it. Hover for the exact numbers.
   - **No telemetry** — dashed grey: one or both drivers have a missing 25 m
     bin. This is not a tie and is excluded from the tally. Hover to see which
     driver is missing data.
4. The **official lap delta**, sector chips, lap/tyre/top-speed facts and the
   track-dominance bar sit beside the map.
5. **Swap** flips A and B without changing the race.
6. The URL records race and drivers, e.g.
   `#race=11396&a=16&b=3`; share or bookmark it.

### Keyboard and touch

- Focus the track, then **← / →** moves through sections; **Esc** clears.
- Hover on desktop; tap to pin the detail panel on touch.
- The page works at phone width (390 px) and desktop width.

## How to read the result honestly

- The **lap and sector times are official**. The **spatial split is estimated**
  from ~4 Hz GPS speed; it is indicative, not timing-grade.
- Each driver uses their **fastest lap with usable telemetry**. If that is not
  their official fastest lap, a **telemetry-limited** badge shows the official
  best lap/time in the driver card and under the map. Below 100 % coverage, the
  page says **partial telemetry** / **best covered laps** and shows the
  percentage; it does not claim a complete-lap comparison.
- Different laps happen at different fuel loads, tyre ages and traffic. A later,
  lighter lap can be quicker everywhere. The page does not correct for that.
- Sections are 100 m, smoothed over three sections; a one-section lead is not
  proof of a setup advantage. The neutral band and the tally are there to stop
  over-reading.
- GPS geometry is about 2 % shorter than the official circuit length. Distance
  labels and the shape are therefore approximate.

## Excluded race

Monaco 2026 is not in the catalog. Its position stream has no complete lap, so
any map would be invented. The build rejects such laps rather than filling gaps.

## Data and licence

Data: [OpenF1](https://openf1.org/), unofficial, **CC BY-NC-SA 4.0**. This is a
personal, non-commercial project and is not affiliated with Formula 1. Do not
use it commercially or with F1 logos/marks. See `data/LICENSE`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| “Catalog could not be loaded” | Start with `npm run dev`, not by opening `index.html` directly. |
| Empty race | Rebuild with `npm run build:data`; check the terminal log. |
| No drawable telemetry | Pick another driver/race; the source stream has a gap. |
| Stale data | `npm run build:data -- --force` (re-fetches; rate-limited). |
