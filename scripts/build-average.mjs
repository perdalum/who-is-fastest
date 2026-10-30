#!/usr/bin/env node
/**
 * Add an "average of clean laps" profile to each curated race.
 *
 * The fastest-lap build intentionally fetches only the selected lap. This
 * companion build reads whole-session position/speed streams once per driver
 * and averages every clean lap onto the same shared centreline, so the client
 * can switch between "fastest lap" and "average race pace" without inventing a
 * spatial profile from official sector times.
 *
 * Clean lap rule: valid sectors, not a pit-out lap, and within 110% of the
 * driver's median lap. Pit-in/traffic/SC laps therefore do not drag the mean
 * down. The count and exclusion rule are persisted with the data.
 *
 * Run: node scripts/build-average.mjs [--force] [--delay 2200] [--sessions ...]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  buildCenterline,
  interpolateAtTime,
  interpolateXYAtTime,
  median,
  projectToCenterline,
  speedBins,
  toSeconds
} from './lib/telemetry.mjs';
import { createClient } from './lib/openf1.mjs';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const RACES = path.join(DATA, 'races');
const CACHE_DIR = path.join(ROOT, 'tmp', 'cache', 'openf1');
const GAP_S = 0.6;
const MAX_GAP_PCT = 15;
const MIN_LAP_COVERAGE_PCT = 60;
const OUTLIER_FACTOR = 1.10;

function parseArgs(argv) {
  const args = { force: false, delay: 2200, sessions: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--delay') args.delay = Number(argv[++i]);
    else if (a === '--sessions') args.sessions = String(argv[++i]).split(',').map((v) => v.trim()).filter(Boolean);
    else throw new Error(`unknown option: ${a}`);
  }
  if (!Number.isFinite(args.delay) || args.delay < 0) throw new Error('--delay must be >= 0');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const client = createClient({ cacheDir: CACHE_DIR, delayMs: args.delay, log: (m) => console.log(m) });
const startedAt = Date.now();
const round = (v, d = 3) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const log = (m) => console.log(`[average] ${m}`);

function lapHasUsableSectors(lap) {
  return [lap.duration_sector_1, lap.duration_sector_2, lap.duration_sector_3].every(
    (v) => Number.isFinite(v) && v > 0,
  );
}

function cleanLocation(rows) {
  return (Array.isArray(rows) ? rows : [])
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

function cleanCarData(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => p && Number.isFinite(Number(p.speed)) && Number(p.speed) > 0)
    .map((p) => ({ t: toSeconds(p.date), speed: Number(p.speed) }))
    .sort((a, b) => a.t - b.t);
}

function timeGaps(samples, t0, t1, gapS = GAP_S) {
  const inside = samples.filter((p) => p.t >= t0 && p.t <= t1);
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

function profileForLap(lap, samples, car, geometry) {
  const t0 = toSeconds(lap.date_start);
  const t1 = t0 + Number(lap.lap_duration);
  const inside = samples.filter((p) => p.t > t0 && p.t < t1);
  if (inside.length < 2) throw new Error('no position samples inside lap');
  const start = interpolateXYAtTime(samples, t0);
  const end = interpolateXYAtTime(samples, t1);
  if (!start || !end) throw new Error('could not interpolate lap endpoints');
  const points = [{ t: t0, x: start.x, y: start.y }, ...inside, { t: t1, x: end.x, y: end.y }];
  const vStart = interpolateAtTime(car, t0, 'speed');
  const vEnd = interpolateAtTime(car, t1, 'speed');
  if (!Number.isFinite(vStart) || !Number.isFinite(vEnd)) throw new Error('no speed at lap endpoints');
  const profile = [{ t: t0, s: 0, v: vStart }];
  const projectionState = { lastIndex: 0 };
  for (const sample of car) {
    if (sample.t <= t0 || sample.t >= t1) continue;
    const xy = interpolateXYAtTime(samples, sample.t);
    if (!xy) continue;
    const projection = projectToCenterline(geometry.points, xy, projectionState, 30);
    if (projection) profile.push({ t: sample.t, s: projection.s, v: sample.speed });
  }
  profile.push({ t: t1, s: geometry.length_m, v: vEnd });

  const extraGapRanges = [];
  for (const [a, b] of timeGaps(samples, t0, t1)) {
    const sa = sAtTime(profile, a);
    const sb = sAtTime(profile, b);
    if (sa != null && sb != null) extraGapRanges.push([sa, sb]);
  }
  const bins = speedBins(profile, geometry.length_m, lap.lap_duration, {
    gapS: GAP_S,
    maxAffectedPct: MAX_GAP_PCT,
    extraGapRanges,
  });
  bins.reasons = bins.reasons || [];
  const topSpeed = Math.max(...car.filter((p) => p.t >= t0 && p.t <= t1).map((p) => p.speed));
  return { bins, topSpeed: Number.isFinite(topSpeed) ? topSpeed : null };
}

function averageLaps(profiles, avgLapTime) {
  if (profiles.length === 0) return null;
  const n5 = profiles[0].bins.dt5.length;
  const sums = new Array(n5).fill(0);
  const counts = new Array(n5).fill(0);
  for (const profile of profiles) {
    for (let i = 0; i < n5; i += 1) {
      const value = profile.bins.dt5[i];
      if (Number.isFinite(value)) {
        sums[i] += value;
        counts[i] += 1;
      }
    }
  }
  const avg5 = sums.map((sum, i) => (counts[i] ? sum / counts[i] : null));
  const finiteTotal = avg5.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
  const scale = finiteTotal > 0 ? avgLapTime / finiteTotal : 0;
  const scaled5 = avg5.map((v) => (Number.isFinite(v) ? v * scale : null));
  const dt = [];
  for (let i = 0; i < n5; i += 5) {
    const end = Math.min(n5, i + 5);
    let sum = 0;
    let isNull = false;
    for (let j = i; j < end; j += 1) {
      if (!Number.isFinite(scaled5[j])) isNull = true;
      else sum += scaled5[j];
    }
    dt.push(isNull ? null : sum);
  }
  const covered = dt.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
  const coveragePct = Math.max(0, Math.min(100, (covered / avgLapTime) * 100));
  return { dt, scale, coveragePct, covered };
}

async function buildOne(raceFile) {
  const race = JSON.parse(await readFile(raceFile, 'utf8'));
  const session = race.session_key;
  if (!args.force && race.drivers.every((d) => d.average)) {
    log(`race ${session}: average already present; use --force to rebuild`);
    return race;
  }

  const laps = await client.getJson('laps', { session_key: session });
  if (!Array.isArray(laps) || laps.length === 0) throw new Error(`race ${session}: no laps`);
  const lapsByDriver = new Map();
  for (const lap of laps) {
    if (!(Number(lap.lap_duration) > 0) || !lapHasUsableSectors(lap) || lap.is_pit_out_lap) continue;
    if (!lapsByDriver.has(lap.driver_number)) lapsByDriver.set(lap.driver_number, []);
    lapsByDriver.get(lap.driver_number).push(lap);
  }

  const points = race.track.points.map(([x, y]) => ({ x, y }));
  const centerline = buildCenterline(points, 5);
  const geometry = { points: centerline.points, length_m: centerline.length_m };

  let processed = 0;
  for (const driver of race.drivers) {
    const candidates = lapsByDriver.get(driver.number) || [];
    if (candidates.length === 0) {
      log(`  ${driver.acronym}: no clean lap rows`);
      continue;
    }
    const medianLap = median(candidates.map((l) => Number(l.lap_duration)));
    const clean = candidates.filter((l) => Number(l.lap_duration) <= medianLap * OUTLIER_FACTOR);
    if (clean.length === 0) continue;

    const rawLocation = await client.getJson('location', { session_key: session, driver_number: driver.number });
    const rawCar = await client.getJson('car_data', { session_key: session, driver_number: driver.number });
    const location = cleanLocation(rawLocation);
    const car = cleanCarData(rawCar);
    if (location.length < 2 || car.length < 2) {
      log(`  ${driver.acronym}: no usable whole-session streams`);
      continue;
    }

    const profiles = [];
    const usedLaps = [];
    for (const lap of clean) {
      try {
        const result = profileForLap(lap, location, car, geometry);
        if (result.bins.rejected || result.bins.coveragePct < MIN_LAP_COVERAGE_PCT) continue;
        profiles.push(result);
        usedLaps.push(lap);
      } catch {
        // A single bad lap must not discard the driver's average.
      }
      processed += 1;
    }
    if (profiles.length === 0) {
      log(`  ${driver.acronym}: no lap produced a usable profile`);
      continue;
    }
    const avgLapTime = usedLaps.reduce((acc, l) => acc + Number(l.lap_duration), 0) / usedLaps.length;
    const avg = averageLaps(profiles, avgLapTime);
    const sectors = [1, 2, 3].map((n) => {
      const sum = usedLaps.reduce((acc, l) => acc + Number(l[`duration_sector_${n}`]), 0);
      return round(sum / usedLaps.length, 3);
    });
    const topSpeed = Math.max(...profiles.map((p) => (Number.isFinite(p.topSpeed) ? p.topSpeed : 0)));
    driver.average = {
      lap_time: round(avgLapTime, 3),
      sectors,
      top_speed: topSpeed > 0 ? Math.round(topSpeed) : null,
      coverage_pct: round(avg.coveragePct, 1),
      lap_count: usedLaps.length,
      lap_numbers: usedLaps.map((l) => l.lap_number),
      scale_factor: round(avg.scale, 5),
      dt: avg.dt.map((v) => (Number.isFinite(v) ? round(v, 4) : null)),
    };
    log(
      `  ${driver.acronym}: ${usedLaps.length}/${clean.length} clean laps, ` +
        `avg ${avgLapTime.toFixed(3)}s, coverage ${avg.coveragePct.toFixed(1)}%`,
    );
  }

  const withAverage = race.drivers.filter((d) => d.average).length;
  if (withAverage < 2) throw new Error(`race ${session}: only ${withAverage} drivers have an average`);
  race.average_rule = {
    label: 'Average of clean laps',
    lap_rule: `valid sectors, not pit-out, within ${Math.round(OUTLIER_FACTOR * 100)}% of driver median`,
    min_lap_coverage_pct: MIN_LAP_COVERAGE_PCT,
    note: 'Official lap and sector means; spatial profile is the mean of each lap normalised to its own official time.',
  };
  await writeJsonAtomic(raceFile, race);
  log(`race ${session}: wrote averages for ${withAverage} drivers (${processed} lap windows)`);
  return race;
}

async function writeJsonAtomic(file, value, pretty = false) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
  await rename(tmp, file);
}

async function digest(file) {
  const buf = await readFile(file);
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

async function updateManifest() {
  const files = ['data/catalog.json'];
  const racesDir = await readDirSorted(RACES);
  for (const name of racesDir) if (name.endsWith('.json')) files.push(`data/races/${name}`);
  files.push('data/manifest.json');
  const entries = [];
  for (const rel of files) {
    if (rel === 'data/manifest.json') continue;
    const file = path.join(ROOT, rel);
    entries.push({ path: rel, ...(await digest(file)) });
  }
  let previous = {};
  try { previous = JSON.parse(await readFile(path.join(DATA, 'manifest.json'), 'utf8')); } catch {}
  const builtAt = new Date().toISOString();
  const manifest = {
    schema_version: previous.schema_version ?? 1,
    as_of: previous.as_of ?? previous.generated_at ?? builtAt,
    generated_at: previous.generated_at ?? builtAt,
    git_sha: gitSha(),
    build_script: previous.build_script ?? 'scripts/build-data.mjs',
    build_seconds: previous.build_seconds ?? 0,
    grid_m: previous.grid_m ?? 25,
    segment_m: previous.segment_m ?? 100,
    deadband_s: previous.deadband_s ?? 0.03,
    // The fastest-lap build owns the dataset request audit. Average profiles
    // are an additive rebuild with their own counters, so they do not inflate
    // the base build's request count.
    request_count: previous.request_count ?? 0,
    network_requests: previous.network_requests ?? 0,
    cache_hits: previous.cache_hits ?? 0,
    average_build: {
      built_at: builtAt,
      request_count: client.stats.requests,
      cache_hits: client.stats.cacheHits,
      errors: client.stats.errors,
    },
    files: entries,
  };
  await writeJsonAtomic(path.join(DATA, 'manifest.json'), manifest);
  log(`manifest: ${entries.length} files, ${client.stats.requests} network requests`);
}

async function readDirSorted(dir) {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(dir)).sort();
}

function gitSha() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

async function main() {
  const catalog = JSON.parse(await readFile(path.join(DATA, 'catalog.json'), 'utf8'));
  let races = catalog.races;
  if (args.sessions) {
    races = races.filter((r) => args.sessions.includes(String(r.session_key)));
    if (races.length !== args.sessions.length) throw new Error('one or more sessions not in catalog');
  }
  for (const entry of races) {
    const race = await buildOne(path.join(ROOT, entry.file));
    entry.average_available = race.drivers.every((d) => d.average);
    entry.average_drivers = race.drivers.filter((d) => d.average).length;
  }
  await writeJsonAtomic(path.join(DATA, 'catalog.json'), catalog, true);
  await updateManifest();
  log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; requests=${client.stats.requests}, cache=${client.stats.cacheHits}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
