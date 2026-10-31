# Deployment manual — static build

The production artifact is a normal static website. The HTTP server does not
need Node.js, npm, a database or an API key.

## Build

Requirements on the build machine: **Node.js 20+** and npm. `rsync` is only
needed if you use the optional deploy target.

```bash
make install      # npm ci; needed once, or after package-lock changes
make build        # → dist/
make preview      # build, then serve dist/ at http://127.0.0.1:5173
```

`make build` runs `npm ci --include=dev` automatically if the local esbuild
binary is missing or older than `package-lock.json`. The npm scripts are the
same entry points:

```bash
npm ci
npm run build
npm run preview
```

`make check` runs the unit, browser and audit suites; it does not modify
`dist/`.

## Output

```text
dist/
  index.html
  assets/
    app.<content-hash>.js
    styles.<content-hash>.css
    favicon.svg
  data/
    catalog.json
    races/*.json
    manifest.json      # provenance; not fetched by the page
    LICENSE
```

Only `dist/` is deployed. `scripts/`, `tests/`, `tmp/`, `docs/`, `node_modules/`
and the repository itself are **not** part of the production artifact.

The JS and CSS filenames contain a content hash. `index.html` is rewritten to
point at those names. Upload the whole `dist/` directory; do not rename the
hashed files.

## Upload

Any method works: SFTP, rsync, the web hotel’s file manager, or CI.

```bash
# explicit target; trailing slash means "contents of dist"
make deploy RSYNC_TARGET=user@host:/var/www/f1/
```

The target is deliberately required; there is no hard-coded host. `--delete`
mirrors the artifact, so make sure the target directory is dedicated to this
site.

If you upload into a subdirectory such as `https://example.com/f1/`, put the
contents of `dist/` in that directory. All application paths are relative.

## Apache

The important settings are MIME types and compression:

```apache
AddType application/json .json
AddType text/javascript .js
AddType text/css .css

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json image/svg+xml
</IfModule>
```

Recommended caching:

- hashed `assets/*.js` and `assets/*.css`: `Cache-Control: public, max-age=31536000, immutable`
- `index.html` and `data/catalog.json`: `Cache-Control: no-cache`
- race JSON: short cache or `no-cache`; the page fetches it with `cache: no-store`

If your host serves `.json` as `text/plain`, the MIME line above is required
for some browsers/proxies; the page itself uses `fetch()` and usually tolerates
it, but `application/json` is the correct production setting.

## nginx

```nginx
types {
  application/json json;
  text/javascript js;
  text/css css;
  image/svg+xml svg;
}

gzip on;
gzip_types text/html text/css application/javascript application/json image/svg+xml;

location = /index.html { add_header Cache-Control "no-cache"; }
location /data/       { add_header Cache-Control "no-cache"; }
location /assets/     { add_header Cache-Control "public, max-age=31536000, immutable"; }
```

Do **not** add a SPA fallback that rewrites every unknown path to
`index.html`; the app uses hash navigation and ordinary files, and a 404 for a
missing race file is useful.

## Release checklist

1. `make check` — expected: 43 unit/data, 22 browser core, 8 adversarial,
   audit 43 pass / 0 fail / 13 warnings.
2. `make build` — expected `dist/` about 0.7 MB on disk, under 150 KB per race
   JSON.
3. `make preview` — open the default race and the average deep link:
   `/#race=11396&a=16&b=3&basis=average`.
4. Upload `dist/`.
5. Verify the live URL, JSON content type and browser console are clean.
6. After deploying, update the release tag and note the production URL in the
   project notes.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `esbuild: not found` | Run `make install` with dev dependencies; do not deploy `node_modules`. |
| Page loads but no races | Upload the whole `dist/data/` directory, including `catalog.json` and `data/races/`. |
| JS/CSS 404 | Upload the hashed files generated in the same build as `index.html`; do not reuse an old `index.html`. |
| JSON 404 only on a race | The catalog references a file that was not uploaded; upload all five race files. |
| Stale content after upload | Hashed assets are immutable; ensure the new `index.html` was uploaded and bypass the old HTML cache. |
| `make deploy` refuses to run | Pass `RSYNC_TARGET=user@host:/dedicated/path/`. |
