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
  sectorMarkPoints
} from './track.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const els = {
  raceSelect: $('race-select'),
  driverA: $('driver-a'),
  driverB: $('driver-b'),
  swap: $('swap-btn'),
  raceMeta: $('race-meta'),
  raceTitle: $('race-title'),
  coverageBadge: $('coverage-badge'),
  legend: $('legend'),
  svg: $('track-svg'),
  layer: $('track-layer'),
  tooltip: $('track-tooltip'),
  trackEmpty: $('track-empty'),
  trackCaption: $('track-caption'),
  wrapper: $('track-wrap'),
  deltaCard: $('delta-card'),
  driverCards: $('driver-cards'),
  tally: $('tally-card'),
  sectorStrip: $('sector-strip'),
  loading: $('loading'),
  errorPanel: $('error-panel'),
  errorMessage: $('error-message'),
  retry: $('retry-btn'),
  footerMeta: $('footer-meta'),
  methodCaveat: $('method-caveat'),
  trackTitle: $('track-title'),
  trackDesc: $('track-desc'),
  trackCard: document.querySelector('.track-card')
};

const state = {
  catalog: null,
  race: null,
  driverA: null,
  driverB: null,
  pair: null,
  segments: [],
  timesA: [],
  timesB: [],
  deltas: [],
  rawDeltas: [],
  classes: [],
  selected: -1,
  pinned: false,
  loadToken: 0
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function hexColour(value, fallback = '#8a97ab') {
  if (!value) return fallback;
  const clean = String(value).replace('#', '').trim();
  return /^[0-9a-f]{6}$/i.test(clean) ? `#${clean}` : fallback;
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const v = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_BG = '#080b12';

/** Keep the team colour recognisable but readable on the dark surface. */
function displayColour(raw) {
  let hex = hexColour(raw);
  let guard = 0;
  while (contrast(hex, DARK_BG) < 3 && guard++ < 24) {
    const v = hex.replace('#', '');
    const rgb = [0, 2, 4].map((i) => Math.min(255, Math.round(parseInt(v.slice(i, i + 2), 16) * 1.12 + 10)));
    hex = `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  return hex;
}

function colourDistance(a, b) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return Math.sqrt(pa.reduce((sum, n, i) => sum + (n - pb[i]) ** 2, 0)) / Math.sqrt(3 * 255 * 255);
}

function teamStyle(driver) {
  return { colour: displayColour(driver.colour), raw: hexColour(driver.colour) };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function gapText(seconds) {
  const abs = Math.abs(seconds);
  if (abs < 0.0005) return '0.000';
  return abs.toFixed(3);
}

function setLoading(show, text = 'Loading race…') {
  els.loading.hidden = !show;
  const p = els.loading.querySelector('p');
  if (p) p.textContent = text;
  document.body.classList.toggle('is-loading', show);
}

function showError(message) {
  setLoading(false);
  els.errorMessage.textContent = message;
  els.errorPanel.hidden = false;
}

function hideError() {
  els.errorPanel.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Data loading                                                       */
/* ------------------------------------------------------------------ */

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function boot() {
  setLoading(true, 'Loading races…');
  try {
    const catalog = await fetchJson('data/catalog.json');
    if (!Array.isArray(catalog.races) || catalog.races.length === 0) {
      throw new Error('The catalog is empty. Run npm run build:data.');
    }
    state.catalog = catalog;
    populateRaceSelect(catalog.races);
    els.footerMeta.textContent = `Dataset ${formatDate(catalog.generated_at?.slice(0, 10))} · OpenF1`;

    const hash = parseHash();
    const raceEntry = catalog.races.find((r) => String(r.session_key) === String(hash.race))
      || catalog.races[catalog.races.length - 1];
    els.raceSelect.value = String(raceEntry.session_key);
    await loadRace(raceEntry, hash.a, hash.b);
  } catch (error) {
    console.error(error);
    showError('The race catalog could not be loaded. Run npm run dev from the project folder and try again.');
  } finally {
    setLoading(false);
  }
}

function populateRaceSelect(races) {
  const years = [...new Set(races.map((r) => r.year))].sort((a, b) => a - b);
  els.raceSelect.innerHTML = '';
  for (const year of years) {
    const group = document.createElement('optgroup');
    group.label = String(year);
    for (const race of races.filter((r) => r.year === year)) {
      const option = document.createElement('option');
      option.value = String(race.session_key);
      option.textContent = `R${race.round} · ${race.name} — ${race.location}`;
      group.append(option);
    }
    els.raceSelect.append(group);
  }
  els.raceSelect.disabled = false;
}

async function loadRace(entry, wantedA, wantedB) {
  const token = ++state.loadToken;
  setLoading(true, `Loading ${entry.name}…`);
  hideError();
  try {
    const race = await fetchJson(entry.file);
    if (token !== state.loadToken) return;

    state.race = race;
    state.driverA = null;
    state.driverB = null;
    state.pair = null;

    populateDrivers(race, wantedA, wantedB);
    applyRaceHeader(race);
    render();
    updateHash();
    setLoading(false);
  } catch (error) {
    if (token !== state.loadToken) return;
    console.error(error);
    showError(`Could not load ${entry.name}. The data file may be missing; try another race or rebuild the dataset.`);
  }
}

function driverById(race, value) {
  if (value == null) return null;
  return race.drivers.find((d) => String(d.number) === String(value)) || null;
}

function populateDrivers(race, wantedA, wantedB) {
  const drivers = [...race.drivers].sort((a, b) => a.name.localeCompare(b.name));
  const byTeam = new Map();
  for (const driver of drivers) {
    if (!byTeam.has(driver.team)) byTeam.set(driver.team, []);
    byTeam.get(driver.team).push(driver);
  }

  for (const select of [els.driverA, els.driverB]) {
    select.innerHTML = '';
    for (const [team, list] of [...byTeam.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const group = document.createElement('optgroup');
      group.label = team;
      for (const driver of list) {
        const option = document.createElement('option');
        option.value = String(driver.number);
        option.textContent = `${driver.acronym} · ${driver.name}`;
        group.append(option);
      }
      select.append(group);
    }
  }

  let a = driverById(race, wantedA);
  let b = driverById(race, wantedB);
  if (a && b && a.number === b.number) b = null;
  if (!a) a = fastestTwo(race)[0];
  if (!b) b = fastestTwo(race).find((d) => d.number !== a?.number) || drivers.find((d) => d.number !== a?.number);
  if (!a && drivers.length) a = drivers[0];

  state.driverA = a;
  state.driverB = b;
  els.driverA.value = a ? String(a.number) : '';
  els.driverB.value = b ? String(b.number) : '';
  syncDriverOptions();
}

function fastestTwo(race) {
  const sorted = [...race.drivers]
    .filter((d) => Number.isFinite(d.lap_time))
    .sort((a, b) => a.lap_time - b.lap_time);
  if (sorted.length === 0) return [];
  const first = sorted[0];
  const rivals = sorted.filter((d) => d.team !== first.team);
  const firstColour = displayColour(first.colour);
  const contrasting = rivals.find((d) => colourDistance(displayColour(d.colour), firstColour) > 0.32);
  return [first, contrasting || rivals[0] || sorted[1]].filter(Boolean);
}

function syncDriverOptions() {
  const a = els.driverA.value;
  const b = els.driverB.value;
  for (const option of els.driverA.options) option.disabled = option.value === b;
  for (const option of els.driverB.options) option.disabled = option.value === a;
  els.swap.disabled = !state.driverA || !state.driverB;
}

function applyRaceHeader(race) {
  els.raceMeta.textContent = `${race.year} · Round ${race.round} · ${race.location}`;
  els.raceTitle.textContent = race.name;
  els.trackTitle.textContent = `${race.circuit} track comparison`;

  const limited = [state.driverA, state.driverB].some((d) => d && d.lap_time > d.official_best_time + 0.0005);
  const partial = !limited && [state.driverA, state.driverB].some((d) => d && d.coverage_pct < 99.5);
  els.coverageBadge.hidden = !limited && !partial;
  if (els.methodCaveat) {
    const cal = state.race?.calibration;
    els.methodCaveat.textContent = cal
      ? `Calibrated on this race: ${cal.pair.replace('/', ' vs ')} sector-delta errors ${cal.sector_delta_error.map((v) => `${v > 0 ? '+' : ''}${v.toFixed(3)} s`).join(' / ')}.`
      : 'This race is not independently calibrated: no calibration pair passed the complete-sector check. Treat its spatial split as indicative.';
  }
  if (limited) {
    els.coverageBadge.textContent = 'Telemetry-limited lap';
    els.coverageBadge.title = 'At least one driver is not on their official fastest lap because the position or speed stream is incomplete.';
  } else if (partial) {
    els.coverageBadge.textContent = 'Partial telemetry';
    els.coverageBadge.title = 'At least one lap has a short position/speed gap. The affected sections are neutral, never interpolated.';
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

function render() {
  const race = state.race;
  const a = state.driverA;
  const b = state.driverB;
  if (!race) return;

  const ready = Boolean(a && b && race.track?.points?.length > 1);
  els.trackCard.dataset.status = ready ? 'ready' : 'empty';
  els.svg.classList.toggle('is-empty', !ready);
  els.trackEmpty.hidden = ready;
  if (!ready) {
    els.layer.replaceChildren();
    els.legend.innerHTML = '';
    els.deltaCard.innerHTML = '';
    els.driverCards.innerHTML = '';
    els.tally.innerHTML = '';
    els.sectorStrip.innerHTML = '';
    els.trackDesc.textContent = 'No comparison available.';
    return;
  }

  const styleA = teamStyle(a);
  const styleB = teamStyle(b);
  const close = colourDistance(styleA.colour, styleB.colour) < 0.22;
  const stage = els.trackCard.closest('.stage') || els.trackCard.parentElement;
  for (const target of [els.trackCard, stage]) {
    target.style.setProperty('--a-color', styleA.colour);
    target.style.setProperty('--b-color', styleB.colour);
  }
  els.trackCard.style.setProperty('--a-raw', styleA.raw);
  els.trackCard.style.setProperty('--b-raw', styleB.raw);
  els.trackCard.classList.toggle('same-team', a.team === b.team || close);

  const points = race.track.points.map(([x, y]) => ({ x, y }));
  const view = buildViewBox(points);
  els.svg.setAttribute('viewBox', view.viewBox);

  const allSegments = buildSegments(view.points, race.track.length_m, race.segment_m);
  const timesA = segmentTimesFromBins(a.dt, race.grid_m, race.segment_m);
  const timesB = segmentTimesFromBins(b.dt, race.grid_m, race.segment_m);
  const count = Math.min(allSegments.length, timesA.length, timesB.length);
  const segments = allSegments.slice(0, count);

  const rawDeltas = [];
  for (let i = 0; i < count; i++) {
    rawDeltas.push(timesA[i] == null || timesB[i] == null ? null : timesA[i] - timesB[i]);
  }
  const smoothed = smoothSeries(rawDeltas, 3);
  const classes = mergeShortRuns(classifySeries(smoothed, race.deadband_s ?? 0.03), 2);

  state.segments = segments;
  state.timesA = timesA;
  state.timesB = timesB;
  state.deltas = smoothed;
  state.rawDeltas = rawDeltas;
  state.classes = classes;
  state.selected = -1;
  state.pinned = false;

  drawTrack({
    race,
    segments,
    classes,
    styleA,
    styleB,
    close,
    view
  });
  renderLegend(a, b, styleA, styleB, close);
  renderStats(a, b, race, segments, classes);
  renderCaption(a, b, race);
  updateTrackDescription(a, b, classes);
  hideTooltip();
}

function drawTrack({ race, segments, classes, styleA, styleB, close, view }) {
  els.layer.replaceChildren();

  const base = svgEl('path', {
    d: buildPath(view.points),
    class: 'track-layer__casing',
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  });
  const baseInner = svgEl('path', {
    d: buildPath(view.points),
    class: 'track-layer__base',
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  });
  els.layer.append(base, baseInner);

  const glowGroup = svgEl('g', { class: 'track-layer__glow', 'aria-hidden': 'true' });
  const segGroup = svgEl('g', { class: 'track-layer__segments' });
  const hitGroup = svgEl('g', { class: 'track-layer__hits' });

  segments.forEach((segment, index) => {
    const cls = classes[index];
    const noData = cls == null;
    const colour = noData ? 'var(--nodata)' : cls === 0 ? 'var(--neutral)' : cls < 0 ? styleA.colour : styleB.colour;
    const stateClass = noData ? 'is-nodata' : cls === 0 ? 'is-neutral' : cls < 0 ? 'is-a' : 'is-b';
    const d = buildPath(segment.points);

    const under = svgEl('path', {
      d,
      class: 'track-layer__underlay',
      fill: 'none',
      stroke: colour,
      'stroke-width': 30,
      'stroke-linecap': 'butt',
      'stroke-linejoin': 'round',
      opacity: noData ? 0 : cls === 0 ? 0.05 : 0.16
    });
    const path = svgEl('path', {
      d,
      class: `track-layer__segment ${stateClass}${close && cls > 0 ? ' is-secondary' : ''}`,
      fill: 'none',
      stroke: colour,
      'stroke-width': noData ? 11 : 16,
      'stroke-linecap': 'butt',
      'stroke-linejoin': 'round',
      'data-index': index
    });
    const hit = svgEl('path', {
      d,
      class: 'track-layer__hit',
      fill: 'none',
      stroke: 'transparent',
      'stroke-width': 34,
      'stroke-linecap': 'butt',
      'stroke-linejoin': 'round',
      'data-index': index,
      tabindex: '-1'
    });

    glowGroup.append(under);
    segGroup.append(path);
    hitGroup.append(hit);
  });

  els.layer.append(glowGroup, segGroup, hitGroup);

  const marks = sectorMarkPoints(view.points, race.track.sector_marks_m || [], race.track.length_m);
  marks.forEach((mark, i) => {
    const line = svgEl('line', {
      x1: mark.a.x, y1: mark.a.y, x2: mark.b.x, y2: mark.b.y,
      class: 'track-layer__tick',
      'aria-hidden': 'true'
    });
    els.layer.append(line);
  });

  const start = startFinishMark(view.points);
  if (start) {
    const line = svgEl('line', {
      x1: start.a.x, y1: start.a.y, x2: start.b.x, y2: start.b.y,
      class: 'track-layer__start',
      'aria-hidden': 'true'
    });
    const dot = svgEl('circle', { cx: start.mid.x, cy: start.mid.y, r: 5, class: 'track-layer__start-dot' });
    els.layer.append(line, dot);
  }

  hitGroup.addEventListener('pointerover', onSegmentPointer);
  hitGroup.addEventListener('pointermove', onSegmentPointer);
  hitGroup.addEventListener('mouseover', onSegmentPointer);
  hitGroup.addEventListener('mousemove', onSegmentPointer);
  hitGroup.addEventListener('pointerleave', () => { if (!state.pinned) hideTooltip(); });
  hitGroup.addEventListener('pointerdown', (event) => {
    const target = event.target.closest('[data-index]');
    if (!target) return;
    event.preventDefault();
    const index = Number(target.dataset.index);
    if (state.pinned && state.selected === index) {
      state.pinned = false;
      hideTooltip();
      return;
    }
    state.pinned = true;
    selectSegment(index, { pin: true });
  });
  segGroup.addEventListener('pointerdown', (event) => {
    const target = event.target.closest('[data-index]');
    if (target) event.preventDefault();
  });
}

function startFinishMark(points) {
  if (points.length < 3) return null;
  const p0 = points[0];
  const p1 = points[1];
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return {
    a: { x: p0.x + nx * 13, y: p0.y + ny * 13 },
    b: { x: p0.x - nx * 13, y: p0.y - ny * 13 },
    mid: p0
  };
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function renderLegend(a, b, styleA, styleB, close = false) {
  els.legend.innerHTML = `
    <div class="legend__item">
      <span class="legend__swatch" style="--swatch:${styleA.colour}"></span>
      <span class="legend__label">${escapeHtml(a.acronym)} <span class="legend__name">${escapeHtml(a.name)}</span></span>
      <span class="legend__sub">${formatTime(a.lap_time)}</span>
    </div>
    <div class="legend__item">
      <span class="legend__swatch${close ? ' is-secondary' : ''}" style="--swatch:${styleB.colour}"></span>
      <span class="legend__label">${escapeHtml(b.acronym)} <span class="legend__name">${escapeHtml(b.name)}</span></span>
      <span class="legend__sub">${formatTime(b.lap_time)}</span>
    </div>
    <div class="legend__item legend__item--neutral">
      <span class="legend__swatch legend__swatch--neutral"></span>
      <span class="legend__label">Too close to call</span>
      <span class="legend__sub">|Δ| < ${(state.race?.deadband_s ?? 0.03).toFixed(2)} s / 100 m</span>
    </div>
    <div class="legend__item legend__item--nodata">
      <span class="legend__swatch legend__swatch--nodata"></span>
      <span class="legend__label">No telemetry</span>
      <span class="legend__sub">excluded</span>
    </div>`;
}

function renderStats(a, b, race, segments, classes) {
  const gap = a.lap_time - b.lap_time;
  const winner = gap < 0 ? a : b;
  const loser = gap < 0 ? b : a;
  const identical = Math.abs(gap) < 0.0005;

  els.deltaCard.innerHTML = `
    <p class="eyebrow">Official lap delta</p>
    <p class="delta-card__value" style="--accent:${winner === a ? 'var(--a-color)' : 'var(--b-color)'}">
      ${identical ? '0.000' : gapText(gap)}<span>s</span>
    </p>
    <p class="delta-card__caption">
      ${identical
        ? `${escapeHtml(a.acronym)} and ${escapeHtml(b.acronym)} set the same lap time.`
        : `<strong>${escapeHtml(winner.acronym)}</strong> was ${gapText(gap)} s quicker over the lap than ${escapeHtml(loser.acronym)}.`}
    </p>
    <p class="delta-card__note">${escapeHtml(race.analysis?.lap_rule || 'Fastest available lap')} · GPS split indicative</p>`;

  const cards = [a, b].map((driver, index) => {
    const other = index === 0 ? b : a;
    const delta = driver.lap_time - other.lap_time;
    const style = index === 0 ? 'var(--a-color)' : 'var(--b-color)';
    const limited = driver.lap_time > driver.official_best_time + 0.0005;
    const metres = (driver.length_m || race.track.length_m).toFixed(0);
    return `
      <article class="driver-card" style="--team:${style}">
        <div class="driver-card__top">
          <span class="driver-card__tag">${index === 0 ? 'A' : 'B'}</span>
          <span class="driver-card__name">${escapeHtml(driver.acronym)} <small>${escapeHtml(driver.name)}</small></span>
          <span class="driver-card__team">${escapeHtml(driver.team)}</span>
        </div>
        <div class="driver-card__stats">
          <div><span>Lap</span><strong>${formatTime(driver.lap_time)}</strong></div>
          <div><span>Gap</span><strong>${delta === 0 ? '—' : `${delta > 0 ? '+' : '−'}${gapText(delta)}`}</strong></div>
          <div><span>Top speed</span><strong>${driver.top_speed ? `${driver.top_speed} km/h` : '—'}</strong></div>
          <div><span>Tyre</span><strong>${driver.compound ? `${escapeHtml(driver.compound)}${driver.tyre_age != null ? ` · ${driver.tyre_age} laps` : ''}` : '—'}</strong></div>
        </div>
        <p class="driver-card__meta">
          Lap ${driver.lap_number} · ${Math.round(driver.coverage_pct ?? 100)}% telemetry · ${metres} m GPS
          ${limited ? `<span class="mini-badge" title="Official fastest: lap ${driver.official_best_lap}, ${formatTime(driver.official_best_time)}">telemetry-limited</span>` : ''}
        </p>
      </article>`;
  });
  els.driverCards.innerHTML = cards.join('');

  const summary = summarise({
    classes,
    segmentM: race.segment_m,
    aName: a.acronym,
    bName: b.acronym
  });
  const total = summary.total || 0;
  const noDataCount = classes.filter((c) => c == null).length;
  const compared = Math.max(0, total - noDataCount);
  const pctA = total ? Math.round((summary.aSegments / total) * 100) : 0;
  const pctB = total ? Math.round((summary.bSegments / total) * 100) : 0;
  const pctN = total ? Math.round((summary.neutralSegments / total) * 100) : 0;
  const pctNo = Math.max(0, 100 - pctA - pctB - pctN);
  const comparedPct = total ? Math.round((compared / total) * 100) : 0;
  const neutralCount = summary.neutralSegments;
  const leader = summary.aSegments === summary.bSegments
    ? null
    : summary.aSegments > summary.bSegments ? a : b;
  els.tally.innerHTML = `
    <div class="tally__head">
      <p class="eyebrow">Track dominance · ${comparedPct}% of lap compared</p>
      <p class="tally__lead">${leader
        ? `<strong style="color:${leader === a ? 'var(--a-color)' : 'var(--b-color)'}">${escapeHtml(leader.acronym)}</strong> quicker through ${Math.max(summary.aSegments, summary.bSegments)} of ${compared} compared sections`
        : `Dead heat: ${neutralCount} of ${compared} compared sections too close`}
      </p>
    </div>
    <div class="tally__bar" role="img" aria-label="${escapeHtml(a.acronym)} ${pctA}%, too close ${pctN}%, ${escapeHtml(b.acronym)} ${pctB}%, no telemetry ${pctNo}%">
      <span class="tally__fill tally__fill--a" style="width:${pctA}%"></span>
      <span class="tally__fill tally__fill--n" style="width:${pctN}%"></span>
      <span class="tally__fill tally__fill--b" style="width:${pctB}%"></span>
      <span class="tally__fill tally__fill--nodata" style="width:${pctNo}%"></span>
    </div>
    <div class="tally__legend">
      <span><i style="background:var(--a-color)"></i>${escapeHtml(a.acronym)} · ${pctA}%</span>
      <span><i class="is-neutral"></i>Too close · ${pctN}%</span>
      <span><i style="background:var(--b-color)"></i>${escapeHtml(b.acronym)} · ${pctB}%</span>
      <span><i class="is-nodata"></i>No data · ${pctNo}%</span>
    </div>`;

  const sectors = [1, 2, 3].map((n) => {
    const ta = a.sectors?.[n - 1];
    const tb = b.sectors?.[n - 1];
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) {
      return `<div class="sector-chip is-neutral"><span>S${n}</span><strong>—</strong></div>`;
    }
    const d = ta - tb;
    const cls = Math.abs(d) < 0.0005 ? 'is-neutral' : d < 0 ? 'is-a' : 'is-b';
    const win = Math.abs(d) < 0.0005 ? '=' : d < 0 ? a.acronym : b.acronym;
    return `<div class="sector-chip ${cls}">
      <span>S${n}</span>
      <strong>${escapeHtml(win)}</strong>
      <small>${Math.abs(d) < 0.0005 ? '0.000' : `${d > 0 ? '+' : '−'}${gapText(d)}`} s</small>
    </div>`;
  });
  els.sectorStrip.innerHTML = `<span class="sector-strip__label">Official sectors</span>${sectors.join('')}`;
}

function renderCaption(a, b, race) {
  const limited = [a, b].filter((d) => d.lap_time > d.official_best_time + 0.0005);
  const partial = [a, b].filter((d) => d.coverage_pct < 99.5);
  const bits = [partial.length ? 'Best covered laps' : 'Best available laps', 'GPS-derived, indicative'];
  if (partial.length && !limited.length) {
    bits.push(`partial telemetry: ${partial.map((d) => `${d.acronym} ${Math.round(d.coverage_pct)}%`).join(', ')}`);
  }
  if (limited.length) {
    bits.push(`telemetry-limited: ${limited.map((d) => `${d.acronym} lap ${d.lap_number} (official best ${formatTime(d.official_best_time)})`).join(', ')}`);
  }
  els.trackCaption.textContent = bits.join(' · ');
  els.trackCaption.title = `Sections are 100 m. A section is neutral when |Δ| < ${race.deadband_s ?? 0.03} s.`;
}

function updateTrackDescription(a, b, classes) {
  const aCount = classes.filter((c) => c < 0).length;
  const bCount = classes.filter((c) => c > 0).length;
  const noData = classes.filter((c) => c == null).length;
  const neutral = classes.filter((c) => c === 0).length;
  els.trackDesc.textContent =
    `${a.name} versus ${b.name}. ${aCount} sections quicker for ${a.acronym}, ${bCount} for ${b.acronym}, ${neutral} too close to call, ${noData} with no telemetry. ` +
    'Use the left and right arrow keys to inspect sections.';
}

/* ------------------------------------------------------------------ */
/* Interaction                                                        */
/* ------------------------------------------------------------------ */

function onSegmentPointer(event) {
  const target = event.target.closest('[data-index]');
  if (!target) return;
  const index = Number(target.dataset.index);
  if (state.pinned && state.selected !== index) return;
  selectSegment(index, { point: { x: event.clientX, y: event.clientY } });
}

function selectSegment(index, { point, pin = false } = {}) {
  if (!Number.isFinite(index) || !state.segments[index]) return;
  state.selected = index;
  if (pin) state.pinned = true;

  for (const node of els.layer.querySelectorAll('.track-layer__segment')) {
    node.classList.toggle('is-selected', Number(node.dataset.index) === index);
  }

  showTooltip(index, point);
}

function hideTooltip() {
  els.tooltip.hidden = true;
}

function showTooltip(index, point) {
  const segment = state.segments[index];
  if (!segment) return;
  const a = state.driverA;
  const b = state.driverB;
  const ta = state.timesA[index];
  const tb = state.timesB[index];
  const delta = state.rawDeltas[index] ?? state.deltas[index];
  const cls = state.classes[index];
  const race = state.race;

  const title = `Section ${index + 1} · ${((segment.d0 + segment.d1) / 2 / 1000).toFixed(2)} km`;
  const rows = `
    <div class="tt__row"><span class="tt__dot" style="background:var(--a-color)"></span><span>${escapeHtml(a.acronym)}</span><strong>${ta == null ? 'no data' : `${ta.toFixed(3)} s`}</strong></div>
    <div class="tt__row"><span class="tt__dot" style="background:var(--b-color)"></span><span>${escapeHtml(b.acronym)}</span><strong>${tb == null ? 'no data' : `${tb.toFixed(3)} s`}</strong></div>`;

  let deltaLine;
  if (ta == null || tb == null || delta == null || cls == null) {
    deltaLine = '<p class="tt__delta is-nodata">No telemetry · excluded from the tally</p>';
  } else if (Math.abs(delta) < (race.deadband_s ?? 0.03)) {
    deltaLine = `<p class="tt__delta is-neutral">Too close to call · |Δ| < ${(race.deadband_s ?? 0.03).toFixed(2)} s</p>`;
  } else {
    const rawClass = delta < 0 ? -1 : 1;
    const winner = rawClass < 0 ? a : b;
    deltaLine = `<p class="tt__delta" style="--accent:${rawClass < 0 ? 'var(--a-color)' : 'var(--b-color)'}">${escapeHtml(winner.acronym)} quicker by ${Math.abs(delta).toFixed(3)} s</p>`;
  }

  els.tooltip.innerHTML = `
    <p class="tt__title">${title}</p>
    ${rows}
    ${deltaLine}
    <p class="tt__note">Raw section times · colour smoothed over 3 sections · GPS estimate</p>`;
  els.tooltip.hidden = false;

  const wrapRect = els.wrapper.getBoundingClientRect();
  let x;
  let y;
  if (point) {
    x = point.x - wrapRect.left + 14;
    y = point.y - wrapRect.top + 14;
  } else {
    const vb = els.svg.viewBox.baseVal;
    const mid = segment.mid;
    x = ((mid.x - vb.x) / vb.width) * els.svg.clientWidth + 14;
    y = ((mid.y - vb.y) / vb.height) * els.svg.clientHeight + 14;
  }
  const ttRect = els.tooltip.getBoundingClientRect();
  x = Math.max(8, Math.min(x, wrapRect.width - ttRect.width - 8));
  y = Math.max(8, Math.min(y, wrapRect.height - ttRect.height - 8));
  els.tooltip.style.left = `${x}px`;
  els.tooltip.style.top = `${y}px`;
}

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

els.raceSelect.addEventListener('change', async () => {
  const entry = state.catalog.races.find((r) => String(r.session_key) === els.raceSelect.value);
  if (!entry) return;
  await loadRace(entry);
});

els.driverA.addEventListener('change', () => {
  const driver = driverById(state.race, els.driverA.value);
  if (!driver) return;
  if (state.driverB && driver.number === state.driverB.number) {
    const fallback = state.race.drivers.find((d) => d.number !== driver.number);
    state.driverB = fallback || null;
    els.driverB.value = fallback ? String(fallback.number) : '';
  }
  state.driverA = driver;
  syncDriverOptions();
  applyRaceHeader(state.race);
  render();
  updateHash();
  hideError();
});

els.driverB.addEventListener('change', () => {
  const driver = driverById(state.race, els.driverB.value);
  if (!driver) return;
  if (state.driverA && driver.number === state.driverA.number) {
    const fallback = state.race.drivers.find((d) => d.number !== driver.number);
    state.driverA = fallback || null;
    els.driverA.value = fallback ? String(fallback.number) : '';
  }
  state.driverB = driver;
  syncDriverOptions();
  applyRaceHeader(state.race);
  render();
  updateHash();
  hideError();
});

els.swap.addEventListener('click', () => {
  if (!state.driverA || !state.driverB) return;
  [state.driverA, state.driverB] = [state.driverB, state.driverA];
  els.driverA.value = String(state.driverA.number);
  els.driverB.value = String(state.driverB.number);
  syncDriverOptions();
  applyRaceHeader(state.race);
  render();
  updateHash();
});

els.svg.addEventListener('keydown', (event) => {
  if (!state.segments.length) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Escape') return;
  event.preventDefault();
  if (event.key === 'Escape') {
    state.pinned = false;
    state.selected = -1;
    for (const node of els.layer.querySelectorAll('.track-layer__segment')) node.classList.remove('is-selected');
    hideTooltip();
    return;
  }
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const start = state.selected < 0 ? (direction > 0 ? -1 : state.segments.length) : state.selected;
  const next = Math.max(0, Math.min(state.segments.length - 1, start + direction));
  state.pinned = true;
  selectSegment(next, { pin: true });
});

els.retry.addEventListener('click', () => {
  hideError();
  boot();
});

document.addEventListener('pointerdown', (event) => {
  if (!state.pinned) return;
  if (event.target.closest('.track-card') || event.target.closest('#track-tooltip')) return;
  state.pinned = false;
  state.selected = -1;
  for (const node of els.layer.querySelectorAll('.track-layer__segment')) node.classList.remove('is-selected');
  hideTooltip();
});

els.trackCard.addEventListener('pointerleave', () => {
  if (!state.pinned) {
    state.selected = -1;
    for (const node of els.layer.querySelectorAll('.track-layer__segment')) node.classList.remove('is-selected');
    hideTooltip();
  }
});

window.addEventListener('hashchange', () => {
  if (!state.catalog) return;
  const hash = parseHash();
  const entry = state.catalog.races.find((r) => String(r.session_key) === String(hash.race));
  if (entry && entry.session_key !== state.race?.session_key) {
    els.raceSelect.value = String(entry.session_key);
    loadRace(entry, hash.a, hash.b);
  }
});

/* ------------------------------------------------------------------ */
/* URL state                                                          */
/* ------------------------------------------------------------------ */

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return {
    race: params.get('race'),
    a: params.get('a'),
    b: params.get('b')
  };
}

function updateHash() {
  if (!state.race || !state.driverA || !state.driverB) return;
  const params = new URLSearchParams({
    race: String(state.race.session_key),
    a: String(state.driverA.number),
    b: String(state.driverB.number)
  });
  const next = `#${params.toString()}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

boot();
