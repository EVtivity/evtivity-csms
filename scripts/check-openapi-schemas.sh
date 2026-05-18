#!/usr/bin/env bash
# Fail if any route file declares a loose response schema placeholder.
#
# `z.object({}).passthrough()` and `z.object({})` produce empty objects in
# the generated OpenAPI spec, which the website renders as a generic object
# with no field detail. Every response/item schema must enumerate its fields
# with `.describe()` strings.
#
# This guard scans packages/api/src/routes/**/*.ts and exits non-zero if it
# finds any loose schema. It is intended to run in CI alongside lint and
# typecheck.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROUTES_DIR="$ROOT/packages/api/src/routes"

if [ ! -d "$ROUTES_DIR" ]; then
  echo "error: $ROUTES_DIR not found"
  exit 2
fi

# Loose response schemas use `z.object({}).passthrough()` to short-circuit
# the response-shape declaration. They render as empty objects in the
# generated OpenAPI spec, which the docs site shows as "object" with no
# field detail. Empty bodies (`z.object({})` for endpoints with no request
# body) are fine and not flagged.
PATTERN='z\.object\(\{\}\)\.passthrough\(\)'

if matches=$(grep -rEn "$PATTERN" "$ROUTES_DIR" 2>/dev/null); then
  count=$(echo "$matches" | wc -l | tr -d ' ')
  echo "error: $count loose response schema(s) found in route files."
  echo
  echo "z.object({}).passthrough() generates an empty object in the OpenAPI spec, which"
  echo "renders as a no-detail object on the docs site. Replace with a typed Zod schema"
  echo "that enumerates fields with .describe() strings and ends in .passthrough()."
  echo
  echo "$matches"
  exit 1
fi

echo "ok: no loose response schemas in route files"
