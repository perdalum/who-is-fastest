#!/usr/bin/env node
/**
 * Independent data audit for "Who is the fastest?".
 *
 * This script is deliberately standalone: it has no npm dependencies and does
 * not import scripts/lib/telemetry.mjs or any build-pipeline helper. It reads
 * the committed JSON, re-hashes the manifest outputs, and independently
 * reconstructs one 100 m section from the cached raw OpenF1 `location` and
 * `car_data` windows.
 *
 * The only product module it imports is assets/track.js, because the audit is
 * explicitly checking the client's deadband/null behaviour. If that module is
 * unavailable the synthetic control is reported as SKIP rather than trusted.
 *
 * Usage:
 *   node tests/audit/audit.mjs
 *
 * Raw responses are read from tmp/cache/openf1 (the same cache the build uses).
 * A missing URL is fetched once, at least 2.2 s after the previous network
 * request. Nothing under data/, assets/, docs/ or scripts/ is written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const RACE_DIR = path.join(DATA_DIR, 'races');
const CACHE_DIR = path.join(ROOT, 'tmp', 'cache', 'openf1');
const REPORT_PATH = path.join(ROOT, 'tests', 'audit', 'report.json');

const GRID_M = 25;
const SEGMENT_M = 100;
const DEADBAND_S = 0.03;
const MAX_RACE_BYTES = 150 * 1024;
const RATE_LIMIT_MS = 2200;
const SECTION_INDEX = 20; // 2000-2100 m
const API_BASE = 'https://api.openf1.org/v1';

const EXPECTED_FIVE_RACES = [
  {
    session_key: 11326,
    name: 'British Grand Prix',
    circuit: 'Silverstone Circuit',
    location: 'Silverstone',
    country: 'United Kingdom',
    round: 9,
  },
  {
    session_key: 11334,
    name: 'Belgian Grand Prix',
    circuit: 'Circuit de Spa-Francorchamps',
    location: 'Spa-Francorchamps',
    country: 'Belgium',
    round: 10,
  },
  {
    session_key: 11361,
    name: 'Italian Grand Prix',
    circuit: 'Autodromo Nazionale Monza',
    location: 'Monza',
    country: 'Italy',
    round: 13,
  },
  {
    session_key: 11388,
    name: 'Singapore Grand Prix',
    circuit: 'Marina Bay Street Circuit',
    location: 'Marina Bay',
    country: 'Singapore',
    round: 17,
  },
  {
    session_key: 11396,
    name: 'United States Grand Prix',
    circuit: 'Circuit of the Americas',
    location: 'Austin',
    country: 'United States',
    round: 18,
  },
];

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const isInt = (value) => Number.isInteger(value);
const isStr = (value) => typeof value === 'string' && value.trim().length > 0;
const isHexColour = (value) => typeof value === 'string' && /^[0-9A-Fa-f]{6}$/.test(value);
const isIso = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const round3 = (value) => Math.round(value * 1000) / 1000;
const round4 = (value) => Math.round(value * 10000) / 10000;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(buffer, label) {
  try {
    return { value: JSON.parse(buffer.toString('utf8')), error: null };
  } catch (error) {
    return { value: null, error: `${label}: invalid JSON (${error.message})` };
  }
}

function pushCheck(state, id, title, errors, warnings, metrics = {}, detail = null) {
  const status = errors.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS';
  const text = detail ?? [...errors, ...warnings].slice(0, 8).join('; ');
  state.checks.push({
    id,
    title,
    status,
    detail: text || 'ok',
    errors,
    warnings,
    metrics,
  });
}

function statusOf(errors) {
  return errors.length > 0 ? 'FAIL' : 'PASS';
}

/* -------------------------------------------------------------------------- */
/* Snapshot of committed data                                                 */
/* -------------------------------------------------------------------------- */

function readDataSnapshot() {
  const catalogPath = path.join(DATA_DIR, 'catalog.json');
  const manifestPath = path.join(DATA_DIR, 'manifest.json');
  const raceNames = fs.existsSync(RACE_DIR)
    ? fs.readdirSync(RACE_DIR).filter((name) => name.endsWith('.json')).sort()
    : [];

  const catalog = fs.existsSync(catalogPath)
    ? { rel: 'data/catalog.json', abs: catalogPath, buf: fs.readFileSync(catalogPath) }
    : null;
  const manifest = fs.existsSync(manifestPath)
    ? { rel: 'data/manifest.json', abs: manifestPath, buf: fs.readFileSync(manifestPath) }
    : null;

  const raceFiles = raceNames.map((name) => {
    const abs = path.join(RACE_DIR, name);
    const buf = fs.readFileSync(abs);
    return { rel: `data/races/${name}`, abs, buf };
  });

  const parts = [];
  for (const file of [catalog, manifest, ...raceFiles]) {
    if (!file) continue;
    const stat = fs.statSync(file.abs);
    file.mtimeMs = stat.mtimeMs;
    file.size = stat.size;
    parts.push(`${file.rel}:${stat.size}:${stat.mtimeMs}`);
  }
  return { catalog, manifest, raceFiles, signature: parts.join('|') };
}

function currentSignature() {
  const parts = [];
  for (const rel of ['data/catalog.json', 'data/manifest.json']) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    parts.push(`${rel}:${stat.size}:${stat.mtimeMs}`);
  }
  if (fs.existsSync(RACE_DIR)) {
    for (const name of fs.readdirSync(RACE_DIR).filter((n) => n.endsWith('.json')).sort()) {
      const abs = path.join(RACE_DIR, name);
      const stat = fs.statSync(abs);
      parts.push(`data/races/${name}:${stat.size}:${stat.mtimeMs}`);
    }
  }
  return parts.join('|');
}

/* -------------------------------------------------------------------------- */
/* OpenF1 cache / network access                                              */
/* -------------------------------------------------------------------------- */

const rawStats = { cache: 0, network: 0, errors: 0, ms: 0 };
let lastNetworkAt = 0;

function apiUrl(endpoint, params = {}) {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${API_BASE}/${String(endpoint).replace(/^\/+/, '')}${query ? `?${query}` : ''}`;
}

function cachePathFor(url) {
  return path.join(CACHE_DIR, `${sha256(Buffer.from(url, 'utf8'))}.json`);
}

async function fetchJson(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wait = RATE_LIMIT_MS - (Date.now() - lastNetworkAt);
    if (wait > 0) await sleep(wait);
    lastNetworkAt = Date.now();
    rawStats.network += 1;
    const started = Date.now();
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      rawStats.ms += Date.now() - started;
      if (response.status === 404) return { data: [], notFound: true };
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        if (attempt === 0) continue;
        throw lastError;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
      const text = await response.text();
      rawStats.ms += Date.now() - started;
      if (!text.trim()) return { data: [] };
      return { data: JSON.parse(text) };
    } catch (error) {
      rawStats.ms += Date.now() - started;
      lastError = error;
      if (attempt === 0) await sleep(RATE_LIMIT_MS);
    }
  }
  rawStats.errors += 1;
  throw lastError ?? new Error(`fetch failed: ${url}`);
}

async function getJson(endpoint, params) {
  const url = apiUrl(endpoint, params);
  const file = cachePathFor(url);
  if (fs.existsSync(file)) {
    try {
      rawStats.cache += 1;
      return { data: JSON.parse(fs.readFileSync(file, 'utf8')), url, source: 'cache' };
    } catch (error) {
      // Corrupt cache is treated as a miss; the network path below will try.
      process.stderr.write(`[audit] unreadable cache ${path.basename(file)}: ${error.message}\n`);
    }
  }
  try {
    const { data, notFound } = await fetchJson(url);
    if (!notFound) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    }
    return { data, url, source: notFound ? 'not-found' : 'network' };
  } catch (error) {
    return { data: null, url, source: 'error', error: error.message };
  }
}

/* -------------------------------------------------------------------------- */
/* Independent geometry, projection and integration                           */
/* -------------------------------------------------------------------------- */

function cleanLocation(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
    .map((point) => ({
      t: Date.parse(point.date) / 1000,
      x: Number(point.x) / 10,
      y: Number(point.y) / 10,
      rawX: Number(point.x),
      rawY: Number(point.y),
    }))
    .filter((point) => !(point.rawX === 0 && point.rawY === 0))
    .sort((a, b) => a.t - b.t);
}

function cleanCarData(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((point) => point && Number.isFinite(Number(point.speed)) && Number(point.speed) > 0)
    .map((point) => ({ t: Date.parse(point.date) / 1000, v: Number(point.speed) }))
    .sort((a, b) => a.t - b.t);
}

function interpolateXY(samples, t) {
  if (!samples.length) return null;
  if (t <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  if (t >= samples[samples.length - 1].t) return { x: samples[samples.length - 1].x, y: samples[samples.length - 1].y };
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

function interpolateSpeed(samples, t) {
  if (!samples.length) return null;
  if (t <= samples[0].t) return samples[0].v;
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1].v;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  return a.v + (b.v - a.v) * f;
}

function smoothXYZ(points) {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let j = i - 1; j <= i + 1; j += 1) {
      if (j < 0 || j >= points.length) continue;
      sx += points[j].x;
      sy += points[j].y;
      count += 1;
    }
    out[i] = { ...points[i], x: sx / count, y: sy / count };
  }
  return out;
}

/** Resample a polyline at 5 m. The last complete 5 m point is retained. */
function buildCentreline(points, step = 5) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const gpsLength = cumulative[cumulative.length - 1];
  const length = Math.floor(gpsLength / step) * step;
  const out = [];
  let j = 0;
  for (let s = 0; s <= length; s += step) {
    while (j < points.length - 2 && cumulative[j + 1] < s) j += 1;
    const a = points[j];
    const b = points[j + 1] ?? points[j];
    const seg = cumulative[j + 1] - cumulative[j] || 1;
    const f = Math.max(0, Math.min(1, (s - cumulative[j]) / seg));
    out.push({ s, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return { points: out, length, gpsLength };
}

/**
 * Project one XY position onto the shared centreline. A local window keeps the
 * projection monotonic and prevents jumps to a neighbouring part of the lap.
 */
function projectToCentreline(centreline, xy, lastS) {
  const lo = lastS == null ? -Infinity : lastS - 50;
  const hi = lastS == null ? Infinity : lastS + 200;
  let best = null;
  for (let i = 1; i < centreline.points.length; i += 1) {
    const a = centreline.points[i - 1];
    const b = centreline.points[i];
    if (b.s < lo || a.s > hi) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let f = ((xy.x - a.x) * dx + (xy.y - a.y) * dy) / len2;
    f = Math.max(0, Math.min(1, f));
    const px = a.x + dx * f;
    const py = a.y + dy * f;
    const d = (xy.x - px) ** 2 + (xy.y - py) ** 2;
    const s = a.s + (b.s - a.s) * f;
    if (!best || d < best.d) best = { s, d };
  }
  if (best || lastS == null) return best;
  return projectToCentreline(centreline, xy, null);
}

function prepareBoundedLocation(raw, t0, t1) {
  const samples = cleanLocation(raw);
  if (!samples.length) return null;
  const start = interpolateXY(samples, t0);
  const end = interpolateXY(samples, t1);
  const inside = samples.filter((point) => point.t > t0 + 1e-9 && point.t < t1 - 1e-9);
  return {
    samples,
    points: [{ t: t0, x: start.x, y: start.y }, ...inside, { t: t1, x: end.x, y: end.y }],
  };
}

/**
 * Build a speed profile on the shared centreline, integrate 5 m at a time,
 * scale the lap to its official time and aggregate five 5 m steps per 25 m bin.
 * A timestamp gap > 0.6 s nulls the affected 5 m bins; nulls are never bridged.
 */
function buildIndependentProfile(lap, centreline) {
  const t0 = Date.parse(lap.date_start) / 1000;
  const t1 = t0 + Number(lap.lap_duration);
  const loc = prepareBoundedLocation(lap.__locationRaw, t0, t1);
  const car = cleanCarData(lap.__carDataRaw);
  if (!loc || !car.length) return null;

  const profile = [{ t: t0, s: 0, v: interpolateSpeed(car, t0), gap: false }];
  let lastS = 0;
  let lastT = t0;
  for (const sample of car) {
    if (sample.t <= t0 || sample.t >= t1) continue;
    const xy = interpolateXY(loc.samples, sample.t);
    if (!xy) continue;
    const projection = projectToCentreline(centreline, xy, lastS);
    if (!projection || projection.s < lastS - 5) continue;
    const gap = sample.t - lastT > 0.6;
    lastS = Math.max(lastS, projection.s);
    lastT = sample.t;
    profile.push({ t: sample.t, s: lastS, v: sample.v, gap });
  }
  profile.push({ t: t1, s: centreline.length, v: interpolateSpeed(car, t1), gap: false });

  let preScale = 0;
  const dt5 = new Array(centreline.points.length);
  let p = 0;
  for (let i = 0; i < centreline.points.length; i += 1) {
    const s0 = centreline.points[i].s;
    const s1 = i + 1 < centreline.points.length ? centreline.points[i + 1].s : centreline.length;
    const mid = (s0 + s1) / 2;
    while (p < profile.length - 2 && profile[p + 1].s < mid) p += 1;
    const a = profile[p];
    const b = profile[p + 1] ?? profile[p];
    const ds = b.s - a.s;
    const f = ds > 0 ? Math.max(0, Math.min(1, (mid - a.s) / ds)) : 0;
    const v = a.v + (b.v - a.v) * f;
    const rawValue = (s1 - s0) / (Math.max(v, 5) / 3.6);
    // The whole-lap integral is recorded before null masking, exactly as the
    // documented method does: gaps are neutralised in the output but still
    // contribute to the scale factor.
    preScale += rawValue;
    dt5[i] = a.gap || b.gap ? null : rawValue;
  }

  const scale = preScale > 0 ? Number(lap.lap_duration) / preScale : 0;
  const dt25 = [];
  for (let i = 0; i < dt5.length; i += 5) {
    let sum = 0;
    let missing = false;
    for (let j = i; j < Math.min(i + 5, dt5.length); j += 1) {
      if (dt5[j] == null) missing = true;
      else sum += dt5[j] * scale;
    }
    dt25.push(missing ? null : sum);
  }


  return {
    dt25,
    preScale,
    scale,
    shortfallPct: (1 - preScale / Number(lap.lap_duration)) * 100,
    nullBins: dt25.filter((value) => value == null).length,
    locationRows: Array.isArray(lap.__locationRaw) ? lap.__locationRaw.length : 0,
    carRows: Array.isArray(lap.__carDataRaw) ? lap.__carDataRaw.length : 0,
    gpsLength: centreline.gpsLength,
    centrelineLength: centreline.length,
  };
}

function sumSection(dt25, index) {
  const bins = dt25.slice(index * 4, index * 4 + 4);
  if (bins.length < 4 || bins.some((value) => value == null)) return null;
  return bins.reduce((sum, value) => sum + value, 0);
}

function jsonSection(driver, index) {
  return sumSection(driver.dt, index);
}

/* -------------------------------------------------------------------------- */
/* Contract validation                                                        */
/* -------------------------------------------------------------------------- */

function validateRace(race, rel, bytes, state) {
  const prefix = `dataset.race.${rel}`;
  const schemaErrors = [];
  const schemaWarnings = [];

  if (!isObj(race)) {
    pushCheck(state, `${prefix}.schema`, 'Race schema', [`${rel}: root is not an object`], [], { bytes });
    return null;
  }

  const requiredTop = [
    'schema_version', 'session_key', 'name', 'circuit', 'location', 'country', 'date',
    'year', 'round', 'generated_at', 'grid_m', 'segment_m', 'deadband_s', 'track',
    'drivers', 'analysis',
  ];
  for (const key of requiredTop) {
    if (!(key in race)) schemaErrors.push(`${rel}: missing top-level key "${key}"`);
  }
  if (race.schema_version !== 1) schemaErrors.push(`${rel}: schema_version is ${race.schema_version}, expected 1`);
  if (!isInt(race.session_key)) schemaErrors.push(`${rel}: session_key is not an integer`);
  for (const key of ['name', 'circuit', 'location', 'country']) {
    if (!isStr(race[key])) schemaErrors.push(`${rel}: ${key} is not a non-empty string`);
  }
  if (!isDate(race.date)) schemaErrors.push(`${rel}: date is not YYYY-MM-DD`);
  if (!isInt(race.year)) schemaErrors.push(`${rel}: year is not an integer`);
  if (!isInt(race.round) || race.round < 1) schemaErrors.push(`${rel}: round is not a positive integer`);
  if (!isIso(race.generated_at)) schemaErrors.push(`${rel}: generated_at is not ISO-8601`);
  if (!isObj(race.track)) schemaErrors.push(`${rel}: track is not an object`);
  if (!Array.isArray(race.drivers)) schemaErrors.push(`${rel}: drivers is not an array`);
  if (!isObj(race.analysis)) schemaErrors.push(`${rel}: analysis is not an object`);
  if (race.drivers != null && !Array.isArray(race.drivers)) schemaErrors.push(`${rel}: drivers is not an array`);

  pushCheck(state, `${prefix}.schema`, 'Race schema', schemaErrors, schemaWarnings, {
    bytes,
    session_key: race.session_key,
  });

  const constantsErrors = [];
  for (const [key, expected] of [['grid_m', GRID_M], ['segment_m', SEGMENT_M], ['deadband_s', DEADBAND_S]]) {
    if (race[key] !== expected) constantsErrors.push(`${rel}: ${key} is ${race[key]}, expected ${expected}`);
  }
  pushCheck(state, `${prefix}.constants`, 'Grid / segment / deadband constants', constantsErrors, [], {
    grid_m: race.grid_m,
    segment_m: race.segment_m,
    deadband_s: race.deadband_s,
  });

  /* Track geometry ------------------------------------------------------- */
  const trackErrors = [];
  const trackWarnings = [];
  const track = race.track;
  let lengthM = null;
  if (isObj(track)) {
    lengthM = Number(track.length_m);
    if (!isNum(track.length_m) || lengthM <= 0) trackErrors.push(`${rel}: track.length_m is not positive`);
    else if (lengthM < 2000 || lengthM > 8000) trackErrors.push(`${rel}: track.length_m ${lengthM} is outside 2-8 km`);
    if (!Array.isArray(track.points) || track.points.length < 2) {
      trackErrors.push(`${rel}: track.points has fewer than 2 points`);
    } else {
      const bad = track.points.filter((point) => !Array.isArray(point) || point.length < 2 || !isNum(point[0]) || !isNum(point[1]));
      if (bad.length) trackErrors.push(`${rel}: ${bad.length} track point(s) are not finite [x,y] pairs`);
      if (track.points.length < 50) trackWarnings.push(`${rel}: only ${track.points.length} track points`);
    }
    if (!Array.isArray(track.sector_marks_m) || track.sector_marks_m.length !== 2) {
      trackErrors.push(`${rel}: sector_marks_m must contain exactly 2 marks for 3 sectors`);
    } else {
      const marks = track.sector_marks_m;
      if (!marks.every(isNum)) trackErrors.push(`${rel}: sector_marks_m contains a non-number`);
      if (!(marks[0] > 0 && marks[0] < marks[1])) trackErrors.push(`${rel}: sector marks are not strictly ordered`);
      if (!(marks[1] < lengthM)) trackErrors.push(`${rel}: second sector mark ${marks[1]} is not below length ${lengthM}`);
      const expectedMarks = marks.map((mark) => Math.round(mark / GRID_M));
      if (expectedMarks.some((mark) => mark < 1 || mark >= Math.ceil(lengthM / GRID_M))) {
        trackErrors.push(`${rel}: sector marks map outside the dt array`);
      }
    }
  }
  pushCheck(state, `${prefix}.track`, 'Track geometry and sector marks', trackErrors, trackWarnings, {
    length_m: track?.length_m,
    points: Array.isArray(track?.points) ? track.points.length : null,
    sector_marks_m: track?.sector_marks_m,
  });

  /* Drivers -------------------------------------------------------------- */
  const drivers = Array.isArray(race.drivers) ? race.drivers : [];
  const driverErrors = [];
  const driverWarnings = [];
  const driverMetrics = { count: drivers.length, numbers: [], acronyms: [] };
  if (drivers.length < 2) driverErrors.push(`${rel}: only ${drivers.length} driver(s); at least 2 required`);

  const numbers = new Set();
  const acronyms = new Set();
  for (const [index, driver] of drivers.entries()) {
    const tag = `${rel}: driver[${index}]${driver && driver.acronym ? ` (${driver.acronym})` : ''}`;
    if (!isObj(driver)) {
      driverErrors.push(`${tag} is not an object`);
      continue;
    }
    if (!isInt(driver.number) || driver.number <= 0) driverErrors.push(`${tag}: number is not a positive integer`);
    else if (numbers.has(driver.number)) driverErrors.push(`${tag}: duplicate number ${driver.number}`);
    else numbers.add(driver.number);

    for (const key of ['acronym', 'name', 'team']) {
      if (!isStr(driver[key])) driverErrors.push(`${tag}: ${key} is not a non-empty string`);
    }
    if (isStr(driver.acronym)) {
      if (acronyms.has(driver.acronym)) driverErrors.push(`${tag}: duplicate acronym ${driver.acronym}`);
      acronyms.add(driver.acronym);
      if (!/^[A-Z0-9]{2,4}$/.test(driver.acronym)) driverWarnings.push(`${tag}: acronym ${driver.acronym} is not 2-4 uppercase characters`);
    }
    if (!isInt(driver.lap_number) || driver.lap_number <= 0) driverErrors.push(`${tag}: lap_number is not a positive integer`);
    if (!isNum(driver.lap_time) || driver.lap_time <= 0) driverErrors.push(`${tag}: lap_time is not positive`);
    if (!isInt(driver.official_best_lap) || driver.official_best_lap <= 0) driverErrors.push(`${tag}: official_best_lap is not a positive integer`);
    if (!isNum(driver.official_best_time) || driver.official_best_time <= 0) driverErrors.push(`${tag}: official_best_time is not positive`);
    if (!Array.isArray(driver.sectors) || driver.sectors.length !== 3 || !driver.sectors.every((value) => isNum(value) && value > 0)) {
      driverErrors.push(`${tag}: sectors must be three positive numbers`);
    }
    if (driver.top_speed != null && (!isNum(driver.top_speed) || driver.top_speed <= 0)) driverErrors.push(`${tag}: top_speed is neither null nor positive`);
    if (driver.top_speed != null && isNum(driver.top_speed) && (driver.top_speed < 100 || driver.top_speed > 400)) driverWarnings.push(`${tag}: top_speed ${driver.top_speed} km/h is implausible`);
    if (driver.compound != null && !isStr(driver.compound)) driverErrors.push(`${tag}: compound is neither null nor a string`);
    if (driver.tyre_age != null && (!isInt(driver.tyre_age) || driver.tyre_age < 0)) driverErrors.push(`${tag}: tyre_age is neither null nor a non-negative integer`);
    if (!isNum(driver.coverage_pct) || driver.coverage_pct < 0 || driver.coverage_pct > 100) {
      driverErrors.push(`${tag}: coverage_pct is not a number in 0-100`);
    }
    if (!Array.isArray(driver.dt)) driverErrors.push(`${tag}: dt is not an array`);
    driverMetrics.numbers.push(driver.number);
    driverMetrics.acronyms.push(driver.acronym);
  }
  pushCheck(state, `${prefix}.drivers`, 'Drivers: count, identity and fields', driverErrors, driverWarnings, driverMetrics);

  /* Colour hex ----------------------------------------------------------- */
  const colourErrors = [];
  const colourWarnings = [];
  const colours = [];
  for (const driver of drivers) {
    if (!isObj(driver)) continue;
    colours.push(driver.colour);
    if (!isHexColour(driver.colour)) {
      colourErrors.push(`${rel}: driver ${driver.acronym ?? driver.number} colour "${driver.colour}" is not 6 hex digits`);
    } else if (!/^[0-9A-F]{6}$/.test(driver.colour)) {
      colourWarnings.push(`${rel}: driver ${driver.acronym ?? driver.number} colour "${driver.colour}" is not uppercase`);
    }
  }
  pushCheck(state, `${prefix}.colour`, 'Team colours are 6-digit hex', colourErrors, colourWarnings, {
    unique: [...new Set(colours)].length,
    colours: [...new Set(colours)],
  });

  /* dt bins -------------------------------------------------------------- */
  const dtErrors = [];
  const dtWarnings = [];
  const dtMetrics = { drivers: drivers.length, lengths: [], expected: null, null_bins: 0, min: null, max: null };
  const expectedLen = lengthM && Number.isFinite(lengthM) ? Math.ceil(lengthM / GRID_M) : null;
  dtMetrics.expected = expectedLen;
  const lengths = new Set();
  for (const driver of drivers) {
    if (!isObj(driver) || !Array.isArray(driver.dt)) continue;
    const tag = `${driver.acronym ?? driver.number}`;
    lengths.add(driver.dt.length);
    dtMetrics.lengths.push({ driver: driver.number, length: driver.dt.length, nulls: driver.dt.filter((value) => value == null).length });
    if (expectedLen != null && Math.abs(driver.dt.length - expectedLen) > 1) {
      dtErrors.push(`${rel}: ${tag} dt length ${driver.dt.length}, expected ~${expectedLen} (ceil(${lengthM}/25))`);
    }
    let nulls = 0;
    for (let i = 0; i < driver.dt.length; i += 1) {
      const value = driver.dt[i];
      if (value == null) {
        nulls += 1;
        continue;
      }
      if (!isNum(value) || value <= 0) {
        dtErrors.push(`${rel}: ${tag} dt[${i}] is ${JSON.stringify(value)}, not null or a positive finite number`);
        break;
      }
      dtMetrics.min = dtMetrics.min == null ? value : Math.min(dtMetrics.min, value);
      dtMetrics.max = dtMetrics.max == null ? value : Math.max(dtMetrics.max, value);
    }
    dtMetrics.null_bins += nulls;
    const sum = driver.dt.reduce((acc, value) => acc + (isNum(value) ? value : 0), 0);
    const full = nulls === 0 && driver.dt.length > 0;
    if (full && Math.abs(sum - driver.lap_time) > 0.05) {
      dtErrors.push(`${rel}: ${tag} full-coverage dt sum ${round3(sum)} differs from lap_time ${driver.lap_time} by ${round3(sum - driver.lap_time)} s`);
    }
    if (!full && sum > driver.lap_time + 0.05) {
      dtErrors.push(`${rel}: ${tag} dt sum ${round3(sum)} exceeds lap_time ${driver.lap_time} by ${round3(sum - driver.lap_time)} s`);
    }
    if (!full) {
      dtWarnings.push(`${rel}: ${tag} has ${nulls} null dt bin(s); sum ${round3(sum)} s is ${round3(driver.lap_time - sum)} s below lap_time (null-rule, not bridged)`);
    }
    if (!Number.isFinite(driver.lap_time) || driver.lap_time <= 0) continue;
    const impliedCoverage = (driver.dt.length - nulls) / Math.max(1, driver.dt.length) * 100;
    if (isNum(driver.coverage_pct) && Math.abs(driver.coverage_pct - impliedCoverage) > 10) {
      dtWarnings.push(`${rel}: ${tag} coverage_pct ${driver.coverage_pct} differs from non-null bin share ${round3(impliedCoverage)} by >10 pp`);
    }
  }
  if (lengths.size > 1) dtErrors.push(`${rel}: drivers have different dt lengths (${[...lengths].join(', ')})`);
  if (drivers.length >= 2 && drivers.every((driver) => Array.isArray(driver.dt) && driver.dt.every((value) => value == null))) {
    dtErrors.push(`${rel}: no driver has any non-null dt bin`);
  }
  pushCheck(state, `${prefix}.dt`, 'dt length, nulls and positive finite values', dtErrors, dtWarnings, dtMetrics);

  /* Coverage ------------------------------------------------------------- */
  const coverageErrors = [];
  const coverageWarnings = [];
  const below97 = [];
  for (const driver of drivers) {
    if (!isObj(driver) || !isNum(driver.coverage_pct)) continue;
    if (driver.coverage_pct < 0 || driver.coverage_pct > 100) {
      coverageErrors.push(`${rel}: ${driver.acronym ?? driver.number} coverage_pct ${driver.coverage_pct} outside 0-100`);
    }
    if (driver.coverage_pct < 97) below97.push({ driver: driver.acronym ?? driver.number, coverage_pct: driver.coverage_pct });
  }
  if (below97.length) {
    coverageWarnings.push(`${rel}: ${below97.length}/${drivers.length} drivers have coverage_pct < 97 (docs/03 §9 threshold); range ${Math.min(...below97.map((row) => row.coverage_pct))}-${Math.max(...below97.map((row) => row.coverage_pct))}`);
  }
  pushCheck(state, `${prefix}.coverage`, 'Coverage is within 0-100', coverageErrors, coverageWarnings, {
    min: drivers.length ? Math.min(...drivers.map((driver) => (isNum(driver.coverage_pct) ? driver.coverage_pct : NaN)).filter(Number.isFinite)) : null,
    max: drivers.length ? Math.max(...drivers.map((driver) => (isNum(driver.coverage_pct) ? driver.coverage_pct : NaN)).filter(Number.isFinite)) : null,
    below_97: below97,
  });

  /* Official facts and sectors ------------------------------------------- */
  const officialErrors = [];
  const officialWarnings = [];
  const sectorErrors = [];
  for (const driver of drivers) {
    if (!isObj(driver)) continue;
    const tag = `${driver.acronym ?? driver.number}`;
    if (Array.isArray(driver.sectors) && driver.sectors.length === 3 && driver.sectors.every(isNum) && isNum(driver.lap_time)) {
      const sum = driver.sectors.reduce((acc, value) => acc + value, 0);
      if (Math.abs(sum - driver.lap_time) > 0.1) {
        sectorErrors.push(`${rel}: ${tag} sectors sum ${round3(sum)} differs from lap_time ${driver.lap_time} by ${round3(sum - driver.lap_time)} s (>0.1)`);
      }
    }
    if (isNum(driver.official_best_time) && isNum(driver.lap_time) && driver.official_best_time > driver.lap_time + 1e-6) {
      officialErrors.push(`${rel}: ${tag} official_best_time ${driver.official_best_time} is slower than chosen lap_time ${driver.lap_time}`);
    }
    if (driver.official_best_lap === driver.lap_number && isNum(driver.official_best_time) && isNum(driver.lap_time) && Math.abs(driver.official_best_time - driver.lap_time) > 0.001) {
      officialErrors.push(`${rel}: ${tag} official_best_lap equals lap_number but times differ (${driver.official_best_time} vs ${driver.lap_time})`);
    }
    if (driver.official_best_lap !== driver.lap_number) {
      officialWarnings.push(`${rel}: ${tag} chosen lap ${driver.lap_number} is not official best lap ${driver.official_best_lap} (telemetry-limited; expected badge)`);
    }
  }
  pushCheck(state, `${prefix}.official`, 'Official best fields and sector sum', [...officialErrors, ...sectorErrors], officialWarnings, {
    sector_max_error: drivers.length
      ? Math.max(...drivers.map((driver) => (Array.isArray(driver.sectors) && driver.sectors.length === 3 && isNum(driver.lap_time)
        ? Math.abs(driver.sectors.reduce((acc, value) => acc + value, 0) - driver.lap_time)
        : 0)))
      : null,
    telemetry_limited: drivers.filter((driver) => driver.official_best_lap !== driver.lap_number).length,
  });

  /* Analysis / calibration ----------------------------------------------- */
  const analysisErrors = [];
  const analysisWarnings = [];
  const analysis = race.analysis;
  const analysisMetrics = {};
  if (isObj(analysis)) {
    const refNumber = analysis.reference_driver_number;
    const refDriver = drivers.find((driver) => driver.number === refNumber);
    if (!refDriver) analysisErrors.push(`${rel}: reference_driver_number ${refNumber} is not a driver`);
    const fastest = drivers.reduce((best, driver) => (!best || driver.lap_time < best.lap_time ? driver : best), null);
    analysisMetrics.reference_driver_number = refNumber;
    analysisMetrics.fastest_driver_number = fastest?.number ?? null;
    if (refDriver && fastest && refDriver.number !== fastest.number) {
      analysisWarnings.push(`${rel}: reference driver ${refNumber} is not the fastest lap (${fastest.number}, ${fastest.lap_time}s); docs/03 §4 step 5 says fastest valid lap`);
    }
    if (isNum(analysis.gps_length_m) && lengthM) {
      const deviation = Math.abs(analysis.gps_length_m - lengthM) / lengthM * 100;
      analysisMetrics.gps_vs_track_pct = round3(deviation);
      if (deviation > 5) analysisWarnings.push(`${rel}: analysis.gps_length_m ${analysis.gps_length_m} differs from track.length_m ${lengthM} by ${round3(deviation)}%`);
    }
    if (isNum(analysis.pre_scale_shortfall_pct)) {
      analysisMetrics.pre_scale_shortfall_pct = analysis.pre_scale_shortfall_pct;
      if (analysis.pre_scale_shortfall_pct < 1 || analysis.pre_scale_shortfall_pct > 2) {
        analysisWarnings.push(`${rel}: pre_scale_shortfall_pct ${analysis.pre_scale_shortfall_pct} is outside the expected 1-2% sanity band`);
      }
    }
    if (isInt(analysis.valid_drivers) && analysis.valid_drivers !== drivers.length) {
      analysisWarnings.push(`${rel}: analysis.valid_drivers ${analysis.valid_drivers} differs from drivers.length ${drivers.length}`);
    }
    if (isInt(analysis.null_bins_reference) && refDriver) {
      const nulls = refDriver.dt.filter((value) => value == null).length;
      analysisMetrics.reference_nulls = nulls;
      if (analysis.null_bins_reference !== nulls) {
        analysisWarnings.push(`${rel}: analysis.null_bins_reference ${analysis.null_bins_reference} differs from ${refDriver.acronym} nulls ${nulls}`);
      }
    }
  } else {
    analysisErrors.push(`${rel}: analysis object missing`);
  }

  const calibration = race.calibration;
  if (isObj(calibration)) {
    const est = calibration.sector_delta_est;
    const official = calibration.sector_delta_official;
    const error = calibration.sector_delta_error;
    if (!Array.isArray(est) || est.length !== 3 || !est.every(isNum)) analysisErrors.push(`${rel}: calibration.sector_delta_est is not three numbers`);
    if (!Array.isArray(official) || official.length !== 3 || !official.every(isNum)) analysisErrors.push(`${rel}: calibration.sector_delta_official is not three numbers`);
    if (!Array.isArray(error) || error.length !== 3 || !error.every(isNum)) analysisErrors.push(`${rel}: calibration.sector_delta_error is not three numbers`);
    if (Array.isArray(est) && Array.isArray(official) && Array.isArray(error) && est.length === 3 && official.length === 3 && error.length === 3) {
      for (let i = 0; i < 3; i += 1) {
        if (Math.abs((est[i] - official[i]) - error[i]) > 0.002) {
          analysisErrors.push(`${rel}: calibration error[${i}] ${error[i]} does not equal est-official ${round3(est[i] - official[i])}`);
        }
      }
      const maxError = Math.max(...error.map((value) => Math.abs(value)));
      analysisMetrics.calibration_max_error = round3(maxError);
      if (maxError > 0.2) analysisErrors.push(`${rel}: calibration max sector-delta error ${round3(maxError)} s exceeds 0.20 s`);
    }
    if (calibration.pair && calibration.pair !== '16/3') analysisWarnings.push(`${rel}: calibration pair is ${calibration.pair}, expected 16/3`);
  } else {
    analysisWarnings.push(`${rel}: calibration block missing; sector-delta acceptance cannot be checked`);
  }
  pushCheck(state, `${prefix}.analysis`, 'Reference lap, pre-scale integral and calibration', analysisErrors, analysisWarnings, analysisMetrics);

  /* File size ------------------------------------------------------------ */
  const sizeErrors = [];
  if (bytes > MAX_RACE_BYTES) sizeErrors.push(`${rel}: ${bytes} bytes exceeds 150 KB (${MAX_RACE_BYTES} bytes)`);
  pushCheck(state, `${prefix}.size`, 'Race file size under 150 KB', sizeErrors, [], {
    bytes,
    limit_bytes: MAX_RACE_BYTES,
    kb: round3(bytes / 1024),
  });

  return race;
}

/* -------------------------------------------------------------------------- */
/* Catalog and manifest                                                       */
/* -------------------------------------------------------------------------- */

function validateCatalog(state, snapshot, parsedRaces) {
  const errors = [];
  const warnings = [];
  const catalogParsed = snapshot.catalog ? parseJson(snapshot.catalog.buf, 'data/catalog.json') : { value: null, error: 'data/catalog.json is missing' };
  const catalog = catalogParsed.value;
  if (catalogParsed.error) errors.push(catalogParsed.error);
  if (isObj(catalog)) {
    if (catalog.schema_version !== 1) errors.push(`catalog: schema_version is ${catalog.schema_version}, expected 1`);
    if (!isIso(catalog.generated_at)) errors.push('catalog: generated_at is not ISO-8601');
    if (!isObj(catalog.source)) {
      errors.push('catalog: source is missing');
    } else {
      if (catalog.source.name !== 'OpenF1') errors.push(`catalog: source.name is ${catalog.source.name}`);
      if (catalog.source.url !== 'https://openf1.org/') errors.push(`catalog: source.url is ${catalog.source.url}`);
      if (catalog.source.licence !== 'CC BY-NC-SA 4.0') errors.push(`catalog: source.licence is ${catalog.source.licence}`);
      if (catalog.source.unofficial !== true) errors.push('catalog: source.unofficial is not true');
    }
    if (!Array.isArray(catalog.races)) errors.push('catalog: races is not an array');
    const keys = new Set();
    for (const [index, entry] of (Array.isArray(catalog.races) ? catalog.races : []).entries()) {
      const tag = `catalog.races[${index}]`;
      if (!isObj(entry)) {
        errors.push(`${tag} is not an object`);
        continue;
      }
      for (const key of ['session_key', 'name', 'circuit', 'location', 'country', 'date', 'year', 'round', 'driver_count', 'file']) {
        if (!(key in entry)) errors.push(`${tag}: missing ${key}`);
      }
      if (!isInt(entry.session_key)) errors.push(`${tag}: session_key is not an integer`);
      if (keys.has(entry.session_key)) errors.push(`${tag}: duplicate session_key ${entry.session_key}`);
      keys.add(entry.session_key);
      for (const key of ['name', 'circuit', 'location', 'country']) {
        if (!isStr(entry[key])) errors.push(`${tag}: ${key} is not a non-empty string`);
      }
      if (!isDate(entry.date)) errors.push(`${tag}: date is not YYYY-MM-DD`);
      if (!isInt(entry.year)) errors.push(`${tag}: year is not an integer`);
      if (!isInt(entry.round) || entry.round < 1) errors.push(`${tag}: round is not a positive integer`);
      if (!isInt(entry.driver_count) || entry.driver_count < 2) errors.push(`${tag}: driver_count is not >= 2`);
      if (!isStr(entry.file) || !entry.file.startsWith('data/races/')) errors.push(`${tag}: file is not a data/races path`);
      if (isStr(entry.file) && !snapshot.raceFiles.some((file) => file.rel === entry.file)) errors.push(`${tag}: ${entry.file} does not exist`);
      const parsed = parsedRaces.get(entry.file);
      if (!parsed || !isObj(parsed.value)) {
        errors.push(`${tag}: referenced race file cannot be parsed`);
        continue;
      }
      const race = parsed.value;
      for (const key of ['session_key', 'name', 'circuit', 'location', 'country', 'date', 'year', 'round']) {
        if (race[key] !== entry[key]) errors.push(`${tag}: ${key} "${race[key]}" does not match catalog "${entry[key]}"`);
      }
      if (Array.isArray(race.drivers) && race.drivers.length !== entry.driver_count) {
        errors.push(`${tag}: driver_count ${entry.driver_count} does not match race file ${race.drivers.length}`);
      }
    }
    const catalogued = new Set((Array.isArray(catalog.races) ? catalog.races : []).map((entry) => entry.file));
    for (const file of snapshot.raceFiles) {
      if (!catalogued.has(file.rel)) errors.push(`catalog: ${file.rel} is present but not listed in catalog.races`);
    }
  }
  pushCheck(state, 'dataset.catalog', 'Catalog schema, source and race entries', errors, warnings, {
    races: Array.isArray(catalog?.races) ? catalog.races.length : null,
  });
  return catalog;
}

function manifestPathBuffers(snapshot) {
  const map = new Map();
  if (snapshot.catalog) map.set(snapshot.catalog.rel, snapshot.catalog.buf);
  if (snapshot.manifest) map.set(snapshot.manifest.rel, snapshot.manifest.buf);
  for (const file of snapshot.raceFiles) map.set(file.rel, file.buf);
  return map;
}

function validateManifest(state, snapshot) {
  const errors = [];
  const warnings = [];
  const parsed = snapshot.manifest ? parseJson(snapshot.manifest.buf, 'data/manifest.json') : { value: null, error: 'data/manifest.json is missing' };
  const manifest = parsed.value;
  const buffers = manifestPathBuffers(snapshot);
  if (parsed.error) errors.push(parsed.error);
  const entries = [];
  if (isObj(manifest)) {
    if (manifest.schema_version !== 1) errors.push(`manifest: schema_version is ${manifest.schema_version}, expected 1`);
    if (!isIso(manifest.generated_at)) errors.push('manifest: generated_at is not ISO-8601');
    if (!isIso(manifest.as_of)) errors.push('manifest: as_of is not ISO-8601');
    if (!isStr(manifest.git_sha)) errors.push('manifest: git_sha is missing');
    if (manifest.build_script !== 'scripts/build-data.mjs') warnings.push(`manifest: build_script is ${manifest.build_script}`);
    if (!isInt(manifest.request_count) || manifest.request_count < 0) errors.push('manifest: request_count is not a non-negative integer');
    if (!Array.isArray(manifest.files)) errors.push('manifest: files is not an array');
    const seen = new Set();
    for (const [index, entry] of (Array.isArray(manifest.files) ? manifest.files : []).entries()) {
      const tag = `manifest.files[${index}]`;
      if (!isObj(entry)) {
        errors.push(`${tag} is not an object`);
        continue;
      }
      if (!isStr(entry.path)) {
        errors.push(`${tag}: path is missing`);
        continue;
      }
      if (seen.has(entry.path)) errors.push(`${tag}: duplicate path ${entry.path}`);
      seen.add(entry.path);
      if (!buffers.has(entry.path)) {
        errors.push(`${tag}: ${entry.path} is listed but no such file exists`);
        continue;
      }
      const buffer = buffers.get(entry.path);
      const hash = sha256(buffer);
      entries.push({ path: entry.path, bytes: buffer.length, sha256: hash });
      if (entry.bytes !== buffer.length) errors.push(`${tag}: ${entry.path} bytes ${entry.bytes} != actual ${buffer.length}`);
      if (entry.sha256 !== hash) errors.push(`${tag}: ${entry.path} sha256 mismatch (manifest ${entry.sha256}, actual ${hash})`);
      if (!/^[0-9a-f]{64}$/.test(String(entry.sha256))) errors.push(`${tag}: sha256 is not 64 lowercase hex characters`);
    }
    const expected = ['data/catalog.json', ...snapshot.raceFiles.map((file) => file.rel)];
    for (const rel of expected) {
      if (!seen.has(rel)) errors.push(`manifest: ${rel} exists but is not listed in manifest.files`);
    }
    for (const pathName of seen) {
      if (!expected.includes(pathName)) warnings.push(`manifest: extra entry ${pathName}`);
    }
  }
  pushCheck(state, 'dataset.manifest', 'Manifest SHA-256 and byte sizes', errors, warnings, {
    files: entries,
  });
  return manifest;
}

/* -------------------------------------------------------------------------- */
/* Five-race set                                                              */
/* -------------------------------------------------------------------------- */

function validateFiveRaceSet(state, catalog) {
  const races = Array.isArray(catalog?.races) ? catalog.races : [];
  const present = new Map(races.map((entry) => [entry.session_key, entry]));
  const missing = [];
  const mismatched = [];
  const presentKeys = [];
  for (const expected of EXPECTED_FIVE_RACES) {
    const entry = present.get(expected.session_key);
    if (!entry) {
      missing.push({ session_key: expected.session_key, name: expected.name, round: expected.round });
      continue;
    }
    presentKeys.push(expected.session_key);
    for (const key of ['name', 'circuit', 'location', 'country', 'round']) {
      if (entry[key] !== expected[key]) {
        mismatched.push(`${expected.session_key}: ${key} "${entry[key]}" != expected "${expected[key]}"`);
      }
    }
  }
  const errors = mismatched;
  const warnings = missing.length
    ? [`${presentKeys.length}/5 curated races present; missing ${missing.map((race) => `${race.session_key} (${race.name}, round ${race.round})`).join(', ')}`]
    : [];
  pushCheck(state, 'dataset.five_race_set', 'Curated five-race set', errors, warnings, {
    expected: EXPECTED_FIVE_RACES.map((race) => ({ session_key: race.session_key, name: race.name, round: race.round })),
    present: presentKeys,
    missing,
    mismatched,
  });
  return { present: presentKeys, missing, mismatched };
}

/* -------------------------------------------------------------------------- */
/* Independent section recomputation                                          */
/* -------------------------------------------------------------------------- */

async function recomputeSection(state, race, snapshot) {
  const errors = [];
  const warnings = [];
  const metrics = {};

  if (!isObj(race)) {
    pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', ['race 11396 is unavailable'], [], {});
    return null;
  }
  const lec = race.drivers?.find((driver) => driver.number === 16);
  const ver = race.drivers?.find((driver) => driver.number === 3);
  if (!lec || !ver) {
    pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', ['LEC(16) or VER(3) missing from 11396'], [], {});
    return null;
  }

  const lapsResult = await getJson('laps', { session_key: 11396 });
  if (!Array.isArray(lapsResult.data)) {
    pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', [`raw laps unavailable: ${lapsResult.error ?? lapsResult.source}`], [], {});
    return null;
  }
  const rawLaps = lapsResult.data;
  const lapFor = (number, lapNumber) => rawLaps.find((lap) => lap.driver_number === number && lap.lap_number === lapNumber);
  const lecLap = lapFor(16, lec.lap_number);
  const verLap = lapFor(3, ver.lap_number);
  if (!lecLap || !verLap) {
    pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', [`raw lap row missing for LEC ${lec.lap_number} or VER ${ver.lap_number}`], [], {});
    return null;
  }

  const attachRaw = async (lap) => {
    const t0 = Date.parse(lap.date_start) / 1000;
    const t1 = t0 + Number(lap.lap_duration);
    const params = {
      session_key: lap.session_key,
      driver_number: lap.driver_number,
      'date>': new Date((t0 - 1.5) * 1000).toISOString(),
      'date<': new Date((t1 + 1.5) * 1000).toISOString(),
    };
    const location = await getJson('location', params);
    const carData = await getJson('car_data', params);
    if (!Array.isArray(location.data) || !Array.isArray(carData.data)) {
      throw new Error(`raw location/car_data unavailable for driver ${lap.driver_number} lap ${lap.lap_number}`);
    }
    return {
      ...lap,
      __locationRaw: location.data,
      __carDataRaw: carData.data,
      __rawSource: { location: location.source, car_data: carData.source },
    };
  };

  let lecRaw;
  let verRaw;
  try {
    lecRaw = await attachRaw(lecLap);
    verRaw = await attachRaw(verLap);
  } catch (error) {
    pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', [error.message], [], {});
    return null;
  }

  // Documented method: shared reference centreline from the faster of the two.
  const reference = lec.lap_time <= ver.lap_time ? lecRaw : verRaw;
  const referenceNumber = reference.driver_number;
  const t0 = Date.parse(reference.date_start) / 1000;
  const t1 = t0 + Number(reference.lap_duration);
  const bounded = prepareBoundedLocation(reference.__locationRaw, t0, t1);
  if (!bounded) {
    pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', ['reference lap has no usable location samples'], [], {});
    return null;
  }
  const centreline = buildCentreline(smoothXYZ(bounded.points), 5);
  const lecProfile = buildIndependentProfile(lecRaw, centreline);
  const verProfile = buildIndependentProfile(verRaw, centreline);
  if (!lecProfile || !verProfile) {
    pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', ['speed profile could not be built'], [], {});
    return null;
  }

  const segments = lec.dt.length / 4;
  const usable = (index) => index >= 0 && index < segments
    && jsonSection(lec, index) != null
    && jsonSection(ver, index) != null
    && sumSection(lecProfile.dt25, index) != null
    && sumSection(verProfile.dt25, index) != null;
  let sectionIndex = SECTION_INDEX;
  if (!usable(sectionIndex)) {
    sectionIndex = -1;
    for (let index = 3; index < segments - 3; index += 1) {
      if (usable(index)) {
        sectionIndex = index;
        break;
      }
    }
  }
  if (sectionIndex < 0) {
    pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', ['no fully covered 100 m section found in both drivers'], [], {});
    return null;
  }
  if (sectionIndex !== SECTION_INDEX) warnings.push(`section ${SECTION_INDEX} was not fully covered; used section ${sectionIndex}`);

  const values = {};
  for (const [number, driver, profile] of [[16, lec, lecProfile], [3, ver, verProfile]]) {
    const jsonValue = jsonSection(driver, sectionIndex);
    const auditValue = sumSection(profile.dt25, sectionIndex);
    const delta = auditValue - jsonValue;
    values[number] = {
      acronym: driver.acronym,
      json_s: round4(jsonValue),
      audit_s: round4(auditValue),
      delta_s: round4(delta),
      abs_delta_s: round4(Math.abs(delta)),
    };
    if (Math.abs(delta) > 0.05) {
      errors.push(`${driver.acronym} section ${sectionIndex}: audit ${round4(auditValue)} s vs JSON ${round4(jsonValue)} s, delta ${round4(delta)} s > 0.05 s`);
    }
  }

  metrics.section_index = sectionIndex;
  metrics.distance_m = [sectionIndex * 100, (sectionIndex + 1) * 100];
  metrics.reference_driver_number = referenceNumber;
  metrics.json_reference_driver_number = race.analysis?.reference_driver_number ?? null;
  metrics.centreline_length_m = round3(centreline.length);
  metrics.values = values;
  metrics.pre_scale_shortfall_pct = round3(lecProfile.shortfallPct);
  metrics.raw_sources = {
    laps: lapsResult.source,
    lec: lecRaw.__rawSource,
    ver: verRaw.__rawSource,
  };
  metrics.raw_rows = {
    lec_location: lecProfile.locationRows,
    lec_car_data: lecProfile.carRows,
    ver_location: verProfile.locationRows,
    ver_car_data: verProfile.carRows,
  };
  if (metrics.json_reference_driver_number !== referenceNumber) {
    warnings.push(`JSON reference driver ${metrics.json_reference_driver_number} differs from faster lap ${referenceNumber}`);
  }

  const detail = `section ${sectionIndex} (${metrics.distance_m[0]}-${metrics.distance_m[1]} m): ` +
    Object.values(values).map((row) => `${row.acronym} audit ${row.audit_s} s vs JSON ${row.json_s} s (delta ${row.delta_s >= 0 ? '+' : ''}${row.delta_s} s)`).join('; ');
  pushCheck(state, 'audit.section', 'Independent 100 m section from raw OpenF1', errors, warnings, metrics, detail);
  return metrics;
}

/* -------------------------------------------------------------------------- */
/* Same-driver control and app behaviour                                      */
/* -------------------------------------------------------------------------- */

function segmentTimesIndependent(dt, grid = GRID_M, segment = SEGMENT_M) {
  const binsPerSegment = segment / grid;
  const result = [];
  for (let start = 0; start < dt.length; start += binsPerSegment) {
    const end = Math.min(dt.length, start + binsPerSegment);
    const covered = (end - start) * grid;
    if (covered < segment * 0.5) break;
    let total = 0;
    let missing = false;
    for (let i = start; i < end; i += 1) {
      const value = dt[i];
      if (value == null || !Number.isFinite(value)) missing = true;
      else total += value;
    }
    result.push(missing ? null : total);
  }
  return result;
}

function sameSeries(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function validateSameDriverControl(state, race) {
  const errors = [];
  const warnings = [];
  const metrics = {};
  const lec = race.drivers?.find((driver) => driver.number === 16);
  if (!lec || !Array.isArray(lec.dt)) {
    pushCheck(state, 'audit.same_driver', 'Same-driver control and deadband/null behaviour', ['LEC(16) dt is unavailable'], [], {});
    return null;
  }

  let track;
  try {
    track = await import(pathToFileURL(path.join(ROOT, 'assets', 'track.js')).href);
  } catch (error) {
    pushCheck(state, 'audit.same_driver', 'Same-driver control and deadband/null behaviour', [], [`assets/track.js could not be imported (${error.message}); app behaviour not verified`], {});
    return null;
  }

  const appTimes = track.segmentTimesFromBins(lec.dt, GRID_M, SEGMENT_M);
  const independentTimes = segmentTimesIndependent(lec.dt);
  if (!sameSeries(appTimes, independentTimes)) {
    errors.push('app segmentTimesFromBins disagrees with the independent 25 m -> 100 m aggregation');
  }

  // Synthetic same-driver self-comparison: same dt array on both sides.
  const selfDeltas = appTimes.map((value) => (value == null ? null : 0));
  const smoothed = track.smoothSeries(selfDeltas, 3);
  const classes = track.classifySeries(smoothed, DEADBAND_S);
  const merged = track.mergeShortRuns(classes, 2);
  const total = merged.length;
  const neutral = merged.filter((value) => value === 0).length;
  const nullCount = merged.filter((value) => value == null).length;
  const coloured = merged.filter((value) => value === 1 || value === -1).length;
  const decided = total - nullCount;
  const neutralShareInclNull = total > 0 ? (neutral + nullCount) / total : 0;
  const neutralShareDecided = decided > 0 ? neutral / decided : 0;

  // Nulls must be preserved: a segment with any null bin is null; smoothing must
  // not bridge a null; no coloured segment may hide a null in its 3-window.
  for (let index = 0; index < appTimes.length; index += 1) {
    const bins = lec.dt.slice(index * 4, index * 4 + 4);
    if (bins.some((value) => value == null) && appTimes[index] !== null) {
      errors.push(`app segment ${index} sums across a null bin instead of returning null`);
      break;
    }
    if (appTimes[index] === null && smoothed[index] !== null) {
      errors.push(`app smoothing bridged a null at segment ${index}`);
      break;
    }
  }
  for (let index = 0; index < merged.length; index += 1) {
    if (merged[index] !== 1 && merged[index] !== -1) continue;
    for (let j = Math.max(0, index - 1); j <= Math.min(merged.length - 1, index + 1); j += 1) {
      if (appTimes[j] === null) {
        errors.push(`app coloured segment ${index} is adjacent to a null segment ${j}`);
        break;
      }
    }
  }

  const boundaryInput = [-0.031, -0.03, -0.0299, 0, 0.0299, 0.03, 0.031];
  const boundaryExpected = [-1, -1, 0, 0, 0, 1, 1];
  const boundaryActual = track.classifySeries(boundaryInput, DEADBAND_S);
  if (!sameSeries(boundaryActual, boundaryExpected)) {
    errors.push(`app deadband boundary mismatch: got [${boundaryActual.join(', ')}], expected [${boundaryExpected.join(', ')}]`);
  }

  // The tooltip uses <= while the classifier uses <. At exactly +/-0.03 s the
  // segment is coloured but the tooltip says "too close to call".
  let tooltipBoundaryWarn = null;
  const appSource = path.join(ROOT, 'assets', 'app.js');
  if (fs.existsSync(appSource)) {
    const text = fs.readFileSync(appSource, 'utf8');
    if (/Math\.abs\(delta\)\s*<=\s*\(?\s*race\.deadband_s/.test(text)) {
      tooltipBoundaryWarn = 'assets/app.js tooltip treats |delta| == 0.03 s as neutral while classifySeries colours it';
      warnings.push(tooltipBoundaryWarn);
    }
  }

  metrics.total_segments = total;
  metrics.non_null_segments = decided;
  metrics.neutral_segments = neutral;
  metrics.null_segments = nullCount;
  metrics.coloured_segments = coloured;
  metrics.neutral_share_including_null = round4(neutralShareInclNull);
  metrics.neutral_share_decided = round4(neutralShareDecided);
  metrics.deadband_s = DEADBAND_S;
  metrics.boundary_classes = boundaryActual;
  metrics.tooltip_boundary_warning = tooltipBoundaryWarn;
  const ver = race.drivers?.find((driver) => driver.number === 3);
  if (ver && Array.isArray(ver.dt)) {
    const verTimes = track.segmentTimesFromBins(ver.dt, GRID_M, SEGMENT_M);
    const pairDeltas = appTimes.map((value, index) => (value == null || verTimes[index] == null ? null : value - verTimes[index]));
    const pairValues = pairDeltas.filter((value) => value != null);
    let pairSignChanges = 0;
    for (let index = 1; index < pairValues.length; index += 1) {
      if (Math.sign(pairValues[index]) !== Math.sign(pairValues[index - 1])) pairSignChanges += 1;
    }
    const pairClasses = track.classifySeries(track.smoothSeries(pairDeltas, 3), DEADBAND_S);
    metrics.lec_ver_pair = {
      total_segments: appTimes.length,
      non_null_segments: pairValues.length,
      raw_beyond_30ms: pairValues.filter((value) => Math.abs(value) >= DEADBAND_S).length,
      raw_neutral: pairValues.filter((value) => Math.abs(value) < DEADBAND_S).length,
      raw_null: pairDeltas.filter((value) => value == null).length,
      raw_sign_changes: pairSignChanges,
      smoothed_coloured: pairClasses.filter((value) => value === 1 || value === -1).length,
      smoothed_neutral: pairClasses.filter((value) => value === 0).length,
      smoothed_null: pairClasses.filter((value) => value == null).length,
      documented_docs01: { beyond_30ms: 17, neutral: 37, sign_changes: 11, total: 54 },
    };
  }

  metrics.documented_calibration = {
    source: 'docs/01-data-source-assessment.md §5',
    laps: 'NOR 42/44',
    rms_s: 0.014,
    within_30ms: 50,
    segments: 53,
    neutral_share: round4(50 / 53),
    sign_changes: 14,
    acceptance_min: 0.9,
    note: 'Documented reference only; this run uses the synthetic self-comparison from the JSON, which is the alternative permitted by the audit brief.',
  };

  if (neutralShareInclNull < 0.9) {
    errors.push(`neutral share including nulls ${round4(neutralShareInclNull)} is below 0.90`);
  }
  const detail = `${total} segments: ${neutral} neutral, ${nullCount} no-data, ${coloured} coloured; ` +
    `neutral share including no-data ${(neutralShareInclNull * 100).toFixed(1)}%, ` +
    `of decided ${(neutralShareDecided * 100).toFixed(1)}%; deadband boundary [${boundaryActual.join(', ')}]`;
  pushCheck(state, 'audit.same_driver', 'Same-driver control and deadband/null behaviour', errors, warnings, metrics, detail);
  return metrics;
}

/* -------------------------------------------------------------------------- */
/* Documented calibration claims                                             */
/* -------------------------------------------------------------------------- */

function validateDocumentedCalibration(state, sameDriver) {
  const warnings = [];
  const pair = sameDriver?.lec_ver_pair ?? null;
  if (pair) {
    if (pair.raw_beyond_30ms !== 17 || pair.raw_neutral !== 37) {
      warnings.push(
        `docs/01 §5 says LEC/VER has 17/54 segments beyond ±30 ms and 37 neutral; ` +
        `the current JSON gives ${pair.raw_beyond_30ms}/${pair.non_null_segments} beyond, ` +
        `${pair.raw_neutral}/${pair.non_null_segments} neutral, ${pair.raw_null} no-data ` +
        `(${pair.smoothed_coloured} coloured / ${pair.smoothed_neutral} neutral / ${pair.smoothed_null} no-data after app smoothing)`,
      );
    }
  }
  pushCheck(state, 'audit.documented_calibration', 'Documented calibration claims match the snapshot', [], warnings, {
    lec_ver: pair,
    nor_reference: sameDriver?.documented_calibration ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* Report assembly                                                            */
/* -------------------------------------------------------------------------- */

async function auditSnapshot(snapshot) {
  const state = { checks: [] };
  const parsedRaces = new Map();
  for (const file of snapshot.raceFiles) {
    parsedRaces.set(file.rel, parseJson(file.buf, file.rel));
  }

  const catalog = validateCatalog(state, snapshot, parsedRaces);
  const manifest = validateManifest(state, snapshot);

  const races = [];
  for (const file of snapshot.raceFiles) {
    const parsed = parsedRaces.get(file.rel);
    if (parsed.error) {
      pushCheck(state, `dataset.race.${file.rel}.schema`, 'Race schema', [parsed.error], [], { bytes: file.buf.length });
      continue;
    }
    const race = validateRace(parsed.value, file.rel, file.buf.length, state);
    if (race) {
      races.push({
        path: file.rel,
        bytes: file.buf.length,
        session_key: race.session_key,
        name: race.name,
        drivers: Array.isArray(race.drivers) ? race.drivers.length : null,
        track_length_m: race.track?.length_m ?? null,
        dt_length: Array.isArray(race.drivers) && race.drivers[0]?.dt ? race.drivers[0].dt.length : null,
      });
    }
  }

  const five = validateFiveRaceSet(state, catalog);
  const austin = parsedRaces.get('data/races/11396.json')?.value ?? null;
  const section = austin ? await recomputeSection(state, austin, snapshot) : null;
  const sameDriver = austin ? await validateSameDriverControl(state, austin) : null;
  validateDocumentedCalibration(state, sameDriver);

  const failed = state.checks.filter((check) => check.status === 'FAIL');
  const warned = state.checks.filter((check) => check.status === 'WARN');
  const skipped = state.checks.filter((check) => check.status === 'SKIP');
  const passed = state.checks.filter((check) => check.status === 'PASS');
  const status = failed.length === 0 ? 'PASS' : 'FAIL';

  const defects = [];
  for (const check of state.checks) {
    if (check.status === 'FAIL' || check.status === 'WARN') {
      defects.push({
        id: check.id,
        status: check.status,
        severity: check.status === 'FAIL' ? 'P2' : 'P3',
        detail: check.detail,
        errors: check.errors,
        warnings: check.warnings,
      });
    }
  }

  return {
    audit: 'independent-data-audit',
    version: 1,
    generated_at: new Date().toISOString(),
    workspace: ROOT,
    source_snapshot: {
      catalog_bytes: snapshot.catalog?.buf.length ?? null,
      manifest_bytes: snapshot.manifest?.buf.length ?? null,
      race_files: snapshot.raceFiles.map((file) => ({ path: file.rel, bytes: file.buf.length })),
      stable: true,
    },
    tolerances: {
      section_abs_s: 0.05,
      sector_sum_s: 0.1,
      full_coverage_dt_sum_s: 0.05,
      max_race_bytes: MAX_RACE_BYTES,
      same_driver_neutral_share_min: 0.9,
      calibration_sector_error_max_s: 0.2,
    },
    summary: {
      status,
      checks: state.checks.length,
      passed: passed.length,
      failed: failed.length,
      warnings: warned.length,
      skipped: skipped.length,
      exit_code: status === 'FAIL' ? 1 : 0,
    },
    dataset: {
      catalog: {
        schema_version: catalog?.schema_version ?? null,
        generated_at: catalog?.generated_at ?? null,
        races: Array.isArray(catalog?.races) ? catalog.races : [],
      },
      manifest: {
        generated_at: manifest?.generated_at ?? null,
        as_of: manifest?.as_of ?? null,
        git_sha: manifest?.git_sha ?? null,
        request_count: manifest?.request_count ?? null,
        files: Array.isArray(manifest?.files) ? manifest.files : [],
      },
      races,
      five_race_set: five,
    },
    section_recompute: section,
    same_driver_control: sameDriver,
    raw_cache: { ...rawStats },
    checks: state.checks,
    defects,
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  let snapshot = readDataSnapshot();
  let report = await auditSnapshot(snapshot);
  if (currentSignature() !== snapshot.signature) {
    process.stderr.write('[audit] data changed during the first pass; waiting 1.5 s and retrying once\n');
    await sleep(1500);
    snapshot = readDataSnapshot();
    report = await auditSnapshot(snapshot);
    if (currentSignature() !== snapshot.signature) {
      report.summary.warnings += 1;
      report.checks.push({
        id: 'dataset.snapshot_stability',
        title: 'Data files stayed stable during the audit',
        status: 'WARN',
        detail: 'data files changed during both audit passes; results reflect the second snapshot',
        errors: [],
        warnings: ['data files changed during both audit passes'],
        metrics: {},
      });
      report.defects.push({
        id: 'dataset.snapshot_stability',
        status: 'WARN',
        severity: 'P3',
        detail: 'data files changed during both audit passes; results reflect the second snapshot',
        errors: [],
        warnings: ['data files changed during both audit passes'],
      });
    }
  }

  report.raw_cache = { ...rawStats };
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('Independent data audit - who-is-the-fastest');
  console.log(`Data: ${snapshot.raceFiles.length} race file(s), catalog ${report.source_snapshot.catalog_bytes} B, manifest ${report.source_snapshot.manifest_bytes} B`);
  for (const check of report.checks) {
    console.log(`[${check.status}] ${check.id} - ${check.detail}`);
  }

  console.log('');
  console.log('File sizes:');
  if (snapshot.catalog) console.log(`  data/catalog.json ${snapshot.catalog.buf.length} B`);
  if (snapshot.manifest) console.log(`  data/manifest.json ${snapshot.manifest.buf.length} B`);
  for (const file of snapshot.raceFiles) {
    const flag = file.buf.length > MAX_RACE_BYTES ? '  ** OVER 150 KB **' : '';
    console.log(`  ${file.rel} ${file.buf.length} B (${round3(file.buf.length / 1024)} KB)${flag}`);
  }

  if (report.section_recompute) {
    const section = report.section_recompute;
    console.log('');
    console.log(`Section ${section.section_index} (${section.distance_m[0]}-${section.distance_m[1]} m), reference driver ${section.reference_driver_number}:`);
    for (const [number, row] of Object.entries(section.values)) {
      console.log(`  ${row.acronym}(${number}): audit ${row.audit_s} s, JSON ${row.json_s} s, delta ${row.delta_s >= 0 ? '+' : ''}${row.delta_s} s`);
    }
    console.log(`  centreline ${section.centreline_length_m} m, pre-scale shortfall ${section.pre_scale_shortfall_pct}%`);
  }

  if (report.same_driver_control) {
    const control = report.same_driver_control;
    console.log('');
    console.log('Same-driver control:');
    console.log(`  ${control.total_segments} segments: ${control.neutral_segments} neutral, ${control.null_segments} no-data, ${control.coloured_segments} coloured`);
    console.log(`  neutral share including no-data ${(control.neutral_share_including_null * 100).toFixed(1)}%, of decided ${(control.neutral_share_decided * 100).toFixed(1)}%`);
  }

  const five = report.dataset.five_race_set;
  if (five) {
    console.log('');
    console.log(`Five-race set: ${five.present.length}/5 present${five.missing.length ? `; missing ${five.missing.map((race) => `${race.session_key} (${race.name}, round ${race.round})`).join(', ')}` : ''}`);
  }

  console.log('');
  console.log(`Raw cache: ${report.raw_cache.cache} hits, ${report.raw_cache.network} network request(s), ${report.raw_cache.errors} error(s)`);
  console.log(`Overall: ${report.summary.status} (${report.summary.passed} pass, ${report.summary.warnings} warn, ${report.summary.failed} fail, ${report.summary.skipped} skip)`);
  console.log(`Report: ${REPORT_PATH}`);
  process.exitCode = report.summary.exit_code;
}

await main();
