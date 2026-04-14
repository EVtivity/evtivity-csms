#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/release.sh                    # Auto patch bump, build only
#   scripts/release.sh --push             # Auto patch bump, build + tag + push
#   scripts/release.sh minor --push       # Minor bump (0.1.x -> 0.2.0)
#   scripts/release.sh major --push       # Major bump (0.x.y -> 1.0.0)
#   scripts/release.sh v0.2.1 --push      # Explicit version (for hotfixes)
#   scripts/release.sh --force --push     # Overwrite existing tag and release
#
# Bump types: patch (default), minor, major
# Explicit version: any v-prefixed semver (e.g. v1.2.3)

PUSH=false
FORCE=false
BUMP="patch"
EXPLICIT=""

for arg in "$@"; do
  case "$arg" in
    --push) PUSH=true ;;
    --force) FORCE=true ;;
    major|minor|patch) BUMP="$arg" ;;
    v[0-9]*) EXPLICIT="$arg" ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Service definitions: name:Dockerfile pairs
SERVICES="
api:packages/api/Dockerfile
ocpp:packages/ocpp/Dockerfile
ocpi:packages/ocpi/Dockerfile
csms:packages/csms/Dockerfile
portal:packages/portal/Dockerfile
migrate:packages/database/Dockerfile
css:packages/css/Dockerfile
worker:packages/worker/Dockerfile
ocpi-simulator:packages/ocpi-simulator/Dockerfile
"

# Determine version
if [ "$FORCE" = true ] && [ -z "$EXPLICIT" ]; then
  # --force without explicit version: reuse current version from package.json
  next_version=$(node -e "console.log(require('./package.json').version)")
  next="v${next_version}"
elif [ -n "$EXPLICIT" ]; then
  next="$EXPLICIT"
  next_version="${next#v}"
else
  # Auto-increment from latest git tag
  latest=$(git tag -l 'v*' --sort=-v:refname | head -n1)
  if [ -z "$latest" ]; then
    next="v0.1.0"
  else
    version="${latest#v}"
    major=$(echo "$version" | cut -d. -f1)
    minor=$(echo "$version" | cut -d. -f2)
    patch=$(echo "$version" | cut -d. -f3)

    case "$BUMP" in
      major) next="v$((major + 1)).0.0" ;;
      minor) next="v${major}.$((minor + 1)).0" ;;
      patch) next="v${major}.${minor}.$((patch + 1))" ;;
    esac
  fi
  next_version="${next#v}"
fi

# Validate the tag does not already exist (unless --force)
if git rev-parse "$next" >/dev/null 2>&1; then
  if [ "$FORCE" = true ]; then
    echo "Tag $next exists. --force: deleting local tag, remote tag, and GitHub release..."
    git tag -d "$next" 2>/dev/null || true
    git push origin ":refs/tags/$next" 2>/dev/null || true
    gh release delete "$next" --yes 2>/dev/null || true
  else
    echo "Error: tag $next already exists. Use --force to overwrite."
    exit 1
  fi
fi

echo "Next tag:   $next"
echo ""

# Update version in all package.json files
echo "Updating package.json versions to $next_version..."
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$next_version';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
for pkg_file in packages/*/package.json; do
  node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$pkg_file', 'utf8'));
pkg.version = '$next_version';
fs.writeFileSync('$pkg_file', JSON.stringify(pkg, null, 2) + '\n');
"
done

echo ""

echo "Running esbuild production bundles..."
if ! node scripts/build.mjs all; then
  echo ""
  echo "esbuild bundle failed. Fix errors before releasing."
  exit 1
fi
echo ""

count=$(echo "$SERVICES" | grep -c ':')
echo "Building all $count Docker images locally..."
echo ""

failed=""
pass=0
fail=0
results=""
total_start=$(date +%s)

for entry in $SERVICES; do
  name="${entry%%:*}"
  dockerfile="${entry#*:}"
  echo "--- Building $name ($dockerfile)"

  start=$(date +%s)
  if docker build -f "$dockerfile" -t "evtivity-${name}:local-test" . 2>&1 | tail -1; then
    elapsed=$(( $(date +%s) - start ))
    pass=$((pass + 1))
    echo "    $name: OK (${elapsed}s)"
    results="$results\n  $name: OK (${elapsed}s)"
  else
    elapsed=$(( $(date +%s) - start ))
    fail=$((fail + 1))
    failed="$failed $name"
    echo "    $name: FAILED (${elapsed}s)"
    results="$results\n  $name: FAILED (${elapsed}s)"
  fi
  echo ""
done

total_elapsed=$(( $(date +%s) - total_start ))
total_min=$((total_elapsed / 60))
total_sec=$((total_elapsed % 60))

echo "=============================="
echo "Build results: $pass passed, $fail failed (${total_min}m ${total_sec}s)"
printf "%b\n" "$results"
echo ""

if [ $fail -gt 0 ]; then
  echo "FAILED services:$failed"
  echo ""
  echo "Fix build errors before releasing."
  exit 1
fi

echo "All builds passed."

if [ "$PUSH" = false ]; then
  echo ""
  echo "Run with --push to tag $next and push."
  exit 0
fi

echo ""

# Check for unpushed commits
unpushed=$(git log --oneline @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ')
if [ "$unpushed" -gt 0 ]; then
  echo "WARNING: $unpushed unpushed commit(s):"
  git log --oneline @{u}..HEAD
  echo ""
  read -rp "Push these commits along with the release tag? (y/n) " confirm
  if [ "$confirm" != "y" ]; then
    echo "Push your commits first, then re-run with --push."
    exit 1
  fi
fi

git add package.json packages/*/package.json
if git diff --cached --quiet; then
  git commit --allow-empty -m "Releasing version $next_version"
else
  git commit -m "Releasing version $next_version"
fi
git tag "$next"
git push origin HEAD "$next"

echo "Pushed $next. CI will build and push images to ghcr.io/evtivity."
