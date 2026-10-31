#!/usr/bin/env node
/**
 * Production static build.
 *
 * Produces a self-contained `dist/` with minified, content-hashed JS/CSS and
 * an index.html whose asset references point at those hashes. Race JSON and
 * the favicon are copied unchanged. No server runtime and no runtime API.
 *
 * Run: npm run build   (or make build)
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const ENTRY_JS = path.join(ROOT, 'assets', 'app.js');
const ENTRY_CSS = path.join(ROOT, 'assets', 'styles.css');
const FAVICON = path.join(ROOT, 'assets', 'favicon.svg');
const DATA = path.join(ROOT, 'data');
const INDEX = path.join(ROOT, 'index.html');

function fail(message) {
  throw new Error(message);
}

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 10);
}

function assertSafeOutDir(dir) {
  if (dir === ROOT || !dir.startsWith(`${ROOT}${path.sep}`)) {
    fail(`refusing to clean suspicious output directory: ${dir}`);
  }
}

async function bundle(entry, loader = undefined) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['es2020'],
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    ...(loader ? { loader: { '.css': 'css' } } : {}),
  });
  const output = result.outputFiles?.[0];
  if (!output) fail(`esbuild produced no ${loader === 'css' ? 'CSS' : 'JS'} output for ${path.relative(ROOT, entry)}`);
  return Buffer.from(output.contents);
}

async function copyFile(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to);
}

async function main() {
  assertSafeOutDir(OUT);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'assets'), { recursive: true });

  const js = await bundle(ENTRY_JS);
  const css = await bundle(ENTRY_CSS, 'css');
  const jsName = `app.${hash(js)}.js`;
  const cssName = `styles.${hash(css)}.css`;

  await writeFile(path.join(OUT, 'assets', jsName), js);
  await writeFile(path.join(OUT, 'assets', cssName), css);

  await copyFile(FAVICON, path.join(OUT, 'assets', 'favicon.svg'));
  await cp(DATA, path.join(OUT, 'data'), {
    recursive: true,
    filter: (source) => path.basename(source) !== '.DS_Store',
  });

  const sourceHtml = await readFile(INDEX, 'utf8');
  const cssRef = 'href="assets/styles.css"';
  const jsRef = 'src="assets/app.js"';
  if (!sourceHtml.includes(cssRef) || !sourceHtml.includes(jsRef)) {
    fail('index.html no longer contains the expected assets/styles.css and assets/app.js references');
  }
  const html = sourceHtml
    .replace(cssRef, `href="assets/${cssName}"`)
    .replace(jsRef, `src="assets/${jsName}"`);
  await writeFile(path.join(OUT, 'index.html'), html);

  const total = js.length + css.length;
  console.log(`[build] dist/index.html`);
  console.log(`[build] assets/${jsName} (${js.length} B)`);
  console.log(`[build] assets/${cssName} (${css.length} B)`);
  console.log(`[build] copied data/ and assets/favicon.svg`);
  console.log(`[build] ${(total / 1024).toFixed(1)} KB minified JS+CSS; output ${path.relative(ROOT, OUT)}/`);
}

main().catch((error) => {
  console.error(`[build] ${error.stack || error.message}`);
  process.exitCode = 1;
});
