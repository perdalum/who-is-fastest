import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RACE_PATH = path.join(ROOT, 'data/races/11396.json');
const CATALOG_PATH = path.join(ROOT, 'data/catalog.json');
const MANIFEST_PATH = path.join(ROOT, 'data/manifest.json');

const race = JSON.parse(await readFile(RACE_PATH, 'utf8'));
const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const sum = (values) => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

test('race file matches the top-level data contract', () => {
  assert.equal(race.schema_version, 1);
  assert.equal(race.session_key, 11396);
  assert.equal(race.name, 'United States Grand Prix');
  assert.equal(race.circuit, 'Circuit of the Americas');
  assert.equal(race.location, 'Austin');
  assert.equal(race.country, 'United States');
  assert.equal(race.date, '2026-10-25');
  assert.equal(race.year, 2026);
  assert.equal(race.round, 18);
  assert.match(race.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(race.grid_m, 25);
  assert.equal(race.segment_m, 100);
  assert.equal(race.deadband_s, 0.03);
  assert.equal(race.segment_m / race.grid_m, 4);
  assert.equal(race.analysis.lap_rule, 'fastest lap with validated speed + position telemetry');
  assert.equal(race.analysis.note, 'Spatial split derived from GPS speed; indicative, not timing-grade.');
});

test('race has at least two complete driver records with 25 m dt bins', () => {
  assert.ok(Array.isArray(race.drivers));
  assert.ok(race.drivers.length >= 2, `only ${race.drivers.length} drivers`);
  const expectedBins = Math.ceil(race.track.length_m / race.grid_m);
  assert.equal(race.drivers.length, race.analysis.valid_drivers);

  for (const driver of race.drivers) {
    assert.ok(Number.isInteger(driver.number));
    assert.match(driver.acronym, /^[A-Z]{3}$/);
    assert.ok(driver.name.length > 0);
    assert.ok(driver.team.length > 0);
    assert.match(driver.colour, /^[0-9A-F]{6}$/);
    assert.ok(Number.isInteger(driver.lap_number) && driver.lap_number > 0);
    assert.ok(driver.lap_time > 60 && driver.lap_time < 200);
    assert.ok(driver.official_best_time <= driver.lap_time + 0.001);
    assert.ok(Number.isInteger(driver.official_best_lap));
    assert.equal(driver.sectors.length, 3);
    assert.ok(Math.abs(sum(driver.sectors) - driver.lap_time) < 0.051);
    assert.ok(driver.top_speed >= 200 && driver.top_speed <= 400);
    assert.equal(typeof driver.compound, 'string');
    assert.ok(Number.isInteger(driver.tyre_age) && driver.tyre_age >= 0);
    assert.ok(driver.coverage_pct >= 90 && driver.coverage_pct <= 100);
    assert.equal(driver.dt.length, expectedBins, `driver ${driver.number} dt length`);
    for (const value of driver.dt) {
      assert.ok(value === null || (Number.isFinite(value) && value > 0 && value < 20));
    }
  }
});

test('dt sums exclude null bins and match the declared coverage', () => {
  let nullBins = 0;
  let nonNullSum = 0;
  for (const driver of race.drivers) {
    const covered = sum(driver.dt);
    const expected = (driver.lap_time * driver.coverage_pct) / 100;
    assert.ok(
      Math.abs(covered - expected) < 0.06,
      `driver ${driver.number}: sum ${covered.toFixed(4)} vs lap*coverage ${expected.toFixed(4)}`,
    );
    assert.ok(covered <= driver.lap_time + 0.01);
    nullBins += driver.dt.filter((value) => value == null).length;
    nonNullSum += covered;
    if (driver.dt.every((value) => value != null)) {
      assert.ok(Math.abs(covered - driver.lap_time) < 0.01);
    }
  }
  assert.ok(nonNullSum > 0);
  const reference = race.drivers.find((driver) => driver.number === race.analysis.reference_driver_number);
  assert.ok(reference, 'reference driver missing');
  assert.equal(
    reference.dt.filter((value) => value == null).length,
    race.analysis.null_bins_reference,
    'reference null-bin count must match metadata',
  );
  assert.ok(race.analysis.dt_null_rule.includes('null dt bins are excluded'));
  assert.ok(nullBins >= race.analysis.null_bins_reference);
});

test('average profiles are complete and internally consistent', () => {
  for (const driver of race.drivers) {
    assert.ok(driver.average, `driver ${driver.number} has no average profile`);
    const avg = driver.average;
    assert.equal(driver.average.lap_count, driver.average.lap_numbers.length);
    assert.ok(avg.lap_count >= 1 && avg.lap_count <= 100);
    assert.ok(avg.lap_time > 60 && avg.lap_time < 200);
    assert.equal(avg.sectors.length, 3);
    assert.ok(Math.abs(sum(avg.sectors) - avg.lap_time) < 0.06);
    assert.equal(avg.dt.length, driver.dt.length);
    assert.ok(avg.coverage_pct >= 90 && avg.coverage_pct <= 100);
    assert.ok(avg.top_speed >= 200 && avg.top_speed <= 400);
    assert.ok(avg.scale_factor > 0.9 && avg.scale_factor < 1.1);
    for (const value of avg.dt) {
      assert.ok(value === null || (Number.isFinite(value) && value > 0 && value < 20));
    }
    const covered = sum(avg.dt);
    const expected = (avg.lap_time * avg.coverage_pct) / 100;
    assert.ok(
      Math.abs(covered - expected) < 0.06,
      `driver ${driver.number} average: sum ${covered.toFixed(4)} vs lap*coverage ${expected.toFixed(4)}`,
    );
    assert.ok(covered <= avg.lap_time + 0.01);
    assert.ok(avg.lap_numbers.every((n) => Number.isInteger(n) && n > 0 && n <= 90));
  }
});

test('track geometry, sector marks and calibration are sane', () => {
  assert.ok(race.track.length_m >= 2000 && race.track.length_m <= 8000);
  assert.ok(race.track.points.length >= 100);
  for (let i = 0; i < race.track.points.length; i += 1) {
    const [x, y] = race.track.points[i];
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    if (i > 0) {
      const [px, py] = race.track.points[i - 1];
      const spacing = Math.hypot(x - px, y - py);
      const last = i === race.track.points.length - 1;
      assert.ok(spacing > (last ? 0 : 8) && spacing <= 12.1, `point spacing ${spacing} at ${i}`);
    }
  }
  assert.equal(race.track.sector_marks_m.length, 2);
  const [s1, s2] = race.track.sector_marks_m;
  assert.ok(Number.isInteger(s1) && Number.isInteger(s2));
  assert.ok(s1 > 0 && s2 > s1 && s2 < race.track.length_m);
  assert.ok(s1 > race.track.length_m * 0.1 && s2 > race.track.length_m * 0.4);

  assert.ok(race.calibration, 'calibration block must be persisted');
  assert.equal(race.calibration.pair, '16/3');
  assert.equal(race.calibration.sector_delta_est.length, 3);
  assert.equal(race.calibration.sector_delta_official.length, 3);
  for (const error of race.calibration.sector_delta_error) {
    assert.ok(Math.abs(error) <= 0.2, `sector delta error ${error} exceeds 0.20 s`);
  }
});

test('catalog lists Austin with the required source metadata', () => {
  assert.equal(catalog.schema_version, 1);
  assert.match(catalog.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(catalog.source, {
    name: 'OpenF1',
    url: 'https://openf1.org/',
    licence: 'CC BY-NC-SA 4.0',
    unofficial: true,
  });
  const entries = catalog.races.filter((entry) => entry.session_key === 11396);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].driver_count, race.drivers.length);
  assert.equal(entries[0].file, 'data/races/11396.json');
  assert.equal(entries[0].round, 18);
});

test('manifest hashes every output and records the request audit', async () => {
  assert.equal(manifest.schema_version, 1);
  assert.match(manifest.as_of, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(typeof manifest.git_sha === 'string' && manifest.git_sha.length >= 7);
  assert.equal(manifest.build_script, 'scripts/build-data.mjs');
  assert.ok(manifest.request_count > 0);
  assert.equal(manifest.request_count, manifest.network_requests + manifest.cache_hits);
  assert.ok(manifest.network_requests >= 0 && manifest.cache_hits >= 0);
  assert.ok(manifest.build_seconds > 0);

  const files = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const raceFiles = (await readdir(path.join(ROOT, 'data/races')))
    .filter((name) => name.endsWith('.json'))
    .map((name) => `data/races/${name}`);
  for (const relative of ['data/catalog.json', ...raceFiles]) {
    const entry = files.get(relative);
    assert.ok(entry, `manifest missing ${relative}`);
    const absolute = path.join(ROOT, relative);
    const bytes = await readFile(absolute);
    assert.equal(entry.bytes, bytes.length, `byte count ${relative}`);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'), `hash ${relative}`);
    assert.equal(entry.bytes, (await stat(absolute)).size);
  }
});
