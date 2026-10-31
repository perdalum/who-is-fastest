# Who is the fastest? — static production build
#
# The normal workflow is `make build`, then upload `dist/`.
# `make deploy RSYNC_TARGET=user@host:/var/www/f1/` optionally pushes it.

SHELL := /bin/bash
NPM ?= npm
NODE ?= node
DIST ?= dist
PORT ?= 5173
RSYNC ?= rsync
RSYNC_TARGET ?=

.PHONY: all help install build preview check test e2e audit clean deploy

all: build

help:
	@printf '%s\n' \
	  'make build        install deps if needed, build dist/' \
	  'make preview      build and serve dist/ locally' \
	  'make check        unit, browser and audit checks' \
	  'make test         unit/data tests' \
	  'make e2e          browser suites' \
	  'make audit        independent data audit' \
	  'make deploy RSYNC_TARGET=user@host:/path   push dist/' \
	  'make clean        remove dist/'

install:
	$(NPM) ci --include=dev

# Reinstall only when the lockfile changes. On a fresh checkout this target
# does not exist, so make runs npm ci once before the first build.
node_modules/.bin/esbuild: package.json package-lock.json
	$(NPM) ci --include=dev

build: node_modules/.bin/esbuild
	$(NODE) scripts/build-static.mjs

preview: build
	PORT=$(PORT) $(NODE) scripts/serve.mjs --dir $(DIST)

check: test e2e audit

test:
	$(NPM) test

e2e:
	$(NPM) run test:e2e

audit:
	$(NODE) tests/audit/audit.mjs

deploy: build
	@test -n "$(RSYNC_TARGET)" || { echo "Usage: make deploy RSYNC_TARGET=user@host:/path/" >&2; exit 2; }
	$(RSYNC) -az --delete --exclude '.DS_Store' "$(DIST)/" "$(RSYNC_TARGET)/"

clean:
	@test -n "$(DIST)" && test "$(DIST)" != "/" && test "$(DIST)" != "." || { echo "Refusing to remove DIST=$(DIST)" >&2; exit 2; }
	rm -rf -- "$(DIST)"
