import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCenterline,
  cumulativeDistance,
  interpolateAtTime,
  interpolateXYAtTime,
  median,
  projectToCenterline,
  sectorMarks,
  smoothPoints,
  speedBins,
  validateLap,
} from '../scripts/lib/telemetry.mjs';

const sum = (values) => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

function straightPoints(length = 100, step = 10) {
  const points = [];
  for (let s = 0; s <= length; s += step) points.push({ t: s / 10, x: s, y: 0 });
  return points;
}

test('smoothPoints averages positions and preserves timestamps', () => {
  const points = [
    { t: 0, x: 0, y: 0 },
    { t: 1, x: 10, y: 10 },
    { t: 2, x: 20, y: 20 },
  ];
  const smoothed = smoothPoints(points, 3);
  assert.deepEqual(
    smoothed.map((p) => [p.t, p.x, p.y]),
    [
      [0, 5, 5],
      [1, 10, 10],
      [2, 15, 15],
    ],
  );
  assert.deepEqual(smoothPoints(points, 1), points);
  assert.deepEqual(smoothPoints([], 3), []);
});

test('cumulativeDistance and buildCenterline resample at fixed arc length', () => {
  const points = straightPoints(100, 10);
  const distance = cumulativeDistance(points);
  assert.equal(distance.length, 11);
  assert.equal(distance[0], 0);
  assert.equal(distance[distance.length - 1], 100);

  const centre = buildCenterline(points, 5);
  assert.equal(centre.length_m, 100);
  assert.equal(centre.gps_length_m, 100);
  assert.equal(centre.points.length, 21);
  assert.equal(centre.points[0].s, 0);
  assert.equal(centre.points[20].s, 100);
  assert.ok(Math.abs(centre.points[10].x - 50) < 1e-9);
  assert.ok(Math.abs(centre.points[10].s - 50) < 1e-9);
});

test('interpolation clamps at the edges and is linear in between', () => {
  const points = straightPoints(100, 10);
  assert.deepEqual(interpolateXYAtTime(points, 2.5), { x: 25, y: 0 });
  assert.equal(interpolateAtTime(points, 2.5, 'x'), 25);
  assert.deepEqual(interpolateXYAtTime(points, -5), { x: 0, y: 0 });
  assert.deepEqual(interpolateXYAtTime(points, 500), { x: 100, y: 0 });
});

test('projectToCenterline keeps a monotonic +/-30 point window', () => {
  const centre = buildCenterline(straightPoints(500, 5), 5).points;
  const state = { lastIndex: 50 };

  // Point at the start, far behind the current window: must not jump to 0.
  const behind = projectToCenterline(centre, { x: 0, y: 0 }, state, 30);
  assert.equal(behind.index, 20);
  assert.equal(behind.s, 100);
  assert.equal(behind.wrapped, false);

  // A point 100 m ahead of the current index is within the window and moves it.
  const ahead = projectToCenterline(centre, { x: 200, y: 0 }, state, 30);
  assert.equal(ahead.index, 40);
  assert.equal(state.lastIndex, 40);
});

test('projectToCenterline has a start/finish wrap guard at both seams', () => {
  const centre = [];
  const n = 200;
  for (let i = 0; i < n; i += 1) {
    const angle = (2 * Math.PI * i) / n;
    centre.push({ s: i, x: 100 * Math.cos(angle), y: 100 * Math.sin(angle) });
  }

  // Late lap: a point on the start line must stay at the finish, not wrap to 0.
  const lateState = { lastIndex: n - 3 };
  const late = projectToCenterline(centre, { x: centre[0].x, y: centre[0].y }, lateState, 30);
  assert.equal(late.wrapped, true);
  assert.equal(late.index, n - 1);
  assert.ok(late.s > n - 10);

  // Early lap: a point on the finish line must stay at the start.
  const earlyState = { lastIndex: 2 };
  const early = projectToCenterline(centre, { x: centre[n - 1].x, y: centre[n - 1].y }, earlyState, 30);
  assert.equal(early.wrapped, true);
  assert.equal(early.index, 0);
});

test('speedBins integrates 5 m bins, scales to the official lap and aggregates 25 m', () => {
  const profile = [];
  for (let i = 0; i <= 40; i += 1) profile.push({ t: i * 0.25, s: i * 2.5, v: 36 }); // 10 m/s at 4 Hz
  const bins = speedBins(profile, 100, 10);
  assert.equal(bins.dt5.length, 20);
  assert.equal(bins.dt.length, 4);
  assert.ok(Math.abs(bins.preScaleTotal - 10) < 1e-9);
  assert.ok(Math.abs(bins.scale - 1) < 1e-9);
  assert.ok(Math.abs(sum(bins.dt) - 10) < 1e-9);
  assert.equal(bins.coveragePct, 100);
  assert.equal(bins.rejected, false);

  const scaled = speedBins(profile, 100, 11);
  assert.ok(Math.abs(sum(scaled.dt) - 11) < 1e-9);
  assert.ok(Math.abs(scaled.scale - 1.1) < 1e-9);
});

test('speedBins applies the 5 km/h floor rather than dividing by zero', () => {
  const profile = [];
  for (let i = 0; i <= 720; i += 1) profile.push({ t: i * 0.25, s: (i * 100) / 720, v: 1 });
  const bins = speedBins(profile, 100, 100, { gapS: 10 });
  assert.ok(bins.preScaleTotal > 0);
  assert.ok(Math.abs(sum(bins.dt) - 100) < 1e-9);
});

test('speedBins nulls gap-affected bins and rejects a lap with >15 % affected', () => {
  const partial = [];
  let t = 0;
  for (let i = 0; i <= 400; i += 1) {
    partial.push({ t, s: i * 2.5, v: 36 });
    t += 0.25;
    if (i === 80) t += 1.0; // 1.25 s gap around 200 m
  }
  const partialBins = speedBins(partial, 1000, 100);
  assert.equal(partialBins.rejected, false);
  assert.equal(partialBins.dt[8], null);
  assert.ok(partialBins.dt[9] > 0);
  assert.ok(partialBins.coveragePct > 90 && partialBins.coveragePct < 100);
  const covered = partialBins.dt.reduce((acc, value) => acc + (value ?? 0), 0);
  assert.ok(Math.abs(covered - partialBins.coveredTotal) < 1e-9);
  assert.ok(Math.abs(partialBins.coveragePct - (100 * covered) / partialBins.total) < 1e-9);

  const bigGap = [];
  let bigT = 0;
  for (let s = 0; s <= 5; s += 2.5) {
    bigGap.push({ t: bigT, s, v: 36 });
    bigT += 0.25;
  }
  bigT += 6.0; // no samples between 5 m and 50 m: 45 % of the lap affected
  for (let s = 50; s <= 100; s += 2.5) {
    bigGap.push({ t: bigT, s, v: 36 });
    bigT += 0.25;
  }
  const rejected = speedBins(bigGap, 100, 12);
  assert.equal(rejected.rejected, true);
  assert.ok(rejected.reasons.includes('gap_affected_pct'));
  assert.ok(rejected.affectedPct > 15);

  const extra = speedBins(partial, 1000, 100, { extraGapRanges: [[400, 600]] });
  assert.equal(extra.rejected, true);
  assert.ok(extra.affectedPct > 15);
});

test('sectorMarks converts official sector times into distance marks', () => {
  const dt = Array.from({ length: 20 }, () => 1);
  assert.deepEqual(sectorMarks(dt, [5, 10, 5]), [125, 375]);
  assert.deepEqual(sectorMarks(dt, { s1: 5, s2: 10, s3: 5 }), [125, 375]);
  assert.deepEqual(sectorMarks([], [5, 10, 5]), []);
});

test('validateLap accepts a well-covered synthetic lap', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const location = [];
  const carData = [];
  for (let i = 0; i <= 500; i += 1) {
    const date = new Date(t0 + i * 200).toISOString();
    location.push({ date, x: 20 + i * 2, y: 1000 });
    carData.push({ date, speed: 100 });
  }
  const result = validateLap({
    lapDuration: 100,
    dateStart: new Date(t0).toISOString(),
    location,
    carData,
  });
  assert.equal(result.valid, true, result.reasons.join(','));
  assert.ok(result.location.hz >= 4.9);
  assert.ok(result.location.span_pct > 99);
  assert.ok(result.gps_length_m > 0);
  assert.equal(result.location.ok, true);
  assert.equal(result.car.ok, true);

  const pre = validateLap({
    lapDuration: 100,
    dateStart: new Date(t0).toISOString(),
    location,
    carData: null,
  });
  assert.equal(pre.valid, true);
  assert.equal(pre.location.ok, true);
});

test('validateLap rejects low rate, short span, zero coordinates, gaps and bad GPS length', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const make = (hz = 5, seconds = 100, zeroAt = -1) => {
    const location = [];
    const carData = [];
    const count = Math.round(hz * seconds);
    for (let i = 0; i <= count; i += 1) {
      const date = new Date(t0 + (i * seconds * 1000) / count).toISOString();
      const zero = i === zeroAt;
      location.push({ date, x: zero ? 0 : 20 + i * 2, y: zero ? 0 : 1000 });
      carData.push({ date, speed: 100 });
    }
    return { location, carData };
  };
  const base = { lapDuration: 100, dateStart: new Date(t0).toISOString() };

  const lowRate = validateLap({ ...base, ...make(1, 100) });
  assert.equal(lowRate.valid, false);
  assert.ok(lowRate.reasons.includes('location_hz'));

  const short = validateLap({ ...base, ...make(5, 50) });
  assert.equal(short.valid, false);
  assert.ok(short.reasons.includes('location_span'));

  const zero = validateLap({ ...base, ...make(5, 100, 10) });
  assert.equal(zero.valid, false);
  assert.ok(zero.reasons.includes('location_zero'));

  const gapData = make(5, 100);
  const gapStart = Date.parse(new Date(t0 + 40000).toISOString());
  const gapEnd = Date.parse(new Date(t0 + 60000).toISOString());
  gapData.carData = gapData.carData.filter((p) => {
    const t = Date.parse(p.date);
    return t < gapStart || t > gapEnd;
  });
  const gap = validateLap({ ...base, ...gapData });
  assert.equal(gap.valid, false);
  assert.ok(gap.reasons.includes('car_gap'));

  const badGps = validateLap({ ...base, ...make(5, 100), gpsLengthM: 1200, medianGpsLengthM: 1000 });
  assert.equal(badGps.valid, false);
  assert.ok(badGps.reasons.includes('gps_length_off_median'));
});

test('same-driver-like synthetic laps stay inside the 0.03 s neutral band', () => {
  const centre = buildCenterline(
    Array.from({ length: 629 }, (_, i) => ({
      t: i,
      x: 100 * Math.cos((2 * Math.PI * i) / 628),
      y: 100 * Math.sin((2 * Math.PI * i) / 628),
    })),
    5,
  );
  const length = centre.length_m;

  const makeProfile = (phase, noise) => {
    const profile = [];
    let t = 0;
    for (let s = 0; s <= length; s += 5) {
      const v = 60 + 8 * Math.sin((2 * Math.PI * s) / 220 + phase) + noise * Math.sin((2 * Math.PI * s) / 37);
      profile.push({ t, s, v });
      t += 5 / (v / 3.6);
    }
    return { profile, lapTime: t };
  };

  const a = makeProfile(0, 0.15);
  const b = makeProfile(0.02, 0.18);
  const binsA = speedBins(a.profile, length, a.lapTime);
  const binsB = speedBins(b.profile, length, b.lapTime);
  assert.equal(binsA.rejected, false);
  assert.equal(binsB.rejected, false);
  assert.ok(Math.abs(sum(binsA.dt) - a.lapTime) < 0.05);
  assert.ok(Math.abs(sum(binsB.dt) - b.lapTime) < 0.05);

  const segments = Math.floor(Math.min(binsA.dt.length, binsB.dt.length) / 4);
  const deltas = [];
  for (let i = 0; i < segments; i += 1) {
    const ta = sum(binsA.dt.slice(i * 4, i * 4 + 4));
    const tb = sum(binsB.dt.slice(i * 4, i * 4 + 4));
    deltas.push(ta - tb);
  }
  const rms = Math.sqrt(deltas.reduce((acc, d) => acc + d * d, 0) / deltas.length);
  const neutral = deltas.filter((d) => Math.abs(d) <= 0.03).length;
  assert.ok(rms < 0.03, `rms ${rms}`);
  assert.ok(neutral / deltas.length >= 0.9, `neutral share ${neutral}/${deltas.length}`);
});

test('median helper ignores non-finite values', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([1, Number.NaN, 3]), 2);
});
