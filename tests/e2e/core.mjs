#!/usr/bin/env node
/**
 * Core browser E2E suite for "Who is the fastest?".
 *
 * Self-contained: starts `scripts/serve.mjs` on port 5174, launches installed
 * Chrome headless through playwright-core, runs the core checks, writes
 * screenshots under tmp/e2e/ and a machine-readable result file for run.mjs.
 *
 * Run directly:  node tests/e2e/core.mjs
 * Or via:        node tests/e2e/run.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.E2E_PORT || 5174);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = path.join(ROOT, 'tmp', 'e2e');
const RESULTS_FILE = path.join(OUT_DIR, 'core-results.json');
const QUIET = process.env.E2E_QUIET === '1' || process.argv.includes('--quiet');

const AUSTIN = {
  sessionKey: '11396',
  title: 'United States Grand Prix',
  segments: 54,
};

const checks = [];
let harnessError = null;
const observed = {
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  httpErrors: [],
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Result collection                                                  */
/* ------------------------------------------------------------------ */

function describeError(error) {
  const message = error?.message ? String(error.message) : String(error);
  return message.replace(/\s+at\s[\s\S]*$/, '').trim() || 'unknown error';
}

async function check(id, name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    checks.push({
      id,
      name,
      status: 'PASS',
      detail: detail == null ? '' : String(detail),
      durationMs: Date.now() - startedAt,
    });
    if (!QUIET) console.log(`PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    checks.push({
      id,
      name,
      status: 'FAIL',
      detail: describeError(error),
      durationMs: Date.now() - startedAt,
    });
    if (!QUIET) {
      console.log(`FAIL  ${id}  ${name}`);
      console.log(`      ${describeError(error).replace(/\n/g, '\n      ')}`);
    }
  }
}

function skip(id, name, reason) {
  checks.push({ id, name, status: 'SKIP', detail: reason, durationMs: 0 });
  if (!QUIET) console.log(`SKIP  ${id}  ${name} — ${reason}`);
}

/* ------------------------------------------------------------------ */
/* Server + browser plumbing                                          */
/* ------------------------------------------------------------------ */

async function startServer() {
  const logs = [];
  const child = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => logs.push(chunk));
  child.stderr.on('data', (chunk) => logs.push(chunk));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode} before becoming ready:\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(400) });
      if (response.ok) {
        const body = await response.text();
        if (body.includes('track-svg')) return { child, logs };
      }
    } catch {
      // Server not up yet; poll again without an arbitrary long sleep.
    }
    await delay(100);
  }
  child.kill('SIGTERM');
  throw new Error(`server did not become ready at ${BASE} within 10s:\n${logs.join('')}`);
}

async function stopServer(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  handle.child.kill('SIGTERM');
  await Promise.race([once(handle.child, 'exit').catch(() => {}), delay(2_000)]);
  if (handle.child.exitCode === null) handle.child.kill('SIGKILL');
}

function instrumentPage(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      observed.consoleErrors.push({
        page: label,
        text: message.text(),
        location: message.location(),
      });
    }
  });
  page.on('pageerror', (error) => {
    observed.pageErrors.push({ page: label, message: error.message, stack: error.stack });
  });
  page.on('requestfailed', (request) => {
    observed.failedRequests.push({
      page: label,
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText || 'unknown',
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      observed.httpErrors.push({
        page: label,
        status: response.status(),
        url: response.url(),
      });
    }
  });
}

async function waitForReady(page, expectedTitle, expectedSegments = null) {
  await page.waitForFunction(
    ({ title, segments }) => {
      const card = document.querySelector('.track-card');
      const loading = document.getElementById('loading');
      const heading = document.getElementById('race-title');
      const count = document.querySelectorAll('.track-layer__segment').length;
      if (!card || !heading) return false;
      return (
        heading.textContent.trim() === title &&
        card.dataset.status === 'ready' &&
        count > 0 &&
        (segments == null || count === segments) &&
        (!loading || loading.hidden)
      );
    },
    { title: expectedTitle, segments: expectedSegments },
    { timeout: 15_000 },
  );
}

async function waitForRaceLoaded(page, expectedTitle) {
  await page.waitForFunction(
    (title) => {
      const card = document.querySelector('.track-card');
      const loading = document.getElementById('loading');
      const heading = document.getElementById('race-title');
      if (!card || !heading || !card.dataset.status) return false;
      return (
        heading.textContent.trim() === title &&
        (card.dataset.status === 'ready' || card.dataset.status === 'empty') &&
        (!loading || loading.hidden)
      );
    },
    expectedTitle,
    { timeout: 15_000 },
  );
}

async function waitForValue(page, selector, value) {
  await page.waitForFunction(
    ({ selector: sel, value: expected }) => {
      const el = document.querySelector(sel);
      return el && String(el.value) === String(expected);
    },
    { selector, value },
    { timeout: 5_000 },
  );
}

async function waitForHash(page, expected) {
  await page.waitForFunction(
    (hash) => window.location.hash === hash,
    expected,
    { timeout: 5_000 },
  );
}

async function waitForAnimations(page, selector) {
  await page.evaluate(async (sel) => {
    const node = document.querySelector(sel);
    if (!node) return;
    const animations = node.getAnimations({ subtree: true });
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
  }, selector);
}

async function textOf(page, selector) {
  const text = await page.locator(selector).evaluate((node) => node.textContent ?? '');
  return text.replace(/\s+/g, ' ').trim();
}

function assertVisible(locator, label) {
  return locator.isVisible().then((visible) => {
    assert.ok(visible, `${label} is not visible`);
  });
}

/* ------------------------------------------------------------------ */
/* Suite                                                              */
/* ------------------------------------------------------------------ */

async function runCoreSuite(context) {
  const raceData = JSON.parse(await readFile(path.join(ROOT, 'data', 'races', '11396.json'), 'utf8'));
  const driverByNumber = new Map(raceData.drivers.map((driver) => [String(driver.number), driver]));
  const fastest = [...raceData.drivers]
    .filter((driver) => Number.isFinite(driver.lap_time))
    .sort((a, b) => a.lap_time - b.lap_time)[0];

  /* ---------------------------------------------------------------- */
  /* 1. Cold load: title, race, 54 segments, two cards, legend, delta  */
  /* ---------------------------------------------------------------- */
  const page = await context.newPage();
  instrumentPage(page, 'main');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  await check('1.1', 'Page loads; document title and Austin race title', async () => {
    assert.equal(await page.title(), 'Who is the fastest? — F1 track dominance');
    await waitForReady(page, AUSTIN.title, AUSTIN.segments);
    assert.equal((await textOf(page, '#race-title')), AUSTIN.title);
    assert.equal(await page.locator('#error-panel').isVisible(), false);
    return `title="${await page.title()}"; race="${AUSTIN.title}"`;
  });

  // The pair the app picks by default. Tests follow the rendered pair instead of
  // hard-coding a rival: the spec only requires the fastest lap plus a distinct
  // challenger, and that choice may legitimately change.
  const initial = await page.evaluate(() => ({
    race: document.getElementById('race-select').value,
    a: document.getElementById('driver-a').value,
    b: document.getElementById('driver-b').value,
    aText: document.getElementById('driver-a').selectedOptions[0]?.textContent.trim(),
    bText: document.getElementById('driver-b').selectedOptions[0]?.textContent.trim(),
  }));
  const initialA = driverByNumber.get(String(initial.a)) || {
    number: initial.a, acronym: initial.aText || initial.a, lap_time: Number.NaN, team: null,
  };
  const initialB = driverByNumber.get(String(initial.b)) || {
    number: initial.b, acronym: initial.bText || initial.b, lap_time: Number.NaN, team: null,
  };

  await check('1.2', '54 segment paths and 54 hit paths for Austin', async () => {
    const counts = await page.evaluate(() => ({
      segments: document.querySelectorAll('.track-layer__segment').length,
      hits: document.querySelectorAll('.track-layer__hit').length,
      indices: [...document.querySelectorAll('.track-layer__segment')]
        .map((node) => Number(node.dataset.index))
        .sort((a, b) => a - b),
    }));
    assert.equal(counts.segments, AUSTIN.segments, `expected ${AUSTIN.segments} segments, got ${counts.segments}`);
    assert.equal(counts.hits, AUSTIN.segments, `expected ${AUSTIN.segments} hit paths, got ${counts.hits}`);
    assert.deepEqual(counts.indices, Array.from({ length: AUSTIN.segments }, (_, i) => i));
    return `${counts.segments} segments, indices 0…${counts.segments - 1}`;
  });

  await check('1.3', 'Two driver cards and a four-item legend (including no-data) are visible', async () => {
    assert.equal(await page.locator('.driver-card').count(), 2, 'expected exactly two driver cards');
    const cards = await textOf(page, '#driver-cards');
    assert.ok(cards.includes(initialA.acronym), `driver cards do not mention ${initialA.acronym}: ${cards}`);
    assert.ok(cards.includes(initialB.acronym), `driver cards do not mention ${initialB.acronym}: ${cards}`);
    await assertVisible(page.locator('#legend'), 'legend');
    assert.equal(await page.locator('.legend__item').count(), 4, 'legend should have A, B, neutral and no-data items');
    assert.equal(await page.locator('.legend__item--nodata').count(), 1, 'legend is missing the no-data item');
    const legend = await textOf(page, '#legend');
    assert.match(legend, /Too close to call/i);
    assert.match(legend, /No telemetry/i, 'no-data legend item should be labelled "No telemetry"');
    assert.ok(legend.includes(initialA.acronym), `legend does not mention ${initialA.acronym}`);
    assert.ok(legend.includes(initialB.acronym), `legend does not mention ${initialB.acronym}`);
    return `cards=${initialA.acronym}/${initialB.acronym}; legend="${legend}"`;
  });

  await check('1.4', 'Official lap delta is visible and matches the dataset', async () => {
    await assertVisible(page.locator('#delta-card'), 'delta card');
    const delta = await textOf(page, '#delta-card');
    assert.match(delta, /Official lap delta/i);
    const expectedGap = Math.abs(initialA.lap_time - initialB.lap_time);
    assert.ok(Number.isFinite(expectedGap), `default drivers do not both have lap times: ${initial.a}/${initial.b}`);
    const expectedGapText = expectedGap.toFixed(3);
    const winner = initialA.lap_time <= initialB.lap_time ? initialA : initialB;
    const loser = winner === initialA ? initialB : initialA;
    const escapedGap = expectedGapText.replace('.', '\\.');
    assert.match(delta, new RegExp(`${escapedGap}\\s*s`), `expected the official delta ${expectedGapText} s, got: ${delta}`);
    assert.equal(await page.locator('#delta-card .delta-card__value').count(), 1);
    const value = (await textOf(page, '#delta-card .delta-card__value')).replace(/\s+/g, '');
    assert.equal(value, `${expectedGapText}s`, `delta value should be ${expectedGapText}s, got ${value}`);
    assert.ok(delta.includes(winner.acronym), `delta caption should name the winner ${winner.acronym}`);
    assert.ok(delta.includes(loser.acronym), `delta caption should name the loser ${loser.acronym}`);
    return `official delta ${value} (${winner.acronym} over ${loser.acronym})`;
  });

  /* ---------------------------------------------------------------- */
  /* 2. Defaults, swap + URL hash, deep link                            */
  /* ---------------------------------------------------------------- */
  await check('2.1', 'Default controls select Austin, the fastest driver and a distinct rival', async () => {
    const values = await page.evaluate(() => ({
      race: document.getElementById('race-select').value,
      a: document.getElementById('driver-a').value,
      b: document.getElementById('driver-b').value,
      raceOptions: document.querySelectorAll('#race-select option').length,
      aGroups: document.querySelectorAll('#driver-a optgroup').length,
      bGroups: document.querySelectorAll('#driver-b optgroup').length,
      aText: document.getElementById('driver-a').selectedOptions[0]?.textContent.trim(),
      bText: document.getElementById('driver-b').selectedOptions[0]?.textContent.trim(),
    }));
    assert.equal(values.race, AUSTIN.sessionKey);
    assert.equal(values.a, initial.a);
    assert.equal(values.b, initial.b);
    assert.equal(values.a, String(fastest.number), `driver A should default to the fastest lap (${fastest.acronym})`);
    assert.notEqual(values.a, values.b, 'the two driver selects must default to different drivers');
    assert.ok(driverByNumber.has(String(values.a)) && driverByNumber.has(String(values.b)), 'defaults must be in the Austin race');
    assert.notEqual(initialA.team, initialB.team, 'default pair should come from different teams');
    assert.ok(values.raceOptions >= 1, 'race select should contain the catalog');
    assert.ok(values.aGroups > 0 && values.bGroups > 0, 'driver selects should be grouped by team');
    assert.ok(values.aText.includes(initialA.acronym), `driver A option should mention ${initialA.acronym}`);
    assert.ok(values.bText.includes(initialB.acronym), `driver B option should mention ${initialB.acronym}`);
    const position = [...raceData.drivers]
      .filter((driver) => Number.isFinite(driver.lap_time))
      .sort((a, b) => a.lap_time - b.lap_time)
      .findIndex((driver) => driver.number === initialB.number) + 1;
    return `race=${values.race}, A=${values.a} ${initialA.acronym} (P1 fastest), B=${values.b} ${initialB.acronym} (P${position} by lap time)`;
  });

  await check('2.2', 'Swap exchanges driver values and rewrites the URL hash', async () => {
    await page.locator('#swap-btn').click();
    await waitForValue(page, '#driver-a', initial.b);
    await waitForValue(page, '#driver-b', initial.a);
    assert.equal(
      await page.evaluate(() => window.location.hash),
      `#race=${AUSTIN.sessionKey}&a=${initial.b}&b=${initial.a}`,
      'swap did not update the URL hash to the swapped pair',
    );
    const swapped = await page.evaluate(() => ({
      a: document.getElementById('driver-a').value,
      b: document.getElementById('driver-b').value,
      legend: document.getElementById('legend').textContent,
    }));
    assert.equal(swapped.a, initial.b);
    assert.equal(swapped.b, initial.a);
    assert.ok(swapped.legend.includes(initialB.acronym));
    assert.ok(swapped.legend.includes(initialA.acronym));

    await page.locator('#swap-btn').click();
    await waitForValue(page, '#driver-a', initial.a);
    await waitForValue(page, '#driver-b', initial.b);
    await waitForHash(page, `#race=${AUSTIN.sessionKey}&a=${initial.a}&b=${initial.b}`);
    return `A↔B changed values/hash, then restored ${initial.a}/${initial.b}`;
  });

  const deepPage = await context.newPage();
  instrumentPage(deepPage, 'deep-link');
  await check('2.3', 'Cold deep link #race=11396&a=16&b=3 restores LEC/VER', async () => {
    await deepPage.goto(`${BASE}/#race=${AUSTIN.sessionKey}&a=16&b=3`, { waitUntil: 'domcontentloaded' });
    await waitForReady(deepPage, AUSTIN.title, AUSTIN.segments);
    const state = await deepPage.evaluate(() => ({
      race: document.getElementById('race-select').value,
      a: document.getElementById('driver-a').value,
      b: document.getElementById('driver-b').value,
      hash: window.location.hash,
      legend: document.getElementById('legend').textContent,
      cards: document.getElementById('driver-cards').textContent,
    }));
    assert.equal(state.race, AUSTIN.sessionKey);
    assert.equal(state.a, '16', 'deep link driver A should be 16');
    assert.equal(state.b, '3', 'deep link driver B should be 3');
    assert.equal(state.hash, `#race=${AUSTIN.sessionKey}&a=16&b=3`);
    assert.match(state.legend, /LEC/);
    assert.match(state.legend, /VER/);
    assert.match(state.cards, /VER/);
    return `A=16 (LEC), B=3 (VER); hash ${state.hash}`;
  });

  /* ---------------------------------------------------------------- */
  /* 3. Same-driver prevention                                          */
  /* ---------------------------------------------------------------- */
  await check('3.1', 'The other driver is disabled in each driver select', async () => {
    const disabled = await page.evaluate(() => ({
      a: [...document.querySelectorAll('#driver-a option')]
        .filter((option) => option.disabled)
        .map((option) => option.value),
      b: [...document.querySelectorAll('#driver-b option')]
        .filter((option) => option.disabled)
        .map((option) => option.value),
      aSelected: document.getElementById('driver-a').value,
      bSelected: document.getElementById('driver-b').value,
    }));
    assert.deepEqual(disabled.a, [disabled.bSelected], `driver A should only disable B (${disabled.bSelected}), got ${JSON.stringify(disabled.a)}`);
    assert.deepEqual(disabled.b, [disabled.aSelected], `driver B should only disable A (${disabled.aSelected}), got ${JSON.stringify(disabled.b)}`);
    const selectedOptions = await page.evaluate(() => ({
      a: document.querySelector('#driver-a option:checked')?.disabled,
      b: document.querySelector('#driver-b option:checked')?.disabled,
    }));
    assert.equal(selectedOptions.a, false, 'A selected option must not be disabled');
    assert.equal(selectedOptions.b, false, 'B selected option must not be disabled');
    return `A disables ${disabled.bSelected}; B disables ${disabled.aSelected}; selected options enabled`;
  });

  /* ---------------------------------------------------------------- */
  /* 4. Pointer hover on a real SVG path point                          */
  /* ---------------------------------------------------------------- */
  await check('4.1', 'Hover on a real SVG path point shows section, both times and a delta/neutral line', async () => {
    const target = await page.evaluate(async () => {
      const svg = document.getElementById('track-svg');
      svg.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const hits = [...document.querySelectorAll('.track-layer__hit[data-index]')];
      const hit = hits.find((candidate) => {
        const segment = document.querySelector(
          `.track-layer__segment[data-index="${candidate.dataset.index}"]`,
        );
        return segment && !segment.classList.contains('is-nodata');
      });
      if (!hit) throw new Error('no non-no-data segment found');
      const index = Number(hit.dataset.index);
      const path = document.querySelector(`.track-layer__segment[data-index="${index}"]`);
      const length = path.getTotalLength();
      const point = path.getPointAtLength(length / 2);
      const ctm = path.getScreenCTM();
      const x = ctm.a * point.x + ctm.c * point.y + ctm.e;
      const y = ctm.b * point.x + ctm.d * point.y + ctm.f;
      const rect = svg.getBoundingClientRect();
      const kind = ['is-a', 'is-b', 'is-neutral'].find((name) => path.classList.contains(name));
      return {
        index,
        kind,
        x,
        y,
        insideViewport: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight,
        insideSvg: x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
        svgRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      };
    });
    assert.ok(['is-a', 'is-b', 'is-neutral'].includes(target.kind), `hover target is not a data segment: ${JSON.stringify(target)}`);
    assert.ok(target.insideSvg, `computed hover point is outside the SVG: ${JSON.stringify(target)}`);
    assert.ok(target.insideViewport, `computed hover point is outside the viewport: ${JSON.stringify(target)}`);

    const segmentM = Number(raceData.segment_m) || 100;
    const d0 = target.index * segmentM;
    const d1 = Math.min(Number(raceData.track.length_m), d0 + segmentM);
    const expectedTitle = `Section ${target.index + 1} · ${((d0 + d1) / 2 / 1000).toFixed(2)} km`;

    await page.mouse.move(target.x, target.y, { steps: 2 });
    await page.locator('#track-tooltip').waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(
      (title) => document.querySelector('#track-tooltip .tt__title')?.textContent.trim() === title,
      expectedTitle,
      { timeout: 5_000 },
    );

    const tooltip = await page.evaluate(() => {
      const node = document.getElementById('track-tooltip');
      const rows = [...node.querySelectorAll('.tt__row')].map((row) => ({
        text: row.textContent.replace(/\s+/g, ' ').trim(),
        time: row.querySelector('strong')?.textContent.trim(),
      }));
      return {
        title: node.querySelector('.tt__title')?.textContent.trim(),
        rows,
        delta: node.querySelector('.tt__delta')?.textContent.replace(/\s+/g, ' ').trim(),
        deltaClass: node.querySelector('.tt__delta')?.className,
        selected: [...document.querySelectorAll('.track-layer__segment.is-selected')]
          .map((segment) => segment.dataset.index),
      };
    });
    assert.equal(tooltip.title, expectedTitle);
    assert.equal(tooltip.rows.length, 2, 'tooltip should show both drivers');
    assert.deepEqual(tooltip.selected, [String(target.index)], 'hover should select exactly the hovered segment');
    for (const row of tooltip.rows) {
      assert.match(row.time, /^\d+\.\d{3} s$/, `row missing a section time: ${JSON.stringify(row)}`);
    }
    assert.doesNotMatch(String(tooltip.deltaClass), /is-nodata/, 'hovered a no-data segment');
    assert.doesNotMatch(tooltip.delta, /No telemetry/i, `tooltip unexpectedly reports no telemetry: ${JSON.stringify(tooltip.delta)}`);
    assert.match(
      tooltip.delta,
      /(quicker by \d+\.\d{3} s|Too close to call)/,
      `tooltip has no delta/neutral line: ${JSON.stringify(tooltip.delta)}`,
    );
    return `section ${target.index + 1} (${target.kind}); rows=${tooltip.rows.map((row) => row.time).join('/')}; "${tooltip.delta}"`;
  });

  await check('4.2', 'Tooltip screenshot is captured while visible', async () => {
    const tooltip = page.locator('#track-tooltip');
    assert.equal(await tooltip.isVisible(), true, 'tooltip is not visible for screenshot');
    await waitForAnimations(page, '#track-tooltip');
    const file = path.join(OUT_DIR, 'tooltip.png');
    await page.screenshot({ path: file });
    const stats = await readFile(file);
    assert.ok(stats.length > 10_000, `tooltip screenshot is suspiciously small (${stats.length} bytes)`);
    return `${path.relative(ROOT, file)} (${stats.length} bytes)`;
  });

  await page.mouse.move(4, 4);
  await page.waitForFunction(
    () => document.getElementById('track-tooltip')?.hidden === true,
    undefined,
    { timeout: 5_000 },
  );

  /* ---------------------------------------------------------------- */
  /* 5. Keyboard (run on the fresh deep-link page, selected = -1)       */
  /* ---------------------------------------------------------------- */
  await check('5.1', 'Keyboard ←/→ moves the tooltip and Escape hides it', async () => {
    await deepPage.locator('#track-svg').focus();
    assert.equal(
      await deepPage.evaluate(() => document.activeElement?.id),
      'track-svg',
      'track SVG did not take focus',
    );
    await deepPage.keyboard.press('ArrowRight');
    await deepPage.locator('#track-tooltip').waitFor({ state: 'visible', timeout: 5_000 });
    const first = await textOf(deepPage, '#track-tooltip .tt__title');
    assert.equal(first, 'Section 1 · 0.05 km', `first ArrowRight should show section 1, got "${first}"`);

    await deepPage.keyboard.press('ArrowRight');
    await deepPage.waitForFunction(
      () => document.querySelector('#track-tooltip .tt__title')?.textContent.trim() === 'Section 2 · 0.15 km',
      undefined,
      { timeout: 5_000 },
    );
    const second = await textOf(deepPage, '#track-tooltip .tt__title');

    await deepPage.keyboard.press('ArrowLeft');
    await deepPage.waitForFunction(
      () => document.querySelector('#track-tooltip .tt__title')?.textContent.trim() === 'Section 1 · 0.05 km',
      undefined,
      { timeout: 5_000 },
    );
    const back = await textOf(deepPage, '#track-tooltip .tt__title');

    await deepPage.keyboard.press('Escape');
    await deepPage.locator('#track-tooltip').waitFor({ state: 'hidden', timeout: 5_000 });
    assert.equal(await deepPage.locator('#track-tooltip').isVisible(), false);
    return `${first} → ${second} → ${back}; Escape hid tooltip`;
  });

  /* ---------------------------------------------------------------- */
  /* 6. Race switch (only when the catalog has another race)            */
  /* ---------------------------------------------------------------- */
  const catalog = await page.evaluate(async () => {
    const response = await fetch('data/catalog.json', { cache: 'no-store' });
    return response.json();
  });
  const otherRace = catalog.races.find((race) => String(race.session_key) !== AUSTIN.sessionKey);
  if (!otherRace) {
    skip('6.1', 'Switch to another catalog race', 'catalog has a single race (Austin only at test time)');
  } else {
    await check('6.1', `Switch to catalog race ${otherRace.session_key} (${otherRace.name})`, async () => {
      const before = await page.evaluate(() => ({
        title: document.getElementById('race-title').textContent.trim(),
        segments: document.querySelectorAll('.track-layer__segment').length,
      }));
      await page.selectOption('#race-select', String(otherRace.session_key));
      await waitForRaceLoaded(page, otherRace.name);
      assert.equal(await page.locator('#error-panel').isVisible(), false, 'error panel shown after race switch');
      const after = await page.evaluate(() => ({
        race: document.getElementById('race-select').value,
        title: document.getElementById('race-title').textContent.trim(),
        hash: window.location.hash,
        status: document.querySelector('.track-card').dataset.status,
        segments: document.querySelectorAll('.track-layer__segment').length,
        cards: document.querySelectorAll('.driver-card').length,
        emptyVisible: !document.getElementById('track-empty').hidden,
        loadingHidden: document.getElementById('loading').hidden,
      }));
      assert.equal(after.race, String(otherRace.session_key));
      assert.equal(after.title, otherRace.name);
      assert.match(after.hash, new RegExp(`(^#|&)race=${otherRace.session_key}(&|$)`));
      assert.equal(after.loadingHidden, true, 'loading overlay remained visible');
      if (after.status === 'ready') {
        assert.ok(after.segments > 0, 'new race rendered no segments');
        assert.equal(after.cards, 2, 'new race should still render two driver cards');
      } else {
        assert.equal(after.status, 'empty', `unexpected track status "${after.status}"`);
        assert.equal(after.emptyVisible, true, 'no-telemetry race did not show its empty state');
      }
      return `${before.title} (${before.segments} segs) → ${after.title} (${after.status}, ${after.segments} segs), hash ${after.hash}`;
    });
  }

  /* ---------------------------------------------------------------- */
  /* 7. Responsive layout + screenshots (fresh page, Austin defaults)   */
  /* ---------------------------------------------------------------- */
  const layoutPage = await context.newPage();
  instrumentPage(layoutPage, 'layout');
  await layoutPage.setViewportSize({ width: 1440, height: 1000 });
  await layoutPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await waitForReady(layoutPage, AUSTIN.title, AUSTIN.segments);
  await layoutPage.evaluate(() => document.fonts.ready.then(() => true));
  await layoutPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  await check('7.1', '1440×1000: no horizontal overflow', async () => {
    const metrics = await layoutPage.evaluate(() => ({
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    }));
    assert.ok(
      metrics.docScrollWidth <= metrics.innerWidth,
      `document scrollWidth ${metrics.docScrollWidth} > innerWidth ${metrics.innerWidth}`,
    );
    assert.ok(
      metrics.bodyScrollWidth <= metrics.innerWidth,
      `body scrollWidth ${metrics.bodyScrollWidth} > innerWidth ${metrics.innerWidth}`,
    );
    return `innerWidth=${metrics.innerWidth}, scrollWidth=${metrics.docScrollWidth}/${metrics.bodyScrollWidth}`;
  });

  const layoutPair = await layoutPage.evaluate(() => ({
    a: document.getElementById('driver-a').value,
    b: document.getElementById('driver-b').value,
  }));

  await check('7.2', '1440×1000: track SVG and controls are visible/usable', async () => {
    const svgMetrics = await layoutPage.evaluate(() => {
      const svg = document.getElementById('track-svg');
      const rect = svg.getBoundingClientRect();
      const style = getComputedStyle(svg);
      return {
        width: rect.width,
        height: rect.height,
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
      };
    });
    assert.ok(svgMetrics.width >= 300 && svgMetrics.height >= 300, `track SVG too small: ${JSON.stringify(svgMetrics)}`);
    assert.notEqual(svgMetrics.display, 'none');
    assert.equal(svgMetrics.visibility, 'visible');
    assert.ok(svgMetrics.opacity > 0.5, `track SVG opacity ${svgMetrics.opacity}`);

    const controls = await layoutPage.evaluate(() => {
      const box = (id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        race: box('race-select'),
        a: box('driver-a'),
        b: box('driver-b'),
        swap: box('swap-btn'),
        swapDisabled: document.getElementById('swap-btn').disabled,
        aDisabled: document.getElementById('driver-a').disabled,
        bDisabled: document.getElementById('driver-b').disabled,
      };
    });
    for (const [name, box] of Object.entries({ race: controls.race, a: controls.a, b: controls.b, swap: controls.swap })) {
      assert.ok(box.width > 0 && box.height > 0, `${name} control has no box`);
      assert.ok(box.left >= 0 && box.right <= 1440, `${name} control overflows the viewport: ${JSON.stringify(box)}`);
    }
    assert.equal(controls.swapDisabled, false, 'swap button is disabled');
    assert.equal(controls.aDisabled, false, 'driver A select is disabled');
    assert.equal(controls.bDisabled, false, 'driver B select is disabled');

    await layoutPage.locator('#swap-btn').click();
    await waitForValue(layoutPage, '#driver-a', layoutPair.b);
    await waitForValue(layoutPage, '#driver-b', layoutPair.a);
    await layoutPage.locator('#swap-btn').click();
    await waitForValue(layoutPage, '#driver-a', layoutPair.a);
    await waitForValue(layoutPage, '#driver-b', layoutPair.b);
    return `SVG ${Math.round(svgMetrics.width)}×${Math.round(svgMetrics.height)}; controls inside 1440px; swap works`;
  });

  const desktopFile = path.join(OUT_DIR, 'desktop.png');
  await check('7.3', '1440×1000 screenshot captured', async () => {
    await layoutPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await waitForAnimations(layoutPage, '#track-svg');
    await layoutPage.screenshot({ path: desktopFile });
    const png = await pngSize(desktopFile);
    assert.equal(png.width, 1440, `desktop screenshot width ${png.width}`);
    assert.equal(png.height, 1000, `desktop screenshot height ${png.height}`);
    return `${path.relative(ROOT, desktopFile)} ${png.width}×${png.height} (${png.bytes} bytes)`;
  });

  await layoutPage.setViewportSize({ width: 390, height: 844 });
  await layoutPage.waitForFunction(() => window.innerWidth === 390, undefined, { timeout: 5_000 });
  await layoutPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  await check('7.4', '390×844: no horizontal overflow', async () => {
    const metrics = await layoutPage.evaluate(() => ({
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      widest: [...document.querySelectorAll('body *')]
        .map((node) => ({ tag: node.tagName, id: node.id, cls: node.className?.baseVal ?? node.className, right: node.getBoundingClientRect().right }))
        .filter((entry) => typeof entry.right === 'number' && entry.right > window.innerWidth + 0.5)
        .slice(0, 8),
    }));
    assert.ok(
      metrics.docScrollWidth <= metrics.innerWidth,
      `document scrollWidth ${metrics.docScrollWidth} > innerWidth ${metrics.innerWidth}; widest=${JSON.stringify(metrics.widest)}`,
    );
    assert.ok(
      metrics.bodyScrollWidth <= metrics.innerWidth,
      `body scrollWidth ${metrics.bodyScrollWidth} > innerWidth ${metrics.innerWidth}; widest=${JSON.stringify(metrics.widest)}`,
    );
    return `innerWidth=${metrics.innerWidth}, scrollWidth=${metrics.docScrollWidth}/${metrics.bodyScrollWidth}`;
  });

  await check('7.5', '390×844: track SVG and controls are visible/usable', async () => {
    const svgMetrics = await layoutPage.evaluate(async () => {
      const svg = document.getElementById('track-svg');
      svg.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = svg.getBoundingClientRect();
      const style = getComputedStyle(svg);
      return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    });
    assert.ok(svgMetrics.width >= 300, `mobile track SVG too narrow: ${svgMetrics.width}px`);
    assert.ok(svgMetrics.height >= 300, `mobile track SVG too short: ${svgMetrics.height}px`);
    assert.notEqual(svgMetrics.display, 'none');
    assert.equal(svgMetrics.visibility, 'visible');
    assert.ok(svgMetrics.opacity > 0.5, `mobile track SVG opacity ${svgMetrics.opacity}`);
    assert.ok(
      svgMetrics.bottom > 0 && svgMetrics.top < svgMetrics.innerHeight,
      `mobile track SVG is not in the viewport: ${JSON.stringify(svgMetrics)}`,
    );

    const controls = await layoutPage.evaluate(() => {
      const box = (id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        innerWidth: window.innerWidth,
        race: box('race-select'),
        a: box('driver-a'),
        b: box('driver-b'),
        swap: box('swap-btn'),
        aDisabled: document.getElementById('driver-a').disabled,
        bDisabled: document.getElementById('driver-b').disabled,
        swapDisabled: document.getElementById('swap-btn').disabled,
        raceOptions: document.querySelectorAll('#race-select option').length,
      };
    });
    for (const [name, box] of Object.entries({ race: controls.race, a: controls.a, b: controls.b, swap: controls.swap })) {
      assert.ok(box.width > 0 && box.height > 0, `${name} control has no box at 390px`);
      assert.ok(box.left >= 0, `${name} control starts left of the viewport: ${JSON.stringify(box)}`);
      assert.ok(box.right <= controls.innerWidth + 0.5, `${name} control overflows 390px: ${JSON.stringify(box)}`);
    }
    assert.equal(controls.aDisabled, false, 'mobile driver A select is disabled');
    assert.equal(controls.bDisabled, false, 'mobile driver B select is disabled');
    assert.equal(controls.swapDisabled, false, 'mobile swap button is disabled');
    assert.ok(controls.raceOptions >= 1, 'mobile race select has no options');

    await layoutPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await layoutPage.locator('#swap-btn').click();
    await waitForValue(layoutPage, '#driver-a', layoutPair.b);
    await waitForValue(layoutPage, '#driver-b', layoutPair.a);
    await layoutPage.locator('#swap-btn').click();
    await waitForValue(layoutPage, '#driver-a', layoutPair.a);
    await waitForValue(layoutPage, '#driver-b', layoutPair.b);

    const candidate = await layoutPage.evaluate(() => {
      const a = document.getElementById('driver-a').value;
      const b = document.getElementById('driver-b').value;
      const option = [...document.querySelectorAll('#driver-a option')]
        .find((entry) => !entry.disabled && entry.value !== a && entry.value !== b);
      return option ? { value: option.value, text: option.textContent.trim() } : null;
    });
    assert.ok(candidate, 'no selectable third driver for the mobile control test');
    const candidateDriver = driverByNumber.get(String(candidate.value));
    assert.ok(candidateDriver, `candidate driver ${candidate.value} missing from race data`);
    await layoutPage.selectOption('#driver-a', candidate.value);
    await waitForValue(layoutPage, '#driver-a', candidate.value);
    await layoutPage.waitForFunction(
      (acronym) => document.getElementById('legend').textContent.includes(acronym),
      candidateDriver.acronym,
      { timeout: 5_000 },
    );
    await layoutPage.selectOption('#driver-a', layoutPair.a);
    await waitForValue(layoutPage, '#driver-a', layoutPair.a);
    return `SVG ${Math.round(svgMetrics.width)}×${Math.round(svgMetrics.height)} in view; controls inside 390px; swap + driver select (${candidateDriver.acronym}) work`;
  });

  const mobileFile = path.join(OUT_DIR, 'mobile.png');
  await check('7.6', '390×844 screenshot captured', async () => {
    await layoutPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await waitForAnimations(layoutPage, '#track-svg');
    await layoutPage.screenshot({ path: mobileFile });
    const png = await pngSize(mobileFile);
    assert.equal(png.width, 390, `mobile screenshot width ${png.width}`);
    assert.equal(png.height, 844, `mobile screenshot height ${png.height}`);
    return `${path.relative(ROOT, mobileFile)} ${png.width}×${png.height} (${png.bytes} bytes)`;
  });

  /* ---------------------------------------------------------------- */
  /* 8. Console / page errors / failed requests                         */
  /* ---------------------------------------------------------------- */
  await check('8.1', 'No console errors or page errors', async () => {
    assert.deepEqual(observed.consoleErrors, [], `console errors:\n${JSON.stringify(observed.consoleErrors, null, 2)}`);
    assert.deepEqual(observed.pageErrors, [], `page errors:\n${JSON.stringify(observed.pageErrors, null, 2)}`);
    return '0 console errors, 0 page errors';
  });

  await check('8.2', 'No failed requests or HTTP error responses', async () => {
    assert.deepEqual(
      observed.failedRequests,
      [],
      `failed requests:\n${JSON.stringify(observed.failedRequests, null, 2)}`,
    );
    assert.deepEqual(
      observed.httpErrors,
      [],
      `HTTP >=400 responses:\n${JSON.stringify(observed.httpErrors, null, 2)}`,
    );
    return '0 failed requests, 0 HTTP >=400 responses';
  });

  /* ---------------------------------------------------------------- */
  /* 9. Screenshot artefacts                                            */
  /* ---------------------------------------------------------------- */
  await check('9.1', 'All three screenshots exist at the expected sizes', async () => {
    const files = {
      desktop: await pngSize(desktopFile),
      mobile: await pngSize(mobileFile),
      tooltip: await pngSize(path.join(OUT_DIR, 'tooltip.png')),
    };
    assert.deepEqual(
      { width: files.desktop.width, height: files.desktop.height },
      { width: 1440, height: 1000 },
    );
    assert.deepEqual(
      { width: files.mobile.width, height: files.mobile.height },
      { width: 390, height: 844 },
    );
    assert.deepEqual(
      { width: files.tooltip.width, height: files.tooltip.height },
      { width: 1440, height: 1000 },
    );
    for (const [name, info] of Object.entries(files)) {
      assert.ok(info.bytes > 10_000, `${name}.png is only ${info.bytes} bytes`);
    }
    return Object.entries(files)
      .map(([name, info]) => `${name} ${info.width}×${info.height} ${info.bytes}B`)
      .join('; ');
  });

  await deepPage.close();
  await page.close();
  await layoutPage.close();
}

async function pngSize(file) {
  const buffer = await readFile(file);
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  let server = null;
  let browser = null;

  try {
    server = await startServer();
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      locale: 'en-GB',
      timezoneId: 'Europe/Copenhagen',
    });
    await runCoreSuite(context);
    await context.close();
  } catch (error) {
    harnessError = error;
    console.error(`HARNESS FAILURE: ${describeError(error)}`);
    if (error?.stack) console.error(error.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    const failed = checks.filter((checkResult) => checkResult.status === 'FAIL').length;
    const skipped = checks.filter((checkResult) => checkResult.status === 'SKIP').length;
    const result = {
      suite: 'core',
      baseUrl: BASE,
      chrome: CHROME,
      generatedAt: new Date().toISOString(),
      status: failed === 0 && !harnessError ? 'PASS' : 'FAIL',
      counts: {
        passed: checks.filter((checkResult) => checkResult.status === 'PASS').length,
        failed,
        skipped,
      },
      harnessError: harnessError ? describeError(harnessError) : null,
      observed,
      checks,
    };
    await writeFile(RESULTS_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    if (!QUIET) {
      console.log('');
      console.log(
        `CORE E2E: ${result.status} — ${result.counts.passed} passed, ${failed} failed, ${skipped} skipped`,
      );
      console.log(`Results: ${path.relative(ROOT, RESULTS_FILE)}`);
    }
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  }
}

await main();
