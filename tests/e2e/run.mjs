#!/usr/bin/env node
/**
 * E2E orchestrator for "Who is the fastest?".
 *
 * Runs the core suite (tests/e2e/core.mjs) and, when present, the independent
 * adversarial suite (tests/e2e/adversarial.mjs). Each suite is self-contained
 * and responsible for its own server/browser lifecycle. This script streams
 * their output, prints a PASS/FAIL line per check from their JSON result files,
 * and exits non-zero if anything failed.
 *
 * Usage: node tests/e2e/run.mjs
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'e2e');
const SUITE_TIMEOUT_MS = Number(process.env.E2E_SUITE_TIMEOUT_MS || 300_000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SUITES = [
  {
    name: 'core',
    file: path.join(ROOT, 'tests', 'e2e', 'core.mjs'),
    results: path.join(OUT_DIR, 'core-results.json'),
    quiet: true,
    requiredResults: true,
    reprintChecks: true,
  },
  {
    name: 'adversarial',
    file: path.join(ROOT, 'tests', 'e2e', 'adversarial.mjs'),
    results: path.join(OUT_DIR, 'adversarial-results.json'),
    quiet: false,
    requiredResults: false,
    reprintChecks: false,
  },
];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonReady(file, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await readJson(file);
    if (payload) return payload;
    await delay(100);
  }
  return readJson(file);
}

function normaliseChecks(payload) {
  if (!payload) return [];
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.checks)
      ? payload.checks
      : Array.isArray(payload.results)
        ? payload.results
        : [];
  return list.map((entry, index) => {
    const status = String(
      entry.status ??
      (entry.ok === true ? 'PASS' : entry.ok === false ? 'FAIL' : entry.passed === true ? 'PASS' : entry.passed === false ? 'FAIL' : 'UNKNOWN'),
    ).toUpperCase();
    return {
      id: entry.id ?? entry.check ?? entry.name ?? `check-${index + 1}`,
      name: entry.name ?? entry.title ?? entry.description ?? '',
      status: status === 'PASSED' ? 'PASS' : status === 'FAILED' ? 'FAIL' : status,
      detail: entry.detail ?? entry.message ?? entry.error ?? '',
    };
  });
}

function parseSummary(stdout) {
  const match = stdout.match(
    /^\s*(?:CORE|ADVERSARIAL) E2E:\s*(PASS|FAIL)\s*[—-]\s*(\d+) passed,\s*(\d+) failed,\s*(\d+) skipped/m,
  );
  if (!match) return null;
  return {
    status: match[1],
    passed: Number(match[2]),
    failed: Number(match[3]),
    skipped: Number(match[4]),
  };
}

function countsMismatch(payload, summary) {
  if (!payload?.counts || !summary) return false;
  return ['passed', 'failed', 'skipped'].some(
    (key) => Number(payload.counts[key]) !== Number(summary[key]),
  );
}

function payloadIsFresh(payload, startedAt, endedAt) {
  if (!payload) return false;
  const generatedAt = Date.parse(payload.generatedAt || '');
  if (!Number.isFinite(generatedAt)) return true;
  return generatedAt >= startedAt - 5_000 && generatedAt <= endedAt + 5_000;
}

function printCheck(suiteName, check) {
  const id = `${suiteName}/${check.id}`;
  const suffix = check.detail ? ` — ${String(check.detail).replace(/\s+/g, ' ').trim()}` : '';
  if (check.status === 'PASS') {
    console.log(`PASS  ${id}  ${check.name}${suffix}`);
  } else if (check.status === 'SKIP') {
    console.log(`SKIP  ${id}  ${check.name}${suffix}`);
  } else {
    console.log(`FAIL  ${id}  ${check.name}${suffix}`);
  }
}

async function runSuite(suite) {
  if (!(await exists(suite.file))) {
    console.log(`\n=== ${suite.name} ===`);
    console.log(`SKIP  ${suite.name}/suite  ${path.relative(ROOT, suite.file)} is not present`);
    return { name: suite.name, status: 'SKIP', passed: 0, failed: 0, skipped: 0, durationMs: 0 };
  }

  await unlink(suite.results).catch(() => {});
  console.log(`\n=== ${suite.name} ===`);
  const startedAt = Date.now();
  const env = { ...process.env };
  if (suite.quiet) env.E2E_QUIET = '1';
  if (!env.E2E_PORT) env.E2E_PORT = '5174';

  const child = spawn(process.execPath, [suite.file], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, SUITE_TIMEOUT_MS);
  timer.unref();

  const [code, signal] = await once(child, 'close');
  clearTimeout(timer);
  const endedAt = Date.now();
  const durationMs = endedAt - startedAt;

  const summary = parseSummary(stdout);
  const stdoutHasChecks = /^(?:PASS|FAIL|SKIP)\s+\S+/m.test(stdout);
  const rawPayload = await readJsonReady(suite.results);
  let payload = rawPayload;
  let staleReason = null;

  if (rawPayload && !payloadIsFresh(rawPayload, startedAt, endedAt)) {
    staleReason = 'result file timestamp is outside this run (concurrent writer)';
    payload = null;
  } else if (rawPayload && countsMismatch(rawPayload, summary)) {
    staleReason = 'result file counts differ from the suite output (concurrent writer)';
    payload = null;
  }
  if (staleReason) {
    console.log(`NOTE  ${suite.name}/results  ignoring ${path.relative(ROOT, suite.results)}: ${staleReason}`);
  }

  const checks = normaliseChecks(payload);
  let suiteFailed = Boolean(timedOut);
  let counts = null;

  if (checks.length > 0 && (suite.reprintChecks || !stdoutHasChecks)) {
    console.log(`\n--- ${suite.name} checks ---`);
    for (const check of checks) printCheck(suite.name, check);
  }

  if (timedOut) {
    suiteFailed = true;
    console.log(`FAIL  ${suite.name}/timeout  suite exceeded ${SUITE_TIMEOUT_MS} ms`);
  }
  if (payload?.harnessError) {
    suiteFailed = true;
    console.log(`FAIL  ${suite.name}/harness  ${payload.harnessError}`);
  }
  if (!payload && suite.requiredResults) {
    suiteFailed = true;
    console.log(
      `FAIL  ${suite.name}/results  no readable result file at ${path.relative(ROOT, suite.results)}`,
    );
  }

  if (summary) {
    counts = {
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
    };
    if (summary.status === 'FAIL') suiteFailed = true;
  } else if (payload?.counts) {
    counts = {
      passed: Number(payload.counts.passed) || 0,
      failed: Number(payload.counts.failed) || 0,
      skipped: Number(payload.counts.skipped) || 0,
    };
    if (String(payload.status || '').toUpperCase() === 'FAIL') suiteFailed = true;
  } else {
    counts = {
      passed: checks.filter((check) => check.status === 'PASS').length,
      failed: checks.filter((check) => check.status === 'FAIL').length,
      skipped: checks.filter((check) => check.status === 'SKIP').length,
    };
  }

  if (counts.failed > 0) suiteFailed = true;
  if (code !== 0) {
    suiteFailed = true;
    if (!summary && !payload && !stdoutHasChecks) {
      const tail = (stderr.trim() || stdout.trim()).split('\n').slice(-12).join('\n');
      console.log(`FAIL  ${suite.name}/process  exited with code ${code}${signal ? ` (${signal})` : ''}`);
      if (tail) console.log(tail.replace(/^/gm, '      '));
    }
  }

  if (!payload && !suite.requiredResults && !summary) {
    // Independent suites may only report through their exit code.
    if (code === 0 && !timedOut) {
      console.log(`PASS  ${suite.name}/process  exited 0 (no JSON result file)`);
      counts = { passed: 1, failed: 0, skipped: 0 };
    } else {
      counts = { passed: 0, failed: 1, skipped: 0 };
    }
  }

  const status = suiteFailed ? 'FAIL' : counts.passed === 0 && counts.skipped > 0 ? 'SKIP' : 'PASS';
  console.log(
    `${status}  ${suite.name}/suite  ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped · ${(durationMs / 1000).toFixed(1)}s`,
  );
  return {
    name: suite.name,
    status,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    durationMs,
  };
}

async function main() {
  const summaries = [];
  for (const suite of SUITES) {
    summaries.push(await runSuite(suite));
  }

  const failed = summaries.filter((suite) => suite.status === 'FAIL');
  const passed = summaries.filter((suite) => suite.status === 'PASS');
  const skipped = summaries.filter((suite) => suite.status === 'SKIP');

  console.log('\n=== summary ===');
  for (const suite of summaries) {
    console.log(
      `${suite.status}  ${suite.name}: ${suite.passed} passed, ${suite.failed} failed, ${suite.skipped} skipped`,
    );
  }
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  console.log(`\nRESULT: ${verdict} (${passed.length} suite(s) passed, ${failed.length} failed, ${skipped.length} skipped)`);
  process.exitCode = verdict === 'PASS' ? 0 : 1;
}

await main();
