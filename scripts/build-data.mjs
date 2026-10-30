#!/usr/bin/env node
/**
 * Build the static race snapshot from OpenF1.
 *
 * Usage:
 *   node scripts/build-data.mjs --session 11396
 *   node scripts/build-data.mjs --year 2026 --out data --limit 5
 *
 * The accepted method is a shared reference centreline plus speed integration
 * (never each driver's own cumulative distance). See docs/03 §3-5.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from './lib/openf1.mjs';
import {
  buildCenterline,
  interpolateAtTime,
  interpolateXYAtTime,
  median,
  projectToCenterline,
  sectorMarks,
  smoothPoints,
  speedBins,
  toSeconds,
  validateLap,
} from './lib/telemetry.mjs';

const ROOT = process.cwd();
const BUILD_SCRIPT = 'scripts/build-data.mjs';
const CACHE_DIR = path.join(ROOT, 'tmp', 'cache', 'openf1');
const SCHEMA_VERSION = 1;
const GRID_M = 25;
const SEGMENT_M = 100;
const DEADBAND_S = 0.03;
const LOCATION_PAD_S = 1.5;
const MAX_CANDIDATES = 8;
const GAP_S = 0.6;
const MAX_GAP_PCT = 15;
const MAX_GPS_DEVIATION_PCT = 10;

// OpenF1 exposes a circuit short name; the data contract uses the full name for
// the curated venues. Unknown venues fall back to the short name.
const CIRCUIT_NAMES = {
  Austin: 'Circuit of the Americas',
  Silverstone: 'Silverstone Circuit',
  'Spa-Francorchamps': 'Circuit de Spa-Francorchamps',
  Monza: 'Autodromo Nazionale Monza',
  'Marina Bay': 'Marina Bay Street Circuit',
};

const startedAt = Date.now();

function log(message) {
  console.error(`[build ${new Date().toISOString()}] ${message}`);
}

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'force') {
      args.force = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function round(value, digits = 3) {
  if (!Number.isFinite(Number(value))) return null;
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function medianIntervalHz(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const intervals = [];
  for (let i = 1; i < points.length; i += 1) {
    const dt = points[i].t - points[i - 1].t;
    if (dt > 0) intervals.push(dt);
  }
  const med = median(intervals);
  return med && med > 0 ? 1 / med : null;
}

function cleanLocation(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => ({
      t: toSeconds(p.date),
      x: Number(p.x) / 10,
      y: Number(p.y) / 10,
      rawX: Number(p.x),
      rawY: Number(p.y),
    }))
    .filter((p) => !(p.rawX === 0 && p.rawY === 0))
    .sort((a, b) => a.t - b.t);
}

function cleanCarData(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((p) => p && Number.isFinite(Number(p.speed)) && Number(p.speed) > 0)
    .map((p) => ({ t: toSeconds(p.date), speed: Number(p.speed) }))
    .sort((a, b) => a.t - b.t);
}

/** Lap-bounded position sequence with interpolated start/finish endpoints. */
function prepareLocation(raw, t0, t1) {
  const samples = cleanLocation(raw);
  if (samples.length === 0) throw new Error('no usable location samples');
  const start = interpolateXYAtTime(samples, t0);
  const end = interpolateXYAtTime(samples, t1);
  const inside = samples.filter((p) => p.t > t0 + 1e-9 && p.t < t1 - 1e-9);
  const points = [{ t: t0, x: start.x, y: start.y }, ...inside, { t: t1, x: end.x, y: end.y }];
  const firstInside = inside[0] ?? null;
  const lastInside = inside[inside.length - 1] ?? null;
  return { samples, inside, points, start, end, firstInside, lastInside };
}

/** Time intervals (seconds) where a stream has a gap larger than `gapS`. */
function timeGaps(samples, t0, t1, gapS = GAP_S) {
  const inside = samples.filter((p) => p.t >= t0 && p.t <= t1).sort((a, b) => a.t - b.t);
  const gaps = [];
  if (inside.length === 0) return [[t0, t1]];
  if (inside[0].t - t0 > gapS) gaps.push([t0, inside[0].t]);
  for (let i = 1; i < inside.length; i += 1) {
    if (inside[i].t - inside[i - 1].t > gapS) gaps.push([inside[i - 1].t, inside[i].t]);
  }
  if (t1 - inside[inside.length - 1].t > gapS) gaps.push([inside[inside.length - 1].t, t1]);
  return gaps;
}

function sAtTime(profile, t) {
  const value = interpolateAtTime(profile, t, 's');
  return Number.isFinite(value) ? value : null;
}

function lapWindow(lap) {
  const t0 = toSeconds(lap.date_start);
  return { t0, t1: t0 + Number(lap.lap_duration) };
}

function windowParams(lap) {
  const { t0, t1 } = lapWindow(lap);
  return {
    session_key: lap.session_key,
    driver_number: lap.driver_number,
    'date>': new Date((t0 - LOCATION_PAD_S) * 1000).toISOString(),
    'date<': new Date((t1 + LOCATION_PAD_S) * 1000).toISOString(),
  };
}

function lapHasUsableSectors(lap) {
  return (
    Number.isFinite(lap.duration_sector_1) &&
    Number.isFinite(lap.duration_sector_2) &&
    Number.isFinite(lap.duration_sector_3)
  );
}

function sectorSum(lap) {
  return lap.duration_sector_1 + lap.duration_sector_2 + lap.duration_sector_3;
}

function driverName(driver) {
  const first = String(driver.first_name ?? '').trim();
  const last = String(driver.last_name ?? '').trim();
  if (first || last) return `${first} ${last}`.trim();
  return String(driver.full_name ?? driver.broadcast_name ?? driver.name_acronym ?? '').trim();
}

function driverCandidates(laps, driverNumber, sessionMedian) {
  return laps
    .filter((lap) => lap.driver_number === driverNumber)
    .filter((lap) => Number.isFinite(lap.lap_duration) && lap.lap_duration > 0)
    .filter((lap) => !lap.is_pit_out_lap)
    .filter((lap) => lapHasUsableSectors(lap))
    .filter((lap) => Math.abs(sectorSum(lap) - lap.lap_duration) <= 0.1)
    .filter(
      (lap) =>
        lap.lap_duration >= sessionMedian * 0.7 && lap.lap_duration <= sessionMedian * 1.4,
    )
    .sort((a, b) => a.lap_duration - b.lap_duration);
}

function stintFor(stints, driverNumber, lapNumber) {
  const rows = stints
    .filter(
      (stint) =>
        stint.driver_number === driverNumber &&
        stint.lap_start <= lapNumber &&
        stint.lap_end >= lapNumber,
    )
    .sort((a, b) => b.stint_number - a.stint_number);
  return rows[0] ?? null;
}

function makeGeometry(chosen) {
  const lap = chosen.lap;
  const { t0, t1 } = lapWindow(lap);
  const loc = chosen.locInfo ?? prepareLocation(chosen.location, t0, t1);
  const smoothed = smoothPoints(loc.points, 3);
  const c5 = buildCenterline(smoothed, 5);
  const c10 = buildCenterline(smoothed, 10);
  const startResidualM = Math.hypot(loc.start.x - c5.points[0].x, loc.start.y - c5.points[0].y);
  const startSampleGapS = loc.firstInside ? loc.firstInside.t - t0 : null;
  return { loc, smoothed, c5, c10, startResidualM, startSampleGapS };
}

function buildProfile(chosen, geometry) {
  const lap = chosen.lap;
  const { t0, t1 } = lapWindow(lap);
  const loc = chosen.locInfo ?? prepareLocation(chosen.location, t0, t1);
  const car = cleanCarData(chosen.carData);
  if (car.length === 0) throw new Error('no usable car_data samples');
  const vStart = interpolateAtTime(car, t0, 'speed');
  const vEnd = interpolateAtTime(car, t1, 'speed');
  const profile = [{ t: t0, s: 0, v: vStart }];
  const state = { lastIndex: 0 };
  for (const sample of car) {
    if (sample.t <= t0 || sample.t >= t1) continue;
    const xy = interpolateXYAtTime(loc.samples, sample.t);
    const projection = projectToCenterline(geometry.c5.points, xy, state, 30);
    if (projection) profile.push({ t: sample.t, s: projection.s, v: sample.speed });
  }
  profile.push({ t: t1, s: geometry.c5.length_m, v: vEnd });

  const extraGapRanges = [];
  for (const [a, b] of timeGaps(loc.samples, t0, t1, GAP_S)) {
    const sa = sAtTime(profile, a);
    const sb = sAtTime(profile, b);
    if (sa != null && sb != null) extraGapRanges.push([sa, sb]);
  }
  const bins = speedBins(profile, geometry.c5.length_m, lap.lap_duration, {
    gapS: GAP_S,
    maxAffectedPct: MAX_GAP_PCT,
    extraGapRanges,
  });
  const inLap = car.filter((p) => p.t >= t0 && p.t <= t1);
  const topSpeed = inLap.length > 0 ? Math.max(...inLap.map((p) => p.speed)) : null;
  return { profile, bins, topSpeed, extraGapRanges };
}

function sumDt(dt, startBin, endBin) {
  let sum = 0;
  for (let i = startBin; i < endBin && i < dt.length; i += 1) {
    if (Number.isFinite(dt[i])) sum += dt[i];
  }
  return sum;
}

function sectorTimes(dt, marks) {
  const bounds = marks.map((m) => Math.max(0, Math.min(dt.length, Math.round(m / GRID_M))));
  return [
    sumDt(dt, 0, bounds[0]),
    sumDt(dt, bounds[0], bounds[1]),
    sumDt(dt, bounds[1], dt.length),
  ];
}

function buildDriverRecord(chosen, geometry, officialBest, stints) {
  const lap = chosen.lap;
  let profileData;
  try {
    profileData = buildProfile(chosen, geometry);
  } catch (error) {
    log(`  driver ${chosen.driver.driver_number} lap ${lap.lap_number}: profile failed (${error.message})`);
    return null;
  }
  const { bins, topSpeed } = profileData;
  if (bins.rejected) {
    log(
      `  driver ${chosen.driver.driver_number} lap ${lap.lap_number}: rejected ` +
        `(${bins.reasons.join(', ')}; affected ${bins.affectedPct.toFixed(1)}%)`,
    );
    return null;
  }
  const stint = stintFor(stints, chosen.driver.driver_number, lap.lap_number);
  const tyreAge = stint
    ? Number(stint.tyre_age_at_start ?? 0) + (lap.lap_number - stint.lap_start)
    : null;
  const preScaleShortfallPct = (1 - bins.preScaleTotal / lap.lap_duration) * 100;
  log(
    `  driver ${chosen.driver.driver_number} lap ${lap.lap_number} ` +
      `${lap.lap_duration.toFixed(3)}s dt=${bins.dt.length} ` +
      `preScale=${bins.preScaleTotal.toFixed(3)}s shortfall=${preScaleShortfallPct.toFixed(2)}% ` +
      `coverage=${bins.coveragePct.toFixed(1)}% nulls=${bins.nullCount5}`,
  );
  return {
    record: {
      number: chosen.driver.driver_number,
      acronym: chosen.driver.name_acronym,
      name: driverName(chosen.driver),
      team: chosen.driver.team_name,
      colour: String(chosen.driver.team_colour ?? '').replace(/^#/, '').toUpperCase(),
      lap_number: lap.lap_number,
      lap_time: round(lap.lap_duration, 3),
      official_best_lap: officialBest.lap_number,
      official_best_time: round(officialBest.lap_duration, 3),
      sectors: [
        round(lap.duration_sector_1, 3),
        round(lap.duration_sector_2, 3),
        round(lap.duration_sector_3, 3),
      ],
      top_speed: topSpeed == null ? null : Math.round(topSpeed),
      compound: stint?.compound ?? null,
      tyre_age: tyreAge,
      coverage_pct: round(bins.coveragePct, 1),
      scale_factor: round(bins.scale, 5),
      dt: bins.dt.map((value) => (Number.isFinite(value) ? round(value, 4) : null)),
    },
    bins,
    dtAll: bins.dtAll,
    preScaleShortfallPct,
  };
}

async function fetchCandidateWindow(driverNumber, lap) {
  const params = windowParams(lap);
  const location = await fetchClient.getJson('location', { ...params, driver_number: driverNumber });
  if (!Array.isArray(location) || location.length === 0) {
    log(`    no location rows for driver ${driverNumber} lap ${lap.lap_number}`);
    return null;
  }
  const pre = validateLap({
    lapDuration: lap.lap_duration,
    dateStart: lap.date_start,
    location,
    carData: null,
    gapS: GAP_S,
    maxGapPct: MAX_GAP_PCT,
  });
  if (!pre.location.ok) {
    log(
      `    driver ${driverNumber} lap ${lap.lap_number} position rejected: ` +
        `${pre.reasons.join(', ')} (${pre.location.count} pts, ` +
        `${pre.location.hz.toFixed(2)} Hz, span ${pre.location.span_pct.toFixed(1)}%)`,
    );
    return null;
  }
  const carData = await fetchClient.getJson('car_data', { ...params, driver_number: driverNumber });
  if (!Array.isArray(carData) || carData.length === 0) {
    log(`    no car_data rows for driver ${driverNumber} lap ${lap.lap_number}`);
    return null;
  }
  const validation = validateLap({
    lapDuration: lap.lap_duration,
    dateStart: lap.date_start,
    location,
    carData,
    gapS: GAP_S,
    maxGapPct: MAX_GAP_PCT,
  });
  if (!validation.valid) {
    log(
      `    driver ${driverNumber} lap ${lap.lap_number} rejected: ${validation.reasons.join(', ')} ` +
        `(loc ${validation.location.count} pts / ${validation.location.hz.toFixed(2)} Hz; ` +
        `car ${validation.car?.count ?? 0} pts / ${(validation.car?.hz ?? 0).toFixed(2)} Hz; ` +
        `gps ${validation.gps_length_m.toFixed(0)} m)`,
    );
    return null;
  }
  const { t0, t1 } = lapWindow(lap);
  log(
    `    driver ${driverNumber} lap ${lap.lap_number} ${lap.lap_duration.toFixed(3)}s ` +
      `loc=${validation.location.count}/${validation.location.hz.toFixed(2)}Hz ` +
      `gps=${validation.gps_length_m.toFixed(0)}m ` +
      `car=${validation.car.count}/${validation.car.hz.toFixed(2)}Hz ` +
      `gaps loc=${validation.location.gap_pct.toFixed(1)}% car=${validation.car.gap_pct.toFixed(1)}%`,
  );
  return {
    driver: null,
    lap,
    location,
    carData,
    locInfo: prepareLocation(location, t0, t1),
    gpsLengthM: validation.gps_length_m,
    locGapCount: validation.location.gap_count,
  };
}

async function chooseLap(driver, candidates, startIndex, medianGpsLengthM = null) {
  const limit = Math.min(candidates.length, MAX_CANDIDATES);
  for (let i = startIndex; i < limit; i += 1) {
    const lap = candidates[i];
    candidateAttempts += 1;
    log(
      `    candidate ${i + 1}/${limit} lap ${lap.lap_number} ${lap.lap_duration.toFixed(3)}s ` +
        `(official best ${candidates[0].lap_duration.toFixed(3)}s)`,
    );
    const window = await fetchCandidateWindow(driver.driver_number, lap);
    if (!window) continue;
    if (medianGpsLengthM != null) {
      const deviation = (Math.abs(window.gpsLengthM - medianGpsLengthM) / medianGpsLengthM) * 100;
      if (deviation > MAX_GPS_DEVIATION_PCT) {
        log(
          `    driver ${driver.driver_number} lap ${lap.lap_number} GPS length ` +
            `${window.gpsLengthM.toFixed(0)}m is ${deviation.toFixed(1)}% off median ` +
            `${medianGpsLengthM.toFixed(0)}m; trying next candidate`,
        );
        continue;
      }
    }
    return { ...window, driver, index: i };
  }
  return null;
}

async function buildRace(session, meeting, options) {
  const sessionKey = session.session_key;
  const raceStartedAt = Date.now();
  candidateAttempts = 0;
  const drivers = await fetchClient.getJson('drivers', { session_key: sessionKey });
  const laps = await fetchClient.getJson('laps', { session_key: sessionKey });
  const stints = await fetchClient.getJson('stints', { session_key: sessionKey });
  if (!Array.isArray(drivers) || drivers.length === 0) {
    log(`race ${sessionKey}: no drivers; skipping`);
    return null;
  }
  if (!Array.isArray(laps) || laps.length === 0) {
    log(`race ${sessionKey}: no laps; skipping`);
    return null;
  }

  const timedLaps = laps.filter(
    (lap) =>
      Number.isFinite(lap.lap_duration) &&
      lap.lap_duration > 0 &&
      !lap.is_pit_out_lap &&
      lapHasUsableSectors(lap),
  );
  const sessionMedian = median(timedLaps.map((lap) => lap.lap_duration));
  if (!sessionMedian) {
    log(`race ${sessionKey}: no usable lap times; skipping`);
    return null;
  }

  const driversByNumber = new Map();
  for (const driver of drivers) {
    if (driver.driver_number != null && !driversByNumber.has(driver.driver_number)) {
      driversByNumber.set(driver.driver_number, driver);
    }
  }

  const candidatesByDriver = new Map();
  for (const driverNumber of driversByNumber.keys()) {
    const candidates = driverCandidates(laps, driverNumber, sessionMedian);
    if (candidates.length > 0) candidatesByDriver.set(driverNumber, candidates);
  }
  if (candidatesByDriver.size < 2) {
    log(`race ${sessionKey}: fewer than 2 drivers with valid lap rows; skipping`);
    return null;
  }

  log(
    `race ${sessionKey}: ${driversByNumber.size} drivers, ${candidatesByDriver.size} with lap rows, ` +
      `session median ${sessionMedian.toFixed(3)}s`,
  );

  // Phase A: fastest telemetry-valid lap per driver (GPS-length check deferred).
  const chosen = new Map();
  for (const [driverNumber, candidates] of candidatesByDriver) {
    const driver = driversByNumber.get(driverNumber);
    log(`  driver ${driverNumber} ${driver.name_acronym ?? ''}: ${candidates.length} candidates`);
    const picked = await chooseLap(driver, candidates, 0, null);
    if (picked) chosen.set(driverNumber, picked);
    else log(`  driver ${driverNumber}: no valid telemetry lap; excluded`);
  }
  if (chosen.size < 2) {
    log(`race ${sessionKey}: fewer than 2 valid telemetry laps (${chosen.size}); skipping`);
    return null;
  }

  // Phase B: field-median GPS length within 10 %.
  const gpsMedian = median([...chosen.values()].map((row) => row.gpsLengthM));
  log(`  field median GPS lap length ${gpsMedian.toFixed(0)}m`);
  for (const [driverNumber, picked] of [...chosen.entries()]) {
    const deviation = (Math.abs(picked.gpsLengthM - gpsMedian) / gpsMedian) * 100;
    if (deviation <= MAX_GPS_DEVIATION_PCT) continue;
    log(
      `  driver ${driverNumber}: GPS length ${picked.gpsLengthM.toFixed(0)}m is ` +
        `${deviation.toFixed(1)}% off median; searching later candidates`,
    );
    const replacement = await chooseLap(
      picked.driver,
      candidatesByDriver.get(driverNumber),
      picked.index + 1,
      gpsMedian,
    );
    if (replacement) chosen.set(driverNumber, replacement);
    else {
      chosen.delete(driverNumber);
      log(`  driver ${driverNumber}: excluded (no candidate within 10% of median GPS length)`);
    }
  }
  if (chosen.size < 2) {
    log(`race ${sessionKey}: fewer than 2 drivers after GPS length filter; skipping`);
    return null;
  }

  // Reference centreline: the fastest valid lap. A >0.6 s position gap is
  // accepted as a straight chord through the centreline, but the affected dt
  // bins stay null/neutral (the client never bridges them). This keeps the
  // method identical to the accepted assessment and its LEC/VER calibration.
  const ordered = [...chosen.values()].sort((a, b) => a.lap.lap_duration - b.lap.lap_duration);
  let reference = null;
  let geometry = null;
  let built = null;
  for (const candidate of ordered) {
    const candidateGeometry = makeGeometry(candidate);
    const attempted = [];
    for (const row of ordered) {
      const officialBest = candidatesByDriver.get(row.driver.driver_number)[0];
      const builtRow = buildDriverRecord(row, candidateGeometry, officialBest, stints);
      if (builtRow) attempted.push({ row, ...builtRow });
    }
    const candidateRecord = attempted.find(
      (row) => row.row.driver.driver_number === candidate.driver.driver_number,
    );
    if (candidateRecord) {
      reference = candidate;
      geometry = candidateGeometry;
      built = attempted;
      break;
    }
    log(
      `  reference driver ${candidate.driver.driver_number} produced no usable dt; ` +
        `trying next fastest`,
    );
  }
  if (!reference || !built || built.length < 2) {
    log(`race ${sessionKey}: fewer than 2 usable drivers after dt build; skipping`);
    return null;
  }
  built.sort((a, b) => a.record.lap_time - b.record.lap_time || a.record.number - b.record.number);

  const referenceRecord = built.find((row) => row.row.driver.driver_number === reference.driver.driver_number);
  // Sector marks are track geometry. Use the fastest official lap's sector
  // times (it is the best available definition of S1/S2/S3) and its unmasked
  // integration so local gaps do not shift the boundaries.
  const marksSource = built[0] ?? referenceRecord;
  const marks = sectorMarks(marksSource.dtAll, marksSource.record.sectors);
  const trackLength = geometry.c5.length_m;

  // 10 m geometry for the SVG, plus a closing point if the 10 m grid stops short.
  const points10 = geometry.c10.points.map((p) => [round(p.x, 1), round(p.y, 1)]);
  const last5 = geometry.c5.points[geometry.c5.points.length - 1];
  if (geometry.c10.points.length === 0 || geometry.c10.points[geometry.c10.points.length - 1].s < trackLength - 0.01) {
    points10.push([round(last5.x, 1), round(last5.y, 1)]);
  }

  const meetingName = meeting?.meeting_name ?? `${session.location ?? 'Grand Prix'} Grand Prix`;
  const date = String(session.date_start).slice(0, 10);
  const race = {
    schema_version: SCHEMA_VERSION,
    session_key: sessionKey,
    name: meetingName,
    circuit:
      CIRCUIT_NAMES[session.circuit_short_name] ??
      CIRCUIT_NAMES[session.location] ??
      session.circuit_short_name ??
      meeting?.circuit_short_name ??
      null,
    location: session.location ?? meeting?.location ?? null,
    country: session.country_name ?? meeting?.country_name ?? null,
    date,
    year: session.year ?? Number(date.slice(0, 4)),
    round: options.round,
    generated_at: nowIso(),
    grid_m: GRID_M,
    segment_m: SEGMENT_M,
    deadband_s: DEADBAND_S,
    track: {
      length_m: round(trackLength, 1),
      points: points10,
      sector_marks_m: marks.map((m) => Math.round(m)),
    },
    drivers: built.map((row) => row.record),
    analysis: {
      lap_rule: 'fastest lap with validated speed + position telemetry',
      position_hz: round(medianIntervalHz(geometry.loc.samples), 1),
      note: 'Spatial split derived from GPS speed; indicative, not timing-grade.',
      reference_driver_number: reference.driver.driver_number,
      reference_location_gaps: reference.locGapCount ?? 0,
      gps_length_m: round(geometry.c5.gps_length_m, 1),
      field_median_gps_m: round(gpsMedian, 1),
      start_residual_m: round(geometry.startResidualM, 2),
      start_sample_gap_s: geometry.startSampleGapS == null ? null : round(geometry.startSampleGapS, 3),
      pre_scale_shortfall_pct: round(referenceRecord.preScaleShortfallPct, 2),
      reference_scale_factor: round(referenceRecord.bins.scale, 5),
      scale_note: 'Each lap is scaled from its pre-scale GPS integral to its official lap time; per-driver factor is persisted.',
      valid_drivers: built.length,
      candidates_tried: candidateAttempts,
      null_bins_reference: referenceRecord.record.dt.filter((v) => v == null).length,
      dt_null_rule: 'null dt bins are excluded from sums; sum(dt) < lap_time when nulls exist',
    },
  };

  // Calibration read-out: Leclerc vs Verstappen sector deltas at the shared marks.
  const lec = race.drivers.find((d) => d.number === 16);
  const ver = race.drivers.find((d) => d.number === 3);
  if (lec && ver) {
    const lecRow = built.find((row) => row.record.number === 16);
    const verRow = built.find((row) => row.record.number === 3);
    const estLec = sectorTimes(lecRow.dtAll, marks);
    const estVer = sectorTimes(verRow.dtAll, marks);
    const official = lec.sectors.map((s, i) => s - ver.sectors[i]);
    const estimated = estLec.map((s, i) => s - estVer[i]);
    // The assessment's calibration table used each driver's own sector
    // boundaries; keep that variant for a like-for-like comparison.
    const lecOwn = sectorTimes(lecRow.dtAll, sectorMarks(lecRow.dtAll, lec.sectors));
    const verOwn = sectorTimes(verRow.dtAll, sectorMarks(verRow.dtAll, ver.sectors));
    const estimatedOwn = lecOwn.map((s, i) => s - verOwn[i]);
    log(
      `  LEC/VER sector delta shared marks [${estimated.map((v) => v.toFixed(3)).join(', ')}] ` +
        `own bounds [${estimatedOwn.map((v) => v.toFixed(3)).join(', ')}] ` +
        `official [${official.map((v) => v.toFixed(3)).join(', ')}] ` +
        `error shared [${estimated.map((v, i) => (v - official[i]).toFixed(3)).join(', ')}] ` +
        `own [${estimatedOwn.map((v, i) => (v - official[i]).toFixed(3)).join(', ')}]`,
    );
    race.calibration = {
      pair: '16/3',
      sector_delta_est: estimated.map((v) => round(v, 3)),
      sector_delta_official: official.map((v) => round(v, 3)),
      sector_delta_error: estimated.map((v, i) => round(v - official[i], 3)),
      sector_delta_est_own_bounds: estimatedOwn.map((v) => round(v, 3)),
      sector_delta_error_own_bounds: estimatedOwn.map((v, i) => round(v - official[i], 3)),
      sectors_est_16: estLec.map((v) => round(v, 3)),
      sectors_est_3: estVer.map((v) => round(v, 3)),
    };
  }

  const raceFile = path.join(options.outDir, 'races', `${sessionKey}.json`);
  await writeJsonAtomic(raceFile, race, false);
  const raceBytes = (await stat(raceFile)).size;
  const raceMs = Date.now() - raceStartedAt;

  log(
    `race ${sessionKey}: wrote ${raceFile} (${(raceBytes / 1024).toFixed(1)} KB) ` +
      `${built.length} drivers in ${(raceMs / 1000).toFixed(1)}s`,
  );

  return {
    race,
    raceFile,
    raceBytes,
    raceMs,
    driverCount: built.length,
    nullBins: referenceRecord.record.dt.filter((v) => v == null).length,
    preScaleShortfallPct: referenceRecord.preScaleShortfallPct,
    marks,
  };
}

async function writeJsonAtomic(file, value, pretty = false) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function sha256File(file) {
  const data = await readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

function posixRelative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

async function rebuildCatalog(outDir, generatedAt) {
  const racesDir = path.join(outDir, 'races');
  const entries = await readdir(racesDir, { withFileTypes: true }).catch(() => []);
  const races = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(racesDir, entry.name);
    try {
      const race = JSON.parse(await readFile(file, 'utf8'));
      races.push({
        session_key: race.session_key,
        name: race.name,
        circuit: race.circuit,
        location: race.location,
        country: race.country,
        date: race.date,
        year: race.year,
        round: race.round,
        driver_count: Array.isArray(race.drivers) ? race.drivers.length : 0,
        file: posixRelative(file),
      });
    } catch (error) {
      log(`warning: cannot read race file ${file}: ${error.message}`);
    }
  }
  races.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.session_key - b.session_key);
  const catalog = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    source: {
      name: 'OpenF1',
      url: 'https://openf1.org/',
      licence: 'CC BY-NC-SA 4.0',
      unofficial: true,
    },
    races,
  };
  const catalogFile = path.join(outDir, 'catalog.json');
  await writeJsonAtomic(catalogFile, catalog, true);
  return { catalog, catalogFile };
}

async function writeManifest(outDir, stats, generatedAt, buildSeconds) {
  const files = [];
  const catalogFile = path.join(outDir, 'catalog.json');
  files.push(catalogFile);
  const racesDir = path.join(outDir, 'races');
  const entries = await readdir(racesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) files.push(path.join(racesDir, entry.name));
  }
  files.sort();
  const outputs = [];
  for (const file of files) {
    outputs.push({
      path: posixRelative(file),
      sha256: await sha256File(file),
      bytes: (await stat(file)).size,
    });
  }
  let gitSha = null;
  try {
    gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    gitSha = null;
  }
  const manifest = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    as_of: generatedAt,
    git_sha: gitSha,
    build_script: BUILD_SCRIPT,
    request_count: stats.requests + stats.cacheHits,
    network_requests: stats.requests,
    cache_hits: stats.cacheHits,
    retries: stats.retries,
    not_found: stats.notFound,
    build_seconds: round(buildSeconds, 1),
    files: outputs,
  };
  const manifestFile = path.join(outDir, 'manifest.json');
  await writeJsonAtomic(manifestFile, manifest, true);
  return { manifest, manifestFile, outputs };
}

let fetchClient;
let candidateAttempts = 0;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionArg = args.session != null ? Number(args.session) : null;
  const sessionsArg =
    args.sessions != null
      ? String(args.sessions)
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => value !== 0)
      : null;
  const yearArg = args.year != null ? Number(args.year) : null;
  const limit = args.limit != null ? Number(args.limit) : null;
  const delayMs = args.delay != null ? Number(args.delay) : 2200;
  const outDir = path.resolve(ROOT, args.out ?? 'data');

  if (sessionArg != null && !Number.isFinite(sessionArg)) throw new Error('--session must be a number');
  if (sessionsArg != null && (sessionsArg.length === 0 || sessionsArg.some((v) => !Number.isFinite(v)))) {
    throw new Error('--sessions must be a comma-separated list of numbers');
  }
  if (sessionArg != null && sessionsArg != null) throw new Error('use either --session or --sessions');
  if (yearArg != null && !Number.isFinite(yearArg)) throw new Error('--year must be a number');
  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) throw new Error('--limit must be positive');
  if (!(delayMs >= 0)) throw new Error('--delay must be >= 0');

  fetchClient = createClient({
    cacheDir: CACHE_DIR,
    delayMs,
    force: Boolean(args.force),
    log,
  });

  const explicitSessions = sessionsArg ?? (sessionArg != null ? [sessionArg] : null);
  log(
    `starting build (${explicitSessions ? `sessions ${explicitSessions.join(',')}` : `year ${yearArg ?? 2026}`}, ` +
      `out ${posixRelative(outDir)}, delay ${delayMs} ms${args.force ? ', force' : ''})`,
  );

  const primary = await fetchClient.getJson(
    'sessions',
    sessionArg != null && sessionsArg == null
      ? { session_key: sessionArg }
      : { year: yearArg ?? 2026 },
  );
  if (!Array.isArray(primary) || primary.length === 0) {
    throw new Error(sessionArg != null ? `session ${sessionArg} not found` : 'no sessions returned');
  }
  const year = yearArg ?? Number(primary[0].year);
  const yearSessions =
    sessionArg != null && sessionsArg == null
      ? await fetchClient.getJson('sessions', { year })
      : primary;
  const meetings = await fetchClient.getJson('meetings', { year });
  const meetingByKey = new Map((meetings ?? []).map((m) => [m.meeting_key, m]));

  const allRaces = yearSessions
    .filter((session) => session.session_name === 'Race')
    .filter((session) => !session.is_cancelled)
    .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
  const roundByKey = new Map(allRaces.map((session, index) => [session.session_key, index + 1]));

  let targets;
  if (explicitSessions) {
    const found = new Map(yearSessions.map((session) => [session.session_key, session]));
    const missing = explicitSessions.filter((key) => !found.has(key));
    if (missing.length > 0) throw new Error(`sessions not found in ${year}: ${missing.join(',')}`);
    targets = explicitSessions.map((key) => found.get(key));
  } else {
    const now = Date.now();
    targets = allRaces.filter((session) => Date.parse(session.date_start) <= now);
  }
  targets = targets.slice(0, limit ?? targets.length);
  if (targets.length === 0) throw new Error('no started races selected');
  log(`calendar: ${allRaces.length} non-cancelled Grands Prix; building ${targets.length} race(s)`);

  let built = 0;
  const results = [];
  for (const session of targets) {
    const round = roundByKey.get(session.session_key) ?? null;
    const meeting = meetingByKey.get(session.meeting_key);
    log(
      `\n=== round ${round ?? '?'} ${session.location ?? ''} (${session.session_key}) ` +
        `${meeting?.meeting_name ?? ''} ===`,
    );
    const result = await buildRace(session, meeting, { round, outDir });
    if (result) {
      built += 1;
      results.push(result);
    }
  }

  if (built === 0) {
    throw new Error(`no races built (${targets.length} requested)`);
  }
  const generatedAt = nowIso();
  const { catalog } = await rebuildCatalog(outDir, generatedAt);
  const buildSeconds = (Date.now() - startedAt) / 1000;
  const { manifest, outputs } = await writeManifest(outDir, fetchClient.stats, generatedAt, buildSeconds);

  log(
    `\ndone: ${built}/${targets.length} races, ${catalog.races.length} in catalog, ` +
      `${fetchClient.stats.requests + fetchClient.stats.cacheHits} requests ` +
      `(${fetchClient.stats.requests} network + ${fetchClient.stats.cacheHits} cache), ` +
      `${buildSeconds.toFixed(1)}s`,
  );
  for (const result of results) {
    log(
      `  ${result.race.session_key}: ${(result.raceBytes / 1024).toFixed(1)} KB, ` +
        `${result.driverCount} drivers, ${result.nullBins} null ref bins, ` +
        `pre-scale shortfall ${result.preScaleShortfallPct.toFixed(2)}%`,
    );
  }

  if (built < targets.length) {
    process.exitCode = 1;
    log(`ERROR: only ${built}/${targets.length} requested races succeeded`);
  }

  console.log(
    JSON.stringify(
      {
        built,
        requested: targets.length,
        races: results.map((r) => ({
          session_key: r.race.session_key,
          name: r.race.name,
          file: posixRelative(r.raceFile),
          bytes: r.raceBytes,
          size_kb: round(r.raceBytes / 1024, 1),
          drivers: r.driverCount,
          null_bins_reference: r.nullBins,
          pre_scale_shortfall_pct: round(r.preScaleShortfallPct, 2),
          build_seconds: round(r.raceMs / 1000, 1),
          sector_marks_m: r.race.track.sector_marks_m,
          calibration: r.race.calibration ?? null,
        })),
        catalog: posixRelative(path.join(outDir, 'catalog.json')),
        manifest: posixRelative(path.join(outDir, 'manifest.json')),
        request_count: fetchClient.stats.requests + fetchClient.stats.cacheHits,
        network_requests: fetchClient.stats.requests,
        cache_hits: fetchClient.stats.cacheHits,
        build_seconds: round(buildSeconds, 1),
        outputs,
      },
      null,
      2,
    ),
  );
}

const isMain =
  process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    log(`FATAL: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
