import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildViewBox,
  buildSegments,
  buildPath,
  segmentTimesFromBins,
  smoothSeries,
  classifySeries,
  mergeShortRuns,
  summarise,
  formatDelta,
  formatTime,
  pointAtDistance,
  sectorMarkPoints,
} from '../assets/track.js';

/** A closed 400 m square, first point repeated at the end. */
const SQUARE = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
  [0, 0],
];

/** The same square without the repeated end point (implicit closing edge). */
const OPEN_SQUARE = SQUARE.slice(0, -1);

/** A 250 m straight, 10 m between samples. */
const LINE_250 = Array.from({ length: 26 }, (_, i) => ({ x: i * 10, y: 0 }));

const closeTo = (actual, expected, tolerance = 1e-6) =>
  Math.abs(actual - expected) <= tolerance;

test('buildViewBox: 1000x1000, preserved aspect, y flipped', () => {
  const square = buildViewBox(SQUARE);
  assert.equal(square.viewBox, '0 0 1000 1000');
  assert.equal(square.points.length, 5);
  assert.ok(closeTo(square.points[0].x, 64));
  assert.ok(closeTo(square.points[0].y, 936));
  assert.ok(closeTo(square.points[2].x, 936));
  assert.ok(closeTo(square.points[2].y, 64));
  assert.ok(closeTo(square.points[4].x, square.points[0].x));
  assert.ok(closeTo(square.points[4].y, square.points[0].y));

  const wide = buildViewBox([
    [0, 0],
    [200, 0],
    [200, 100],
    [0, 100],
  ]);
  assert.ok(closeTo(wide.points[0].x, 64));
  assert.ok(closeTo(wide.points[0].y, 718));
  assert.ok(closeTo(wide.points[2].x, 936));
  assert.ok(closeTo(wide.points[2].y, 282));
  const drawnWidth = wide.points[2].x - wide.points[0].x;
  const drawnHeight = wide.points[0].y - wide.points[2].y;
  assert.ok(closeTo(drawnWidth / drawnHeight, 2));

  assert.deepEqual(buildViewBox([]), { points: [], viewBox: '0 0 1000 1000' });
});

test('buildViewBox: accepts [x,y] pairs and custom size/padding', () => {
  const view = buildViewBox(
    [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
    500,
    500,
    20,
  );
  assert.equal(view.viewBox, '0 0 500 500');
  assert.ok(closeTo(view.points[0].x, 20));
  assert.ok(closeTo(view.points[0].y, 480));
  assert.ok(closeTo(view.points[2].x, 480));
});

test('buildSegments: 400 m square into 4 exact, gap-free segments', () => {
  const segments = buildSegments(SQUARE, 400, 100);
  assert.equal(segments.length, 4);
  assert.deepEqual(
    segments.map((segment) => segment.index),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    segments.map((segment) => [segment.d0, segment.d1]),
    [
      [0, 100],
      [100, 200],
      [200, 300],
      [300, 400],
    ],
  );
  assert.deepEqual(segments[0].points, [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);
  assert.deepEqual(segments[0].mid, { x: 50, y: 0 });
  assert.deepEqual(segments[1].mid, { x: 100, y: 50 });
  assert.deepEqual(segments[2].mid, { x: 50, y: 100 });
  assert.deepEqual(segments[3].mid, { x: 0, y: 50 });
  assert.deepEqual(segments[3].points.at(-1), { x: 0, y: 0 });

  // Shared boundaries are exactly equal, not merely close.
  for (let i = 1; i < segments.length; i += 1) {
    assert.deepEqual(segments[i].points[0], segments[i - 1].points.at(-1));
  }
});

test('buildSegments: implicit closing edge for a circuit without repeated point', () => {
  const segments = buildSegments(OPEN_SQUARE, 400, 100);
  assert.equal(segments.length, 4);
  assert.deepEqual(segments[3].points.at(-1), { x: 0, y: 0 });
  assert.ok(closeTo(segments[3].mid.x, 0));
  assert.ok(closeTo(segments[3].mid.y, 50));
});

test('buildSegments: a genuinely open polyline is not closed', () => {
  const line = Array.from({ length: 106 }, (_, i) => ({ x: i * 10, y: 0 }));
  const segments = buildSegments(line, 1050, 100);
  assert.equal(segments.length, 11);
  assert.deepEqual([segments[10].d0, segments[10].d1], [1000, 1050]);
  assert.ok(closeTo(segments[10].points.at(-1).x, 1050));
});

test('buildSegments: trailing partial included at >= 50 %, dropped below', () => {
  assert.equal(buildSegments(LINE_250, 250, 100).length, 3);
  assert.equal(buildSegments(SQUARE, 240, 100).length, 2);
  assert.equal(buildSegments(SQUARE, 200, 100).length, 2);

  const tail = buildSegments(LINE_250, 250, 100)[2];
  assert.deepEqual([tail.d0, tail.d1], [200, 250]);
  assert.deepEqual(tail.mid, { x: 225, y: 0 });
});

test('buildSegments: normalized SVG points are scaled by lengthM', () => {
  // Regression: geometry length (3488 units) != lap length (400 m). Using
  // geometry instead of lengthM would produce 34 tiny segments.
  const view = buildViewBox(SQUARE);
  const segments = buildSegments(view.points, 400, 100);
  assert.equal(segments.length, 4);
  assert.ok(closeTo(segments[0].mid.x, 500));
  assert.ok(closeTo(segments[0].mid.y, 936));
  assert.ok(closeTo(segments[1].mid.x, 936));
  assert.ok(closeTo(segments[1].mid.y, 500));
  assert.ok(closeTo(segments[2].mid.x, 500));
  assert.ok(closeTo(segments[2].mid.y, 64));
  assert.ok(closeTo(segments[3].mid.x, 64));
  assert.ok(closeTo(segments[3].mid.y, 500));
});

test('buildSegments: closed oval loop has no seam gap', () => {
  const OVAL = Array.from({ length: 41 }, (_, i) => {
    const t = (2 * Math.PI * i) / 40;
    return [300 * Math.cos(t), 100 * Math.sin(t)];
  });
  const perimeter = OVAL.reduce(
    (sum, point, i) =>
      i === 0
        ? 0
        : sum + Math.hypot(point[0] - OVAL[i - 1][0], point[1] - OVAL[i - 1][1]),
    0,
  );
  const segments = buildSegments(OVAL, perimeter, 100);
  const expected = Math.floor(perimeter / 100) + (perimeter % 100 >= 50 ? 1 : 0);
  assert.equal(segments.length, expected);
  for (let i = 1; i < segments.length; i += 1) {
    assert.deepEqual(segments[i].points[0], segments[i - 1].points.at(-1));
  }
  const halfway = pointAtDistance(OVAL, perimeter, perimeter / 2);
  assert.ok(closeTo(halfway.x, -300, 1e-6));
  assert.ok(closeTo(halfway.y, 0, 1e-6));
});

test('buildPath: compact, rounded, and empty-safe', () => {
  assert.equal(buildPath([]), '');
  assert.equal(buildPath([{ x: 0, y: 0 }, { x: 10, y: 5 }]), 'M0 0 L10 5');
  assert.equal(
    buildPath([
      { x: 1.234, y: 5.678 },
      { x: 10, y: 20 },
    ]),
    'M1.23 5.68 L10 20',
  );
  assert.equal(buildPath([[0, 0], [1, 1]]), 'M0 0 L1 1');
});

test('segmentTimesFromBins: four 25 m bins per 100 m segment', () => {
  assert.deepEqual(segmentTimesFromBins([1, 2, 3, 4, 5, 6, 7, 8], 25, 100), [10, 26]);
  assert.deepEqual(segmentTimesFromBins([], 25, 100), []);
});

test('segmentTimesFromBins: one null bin nulls the whole segment', () => {
  assert.deepEqual(segmentTimesFromBins([1, 2, null, 4, 5, 6, 7, 8], 25, 100), [null, 26]);
  assert.deepEqual(
    segmentTimesFromBins([1, 2, 3, 4, undefined, 6, 7, 8], 25, 100),
    [10, null],
  );
});

test('segmentTimesFromBins: 50 % tail rule and integer multiple contract', () => {
  assert.deepEqual(segmentTimesFromBins([1, 2, 3, 4, 5, 6], 25, 100), [10, 11]);
  assert.deepEqual(segmentTimesFromBins([1, 2, 3, 4, 5], 25, 100), [10]);
  assert.deepEqual(
    segmentTimesFromBins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 25, 100),
    [10, 26, 19],
  );
  assert.throws(() => segmentTimesFromBins([1, 2], 25, 90), RangeError);
  assert.throws(() => segmentTimesFromBins([1, 2], 0, 100), RangeError);
});

test('smoothSeries: centred average, conservative at nulls', () => {
  assert.deepEqual(smoothSeries([1, 2, 3]), [1.5, 2, 2.5]);
  assert.deepEqual(smoothSeries([1, 2, 3, 4, 5], 3), [1.5, 2, 3, 4, 4.5]);
  // A null anywhere in the window makes the result null; nulls never bridge.
  assert.deepEqual(smoothSeries([1, 2, 3, 4, null, 6], 3), [1.5, 2, 3, null, null, null]);
  assert.deepEqual(smoothSeries([null, null, null], 3), [null, null, null]);
  assert.deepEqual(smoothSeries([null, 2, null], 3), [null, null, null]);
  assert.deepEqual(smoothSeries([], 3), []);
});

test('classifySeries: deadband edges, A/B sign, null-safe', () => {
  assert.deepEqual(
    classifySeries([-0.5, -0.03, -0.029, 0, 0.029, 0.03, 0.5], 0.03),
    [-1, -1, 0, 0, 0, 1, 1],
  );
  assert.deepEqual(classifySeries([null, undefined, NaN, Infinity, -Infinity]), [
    null,
    null,
    null,
    null,
    null,
  ]);
  assert.deepEqual(classifySeries([-0.05, 0.05], 0.1), [0, 0]);
});

test('mergeShortRuns: isolated coloured runs merge, long runs and nulls survive', () => {
  assert.deepEqual(mergeShortRuns([-1, -1, 1, -1, -1], 2), [-1, -1, -1, -1, -1]);
  assert.deepEqual(mergeShortRuns([-1, 1, -1], 2), [-1, -1, -1]);
  assert.deepEqual(mergeShortRuns([-1, -1, 1, 1], 2), [-1, -1, 1, 1]);
  assert.deepEqual(mergeShortRuns([1, null, 1], 2), [1, null, 1]);
  assert.deepEqual(
    mergeShortRuns([1, 1, -1, null, -1, 1, 1], 2),
    [1, 1, 1, null, 1, 1, 1],
  );
  assert.deepEqual(mergeShortRuns([-1, 1, -1], 1), [-1, 1, -1]);
});

test('mergeShortRuns: neutral uncertainty is never recoloured', () => {
  // A one-segment neutral inside A territory stays neutral: the 0.03 s band is
  // a fact, not confetti to be smoothed away.
  assert.deepEqual(mergeShortRuns([1, 1, 0, 1, 1], 2), [1, 1, 0, 1, 1]);
  assert.deepEqual(mergeShortRuns([0, 0, 1, 0, 0], 2), [0, 0, 0, 0, 0]);
  assert.deepEqual(mergeShortRuns([0, 1, 0, 0], 2), [0, 0, 0, 0]);
});

test('mergeShortRuns: start/finish seam is one loop', () => {
  // Leading and trailing 1s form a single 3-segment run across the seam.
  assert.deepEqual(mergeShortRuns([1, -1, 1, 1], 2), [1, 1, 1, 1]);
  // Both runs are long enough; the seam must not create extra merging.
  assert.deepEqual(mergeShortRuns([1, -1, -1, 1], 2), [1, -1, -1, 1]);
});

test('summarise: counts, metres and total-based shares', () => {
  const summary = summarise({ classes: [-1, 0, 1, 1], segmentM: 100 });
  assert.deepEqual(summary, {
    aSegments: 1,
    bSegments: 2,
    neutralSegments: 1,
    total: 4,
    aMetres: 100,
    bMetres: 200,
    shareA: 0.25,
    shareB: 0.5,
  });

  const withUnknown = summarise({ classes: [-1, null, 1], segmentM: 50 });
  assert.equal(withUnknown.total, 3);
  assert.equal(withUnknown.neutralSegments, 0);
  assert.equal(withUnknown.aMetres, 50);
  assert.equal(withUnknown.bMetres, 50);

  assert.deepEqual(summarise({}), {
    aSegments: 0,
    bSegments: 0,
    neutralSegments: 0,
    total: 0,
    aMetres: 0,
    bMetres: 0,
    shareA: 0,
    shareB: 0,
  });
});

test('formatDelta: true minus sign, signless zero, configurable digits', () => {
  assert.equal(formatDelta(-0.042), '−0.04 s');
  assert.equal(formatDelta(1.255), '+1.25 s');
  assert.equal(formatDelta(0), '0.00 s');
  assert.equal(formatDelta(-0.0001), '0.00 s');
  assert.equal(formatDelta(-0.042, 3), '−0.042 s');
  assert.equal(formatDelta(null), '—');
  assert.equal(formatDelta(Number.NaN), '—');
});

test('formatTime: m:ss.mmm, carries and short laps', () => {
  assert.equal(formatTime(99.811), '1:39.811');
  assert.equal(formatTime(97.976), '1:37.976');
  assert.equal(formatTime(59.5), '59.500');
  assert.equal(formatTime(9.5), '9.500');
  assert.equal(formatTime(60), '1:00.000');
  assert.equal(formatTime(119.9999), '2:00.000');
  assert.equal(formatTime(null), '—');
});

test('pointAtDistance: interpolation, closure and wrap', () => {
  assert.deepEqual(pointAtDistance(SQUARE, 400, 50), { x: 50, y: 0 });
  assert.deepEqual(pointAtDistance(SQUARE, 400, 150), { x: 100, y: 50 });
  assert.deepEqual(pointAtDistance(SQUARE, 400, 350), { x: 0, y: 50 });
  assert.deepEqual(pointAtDistance(SQUARE, 400, 400), { x: 0, y: 0 });
  assert.deepEqual(pointAtDistance(SQUARE, 400, 450), { x: 50, y: 0 });
  assert.deepEqual(pointAtDistance(OPEN_SQUARE, 400, 350), { x: 0, y: 50 });
  assert.deepEqual(pointAtDistance([{ x: 0, y: 0 }, { x: 100, y: 0 }], 100, 100), {
    x: 100,
    y: 0,
  });
  assert.equal(pointAtDistance([], 400, 50), null);
});

test('sectorMarkPoints: perpendicular ticks at metre marks', () => {
  const marks = sectorMarkPoints(SQUARE, [100, 300]);
  assert.equal(marks.length, 2);
  assert.ok(closeTo(marks[0].mid.x, 100));
  assert.ok(closeTo(marks[0].mid.y, 0));
  assert.ok(closeTo(marks[1].mid.x, 0));
  assert.ok(closeTo(marks[1].mid.y, 100));

  for (const mark of marks) {
    assert.ok(closeTo(Math.hypot(mark.a.x - mark.mid.x, mark.a.y - mark.mid.y), 10));
    assert.ok(closeTo(Math.hypot(mark.b.x - mark.mid.x, mark.b.y - mark.mid.y), 10));
  }

  // Mid-side mark: the tick is perpendicular to a horizontal tangent.
  const side = sectorMarkPoints(SQUARE, [50])[0];
  assert.ok(closeTo(side.mid.x, 50));
  assert.ok(closeTo(side.mid.y, 0));
  assert.ok(closeTo(side.a.x, 50));
  assert.ok(closeTo(side.a.y, 10));
});

test('sectorMarkPoints: normalized SVG points + lengthM sees the same marks', () => {
  // Regression for the inverted metre -> SVG mapping. The old code multiplied
  // by lengthM/geometry and clamped both marks to the finish point.
  const view = buildViewBox(SQUARE);
  const viewMarks = sectorMarkPoints(view.points, [100, 300], 400);
  assert.equal(viewMarks.length, 2);
  assert.ok(closeTo(viewMarks[0].mid.x, 936));
  assert.ok(closeTo(viewMarks[0].mid.y, 936));
  assert.ok(closeTo(viewMarks[1].mid.x, 64));
  assert.ok(closeTo(viewMarks[1].mid.y, 64));

  const metreMarks = sectorMarkPoints(SQUARE, [100, 300]);
  assert.ok(closeTo(metreMarks[0].mid.x, 100));
  assert.ok(closeTo(metreMarks[0].mid.y, 0));
  assert.ok(closeTo(metreMarks[1].mid.x, 0));
  assert.ok(closeTo(metreMarks[1].mid.y, 100));
});
