/**
 * Pure telemetry helpers for the "Who is the fastest?" data pipeline.
 *
 * All functions in this module are side-effect free and dependency free so the
 * geometry / integration rules can be unit-tested without network access.
 *
 * Conventions
 * -----------
 * - Position samples are `{t, x, y}` with `t` in seconds and `x`/`y` in metres.
 * - A centreline is an array of `{s, x, y}` with `s` the cumulative distance in
 *   metres from the start/finish line.
 * - A speed profile is an array of `{t, s, v}` with `v` in km/h.
 * - A lap's `dt` is seconds per 25 m bin; `null` means "no trustworthy data".
 */

const KMH_TO_MS = 1 / 3.6;

/** Parse an ISO timestamp (or pass through a numeric epoch) into seconds. */
export function toSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`invalid timestamp: ${value}`);
  return ms / 1000;
}

/** Median of a numeric array (ignores non-finite values). */
export function median(values) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** First index whose value is >= target (classic lower_bound). */
function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Symmetric moving average over sample positions. `k=3` is the accepted
 * 3-sample smoothing from the plan; timestamps are preserved.
 */
export function smoothPoints(points, k = 3) {
  if (!Array.isArray(points)) throw new TypeError('points must be an array');
  const n = points.length;
  if (n === 0) return [];
  const width = Math.max(1, Math.floor(Number(k) || 1));
  if (width <= 1) return points.map((p) => ({ ...p }));

  const half = Math.floor(width / 2);
  const px = new Float64Array(n + 1);
  const py = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    px[i + 1] = px[i] + Number(points[i].x);
    py[i + 1] = py[i] + Number(points[i].y);
  }
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    out[i] = {
      ...points[i],
      x: (px[hi] - px[lo]) / (hi - lo),
      y: (py[hi] - py[lo]) / (hi - lo),
    };
  }
  return out;
}

/** Cumulative path distance for a position sequence. */
export function cumulativeDistance(points) {
  const n = points.length;
  if (n === 0) return [];
  const out = new Float64Array(n);
  out[0] = 0;
  for (let i = 1; i < n; i += 1) {
    out[i] = out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return Array.from(out);
}

/**
 * Resample a smoothed position sequence at a fixed arc-length interval.
 * Returns centreline points from `s=0` to `floor(length/step)*step`.
 */
export function buildCenterline(points, stepM = 5) {
  if (!Array.isArray(points)) throw new TypeError('points must be an array');
  const step = Number(stepM);
  if (!(step > 0)) throw new RangeError('stepM must be positive');
  if (points.length === 0) {
    return { points: [], length_m: 0, gps_length_m: 0, step_m: step };
  }

  const dist = cumulativeDistance(points);
  const gpsLength = dist[dist.length - 1];
  const count = Math.floor(gpsLength / step);
  const samples = [];
  for (let k = 0; k <= count; k += 1) {
    const target = k * step;
    const j = lowerBound(dist, target);
    if (j <= 0) {
      samples.push({ s: target, x: points[0].x, y: points[0].y });
    } else if (j >= points.length) {
      const last = points[points.length - 1];
      samples.push({ s: target, x: last.x, y: last.y });
    } else {
      const d0 = dist[j - 1];
      const d1 = dist[j];
      const f = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
      samples.push({
        s: target,
        x: points[j - 1].x + (points[j].x - points[j - 1].x) * f,
        y: points[j - 1].y + (points[j].y - points[j - 1].y) * f,
      });
    }
  }
  const length = count > 0 ? count * step : gpsLength;
  return { points: samples, length_m: length, gps_length_m: gpsLength, step_m: step };
}

/**
 * Linear interpolation of an arbitrary numeric property at time `t`.
 * Values outside the sample range clamp to the nearest endpoint, matching the
 * reference implementation. Callers that need strict coverage should check the
 * sample span first.
 */
export function interpolateAtTime(points, t, key) {
  const n = points.length;
  if (n === 0) return null;
  if (t <= points[0].t) return Number(points[0][key]);
  if (t >= points[n - 1].t) return Number(points[n - 1][key]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const den = b.t - a.t;
  const f = den > 0 ? (t - a.t) / den : 0;
  return Number(a[key]) + (Number(b[key]) - Number(a[key])) * f;
}

/** Interpolate an `{x,y}` position at time `t`. */
export function interpolateXYAtTime(points, t) {
  return {
    x: interpolateAtTime(points, t, 'x'),
    y: interpolateAtTime(points, t, 'y'),
  };
}

/**
 * Project a position onto the shared centreline using a monotonic +/-window
 * point search. The start/finish wrap guard prevents a late-lap sample near the
 * seam from jumping back to index 0 (and vice versa); for a single lap the
 * correct answer at the seam is the end of the centreline.
 *
 * `state.lastIndex` is updated in place so a sequence of samples stays ordered.
 */
export function projectToCenterline(centerline, xy, state = { lastIndex: 0 }, window = 30) {
  const n = centerline.length;
  if (n === 0) return null;
  const x = Number(xy.x ?? xy[0]);
  const y = Number(xy.y ?? xy[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const win = Math.max(1, Math.floor(window));
  let last = clamp(Math.floor(Number(state.lastIndex) || 0), 0, n - 1);

  const lo = Math.max(0, last - win);
  const hi = Math.min(n - 1, last + win);
  let best = lo;
  let bestD = Infinity;
  for (let i = lo; i <= hi; i += 1) {
    const dx = centerline[i].x - x;
    const dy = centerline[i].y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }

  // Seam guard: look at the far side of the start/finish only to detect a wrap,
  // never to accept one inside a lap-bounded window.
  let wrapped = false;
  const lateLap = last > n / 2;
  if (lateLap && n - 1 - last <= win) {
    const reach = win - (n - 1 - last);
    let seamD = Infinity;
    for (let i = 0; i <= Math.min(n - 1, reach); i += 1) {
      const dx = centerline[i].x - x;
      const dy = centerline[i].y - y;
      seamD = Math.min(seamD, dx * dx + dy * dy);
    }
    if (seamD < bestD) {
      wrapped = true;
      best = hi; // clamp to the finish, not the start
      const dx = centerline[best].x - x;
      const dy = centerline[best].y - y;
      bestD = dx * dx + dy * dy;
    }
  } else if (!lateLap && last <= win) {
    const reach = win - last;
    let seamD = Infinity;
    for (let i = Math.max(0, n - 1 - reach); i < n; i += 1) {
      const dx = centerline[i].x - x;
      const dy = centerline[i].y - y;
      seamD = Math.min(seamD, dx * dx + dy * dy);
    }
    if (seamD < bestD) {
      wrapped = true;
      best = lo; // clamp to the start, not the finish
      const dx = centerline[best].x - x;
      const dy = centerline[best].y - y;
      bestD = dx * dx + dy * dy;
    }
  }

  state.lastIndex = best;
  return {
    index: best,
    s: centerline[best].s,
    x: centerline[best].x,
    y: centerline[best].y,
    distance: Math.sqrt(Math.max(0, bestD)),
    wrapped,
  };
}

function speedAt(profile, s) {
  const n = profile.length;
  if (n === 0) return null;
  if (s <= profile[0].s) return profile[0].v;
  if (s >= profile[n - 1].s) return profile[n - 1].v;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (profile[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = profile[lo];
  const b = profile[hi];
  const den = b.s - a.s;
  const f = den > 0 ? (s - a.s) / den : 0;
  return a.v + (b.v - a.v) * f;
}

/**
 * Integrate a speed profile over equal 5 m steps, scale the whole lap to the
 * official lap time, then aggregate five 5 m bins into one 25 m bin.
 *
 * `dt = 5 / max(v_m_s, 5 km/h)`. `preScaleTotal` is recorded before scaling;
 * the plan expects it to be ~1-2 % short of the official lap time. Gaps in the
 * profile (or `extraGapRanges`, used for position-stream gaps) null the
 * affected bins. A lap with more than 15 % of its time affected is rejected.
 * Sums of `dt` exclude null bins, so `sum(dt) < lapTime` whenever a gap exists;
 * `coveragePct` is exactly the non-null share of the 25 m bins.
 *
 * @param {Array<{t:number,s:number,v:number}>} profile km/h, distance in metres
 * @param {number} lengthM centreline length in metres
 * @param {number} lapTime official lap duration in seconds
 * @param {object} [options]
 * @returns {object} `{dt, dt5, preScaleTotal, scale, coveragePct, affectedPct,
 *   rejected, reasons, nullBins, gridM}`
 */
export function speedBins(profile, lengthM, lapTime, options = {}) {
  const {
    stepM = 5,
    gridM = 25,
    gapS = 0.6,
    maxAffectedPct = 15,
    minSpeedKmh = 5,
    extraGapRanges = [],
    maxSpeedKmh = 400,
  } = options;
  const reasons = [];
  const lap = Number(lapTime);
  const length = Number(lengthM);
  if (!(lap > 0)) reasons.push('invalid_lap_time');
  if (!(length > 0)) reasons.push('invalid_length');
  const clean = (Array.isArray(profile) ? profile : [])
    .map((p) => ({ t: Number(p.t), s: Number(p.s), v: Number(p.v) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.s) && Number.isFinite(p.v) && p.v > 0)
    .sort((a, b) => a.t - b.t);

  // Keep a strictly increasing distance profile; duplicated projections add no
  // information and break interpolation.
  const points = [];
  let lastS = -Infinity;
  for (const p of clean) {
    if (p.s > lastS + 0.5) {
      points.push(p);
      lastS = p.s;
    }
  }
  if (points.length < 2) reasons.push('speed_profile_too_short');

  const step = Math.max(1, Number(stepM));
  const grid = Math.max(step, Number(gridM));
  const n5 = Math.max(1, Math.floor(length / step));
  const dt5 = new Array(n5);
  let preScaleTotal = 0;
  if (points.length >= 2) {
    const minMps = Math.max(0.1, Number(minSpeedKmh)) * KMH_TO_MS;
    for (let i = 0; i < n5; i += 1) {
      const s = i * step + step / 2;
      const v = Math.min(maxSpeedKmh, Math.max(0, speedAt(points, s)));
      const dt = step / Math.max(v * KMH_TO_MS, minMps);
      dt5[i] = dt;
      preScaleTotal += dt;
    }
  }
  const scale = preScaleTotal > 0 ? lap / preScaleTotal : 0;
  const scaled5 = dt5.map((dt) => (Number.isFinite(dt) ? dt * scale : null));

  // Gap ranges in distance space. Profile gaps are detected from timestamps;
  // position-stream gaps are supplied by the builder.
  const gapRanges = [];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].t - points[i - 1].t > gapS) {
      gapRanges.push([Math.min(points[i - 1].s, points[i].s), Math.max(points[i - 1].s, points[i].s)]);
    }
  }
  for (const range of extraGapRanges) {
    if (!Array.isArray(range) || range.length < 2) continue;
    const a = Number(range[0]);
    const b = Number(range[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) gapRanges.push([Math.min(a, b), Math.max(a, b)]);
  }

  const null5 = new Array(n5).fill(false);
  for (const [s0, s1] of gapRanges) {
    const start = clamp(Math.floor(s0 / step), 0, n5 - 1);
    const end = clamp(Math.ceil(s1 / step) - 1, start, n5 - 1);
    for (let i = start; i <= end; i += 1) null5[i] = true;
  }

  let nullCount = 0;
  for (let i = 0; i < n5; i += 1) {
    if (!Number.isFinite(scaled5[i])) null5[i] = true;
    if (null5[i]) nullCount += 1;
  }

  const groupSize = Math.max(1, Math.round(grid / step));
  const dt = [];
  const dtAll = [];
  for (let i = 0; i < n5; i += groupSize) {
    const end = Math.min(n5, i + groupSize);
    let groupNull = false;
    let sum = 0;
    let allSum = 0;
    for (let j = i; j < end; j += 1) {
      const value = Number.isFinite(scaled5[j]) ? scaled5[j] : 0;
      allSum += value;
      if (null5[j] || !Number.isFinite(scaled5[j])) groupNull = true;
      else sum += value;
    }
    dtAll.push(allSum);
    dt.push(groupNull ? null : sum);
  }

  // Coverage is measured on the 25 m bins the client actually sees: if any
  // 5 m sub-bin is untrustworthy the whole 25 m bin is neutral, so its full
  // time is uncovered.
  const total = dtAll.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
  const coveredTotal = dt.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
  const affectedPct = total > 0 ? (1 - coveredTotal / total) * 100 : 100;
  const coveragePct = Math.max(0, Math.min(100, 100 - affectedPct));
  if (affectedPct > maxAffectedPct) reasons.push('gap_affected_pct');
  return {
    dt,
    dtAll,
    dt5: scaled5,
    preScaleTotal,
    scale,
    total,
    coveredTotal,
    coveragePct,
    affectedPct,
    nullCount5: nullCount,
    nullBinCount25: dt.filter((value) => value == null).length,
    nullBins: null5,
    stepM: step,
    gridM: grid,
    rejected: reasons.length > 0,
    reasons,
  };
}

/**
 * Convert official sector durations into distance marks on the centreline.
 * Cumulative time is integrated over the `dt` bins (null bins contribute no
 * time). Returns the two inner sector boundaries in metres.
 */
export function sectorMarks(dtBins, sectors) {
  if (!Array.isArray(dtBins) || dtBins.length === 0) return [];
  const s = Array.isArray(sectors)
    ? sectors
    : [sectors?.s1, sectors?.s2, sectors?.s3];
  const s1 = Number(s[0]);
  const s2 = Number(s[1]);
  if (!(s1 > 0) || !(s2 >= 0)) return [];
  const cum = [0];
  for (let i = 0; i < dtBins.length; i += 1) {
    const dt = Number(dtBins[i]);
    cum.push(cum[i] + (Number.isFinite(dt) && dt > 0 ? dt : 0));
  }
  const out = [];
  for (const target of [s1, s1 + s2]) {
    const j = lowerBound(cum, target);
    const mark = Math.min(j, dtBins.length) * 25;
    out.push(mark);
  }
  return out;
}

function streamStats(samples, t0, t1, gapS, kind, reasons, maxGapPct = 15) {
  const duration = t1 - t0;
  const inside = samples.filter((p) => p.t >= t0 && p.t <= t1).sort((a, b) => a.t - b.t);
  const count = inside.length;
  const span = count > 1 ? inside[count - 1].t - inside[0].t : 0;
  const hz = duration > 0 ? count / duration : 0;
  const spanPct = duration > 0 ? (span / duration) * 100 : 0;
  const gaps = [];
  if (count > 0) {
    if (inside[0].t - t0 > gapS) gaps.push([t0, inside[0].t]);
    for (let i = 1; i < count; i += 1) {
      if (inside[i].t - inside[i - 1].t > gapS) gaps.push([inside[i - 1].t, inside[i].t]);
    }
    if (t1 - inside[count - 1].t > gapS) gaps.push([inside[count - 1].t, t1]);
  } else if (duration > 0) {
    gaps.push([t0, t1]);
  }
  const gapTime = gaps.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
  const gapPct = duration > 0 ? (gapTime / duration) * 100 : 0;

  if (count === 0) reasons.push(`${kind}_missing`);
  else if (hz < 2) reasons.push(`${kind}_hz`);
  if (spanPct < 97) reasons.push(`${kind}_span`);
  if (gapPct > maxGapPct) reasons.push(`${kind}_gap`);

  return {
    ok: !reasons.some((r) => r.startsWith(`${kind}_`)),
    count,
    span_s: span,
    span_pct: spanPct,
    hz,
    gap_count: gaps.length,
    gap_s: gapTime,
    gap_pct: gapPct,
    gaps,
  };
}

/**
 * Validate one driver/lap telemetry window against the plan's rules:
 * - position and car streams each at least 2 samples per lap second,
 * - span at least 97 % of the official lap,
 * - no `(0,0)` positions,
 * - gaps > 0.6 s affect at most 15 % of the lap,
 * - GPS path length within 10 % of the field median (when provided).
 *
 * Pass `carData: null` for a cheap position-only pre-check.
 */
export function validateLap(candidate) {
  const {
    lapDuration,
    dateStart,
    location = [],
    carData = null,
    gpsLengthM = null,
    medianGpsLengthM = null,
    gapS = 0.6,
    maxGapPct = 15,
    maxGpsDeviationPct = 10,
  } = candidate ?? {};
  const duration = Number(lapDuration);
  const reasons = [];
  if (!(duration > 0)) {
    return {
      valid: false,
      reasons: ['invalid_lap_duration'],
      location: { ok: false },
      car: null,
      gps_length_m: 0,
    };
  }

  const locationSamples = (Array.isArray(location) ? location : [])
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => ({
      t: toSeconds(p.date),
      x: Number(p.x) / 10,
      y: Number(p.y) / 10,
      rawX: Number(p.x),
      rawY: Number(p.y),
    }))
    .sort((a, b) => a.t - b.t);
  let t0;
  let t1;
  if (dateStart != null) {
    t0 = toSeconds(dateStart);
    t1 = t0 + duration;
  } else if (locationSamples.length > 0) {
    t0 = locationSamples[0].t;
    t1 = locationSamples[locationSamples.length - 1].t;
  } else {
    t0 = 0;
    t1 = duration;
  }

  const zeros = locationSamples.filter(
    (p) => p.t >= t0 && p.t <= t1 && p.rawX === 0 && p.rawY === 0,
  ).length;
  const usable = locationSamples.filter((p) => !(p.rawX === 0 && p.rawY === 0));
  const loc = streamStats(usable, t0, t1, gapS, 'location', reasons, maxGapPct);
  if (zeros > 0) reasons.push('location_zero');

  // Raw GPS path length over the lap-bounded samples (decimetres -> metres).
  const bounded = usable.filter((p) => p.t >= t0 && p.t <= t1);
  // Smooth before measuring so GPS jitter does not inflate the length, matching
  // the reference centreline construction.
  const gpsPoints = smoothPoints(bounded, 3);
  let gpsLength = 0;
  for (let i = 1; i < gpsPoints.length; i += 1) {
    gpsLength += Math.hypot(gpsPoints[i].x - gpsPoints[i - 1].x, gpsPoints[i].y - gpsPoints[i - 1].y);
  }
  if (gpsLengthM != null && Number.isFinite(Number(gpsLengthM))) gpsLength = Number(gpsLengthM);

  let gpsDeviationPct = null;
  if (medianGpsLengthM != null && Number(medianGpsLengthM) > 0 && gpsLength > 0) {
    gpsDeviationPct = (Math.abs(gpsLength - Number(medianGpsLengthM)) / Number(medianGpsLengthM)) * 100;
    if (gpsDeviationPct > maxGpsDeviationPct) reasons.push('gps_length_off_median');
  }

  let car = null;
  if (carData != null) {
    const carSamples = (Array.isArray(carData) ? carData : [])
      .filter((p) => p && Number.isFinite(Number(p.speed)) && Number(p.speed) > 0)
      .map((p) => ({ t: toSeconds(p.date), speed: Number(p.speed) }))
      .sort((a, b) => a.t - b.t);
    car = streamStats(carSamples, t0, t1, gapS, 'car', reasons, maxGapPct);
  }

  // Location-specific reason remapping keeps the stats object's ok flag simple.
  loc.ok = !reasons.some((r) => r.startsWith('location_'));

  return {
    valid: reasons.length === 0,
    reasons,
    location: loc,
    car,
    zeros,
    gps_length_m: gpsLength,
    gps_deviation_pct: gpsDeviationPct,
    window: { t0, t1, duration },
  };
}
