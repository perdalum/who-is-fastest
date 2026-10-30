#!/usr/bin/env node
/**
 * Adversarial + accessibility browser suite for "Who is the fastest?".
 *
 * Independent of the product code: this file only reads/serves the built app and
 * drives it through Playwright. It never imports product modules and never edits
 * index.html / assets / scripts / data / docs.
 *
 * What it covers
 *   1. Same-team pair (LEC / HAM, both Ferrari): both driver selects work, the
 *      legend names both drivers, and a secondary non-colour channel
 *      (`is-secondary`, dashed stroke / outlined swatch) distinguishes them.
 *      The SVG accessible description must name both drivers, not just colours.
 *   2. Colour-blind proxy: all driver colours are rewritten to the same value
 *      via request interception, then `is-secondary` must still be present and
 *      the B driver must have a real `stroke-dasharray` / outlined legend swatch.
 *   3. Keyboard-only: Tab reaches the race + driver selects and the SVG; ←/→
 *      move the tooltip; Escape clears it; focus-visible outlines exist.
 *   4. Touch (390 × 844, hasTouch: true): tap pins the tooltip, another segment
 *      updates it, tapping elsewhere dismisses it (docs/05-test-strategy.md,
 *      "Touch pass: tap to pin, tap elsewhere to dismiss"), no horizontal page
 *      scroll and the tooltip stays inside the viewport.
 *   5. prefers-reduced-motion: reduce: page loads, loading overlay is gone, the
 *      stage is not inert, and no visible animation keeps running.
 *   6. Missing race data: `**\/data/races/*.json` is answered with 404; the
 *      error panel with a retry button must be visible; restoring the route and
 *      clicking retry must recover. The two intentional 404 console errors are
 *      whitelisted here only.
 *   7. A normal run produces no console errors, page errors, failed requests,
 *      HTTP >= 400 responses or unhandled promise rejections.
 *   8. ARIA: SVG role/title/desc, labelled selects, live region, named buttons.
 *
 * Server
 *   Self-contained static server on PORT 5175 by default (override with
 *   ADVERSARIAL_PORT or options.port). If 5175 is occupied, the suite binds the
 *   next free port (5176…5185) so it still owns the server it tests; the actual
 *   port is recorded in the result. It never piggybacks on a foreign server.
 *
 * Integration with tests/e2e/run.mjs (owned by another agent)
 *   run.mjs spawns: node tests/e2e/adversarial.mjs
 *   It reads:       tmp/e2e/adversarial-results.json
 *   Result schema:  { suite, status, counts, harnessError, checks[] }
 *   Each check:     { id, name, status: 'PASS'|'FAIL', detail, defects[] }
 *   The file can also be imported:
 *       import { runAdversarial } from './adversarial.mjs';
 *       const result = await runAdversarial();       // no process.exit
 *   `runAdversarial()` resolves; it never calls process.exit. Pass
 *   { writeResults: false } to skip the tmp/e2e result file, or
 *   { port, headless, executablePath, quiet } to override defaults.
 *
 * Direct run: node tests/e2e/adversarial.mjs
 */

import http from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PORT = 5175;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = path.join(ROOT, 'tmp', 'e2e');
const RESULTS_FILE = path.join(OUT_DIR, 'adversarial-results.json');
const QUIET = process.env.E2E_QUIET === '1' || process.argv.includes('--quiet');
const VIEWPORT_DESKTOP = { width: 1440, height: 1000 };
const VIEWPORT_MOBILE = { width: 390, height: 844 };

/* ------------------------------------------------------------------ */
/* Static server                                                      */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': body.length
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
}

async function startServer(preferredPort) {
  let lastError = null;
  for (let offset = 0; offset <= 10; offset += 1) {
    const port = preferredPort + offset;
    const server = createAppServer();
    try {
      await listen(server, port);
      return {
        server,
        port,
        requestedPort: preferredPort,
        baseURL: `http://127.0.0.1:${port}`,
        close: async () => {
          await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections?.();
          });
        }
      };
    } catch (error) {
      server.close();
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(
    `Ports ${preferredPort}-${preferredPort + 10} are all in use; cannot start a self-contained ` +
      `server (${describeError(lastError)}).`
  );
}

/* ------------------------------------------------------------------ */
/* Browser / diagnostics helpers                                      */
/* ------------------------------------------------------------------ */

function describeError(error) {
  const message = error?.message ? String(error.message) : String(error);
  return message.replace(/\s+at\s[\s\S]*$/, '').trim() || 'unknown error';
}

function attachDiagnostics(page) {
  const state = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    httpErrors: [],
    reset() {
      this.consoleErrors.length = 0;
      this.pageErrors.length = 0;
      this.requestFailures.length = 0;
      this.httpErrors.length = 0;
    }
  };
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => state.pageErrors.push(error?.stack || String(error)));
  page.on('requestfailed', (request) => {
    state.requestFailures.push(`${request.url()} :: ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) state.httpErrors.push(`${response.status()} ${response.url()}`);
  });
  return state;
}

async function createPage(browser, contextOptions = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORT_DESKTOP,
    locale: 'en-GB',
    timezoneId: 'Europe/Copenhagen',
    ...contextOptions
  });
  await context.addInitScript(() => {
    window.__adversarialDiagnostics = { unhandled: [] };
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      window.__adversarialDiagnostics.unhandled.push(
        reason && reason.stack ? reason.stack : String(reason)
      );
    });
  });
  const page = await context.newPage();
  const diagnostics = attachDiagnostics(page);
  return { context, page, diagnostics };
}

async function unhandledRejections(page) {
  try {
    return await page.evaluate(() => window.__adversarialDiagnostics?.unhandled ?? []);
  } catch {
    return [];
  }
}

async function waitForApp(page, timeout = 20000) {
  await page.waitForFunction(
    () => {
      const title = document.querySelector('#race-title')?.textContent?.trim();
      return (
        title &&
        title !== 'Loading…' &&
        document.querySelectorAll('.track-layer__segment').length > 0
      );
    },
    null,
    { timeout }
  );
}

function findAcronym(options, acronym) {
  return options.find((option) => {
    const match = option.label.match(/^\s*([A-Z0-9]{2,4})\b/);
    return match && match[1].toUpperCase() === acronym.toUpperCase();
  });
}

function optionName(option) {
  const bits = option.label.split('·');
  return bits.length > 1 ? bits.slice(1).join('·').trim() : option.label;
}

async function driverOptions(page, select = '#driver-a') {
  return page.$$eval(`${select} option`, (options) =>
    options.map((option) => ({
      value: option.value,
      label: option.textContent.replace(/\s+/g, ' ').trim(),
      disabled: option.disabled
    }))
  );
}

async function pairSnapshot(page) {
  return page.evaluate(() => {
    const legend = document.querySelector('#legend')?.innerText || '';
    const desc = document.querySelector('#track-desc')?.textContent?.trim() || '';
    const card = document.querySelector('.track-card');
    return {
      a: document.querySelector('#driver-a')?.value ?? '',
      b: document.querySelector('#driver-b')?.value ?? '',
      legend,
      desc,
      cardClass: card?.className || '',
      aColor: card ? getComputedStyle(card).getPropertyValue('--a-color').trim() : '',
      bColor: card ? getComputedStyle(card).getPropertyValue('--b-color').trim() : ''
    };
  });
}

async function secondarySnapshot(page) {
  return page.evaluate(() => {
    const segments = [...document.querySelectorAll('.track-layer__segment.is-secondary')];
    const swatch = document.querySelector('.legend__swatch.is-secondary');
    const swatchStyle = swatch ? getComputedStyle(swatch) : null;
    return {
      segmentCount: segments.length,
      segmentClasses: segments.slice(0, 4).map((segment) => segment.getAttribute('class')),
      dash: segments[0] ? getComputedStyle(segments[0]).strokeDasharray : null,
      legendCount: document.querySelectorAll('.legend__swatch.is-secondary').length,
      legendBackground: swatchStyle?.backgroundColor || null,
      legendShadow: swatchStyle?.boxShadow || null,
      aSegments: document.querySelectorAll('.track-layer__segment.is-a').length,
      bSegments: document.querySelectorAll('.track-layer__segment.is-b').length,
      neutralSegments: document.querySelectorAll('.track-layer__segment.is-neutral').length
    };
  });
}

function outlineOk(snapshot) {
  return (
    snapshot.focusVisible === true &&
    snapshot.outlineStyle !== 'none' &&
    Number.parseFloat(snapshot.outlineWidth) > 0
  );
}

async function focusSnapshot(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    const style = element ? getComputedStyle(element) : null;
    const className =
      typeof element?.className === 'string'
        ? element.className
        : element?.className?.baseVal || '';
    return {
      tag: element?.tagName?.toLowerCase() || '',
      id: element?.id || '',
      className,
      focusVisible: element?.matches?.(':focus-visible') ?? false,
      outlineStyle: style?.outlineStyle || 'none',
      outlineWidth: style?.outlineWidth || '0px',
      outlineColor: style?.outlineColor || ''
    };
  });
}

async function segmentPoint(page, index) {
  return page.evaluate((segmentIndex) => {
    const hit = document.querySelector(`.track-layer__hit[data-index="${segmentIndex}"]`);
    if (!hit) return null;
    const length = hit.getTotalLength();
    const point = hit.getPointAtLength(length * 0.5);
    const matrix = hit.getScreenCTM();
    if (!matrix) return null;
    return {
      x: point.x * matrix.a + point.y * matrix.c + matrix.e,
      y: point.x * matrix.b + point.y * matrix.d + matrix.f
    };
  }, index);
}

async function tooltipSnapshot(page) {
  return page.evaluate(() => {
    const tooltip = document.querySelector('#track-tooltip');
    const rect = tooltip?.getBoundingClientRect();
    return {
      visible: Boolean(tooltip && !tooltip.hidden),
      title: tooltip?.querySelector('.tt__title')?.textContent?.trim() || '',
      selected: document.querySelector('.track-layer__segment.is-selected')?.dataset.index ?? null,
      selectedCount: document.querySelectorAll('.track-layer__segment.is-selected').length,
      rect: rect
        ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
        : null,
      innerWidth: window.innerWidth
    };
  });
}

/* ------------------------------------------------------------------ */
/* Checks                                                             */
/* ------------------------------------------------------------------ */

/* 1. Same-team pair ------------------------------------------------- */

async function checkSameTeam(t, ctx) {
  const { context, page, diagnostics } = await createPage(ctx.browser);
  try {
    await page.goto(`${ctx.baseURL}/`, { waitUntil: 'load' });
    await waitForApp(page);

    const options = await driverOptions(page, '#driver-a');
    const lec = findAcronym(options, 'LEC');
    const ham = findAcronym(options, 'HAM');
    t.expect(Boolean(lec), 'LEC is not present in #driver-a options.');
    t.expect(Boolean(ham), 'HAM is not present in #driver-a options.');
    if (!lec || !ham) return;

    const six = options.find((option) => option.value === '6');
    if (six && ham.value !== '6') {
      t.observe(
        `Fixture note: the brief says "HAM 6", but this dataset maps #6 to ${six.label}; ` +
          `HAM is #${ham.value}. The same-team check therefore resolves drivers by acronym.`
      );
    }

    t.expect(lec.value === '16', `LEC option value is ${lec.value}, expected 16 (data/catalog/race fixture).`);

    await page.selectOption('#driver-a', lec.value);
    await page.selectOption('#driver-b', ham.value);
    await page.waitForFunction(
      (names) => {
        const desc = document.querySelector('#track-desc')?.textContent || '';
        return (
          document.querySelector('#driver-a')?.value === names.a &&
          document.querySelector('#driver-b')?.value === names.b &&
          desc.includes(names.aName) &&
          desc.includes(names.bName)
        );
      },
      { a: lec.value, b: ham.value, aName: optionName(lec), bName: optionName(ham) },
      { timeout: 10000 }
    );

    const pair = await pairSnapshot(page);
    t.expect(pair.a === lec.value, `#driver-a reads ${pair.a}, expected ${lec.value}.`);
    t.expect(pair.b === ham.value, `#driver-b reads ${pair.b}, expected ${ham.value}.`);
    t.expect(
      pair.cardClass.includes('same-team'),
      `Track card lacks .same-team for ${lec.label} / ${ham.label} (class="${pair.cardClass}").`
    );

    // Legend must name both drivers, not only show swatches.
    t.expect(/LEC/.test(pair.legend), `Legend does not contain LEC: ${JSON.stringify(pair.legend)}`);
    t.expect(/HAM/.test(pair.legend), `Legend does not contain HAM: ${JSON.stringify(pair.legend)}`);
    t.expect(
      pair.legend.includes(optionName(lec)),
      `Legend does not contain full name "${optionName(lec)}": ${JSON.stringify(pair.legend)}`
    );
    t.expect(
      pair.legend.includes(optionName(ham)),
      `Legend does not contain full name "${optionName(ham)}": ${JSON.stringify(pair.legend)}`
    );

    const secondary = await secondarySnapshot(page);
    t.expect(
      secondary.segmentCount > 0 || secondary.legendCount > 0,
      'Same-team pair has no .is-secondary segment and no .is-secondary legend swatch; ' +
        'colour is the only encoding on the track.'
    );
    if (secondary.segmentCount > 0) {
      t.expect(
        secondary.dash && secondary.dash !== 'none',
        `A segment has class .is-secondary but computed stroke-dasharray is ${JSON.stringify(secondary.dash)}.`
      );
    }
    if (secondary.legendCount > 0) {
      t.expect(
        /inset/.test(secondary.legendShadow || '') ||
          secondary.legendBackground === 'rgba(0, 0, 0, 0)',
        `Legend .is-secondary swatch has no visible secondary treatment (background=${secondary.legendBackground}, ` +
          `box-shadow=${secondary.legendShadow}).`
      );
    }

    // Accessible description: names and counts, not a colour-only claim.
    t.expect(
      pair.desc.includes(optionName(lec)) && pair.desc.includes(optionName(ham)),
      `Accessible SVG description does not name both same-team drivers: ${JSON.stringify(pair.desc)}`
    );
    t.expect(
      /sections quicker for LEC/.test(pair.desc) && /for HAM/.test(pair.desc),
      `Accessible SVG description does not state per-driver section counts: ${JSON.stringify(pair.desc)}`
    );
    const colourOnly =
      /(colou?r[^.]{0,50}\b(red|blue|green|yellow|orange|pink|purple|silver|black|white)\b)|(\b(red|blue|green|yellow|orange|pink|purple|silver|black|white)\b[^.]{0,50}colou?r)/i.test(
        pair.desc
      );
    t.expect(!colourOnly, `Accessible SVG description makes a colour-only mapping claim: ${JSON.stringify(pair.desc)}`);

    t.expect(
      diagnostics.consoleErrors.length === 0,
      `Console errors during same-team check: ${diagnostics.consoleErrors.join(' | ')}`
    );
    t.note(
      `Same-team ${lec.label} / ${ham.label}: ${secondary.segmentCount} dashed segment(s), ` +
        `${secondary.aSegments} A / ${secondary.bSegments} B / ${secondary.neutralSegments} neutral.`
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* 2. Colour-blind proxy --------------------------------------------- */

async function checkColourBlindProxy(t, ctx) {
  const { context, page, diagnostics } = await createPage(ctx.browser);
  let rewritten = 0;
  try {
    await context.route('**/data/races/*.json', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const source =
        data.drivers?.find((driver) => String(driver.number) === '16')?.colour ||
        data.drivers?.[0]?.colour ||
        'ED1131';
      for (const driver of data.drivers || []) {
        driver.colour = source;
        rewritten += 1;
      }
      await route.fulfill({ response, json: data });
    });

    await page.goto(`${ctx.baseURL}/#race=11396&a=16&b=3`, { waitUntil: 'load' });
    await waitForApp(page);

    t.expect(rewritten > 0, 'Request interception did not rewrite any driver colours.');

    let pair = await pairSnapshot(page);
    let secondary = await secondarySnapshot(page);

    // If B happens to be quicker nowhere, swap A/B; with all colours equal the
    // faster driver then supplies B-coloured (dashed) sections.
    if (secondary.segmentCount === 0) {
      await page.click('#swap-btn');
      await page.waitForTimeout(300);
      pair = await pairSnapshot(page);
      secondary = await secondarySnapshot(page);
    }

    // Last resort: try a known different B driver.
    if (secondary.segmentCount === 0) {
      const options = await driverOptions(page, '#driver-b');
      for (const candidate of options.filter((option) => !option.disabled && option.value !== pair.b).slice(0, 6)) {
        await page.selectOption('#driver-b', candidate.value);
        await page.waitForTimeout(250);
        secondary = await secondarySnapshot(page);
        if (secondary.segmentCount > 0) {
          pair = await pairSnapshot(page);
          break;
        }
      }
    }

    t.expect(
      pair.aColor.toLowerCase() === pair.bColor.toLowerCase(),
      `Forced colours did not reach the track: --a-color=${pair.aColor}, --b-color=${pair.bColor}.`
    );
    t.expect(
      pair.cardClass.includes('same-team'),
      `Track card lacks the close-colour .same-team state after forcing colours (class="${pair.cardClass}").`
    );
    t.expect(
      secondary.segmentCount > 0,
      'No .is-secondary segment after forcing every team colour to the same value; ' +
        'the track cannot show which B sections belong to the second driver without colour.'
    );
    t.expect(
      Boolean(secondary.dash) && secondary.dash !== 'none',
      `Secondary B segment has no computed stroke-dasharray (got ${JSON.stringify(secondary.dash)}).`
    );
    t.expect(
      secondary.legendCount > 0,
      'Legend has no .is-secondary swatch after forcing colours.'
    );
    t.expect(
      /inset/.test(secondary.legendShadow || ''),
      `Legend .is-secondary swatch has no outline/inset treatment (box-shadow=${secondary.legendShadow}).`
    );
    if (secondary.aSegments === 0) {
      t.observe(
        `No solid A segments exist for this pair (A=0, B=${secondary.bSegments}); dashed B sections are ` +
          'distinguishable from neutral sections but there is no A/B contrast on the track itself.'
      );
    }

    t.note(
      `Forced ${rewritten} driver colours to ${pair.aColor}; ` +
        `${secondary.segmentCount} dashed B segment(s), A=${secondary.aSegments}, B=${secondary.bSegments}.`
    );

    t.expect(
      diagnostics.consoleErrors.length === 0,
      `Console errors during colour-blind check: ${diagnostics.consoleErrors.join(' | ')}`
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* 3. Keyboard-only -------------------------------------------------- */

async function testKeyboardTooltip(t, page) {
  await page.keyboard.press('ArrowRight');
  await page
    .waitForFunction(() => !document.querySelector('#track-tooltip')?.hidden, null, { timeout: 4000 })
    .catch(() => {});
  const first = await tooltipSnapshot(page);
  t.expect(first.visible, 'ArrowRight on the focused SVG did not show the tooltip.');
  t.expect(
    /^Section \d+ · [\d.]+ km$/.test(first.title),
    `Tooltip title after ArrowRight is not a section description: ${JSON.stringify(first.title)}`
  );

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const second = await tooltipSnapshot(page);
  t.expect(second.visible, 'Second ArrowRight hid the tooltip.');
  t.expect(
    second.title !== first.title && second.selected !== first.selected,
    `ArrowRight did not move the tooltip (first=${JSON.stringify(first.title)}, second=${JSON.stringify(second.title)}).`
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const escaped = await tooltipSnapshot(page);
  t.expect(!escaped.visible, 'Escape did not hide the tooltip.');
  if (escaped.selectedCount > 0) {
    t.observe(
      `P3: Escape hides the tooltip but leaves ${escaped.selectedCount} segment(s) with .is-selected; ` +
        'the visual selection is not cleared (app.js Escape branch only calls hideTooltip()).'
    );
  }
}

async function checkKeyboard(t, ctx) {
  const { context, page, diagnostics } = await createPage(ctx.browser);
  try {
    await page.goto(`${ctx.baseURL}/`, { waitUntil: 'load' });
    await waitForApp(page);

    const initialFocus = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    if (initialFocus === 'track-svg') {
      t.observe(
        'P3: loadRace() moves focus to #track-svg on page load; a keyboard user pressing Tab starts after ' +
          'the track and must wrap through the page to reach the driver selects.'
      );
    }

    const raceSelect = await page.evaluate(() => {
      const select = document.querySelector('#race-select');
      return {
        disabled: Boolean(select?.disabled),
        optionCount: select?.options.length ?? 0
      };
    });

    await page.evaluate(() => document.activeElement?.blur());

    const reached = new Map();
    let svgTested = false;
    for (let i = 0; i < 18; i += 1) {
      await page.keyboard.press('Tab');
      const focus = await focusSnapshot(page);
      if (focus.id) reached.set(focus.id, focus);
      if (focus.className.includes('skip-link')) reached.set('skip-link', focus);
      if (focus.id === 'track-svg' && !svgTested) {
        svgTested = true;
        await testKeyboardTooltip(t, page);
      }
    }

    if (raceSelect.disabled) {
      t.expect(
        false,
        `P2: #race-select is disabled because data/catalog.json exposes only ${raceSelect.optionCount} race ` +
          '(docs/03 §1.2 requires five curated 2026 races) and populateRaceSelect() disables a single-race ' +
          'select. It is skipped by Tab, so keyboard users cannot reach the race picker; docs/03 §6 and ' +
          'check 3 require Tab to reach the race select.'
      );
    } else {
      t.expect(reached.has('race-select'), 'Tab never reached #race-select.');
    }
    t.expect(reached.has('driver-a'), 'Tab never reached #driver-a.');
    t.expect(reached.has('driver-b'), 'Tab never reached #driver-b.');
    t.expect(reached.has('track-svg'), 'Tab never reached #track-svg.');

    for (const id of ['driver-a', 'driver-b', 'track-svg']) {
      const focus = reached.get(id);
      if (!focus) continue;
      t.expect(
        outlineOk(focus),
        `No visible :focus-visible outline on #${id} after keyboard focus ` +
          `(style=${focus.outlineStyle}, width=${focus.outlineWidth}, focusVisible=${focus.focusVisible}).`
      );
    }
    if (!raceSelect.disabled && reached.has('race-select')) {
      t.expect(outlineOk(reached.get('race-select')), 'No visible :focus-visible outline on #race-select.');
    }

    t.expect(
      diagnostics.consoleErrors.length === 0,
      `Console errors during keyboard check: ${diagnostics.consoleErrors.join(' | ')}`
    );
    t.note(
      `Tab reached: ${[...reached.keys()].join(', ')}; ` +
        `race select ${raceSelect.disabled ? 'disabled' : 'enabled'}.`
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* 4. Touch ----------------------------------------------------------- */

async function checkTouch(t, ctx) {
  const { context, page, diagnostics } = await createPage(ctx.browser, {
    viewport: VIEWPORT_MOBILE,
    screen: VIEWPORT_MOBILE,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2
  });
  try {
    await page.goto(`${ctx.baseURL}/#race=11396&a=16&b=44`, { waitUntil: 'load' });
    await waitForApp(page);

    const overflow = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth
    }));
    t.expect(
      overflow.docScrollWidth <= overflow.clientWidth + 1 && overflow.bodyScrollWidth <= overflow.clientWidth + 1,
      `Horizontal page scroll at 390px: client=${overflow.clientWidth}, ` +
        `document.scrollWidth=${overflow.docScrollWidth}, body.scrollWidth=${overflow.bodyScrollWidth}.`
    );

    const segmentCount = await page.locator('.track-layer__segment').count();
    t.expect(segmentCount >= 2, `Only ${segmentCount} track segment(s) available for the touch test.`);
    if (segmentCount < 2) return;
    const firstIndex = Math.min(20, segmentCount - 1);
    let secondIndex = Math.min(30, segmentCount - 1);
    if (secondIndex === firstIndex) secondIndex = firstIndex === 0 ? 1 : firstIndex - 1;
    const firstTitlePattern = new RegExp(`^Section ${firstIndex + 1} · `);

    const firstPoint = await segmentPoint(page, firstIndex);
    t.expect(Boolean(firstPoint), `Could not resolve a screen point for segment ${firstIndex}.`);
    if (!firstPoint) return;

    await page.touchscreen.tap(firstPoint.x, firstPoint.y);
    await page
      .waitForFunction(() => !document.querySelector('#track-tooltip')?.hidden, null, { timeout: 4000 })
      .catch(() => {});
    const first = await tooltipSnapshot(page);
    t.expect(first.visible, 'Tapping a track segment did not pin/show the tooltip.');
    t.expect(
      first.selected === String(firstIndex),
      `Tapping segment ${firstIndex} selected ${JSON.stringify(first.selected)} instead.`
    );
    t.expect(
      firstTitlePattern.test(first.title),
      `Pinned tooltip title is not for section ${firstIndex + 1}: ${JSON.stringify(first.title)}`
    );
    t.expect(
      first.rect && first.rect.left >= 0 && first.rect.right <= first.innerWidth + 1,
      `Tooltip is clipped horizontally at 390px: ${JSON.stringify(first.rect)}.`
    );

    const secondPoint = await segmentPoint(page, secondIndex);
    t.expect(Boolean(secondPoint), `Could not resolve a screen point for segment ${secondIndex}.`);
    if (secondPoint) {
      await page.touchscreen.tap(secondPoint.x, secondPoint.y);
      await page
        .waitForFunction(
          (previous) => {
            const title = document.querySelector('#track-tooltip .tt__title')?.textContent?.trim();
            return title && title !== previous;
          },
          first.title,
          { timeout: 4000 }
        )
        .catch(() => {});
      const second = await tooltipSnapshot(page);
      t.expect(
        second.visible && second.selected === String(secondIndex),
        `Tapping another segment did not update the tooltip (selected=${JSON.stringify(second.selected)}).`
      );
      t.expect(
        second.title !== first.title,
        `Tapping another segment left the same tooltip text: ${JSON.stringify(second.title)}`
      );
    }

    // docs/05-test-strategy.md: "Touch pass: tap to pin, tap elsewhere to dismiss".
    await page.touchscreen.tap(195, 24);
    await page.waitForTimeout(450);
    const afterOutside = await tooltipSnapshot(page);
    t.expect(
      !afterOutside.visible,
      `P2: tapping outside the track (header) does not dismiss the pinned tooltip; it still shows ` +
        `${JSON.stringify(afterOutside.title)}. docs/05-test-strategy.md requires "tap elsewhere to dismiss"; ` +
        'app.js only dismisses on a second tap on the same segment or via Escape.'
    );
    if (afterOutside.visible) {
      t.observe(
        'P3: the only pointer dismissal is re-tapping the selected segment; there is no document/outside ' +
          'pointerdown handler and no dismiss control.'
      );
    }

    const overflowAfter = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth
    }));
    t.expect(
      overflowAfter.docScrollWidth <= overflowAfter.clientWidth + 1 &&
        overflowAfter.bodyScrollWidth <= overflowAfter.clientWidth + 1,
      `Horizontal page scroll after opening the tooltip: client=${overflowAfter.clientWidth}, ` +
        `document.scrollWidth=${overflowAfter.docScrollWidth}, body.scrollWidth=${overflowAfter.bodyScrollWidth}.`
    );

    const target = await page.evaluate((index) => {
      const hit = document.querySelector(`.track-layer__hit[data-index="${index}"]`);
      const matrix = hit?.getScreenCTM();
      return matrix ? 34 * Math.abs(matrix.a) : 0;
    }, firstIndex);
    if (target > 0 && target < 24) {
      t.observe(
        `P3: effective touch lane is ~${target.toFixed(1)}px wide at 390px (SVG hit stroke 34 user units × ` +
          `scale); below the 24×24 CSS px WCAG 2.5.8 minimum. Tapping the exact centre works, but the target is small.`
      );
    }

    t.expect(
      diagnostics.consoleErrors.length === 0,
      `Console errors during touch check: ${diagnostics.consoleErrors.join(' | ')}`
    );
    t.note(
      `390px overflow: document=${overflow.docScrollWidth}, body=${overflow.bodyScrollWidth}; ` +
        `tooltip ${first.visible ? 'pinned' : 'missing'}, outside tap ${afterOutside.visible ? 'did NOT dismiss' : 'dismissed'}.`
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* 5. Reduced motion -------------------------------------------------- */

async function checkReducedMotion(t, ctx) {
  const { context, page, diagnostics } = await createPage(ctx.browser, {
    viewport: VIEWPORT_DESKTOP,
    reducedMotion: 'reduce'
  });
  try {
    await page.goto(`${ctx.baseURL}/`, { waitUntil: 'load' });
    await waitForApp(page);

    const state = await page.evaluate(() => {
      const loading = document.querySelector('#loading');
      const stage = document.querySelector('.stage');
      const title = document.querySelector('#race-title');
      const spinner = document.querySelector('.spinner');
      const spinnerStyle = spinner ? getComputedStyle(spinner) : null;
      const stageStyle = getComputedStyle(stage);
      const rect = title.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)),
        Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2))
      );
      const animated = [...document.querySelectorAll('*')]
        .map((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            id: element.id || '',
            className:
              typeof element.className === 'string' ? element.className : element.className?.baseVal || '',
            name: style.animationName,
            duration: style.animationDuration,
            iterations: style.animationIterationCount,
            display: style.display,
            visible:
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number.parseFloat(style.opacity || '1') > 0 &&
              box.width > 0 &&
              box.height > 0
          };
        })
        .filter((entry) => entry.name !== 'none' && entry.visible);
      return {
        reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        loadingHidden: loading.hidden,
        loadingDisplay: getComputedStyle(loading).display,
        bodyLoading: document.body.classList.contains('is-loading'),
        title: title.textContent.trim(),
        segments: document.querySelectorAll('.track-layer__segment').length,
        stageOpacity: stageStyle.opacity,
        stagePointerEvents: stageStyle.pointerEvents,
        titleBlocked: !hit || Boolean(hit.closest('#loading, .overlay')),
        spinnerDuration: spinnerStyle?.animationDuration || '',
        spinnerIterations: spinnerStyle?.animationIterationCount || '',
        spinnerName: spinnerStyle?.animationName || '',
        visibleAnimations: animated
      };
    });

    t.expect(state.reduced, 'prefers-reduced-motion: reduce was not emulated.');
    t.expect(state.loadingHidden, 'Loading overlay is still visible under reduced motion.');
    t.expect(
      state.loadingDisplay === 'none',
      `Loading overlay computed display is ${state.loadingDisplay} under reduced motion.`
    );
    t.expect(!state.bodyLoading, 'body.is-loading is still set after load under reduced motion.');
    t.expect(
      state.title && state.title !== 'Loading…',
      `Race title did not resolve under reduced motion: ${JSON.stringify(state.title)}`
    );
    t.expect(state.segments > 0, 'No track segments rendered under reduced motion.');
    t.expect(
      state.stageOpacity === '1',
      `Stage opacity is ${state.stageOpacity} under reduced motion; loading state still dims/blocks content.`
    );
    t.expect(
      state.stagePointerEvents !== 'none',
      'Stage has pointer-events: none under reduced motion; content is blocked.'
    );
    t.expect(!state.titleBlocked, 'An overlay/loading element covers the race title under reduced motion.');
    t.expect(
      state.visibleAnimations.length === 0,
      `Visible animations still run under prefers-reduced-motion: ` +
        state.visibleAnimations
          .map((entry) => `${entry.tag}#${entry.id}.${entry.className} ${entry.name} ${entry.duration} ×${entry.iterations}`)
          .join(' | ')
    );

    if (
      state.spinnerName === 'spin' &&
      Number.parseFloat(state.spinnerDuration) > 0.001 &&
      state.spinnerIterations === 'infinite'
    ) {
      t.observe(
        `P3: the hidden loading spinner keeps "spin ${state.spinnerDuration} infinite" under ` +
          'prefers-reduced-motion (assets/styles.css overrides it to 2.4s infinite). It does not block content ' +
          'after load, but reduced-motion users still see continuous rotation while loading.'
      );
    }

    t.expect(
      diagnostics.consoleErrors.length === 0,
      `Console errors during reduced-motion check: ${diagnostics.consoleErrors.join(' | ')}`
    );
    t.note(
      `Reduced motion: title=${JSON.stringify(state.title)}, segments=${state.segments}, ` +
        `loading hidden=${state.loadingHidden}, visible animations=${state.visibleAnimations.length}.`
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* 6. Missing/broken race data --------------------------------------- */

async function checkMissingData(t, ctx) {
  const { context, page, diagnostics } = await createPage(ctx.browser);
  let failRace = true;
  let expectedRaceName = '';
  try {
    const catalogResponse = await fetch(`${ctx.baseURL}/data/catalog.json`);
    const catalog = await catalogResponse.json();
    expectedRaceName = catalog.races?.at(-1)?.name || '';
    await context.route('**/data/races/*.json', async (route) => {
      if (failRace) {
        await route.fulfill({
          status: 404,
          contentType: 'text/html; charset=utf-8',
          body: '<h1>404</h1><p>Not found</p>'
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${ctx.baseURL}/`, { waitUntil: 'load' });

    let panelVisible = false;
    try {
      await page.waitForFunction(
        () => {
          const panel = document.querySelector('#error-panel');
          return Boolean(panel && !panel.hidden && getComputedStyle(panel).display !== 'none');
        },
        null,
        { timeout: 5000 }
      );
      panelVisible = true;
    } catch {
      panelVisible = false;
    }

    const errorState = await page.evaluate(() => {
      const panel = document.querySelector('#error-panel');
      const retry = document.querySelector('#retry-btn');
      const panelStyle = panel ? getComputedStyle(panel) : null;
      const retryStyle = retry ? getComputedStyle(retry) : null;
      const retryRect = retry?.getBoundingClientRect();
      return {
        hidden: Boolean(panel?.hidden),
        display: panelStyle?.display || '',
        role: panel?.getAttribute('role') || '',
        message: document.querySelector('#error-message')?.textContent?.trim() || '',
        retryHidden: Boolean(retry?.hidden),
        retryDisplay: retryStyle?.display || '',
        retryVisible: Boolean(retryRect && retryRect.width > 0 && retryRect.height > 0),
        retryName: (retry?.getAttribute('aria-label') || retry?.textContent || '').replace(/\s+/g, ' ').trim(),
        title: document.querySelector('#race-title')?.textContent?.trim() || ''
      };
    });

    t.expect(
      panelVisible,
      'P2: after a 404 on the race JSON the error panel is not visibly shown. ' +
        'If boot() calls hideError() after awaiting loadRace(), while loadRace() catches the failure and ' +
        'resolves, the retry UI is unreachable.'
    );
    t.expect(errorState.role === 'alert', `#error-panel role is ${JSON.stringify(errorState.role)}, expected "alert".`);
    t.expect(
      /could not load/i.test(errorState.message),
      `#error-message does not explain the failed race load: ${JSON.stringify(errorState.message)}`
    );
    t.expect(errorState.retryVisible, 'Retry button is not visible while the error panel is shown.');
    t.expect(
      errorState.retryName === 'Try again',
      `Retry button accessible name is ${JSON.stringify(errorState.retryName)}, expected "Try again".`
    );

    const allowed404 = (message) =>
      /404/.test(message) &&
      /(Failed to load resource|Error: 404|Not Found|Could not load)/i.test(message);
    const unexpectedConsole = diagnostics.consoleErrors.filter((message) => !allowed404(message));
    t.expect(
      unexpectedConsole.length === 0,
      `Unexpected console error(s) during intentional 404: ${unexpectedConsole.join(' | ')}`
    );
    const unexpectedHttp = diagnostics.httpErrors.filter((entry) => !/^404\b/.test(entry));
    t.expect(
      unexpectedHttp.length === 0,
      `Unexpected HTTP error response(s) during intentional 404: ${unexpectedHttp.join(' | ')}`
    );
    t.expect(
      diagnostics.pageErrors.length === 0,
      `Page error(s) during intentional 404: ${diagnostics.pageErrors.join(' | ')}`
    );

    const expectedConsole = [...diagnostics.consoleErrors];

    // Restore the route and recover. If the panel was (incorrectly) hidden, use
    // the DOM click so the retry handler itself is still verified, and report
    // the visibility defect above rather than hanging on an invisible button.
    failRace = false;
    diagnostics.reset();
    let retryMode = 'real click';
    if (panelVisible && errorState.retryVisible) {
      await page.click('#retry-btn');
    } else {
      retryMode = 'programmatic click (button not visible)';
      await page.evaluate(() => document.querySelector('#retry-btn')?.click());
    }

    await waitForApp(page);
    const recovered = await page.evaluate(() => ({
      errorHidden: Boolean(document.querySelector('#error-panel')?.hidden),
      errorDisplay: getComputedStyle(document.querySelector('#error-panel')).display,
      title: document.querySelector('#race-title')?.textContent?.trim() || '',
      segments: document.querySelectorAll('.track-layer__segment').length,
      driverA: document.querySelector('#driver-a')?.value || '',
      driverB: document.querySelector('#driver-b')?.value || '',
      loadingHidden: Boolean(document.querySelector('#loading')?.hidden)
    }));

    t.expect(recovered.errorHidden, 'Retry succeeded but #error-panel is still visible.');
    t.expect(
      !expectedRaceName || recovered.title.includes(expectedRaceName),
      `Retry did not restore the race title (got ${JSON.stringify(recovered.title)}, expected ${JSON.stringify(expectedRaceName)}).`
    );
    t.expect(recovered.segments > 0, 'Retry restored the page but no track segments were rendered.');
    t.expect(Boolean(recovered.driverA && recovered.driverB), 'Retry did not restore both driver selects.');
    t.expect(recovered.loadingHidden, 'Loading overlay is still shown after successful retry.');
    t.expect(
      diagnostics.consoleErrors.length === 0,
      `Console errors after restoring the race route: ${diagnostics.consoleErrors.join(' | ')}`
    );
    t.expect(
      diagnostics.httpErrors.length === 0,
      `HTTP errors after restoring the race route: ${diagnostics.httpErrors.join(' | ')}`
    );

    t.note(
      `404 phase: panel ${panelVisible ? 'visible' : 'HIDDEN'}, ${expectedConsole.length} allowed console ` +
        `error(s); recovery via ${retryMode}, ${recovered.segments} segments.`
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* 7. Console clean --------------------------------------------------- */

async function checkConsoleClean(t, ctx) {
  const { context, page, diagnostics } = await createPage(ctx.browser);
  try {
    await page.goto(`${ctx.baseURL}/`, { waitUntil: 'load' });
    await waitForApp(page);

    await page.selectOption('#driver-a', '16');
    await page.selectOption('#driver-b', '44');
    await page.waitForTimeout(250);
    await page.focus('#track-svg');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    const unhandled = await unhandledRejections(page);

    t.expect(
      diagnostics.consoleErrors.length === 0,
      `Console error(s) on a normal load/interaction: ${diagnostics.consoleErrors.join(' | ')}`
    );
    t.expect(
      diagnostics.pageErrors.length === 0,
      `Uncaught page error(s): ${diagnostics.pageErrors.join(' | ')}`
    );
    t.expect(
      diagnostics.requestFailures.length === 0,
      `Failed request(s): ${diagnostics.requestFailures.join(' | ')}`
    );
    t.expect(
      diagnostics.httpErrors.length === 0,
      `HTTP >= 400 response(s): ${diagnostics.httpErrors.join(' | ')}`
    );
    t.expect(
      unhandled.length === 0,
      `Unhandled promise rejection(s): ${unhandled.join(' | ')}`
    );

    ctx.observed.consoleErrors = [...diagnostics.consoleErrors];
    ctx.observed.pageErrors = [...diagnostics.pageErrors];
    ctx.observed.requestFailures = [...diagnostics.requestFailures];
    ctx.observed.httpErrors = [...diagnostics.httpErrors];
    ctx.observed.unhandledRejections = [...unhandled];
    t.note('Normal load + same-team + arrow/Escape pass: 0 console/page/unhandled errors.');
  } finally {
    await context.close().catch(() => {});
  }
}

/* 8. ARIA ------------------------------------------------------------ */

async function checkAria(t, ctx) {
  const { context, page, diagnostics } = await createPage(ctx.browser);
  try {
    await page.goto(`${ctx.baseURL}/`, { waitUntil: 'load' });
    await waitForApp(page);

    const aria = await page.evaluate(() => {
      const svg = document.querySelector('#track-svg');
      const labelledby = (svg?.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      const title = document.getElementById('track-title');
      const desc = document.getElementById('track-desc');
      const selects = [...document.querySelectorAll('select')].map((select) => ({
        id: select.id,
        disabled: select.disabled,
        labels: [...select.labels].map((label) => label.textContent.replace(/\s+/g, ' ').trim()),
        ariaLabel: select.getAttribute('aria-label') || ''
      }));
      const buttons = [...document.querySelectorAll('button')].map((button) => ({
        id: button.id,
        name: (button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/g, ' ').trim(),
        disabled: button.disabled
      }));
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      return {
        lang: document.documentElement.lang || '',
        documentTitle: document.title || '',
        svgRole: svg?.getAttribute('role') || '',
        svgTabindex: svg?.getAttribute('tabindex') || '',
        svgTabIndexProperty: svg?.tabIndex,
        labelledby,
        titleId: title?.id || '',
        titleText: title?.textContent?.trim() || '',
        descId: desc?.id || '',
        descText: desc?.textContent?.trim() || '',
        selects,
        buttons,
        stageLive: document.querySelector('.stage')?.getAttribute('aria-live') || '',
        tooltipRole: document.querySelector('#track-tooltip')?.getAttribute('role') || '',
        loadingRole: document.querySelector('#loading')?.getAttribute('role') || '',
        errorRole: document.querySelector('#error-panel')?.getAttribute('role') || '',
        skipTarget: document.querySelector('.skip-link')?.getAttribute('href') || '',
        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index)
      };
    });

    t.expect(aria.svgRole === 'img', `SVG role is ${JSON.stringify(aria.svgRole)}, expected "img".`);
    t.expect(aria.svgTabindex === '0', `SVG tabindex is ${JSON.stringify(aria.svgTabindex)}, expected "0".`);
    t.expect(
      aria.labelledby.includes('track-title') && aria.labelledby.includes('track-desc'),
      `SVG aria-labelledby is ${JSON.stringify(aria.labelledby)}, expected track-title + track-desc.`
    );
    t.expect(Boolean(aria.titleText), 'SVG <title> is empty.');
    t.expect(Boolean(aria.descText), 'SVG <desc> is empty.');
    t.expect(
      aria.descText.length > 60 && /sections quicker/i.test(aria.descText),
      `SVG <desc> does not describe the comparison in text: ${JSON.stringify(aria.descText)}`
    );
    t.expect(
      /sections quicker for/i.test(aria.descText),
      `SVG <desc> does not expose per-driver section counts: ${JSON.stringify(aria.descText)}`
    );

    t.expect(aria.selects.length >= 3, `Expected 3 selects, found ${aria.selects.length}.`);
    for (const select of aria.selects) {
      t.expect(
        select.labels.some((label) => label.length > 0) || select.ariaLabel.length > 0,
        `Select #${select.id} has no associated <label> or aria-label.`
      );
    }

    for (const button of aria.buttons) {
      t.expect(Boolean(button.name), `Button #${button.id || '(no id)'} has no accessible name.`);
    }
    t.expect(
      aria.buttons.some((button) => button.id === 'swap-btn' && /swap the two drivers/i.test(button.name)),
      'Swap button does not have the expected accessible name "Swap the two drivers".'
    );

    t.expect(
      aria.stageLive === 'polite',
      `Comparison stage aria-live is ${JSON.stringify(aria.stageLive)}, expected "polite".`
    );
    t.expect(aria.tooltipRole === 'status', `Tooltip role is ${JSON.stringify(aria.tooltipRole)}, expected "status".`);
    t.expect(aria.loadingRole === 'status', `Loading overlay role is ${JSON.stringify(aria.loadingRole)}, expected "status".`);
    t.expect(aria.errorRole === 'alert', `Error panel role is ${JSON.stringify(aria.errorRole)}, expected "alert".`);
    t.expect(Boolean(aria.lang), 'html element has no lang attribute.');
    t.expect(Boolean(aria.documentTitle), 'document.title is empty.');
    t.expect(aria.skipTarget === '#main', `Skip link target is ${JSON.stringify(aria.skipTarget)}, expected "#main".`);
    t.expect(aria.duplicateIds.length === 0, `Duplicate id(s) in document: ${aria.duplicateIds.join(', ')}`);

    t.expect(
      diagnostics.consoleErrors.length === 0,
      `Console errors during ARIA check: ${diagnostics.consoleErrors.join(' | ')}`
    );
    t.note(
      `ARIA: ${aria.labelledby.join('+')} references <title>/<desc>; ` +
        `${aria.selects.length} labelled selects; ${aria.buttons.length} named buttons.`
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

const CHECK_SPECS = [
  { id: '1-same-team', name: 'Same-team pair keeps a non-colour distinction', fn: checkSameTeam },
  { id: '2-colour-blind', name: 'Forced close colours still expose a pattern/outline', fn: checkColourBlindProxy },
  { id: '3-keyboard', name: 'Keyboard reaches race/driver selects + SVG, arrows, Escape, focus ring', fn: checkKeyboard },
  { id: '4-touch-390', name: 'Touch pins/updates/dismisses tooltip; no 390px horizontal scroll', fn: checkTouch },
  { id: '5-reduced-motion', name: 'Reduced motion loads content without blocking animation', fn: checkReducedMotion },
  { id: '6-missing-data', name: '404 race data shows error + retry and recovers', fn: checkMissingData },
  { id: '7-console-clean', name: 'No console/page/request/unhandled errors on a normal run', fn: checkConsoleClean },
  { id: '8-aria', name: 'SVG title/desc, select labels, live regions, named buttons', fn: checkAria }
];

function printResult(result) {
  console.log(`\nAdversarial / accessibility E2E — ${result.status}`);
  const portNote =
    result.port && result.port !== result.requestedPort
      ? ` (port ${result.requestedPort} was busy; using next free port)`
      : '';
  console.log(`Server: ${result.baseUrl}${portNote}`);
  console.log(`Chrome: ${result.chrome}`);
  console.log('');
  for (const check of result.checks) {
    console.log(`${check.status}  ${check.id}  ${check.name}`);
    if (check.detail && check.status === 'PASS') console.log(`      ${check.detail}`);
    for (const defect of check.defects || []) console.log(`      DEFECT: ${defect}`);
    for (const observation of check.observations || []) console.log(`      NOTE: ${observation}`);
  }
  console.log('');
  console.log(
    `ADVERSARIAL E2E: ${result.status} — ${result.counts.passed} passed, ${result.counts.failed} failed, ` +
      `${result.counts.skipped} skipped · ${(result.durationMs / 1000).toFixed(1)}s`
  );
  if (result.harnessError) console.log(`HARNESS ERROR: ${result.harnessError}`);
  console.log(`Results: ${path.relative(ROOT, RESULTS_FILE)}`);
}

/**
 * Run the adversarial suite.
 * @param {{
 *   port?: number,
 *   headless?: boolean,
 *   executablePath?: string,
 *   quiet?: boolean,
 *   writeResults?: boolean
 * }} [options]
 * @returns {Promise<object>} result object (also written to tmp/e2e/adversarial-results.json)
 */
export async function runAdversarial(options = {}) {
  const startedAt = Date.now();
  const port = Number(options.port || process.env.ADVERSARIAL_PORT || DEFAULT_PORT);
  const chrome = options.executablePath || CHROME;
  const quiet = options.quiet ?? QUIET;
  const checks = [];
  const observed = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    httpErrors: [],
    unhandledRejections: []
  };
  let browser = null;
  let serverInfo = null;
  let harnessError = null;

  const runCheck = async (spec, ctx) => {
    const checkStarted = Date.now();
    const defects = [];
    const observations = [];
    const notes = [];
    const t = {
      expect(condition, message) {
        if (!condition) defects.push(String(message));
      },
      observe(message) {
        observations.push(String(message));
      },
      note(message) {
        notes.push(String(message));
      }
    };
    try {
      await spec.fn(t, ctx);
    } catch (error) {
      defects.push(describeError(error));
    }
    const status = defects.length === 0 ? 'PASS' : 'FAIL';
    const detail =
      defects.length > 0
        ? defects.join(' | ')
        : notes.length > 0
          ? notes.join(' | ')
          : observations.join(' | ');
    const check = {
      id: spec.id,
      name: spec.name,
      status,
      detail,
      defects,
      observations,
      durationMs: Date.now() - checkStarted
    };
    checks.push(check);
    if (!quiet && process.env.ADVERSARIAL_STREAM === '1') {
      console.log(`${status}  ${spec.id}  ${spec.name}`);
      if (detail && status === 'PASS') console.log(`      ${detail}`);
      for (const defect of defects) console.log(`      DEFECT: ${defect}`);
      for (const observation of observations) console.log(`      NOTE: ${observation}`);
    }
  };

  try {
    serverInfo = await startServer(port);
    browser = await chromium.launch({
      headless: options.headless ?? process.env.HEADED !== '1',
      executablePath: chrome,
      timeout: 30000
    });

    const ctx = {
      browser,
      baseURL: serverInfo.baseURL,
      observed
    };
    for (const spec of CHECK_SPECS) {
      await runCheck(spec, ctx);
    }
  } catch (error) {
    harnessError = describeError(error);
    if (!quiet) {
      console.error(`HARNESS FAILURE: ${harnessError}`);
      if (error?.stack) console.error(error.stack);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (serverInfo) await serverInfo.close().catch(() => {});
  }

  const failed = checks.filter((check) => check.status === 'FAIL').length;
  const passed = checks.filter((check) => check.status === 'PASS').length;
  const result = {
    suite: 'adversarial',
    baseUrl: serverInfo?.baseURL || `http://127.0.0.1:${port}`,
    port: serverInfo?.port || port,
    requestedPort: port,
    portFallback: Boolean(serverInfo && serverInfo.port !== port),
    chrome,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    status: failed === 0 && !harnessError ? 'PASS' : 'FAIL',
    ok: failed === 0 && !harnessError,
    counts: { passed, failed, skipped: 0 },
    harnessError,
    observed,
    observations: checks.flatMap((check) => check.observations || []),
    checks
  };

  if (options.writeResults !== false) {
    try {
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(RESULTS_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch (error) {
      result.harnessError = result.harnessError || `Could not write ${RESULTS_FILE}: ${describeError(error)}`;
      result.status = 'FAIL';
      result.ok = false;
    }
  }

  if (!quiet) printResult(result);
  return result;
}

export default runAdversarial;

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const result = await runAdversarial();
  process.exitCode = result.ok ? 0 : 1;
}
