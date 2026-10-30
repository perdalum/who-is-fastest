/**
 * Pure track geometry and comparison helpers for "Who is the fastest?".
 *
 * No DOM, no fetch, no mutable module state. Every function accepts plain
 * arrays/objects and returns plain values, so the same code runs in the browser
 * and under `node --test`.
 *
 * Conventions
 * -----------
 * - Track points are in metres on the data plane, y up.
 * - `buildViewBox` is the only function that flips y for SVG.
 * - `trackPoints` may be `[[x, y], ...]` (the JSON shape) or `[{x, y}, ...]`.
 * - A circuit is closed. A missing final edge is added when the gap between the
 *   first and last point is on the scale of the point spacing; a genuinely open
 *   polyline (as used in unit tests) is left open.
 * - Segment time deltas are `timeA - timeB`; negative means A was quicker.
 * - Segments are adjacent but never overlap: segment i ends exactly where
 *   segment i+1 starts, so butt-capped SVG strokes have no gaps or colour
 *   bleed. No antialiasing epsilon is added.
 */

const EPSILON = 1e-9;

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{start: number, length: number, value: number}} Run */

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Accept both `[x, y]` and `{x, y}` and reject non-finite coordinates.
 * @param {unknown} value
 * @returns {Point|null}
 */
function toPoint(value) {
  if (Array.isArray(value)) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  if (value && typeof value === 'object') {
    const x = Number(/** @type {{x?: unknown}} */ (value).x);
    const y = Number(/** @type {{y?: unknown}} */ (value).y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  return null;
}

/**
 * @param {unknown} values
 * @returns {Point[]}
 */
function toPoints(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    const point = toPoint(value);
    if (point) out.push(point);
  }
  return out;
}

/** @param {number} a @param {number} b @param {number} t */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** @param {number} value */
function pathNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** @param {unknown} value */
function finiteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function normaliseClass(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {Point[]} points */
function consecutiveLengths(points) {
  const lengths = [];
  for (let i = 1; i < points.length; i += 1) {
    lengths.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return lengths;
}

/** @param {number[]} values */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Build a distance-parameterised polyline. Raw arclength is scaled to the
 * caller's `lengthM` so GPS-derived geometry can be compared on the official
 * lap length (or, for SVG-space points, so segments follow the drawn shape).
 *
 * @param {Point[]} points
 * @param {number} [lengthM]
 */
function buildPolyline(points, lengthM) {
  const n = points.length;
  const cumulative = [0];
  const edges = consecutiveLengths(points);
  for (let i = 1; i < n; i += 1) {
    cumulative.push(cumulative[i - 1] + edges[i - 1]);
  }

  const openLength = n > 0 ? cumulative[n - 1] : 0;
  let totalRaw = openLength;
  let closed = false;

  if (n >= 3) {
    const gap = Math.hypot(points[0].x - points[n - 1].x, points[0].y - points[n - 1].y);
    const typical = median(edges);

    if (gap <= EPSILON) {
      // The supplied points already return to the start.
      closed = true;
    } else if (typical > EPSILON && gap <= typical * 3) {
      // A circuit whose final edge was omitted from the point list.
      totalRaw += gap;
      closed = true;
    }
  }

  const requested = Number(lengthM);
  const total =
    Number.isFinite(requested) && requested > 0 ? requested : totalRaw;
  const scale = totalRaw > 0 ? total / totalRaw : 1;

  return { points, cumulative, totalRaw, scale, total, closed };
}

/**
 * Point at a raw arclength in [0, totalRaw] (never wraps).
 * @param {ReturnType<typeof buildPolyline>} poly
 * @param {number} raw
 * @returns {Point|null}
 */
function pointAtRaw(poly, raw) {
  const { points, cumulative, totalRaw, closed } = poly;
  const n = points.length;
  if (n === 0) return null;
  if (n === 1 || totalRaw <= EPSILON) return { ...points[0] };

  const distance = Math.min(Math.max(raw, 0), totalRaw);

  for (let i = 0; i < n - 1; i += 1) {
    const start = cumulative[i];
    const end = cumulative[i + 1];
    if (distance <= end) {
      if (end - start <= EPSILON) return { ...points[i] };
      const t = (distance - start) / (end - start);
      return {
        x: lerp(points[i].x, points[i + 1].x, t),
        y: lerp(points[i].y, points[i + 1].y, t),
      };
    }
  }

  if (!closed) return { ...points[n - 1] };

  // Closing segment from the last supplied point back to the first.
  const start = cumulative[n - 1];
  if (totalRaw - start <= EPSILON) return { ...points[0] };
  const t = (distance - start) / (totalRaw - start);
  return {
    x: lerp(points[n - 1].x, points[0].x, t),
    y: lerp(points[n - 1].y, points[0].y, t),
  };
}

/**
 * Point at a scaled distance along the lap. Distances outside [0, total] wrap.
 * `total` itself resolves to the geometric finish (the start on a closed lap).
 *
 * @param {ReturnType<typeof buildPolyline>} poly
 * @param {number} distanceM
 * @returns {Point|null}
 */
function pointAtScaled(poly, distanceM) {
  if (poly.points.length === 0) return null;
  const total = poly.total;
  if (total <= EPSILON) return { ...poly.points[0] };

  const distance = Number(distanceM);
  if (!Number.isFinite(distance)) return null;

  let d = distance;
  if (d < 0 || d > total) {
    d = ((d % total) + total) % total;
  }
  const raw = (d / total) * poly.totalRaw;
  return pointAtRaw(poly, raw);
}

/**
 * Slice the polyline between two scaled distances, keeping original vertices
 * and interpolating both ends exactly. Adjacent calls with the same boundary
 * return the identical boundary coordinate.
 *
 * @param {ReturnType<typeof buildPolyline>} poly
 * @param {number} d0
 * @param {number} d1
 * @returns {Point[]}
 */
function slicePolyline(poly, d0, d1) {
  const start = pointAtScaled(poly, d0);
  if (!start) return [];

  const out = [start];
  const { points, cumulative, scale } = poly;

  for (let i = 1; i < points.length; i += 1) {
    const d = cumulative[i] * scale;
    if (d > d0 + EPSILON && d < d1 - EPSILON) {
      out.push({ ...points[i] });
    }
  }

  const end = pointAtScaled(poly, d1);
  if (end) {
    const previous = out[out.length - 1];
    if (
      Math.abs(previous.x - end.x) > EPSILON ||
      Math.abs(previous.y - end.y) > EPSILON
    ) {
      out.push(end);
    }
  }

  return out;
}

/**
 * Rotate the class list so that no same-class run is split across the seam.
 * The circuit is a loop, so endpoints are neighbours unless a null separates
 * them. Merging then runs linearly and the result is mapped back.
 *
 * @param {(number|null)[]} values
 */
function circularView(values) {
  const n = values.length;
  const map = [];
  if (n === 0) return { rotated: [], map };

  let start = 0;
  const nullIndex = values.indexOf(null);
  if (nullIndex !== -1) {
    start = nullIndex;
  } else {
    for (let i = 0; i < n; i += 1) {
      if (values[i] !== values[(i - 1 + n) % n]) {
        start = i;
        break;
      }
    }
  }

  const rotated = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const index = (start + i) % n;
    rotated[i] = values[index];
    map.push(index);
  }
  return { rotated, map };
}

/**
 * @param {(number|null)[]} values
 * @returns {Run[]}
 */
function findRuns(values) {
  const runs = [];
  let i = 0;
  while (i < values.length) {
    const value = values[i];
    if (value === null) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < values.length && values[end] === value) end += 1;
    runs.push({ start: i, length: end - i, value });
    i = end;
  }
  return runs;
}

/**
 * Build a perpendicular tick marker around a point on a polyline.
 * Width is in the coordinate space of the polyline (10 units).
 *
 * @param {ReturnType<typeof buildPolyline>} poly
 * @param {number} distance
 * @param {number} [halfLength=10]
 */
function tickAt(poly, distance, halfLength = 10) {
  const mid = pointAtScaled(poly, distance);
  if (!mid) return null;

  const before = pointAtScaled(poly, distance - 4);
  const after = pointAtScaled(poly, distance + 4);
  if (!before || !after) return null;

  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;

  return {
    mid,
    a: { x: mid.x + nx * halfLength, y: mid.y + ny * halfLength },
    b: { x: mid.x - nx * halfLength, y: mid.y - ny * halfLength },
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fit track points into an SVG box, preserving aspect ratio and flipping y.
 * The drawing is centred, with `padding` SVG units on every side.
 *
 * @param {unknown[]} points track points in metres, `[x,y]` or `{x,y}`
 * @param {number} [width=1000]
 * @param {number} [height=1000]
 * @param {number} [padding=64]
 * @returns {{points: Point[], viewBox: string}}
 */
export function buildViewBox(points, width = 1000, height = 1000, padding = 64) {
  const input = toPoints(points);
  const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 1000;
  const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : 1000;
  const pad = Math.max(
    0,
    Math.min(Number.isFinite(Number(padding)) ? Number(padding) : 64, w / 2, h / 2),
  );

  const viewBox = `0 0 ${pathNumber(w)} ${pathNumber(h)}`;
  if (input.length === 0) return { points: [], viewBox };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of input) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const availableWidth = Math.max(0, w - 2 * pad);
  const availableHeight = Math.max(0, h - 2 * pad);

  let scale = 1;
  if (spanX > 0 && spanY > 0) {
    scale = Math.min(availableWidth / spanX, availableHeight / spanY);
  } else if (spanX > 0) {
    scale = availableWidth / spanX;
  } else if (spanY > 0) {
    scale = availableHeight / spanY;
  }

  const usedWidth = spanX * scale;
  const usedHeight = spanY * scale;
  const left = pad + (availableWidth - usedWidth) / 2;
  const top = pad + (availableHeight - usedHeight) / 2;

  const normalised = input.map((point) => ({
    x: left + (point.x - minX) * scale,
    // Data y increases upward; SVG y increases downward.
    y: top + usedHeight - (point.y - minY) * scale,
  }));

  return { points: normalised, viewBox };
}

/**
 * Split the lap into visual segments. Endpoints are interpolated exactly, so
 * segment i's last point is segment i+1's first point (no gaps or overlap).
 * A trailing partial segment is returned only when it covers at least half a
 * full segment.
 *
 * `trackPoints` may be metre-space data or the SVG-space points returned by
 * `buildViewBox`; `lengthM` scales either one to the lap length.
 *
 * @param {unknown[]} trackPoints track points in metres (or SVG units)
 * @param {number} lengthM lap length in metres
 * @param {number} segmentM visual segment length in metres
 * @returns {{index: number, d0: number, d1: number, points: Point[], mid: Point}[]}
 */
export function buildSegments(trackPoints, lengthM, segmentM = 100) {
  const points = toPoints(trackPoints);
  const segment = Number(segmentM);
  if (points.length === 0 || !Number.isFinite(segment) || segment <= 0) return [];

  const length = Number(lengthM);
  const poly = buildPolyline(
    points,
    Number.isFinite(length) && length > 0 ? length : undefined,
  );
  if (poly.total <= EPSILON) return [];

  const fullCount = Math.floor(poly.total / segment);
  const remainder = poly.total - fullCount * segment;
  const includePartial = remainder >= segment * 0.5 - EPSILON;
  const count = fullCount + (includePartial ? 1 : 0);

  const segments = [];
  for (let index = 0; index < count; index += 1) {
    const d0 = index * segment;
    const d1 = Math.min(poly.total, d0 + segment);
    const mid = pointAtScaled(poly, d0 + (d1 - d0) / 2);
    segments.push({
      index,
      d0,
      d1,
      points: slicePolyline(poly, d0, d1),
      mid: mid ?? { ...points[0] },
    });
  }
  return segments;
}

/**
 * Build an SVG path from points. Coordinates are rounded to 2 SVG units
 * (0.01 of the viewBox), keeping the DOM compact; adjacent segments share the
 * same rounded endpoint.
 *
 * @param {unknown[]} points
 * @returns {string}
 */
export function buildPath(points) {
  const input = toPoints(points);
  return input
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${pathNumber(point.x)} ${pathNumber(point.y)}`,
    )
    .join(' ');
}

/**
 * Sum per-bin times into visual segments. A segment containing any null bin is
 * null: a gap is never bridged by interpolation.
 *
 * The contract fixes `segmentM / gridM` to an integer (four 25 m bins per
 * 100 m segment). A trailing partial group is included only at >= 50 %.
 *
 * @param {(number|null|undefined)[]} dt seconds per bin
 * @param {number} gridM bin length in metres
 * @param {number} segmentM visual segment length in metres
 * @returns {(number|null)[]}
 */
export function segmentTimesFromBins(dt, gridM = 25, segmentM = 100) {
  if (!Array.isArray(dt)) return [];

  const grid = Number(gridM);
  const segment = Number(segmentM);
  if (!Number.isFinite(grid) || grid <= 0) {
    throw new RangeError('gridM must be a positive number');
  }
  if (!Number.isFinite(segment) || segment <= 0) {
    throw new RangeError('segmentM must be a positive number');
  }

  const binsPerSegment = segment / grid;
  if (!Number.isInteger(binsPerSegment)) {
    throw new RangeError('segmentM must be an integer multiple of gridM');
  }

  const result = [];
  for (let start = 0; start < dt.length; start += binsPerSegment) {
    const end = Math.min(dt.length, start + binsPerSegment);
    const covered = (end - start) * grid;
    if (covered < segment * 0.5 - EPSILON) break;

    let total = 0;
    let missing = false;
    for (let i = start; i < end; i += 1) {
      const value = finiteNumberOrNull(dt[i]);
      if (value === null) {
        missing = true;
      } else {
        total += value;
      }
    }
    result.push(missing ? null : total);
  }
  return result;
}

/**
 * Centred moving average over an odd window. Nulls are preserved and never
 * bridged: if any value in the window is null, the result is null. This is the
 * conservative choice — a smoothed segment adjacent to a gap stays neutral
 * rather than being inferred from partial data.
 *
 * @param {(number|null|undefined)[]} values
 * @param {number} [window=3]
 * @returns {(number|null)[]}
 */
export function smoothSeries(values, window = 3) {
  if (!Array.isArray(values)) return [];
  const n = values.length;
  if (n === 0) return [];

  const rawWindow = Math.floor(Number(window));
  const size = Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : 3;
  const before = Math.floor((size - 1) / 2);
  const after = size - 1 - before;

  const source = values.map(finiteNumberOrNull);
  const result = new Array(n);

  for (let i = 0; i < n; i += 1) {
    if (source[i] === null) {
      result[i] = null;
      continue;
    }
    let sum = 0;
    let count = 0;
    let complete = true;
    const from = Math.max(0, i - before);
    const to = Math.min(n - 1, i + after);
    for (let j = from; j <= to; j += 1) {
      if (source[j] === null) {
        complete = false;
        break;
      }
      sum += source[j];
      count += 1;
    }
    result[i] = complete && count > 0 ? sum / count : null;
  }
  return result;
}

/**
 * Classify time deltas (`timeA - timeB`) with a deadband.
 * -1 = A quicker, 0 = inside the band, 1 = B quicker, null = no data.
 * A delta exactly on the deadband edge is classified (|delta| >= deadband).
 *
 * @param {(number|null|undefined)[]} deltas
 * @param {number} [deadband=0.03]
 * @returns {(-1|0|1|null)[]}
 */
export function classifySeries(deltas, deadband = 0.03) {
  if (!Array.isArray(deltas)) return [];
  const band =
    Number.isFinite(Number(deadband)) && Number(deadband) >= 0
      ? Number(deadband)
      : 0.03;

  return deltas.map((delta) => {
    const value = finiteNumberOrNull(delta);
    if (value === null) return null;
    if (value === 0) return 0;
    if (Math.abs(value) < band) return 0;
    return value < 0 ? -1 : 1;
  });
}

/**
 * Merge short runs of **coloured** classes into a neighbour. Neutral runs and
 * nulls are never recoloured: uncertainty must stay visible, and a gap is never
 * bridged. A short run with two different coloured neighbours becomes neutral.
 * The list is treated as a closed loop for the start/finish seam, except where
 * a null separates the ends.
 *
 * @param {(number|null|undefined)[]} classes -1 (A), 0 (neutral), 1 (B), null
 * @param {number} [minRun=2]
 * @returns {(number|null)[]}
 */
export function mergeShortRuns(classes, minRun = 2) {
  if (!Array.isArray(classes)) return [];
  const out = classes.map(normaliseClass);
  const n = out.length;
  const minimum = Number(minRun);
  if (n === 0 || !Number.isFinite(minimum) || minimum <= 1) return out;

  const maxMerges = n + 1;
  for (let pass = 0; pass < maxMerges; pass += 1) {
    const { rotated, map } = circularView(out);
    const runs = findRuns(rotated);
    const shortRuns = runs.filter(
      (run) => run.value !== 0 && run.length < minimum,
    );
    if (shortRuns.length === 0) break;

    let merged = false;
    for (const run of shortRuns) {
      const previous = rotated[(run.start - 1 + n) % n];
      const next = rotated[(run.start + run.length) % n];
      const leftColour = previous === -1 || previous === 1 ? previous : null;
      const rightColour = next === -1 || next === 1 ? next : null;
      const touchesNeutral = previous === 0 || next === 0;

      let target = null;
      if (leftColour !== null && rightColour !== null) {
        target = leftColour === rightColour ? leftColour : 0;
      } else if (leftColour !== null || rightColour !== null) {
        target = touchesNeutral ? 0 : leftColour ?? rightColour;
      } else if (touchesNeutral) {
        target = 0;
      }

      if (target !== null && target !== run.value) {
        for (let i = 0; i < run.length; i += 1) {
          rotated[run.start + i] = target;
        }
        for (let i = 0; i < n; i += 1) {
          out[map[i]] = rotated[i];
        }
        merged = true;
        break;
      }
    }

    if (!merged) break;
  }

  return out;
}

/**
 * Aggregate classified segments for the stats panel.
 *
 * `total` is the number of track segments (including unknown/null entries, which
 * the UI draws as neutral). `shareA` and `shareB` are shares of that total.
 *
 * @param {{classes?: (number|null|undefined)[], segmentM?: number, aName?: string, bName?: string}} [input]
 * @returns {{aSegments: number, bSegments: number, neutralSegments: number, total: number, aMetres: number, bMetres: number, shareA: number, shareB: number}}
 */
export function summarise({ classes, segmentM = 100 } = {}) {
  const list = Array.isArray(classes) ? classes : [];
  const segment = Number(segmentM);
  const metresPerSegment = Number.isFinite(segment) && segment > 0 ? segment : 0;

  let aSegments = 0;
  let bSegments = 0;
  let neutralSegments = 0;

  for (const value of list) {
    if (value === -1) aSegments += 1;
    else if (value === 1) bSegments += 1;
    else if (value === 0) neutralSegments += 1;
  }

  const total = list.length;

  return {
    aSegments,
    bSegments,
    neutralSegments,
    total,
    aMetres: aSegments * metresPerSegment,
    bMetres: bSegments * metresPerSegment,
    shareA: total > 0 ? aSegments / total : 0,
    shareB: total > 0 ? bSegments / total : 0,
  };
}

/**
 * Format a signed time delta for display. Negative values use a true minus
 * sign (U+2212), not a hyphen. Values that round to zero carry no sign.
 *
 * @param {number|null|undefined} seconds
 * @param {number} [digits=2]
 * @returns {string}
 */
export function formatDelta(seconds, digits = 2) {
  const value = finiteNumberOrNull(seconds);
  if (value === null) return '—';

  const places =
    Number.isFinite(Number(digits)) && Number(digits) >= 0
      ? Math.min(6, Math.floor(Number(digits)))
      : 2;

  const rounded = Number(value.toFixed(places));
  if (rounded === 0) return `${(0).toFixed(places)} s`;
  if (rounded > 0) return `+${rounded.toFixed(places)} s`;
  return `−${Math.abs(rounded).toFixed(places)} s`;
}

/**
 * Format a lap time. Laps of a minute or more use `m:ss.mmm`
 * (e.g. 1:39.811); shorter values use `ss.mmm` (e.g. 59.500).
 *
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  const value = finiteNumberOrNull(seconds);
  if (value === null) return '—';

  const negative = value < 0;
  const totalMs = Math.round(Math.abs(value) * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const rest = totalMs - minutes * 60000;
  const whole = Math.floor(rest / 1000);
  const millis = rest - whole * 1000;
  const wholeText = minutes > 0 ? String(whole).padStart(2, '0') : String(whole);
  const secondsText = `${wholeText}.${String(millis).padStart(3, '0')}`;

  return `${negative ? '−' : ''}${minutes > 0 ? `${minutes}:` : ''}${secondsText}`;
}

/**
 * Point at a distance along the lap. The lap closes implicitly if needed and
 * distances outside the lap wrap (e.g. -10 m == lengthM - 10 m).
 *
 * @param {unknown[]} trackPoints
 * @param {number} lengthM
 * @param {number} distanceM
 * @returns {Point|null}
 */
export function pointAtDistance(trackPoints, lengthM, distanceM) {
  const points = toPoints(trackPoints);
  if (points.length === 0) return null;

  const length = Number(lengthM);
  const poly = buildPolyline(
    points,
    Number.isFinite(length) && length > 0 ? length : undefined,
  );
  return pointAtScaled(poly, distanceM);
}

/**
 * Tick geometry for the sector marks (S1/S2 and, if supplied, S3).
 *
 * Each item is `{mid, a, b}`: the centre on the track and the two ends of a
 * 10-unit perpendicular tick. `marksM` are distances from the start/finish in
 * metres. If `trackPoints` are the SVG-space points returned by
 * `buildViewBox`, pass `lengthM` so the metre marks are mapped onto the drawn
 * shape; with metre-space points `lengthM` is optional.
 *
 * @param {unknown[]} trackPoints
 * @param {number[]} marksM
 * @param {number} [lengthM] official lap length in metres, for SVG-space points
 * @returns {{mid: Point, a: Point, b: Point}[]}
 */
export function sectorMarkPoints(trackPoints, marksM, lengthM) {
  const points = toPoints(trackPoints);
  if (points.length === 0 || !Array.isArray(marksM)) return [];

  const length = Number(lengthM);
  const hasLength = Number.isFinite(length) && length > 0;
  const poly = buildPolyline(points, hasLength ? length : undefined);

  const result = [];
  for (const mark of marksM) {
    const distanceM = Number(mark);
    if (!Number.isFinite(distanceM)) continue;

    // With lengthM the polyline's distance axis is the official lap, so the
    // mark can be used directly whether the points are metres or SVG units.
    // Without it, points and marks are assumed to share the metre axis.
    const tick = tickAt(poly, distanceM);
    if (tick) result.push(tick);
  }
  return result;
}
