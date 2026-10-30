/**
 * Zero-dependency OpenF1 API client.
 *
 * - Manual URL construction. Date filters use the key `date>` / `date<`, which
 *   must serialise as `date%3E=...` / `date%3C=...`, never `date%3E%3D=...`.
 * - Persistent, atomic JSON cache keyed by SHA-256 of the full request URL.
 * - One network request at a time, at least `delayMs` apart (default 2200 ms).
 * - 429/5xx responses are retried with exponential backoff.
 * - 404 means "no rows": logged and returned as `[]`, but never cached.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.openf1.org/v1';
export const DEFAULT_CACHE_DIR = path.join('tmp', 'cache', 'openf1');
export const DEFAULT_DELAY_MS = 2200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function normaliseKey(key) {
  // Be forgiving if a caller passes the operator inside the key.
  if (key === 'date>=') return 'date>';
  if (key === 'date<=') return 'date<';
  return key;
}

/**
 * Build a request URL with manual query encoding. Values are URI-encoded, but
 * the operator belongs to the key and therefore ends up as `%3E=` (not `%3E%3D`).
 */
export function buildUrl(endpoint, params = {}, baseUrl = DEFAULT_BASE_URL) {
  const cleanEndpoint = String(endpoint).replace(/^\/+/, '');
  const base = String(baseUrl).replace(/\/+$/, '');
  const query = [];
  for (const [rawKey, value] of Object.entries(params ?? {})) {
    if (value == null) continue;
    const key = encodeURIComponent(normaliseKey(rawKey));
    if (Array.isArray(value)) {
      for (const item of value) query.push(`${key}=${encodeURIComponent(String(item))}`);
    } else {
      query.push(`${key}=${encodeURIComponent(String(value))}`);
    }
  }
  return `${base}/${cleanEndpoint}${query.length ? `?${query.join('&')}` : ''}`;
}

async function writeCacheAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Create a throttled, cached client.
 *
 * @param {object} [options]
 * @param {string} [options.cacheDir]
 * @param {number} [options.delayMs] minimum gap between network calls
 * @param {boolean} [options.force] bypass cache reads (fresh responses still cached)
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.log]
 * @param {number} [options.retries]
 */
export function createClient(options = {}) {
  const {
    cacheDir = DEFAULT_CACHE_DIR,
    delayMs = DEFAULT_DELAY_MS,
    force = false,
    fetchImpl = globalThis.fetch,
    log = console.error,
    retries = 4,
    baseUrl = DEFAULT_BASE_URL,
  } = options;
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');

  const stats = { requests: 0, cacheHits: 0, notFound: 0, retries: 0, errors: 0 };
  let tail = Promise.resolve();
  let lastNetworkAt = 0;
  let sequence = 0;

  async function waitForSlot() {
    const wait = Number(delayMs) - (Date.now() - lastNetworkAt);
    if (wait > 0) await sleep(wait);
    lastNetworkAt = Date.now();
    stats.requests += 1;
  }

  async function fetchOnce(url, endpoint) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await waitForSlot();
      sequence += 1;
      const label = `${endpoint} #${sequence}`;
      let response;
      try {
        response = await fetchImpl(url, { headers: { accept: 'application/json' } });
      } catch (error) {
        if (attempt >= retries) {
          stats.errors += 1;
          throw new Error(`${label} network error after ${attempt + 1} attempts: ${error.message}`);
        }
        const backoff = Math.max(Number(delayMs), 1500 * 2 ** attempt);
        log(`[openf1] ${label} network error (${error.message}); retry in ${backoff} ms`);
        stats.retries += 1;
        await sleep(backoff);
        continue;
      }

      if (response.status === 404) {
        stats.notFound += 1;
        log(`[openf1] ${label} -> 404 (no rows; not cached)`);
        return { data: [], cacheable: false };
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= retries) {
          stats.errors += 1;
          throw new Error(`${label} HTTP ${response.status} after ${attempt + 1} attempts`);
        }
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const backoff = Math.max(
          Number(delayMs),
          2000 * 2 ** attempt,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
        );
        log(`[openf1] ${label} -> HTTP ${response.status}; retry in ${backoff} ms`);
        stats.retries += 1;
        await sleep(backoff);
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        stats.errors += 1;
        throw new Error(`${label} HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`);
      }

      const text = await response.text();
      if (!text.trim()) return { data: [], cacheable: true };
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        stats.errors += 1;
        throw new Error(`${label} invalid JSON: ${error.message}`);
      }
      return { data, cacheable: true };
    }
    throw new Error('unreachable retry state');
  }

  function getJson(endpoint, params = {}) {
    const url = buildUrl(endpoint, params, baseUrl);
    const hash = sha256(url);
    const file = path.join(cacheDir, `${hash}.json`);
    const task = async () => {
      if (!force) {
        try {
          const cached = JSON.parse(await readFile(file, 'utf8'));
          stats.cacheHits += 1;
          log(`[openf1] ${endpoint} cache hit ${hash.slice(0, 12)}…`);
          return cached;
        } catch (error) {
          if (error.code !== 'ENOENT') {
            log(`[openf1] ${endpoint} unreadable cache ${hash.slice(0, 12)}… (${error.message}); refetching`);
          }
        }
      }
      const { data, cacheable } = await fetchOnce(url, endpoint);
      if (cacheable) {
        await writeCacheAtomic(file, data);
        log(`[openf1] ${endpoint} -> ${Array.isArray(data) ? data.length : 1} rows (cached ${hash.slice(0, 12)}…)`);
      }
      return data;
    };
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return { getJson, stats, cacheDir, delayMs };
}

let defaultClient = null;

/** Convenience wrapper around a process-wide default client. */
export function getJson(endpoint, params = {}, options = undefined) {
  if (options || !defaultClient) {
    defaultClient = createClient(options ?? {});
  }
  return defaultClient.getJson(endpoint, params);
}
