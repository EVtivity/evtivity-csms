#!/usr/bin/env bash
# Tests for scripts/release-version.sh. Runs against a throwaway git repo.
# Usage: bash scripts/release-version.test.sh   (npm run test:release)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-version.sh
source "$SCRIPT_DIR/release-version.sh"

failures=0
passes=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    passes=$((passes + 1))
  else
    failures=$((failures + 1))
    echo "FAIL: $name: expected '$expected', got '$actual'"
  fi
}

status_of() {
  if "$@"; then echo yes; else echo no; fi
}

# Tag validation
for tag in v0.1.38 v1.0.0 v10.20.30 v0.1.38-beta.1 v0.1.38-beta v0.1.38-nightly.1 \
  v0.1.38-nightly v0.1.38-beta.0 v0.1.38-nightly.12 v0.1.39-alpha v0.1.39-alpha.3; do
  check "valid $tag" yes "$(status_of release_tag_is_valid "$tag")"
done
# Only the stable, alpha, beta and nightly channels exist; other prerelease labels are refused.
for tag in 0.1.38 v0.1 v0.1.38. v01.1.38 v0.01.38 v0.1.038 v0.1.38- v0.1.38-beta..1 \
  v0.1.38-01 v0.1.38+build.1 v0.1.38-beta+build "v0.1.38 " vfoo "" \
  v0.1.38-rc.1 v0.1.38-preview.2 v1.0.0-alphabet v0.1.38-betax.1 v0.1.38-beta.01 \
  v0.1.38-beta.1.2 v0.1.38-Beta.1 v0.1.38-nightly-1; do
  check "invalid '$tag'" no "$(status_of release_tag_is_valid "$tag")"
done

# Prerelease detection
check "stable not prerelease" no "$(status_of release_tag_is_prerelease v0.1.38)"
check "beta is prerelease" yes "$(status_of release_tag_is_prerelease v0.1.38-beta.1)"
check "alpha is prerelease" yes "$(status_of release_tag_is_prerelease v0.1.39-alpha.1)"
check "nightly is prerelease" yes "$(status_of release_tag_is_prerelease v0.1.38-nightly.3)"
check "invalid not prerelease" no "$(status_of release_tag_is_prerelease v0.1-beta)"

# Floating image tag (alias) per release channel
check "stable channel" stable "$(release_tag_channel v0.1.38)"
check "beta channel" beta "$(release_tag_channel v0.1.38-beta.2)"
check "bare beta channel" beta "$(release_tag_channel v0.1.38-beta)"
check "nightly channel" nightly "$(release_tag_channel v0.1.38-nightly.7)"
check "bare nightly channel" nightly "$(release_tag_channel v0.1.38-nightly)"
check "alpha channel" alpha "$(release_tag_channel v0.1.39-alpha.1)"
check "invalid tag fails" no "$(status_of release_tag_channel v0.1-beta)"
check "rc tag fails" no "$(status_of release_tag_channel v0.1.38-rc.1)"

# Tag ordering against a real repo
REPO=$(mktemp -d)
trap 'rm -rf "$REPO"' EXIT
cd "$REPO"
git init -q
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init

check "no tags: latest stable" "" "$(release_latest_stable_tag)"
check "no tags: next patch" v0.1.0 "$(release_next_stable_tag patch)"

for tag in v0.1.9 v0.1.10 v0.1.37 v0.1.38-beta.1 v0.1.38-nightly.1 v0.1.38-nightly.2 \
  v0.1.38-beta.2 v0.1.38 v0.1.39-nightly.1 v0.2.0-alpha.1 v0.2.0-beta.1 v0.2.0-rc.1 \
  not-a-version; do
  git tag "$tag"
done

check "latest stable skips prereleases" v0.1.38 "$(release_latest_stable_tag)"
check "next patch" v0.1.39 "$(release_next_stable_tag patch)"
check "next minor" v0.2.0 "$(release_next_stable_tag minor)"
check "next major" v1.0.0 "$(release_next_stable_tag major)"
check "unknown bump fails" no "$(status_of release_next_stable_tag huge 2>/dev/null)"

check "stable prev is previous stable" v0.1.37 "$(release_previous_tag v0.1.38)"
check "stable prev uses numeric order" v0.1.9 "$(release_previous_tag v0.1.10)"
check "first stable has no prev" "" "$(release_previous_tag v0.1.9)"
check "prerelease prev is previous stable" v0.1.37 "$(release_previous_tag v0.1.38-beta.1)"
# Semver orders prerelease labels alphabetically: every beta of a version sorts
# below every nightly of it (beta.1 < beta.2 < nightly.1 < nightly.2).
check "prerelease prev is previous prerelease" v0.1.38-beta.2 \
  "$(release_previous_tag v0.1.38-nightly.1)"
check "nightly prev is previous nightly" v0.1.38-nightly.1 \
  "$(release_previous_tag v0.1.38-nightly.2)"
check "beta prev is previous beta" v0.1.38-beta.1 "$(release_previous_tag v0.1.38-beta.2)"
check "next-version prerelease prev is stable" v0.1.38 \
  "$(release_previous_tag v0.1.39-nightly.1)"
# alpha < beta < nightly within a version.
check "minor alpha prev is previous prerelease" v0.1.39-nightly.1 \
  "$(release_previous_tag v0.2.0-alpha.1)"
check "beta after alpha prev is the alpha" v0.2.0-alpha.1 \
  "$(release_previous_tag v0.2.0-beta.1)"
check "rc tag is ignored as a changelog base" v0.2.0-beta.1 \
  "$(git tag -l 'v*' | grep -E "$RELEASE_TAG_RE" | sort -V | tail -1)"

# Hotfix: an older stable release compares against its own predecessor, not the newest tag.
check "hotfix prev ignores newer tags" v0.1.10 "$(release_previous_tag v0.1.37)"

# Version file backup and restore (a failed release leaves no bump behind)
TREE=$(mktemp -d)
BACKUP=$(mktemp -d)
trap 'rm -rf "$REPO" "$TREE" "$BACKUP"' EXIT
mkdir -p "$TREE/packages/api/src/services/ai" "$TREE/packages/lib" "$TREE/packages/empty"
echo '{"version":"0.1.37"}' > "$TREE/package.json"
echo '{"version":"0.1.37"}' > "$TREE/packages/lib/package.json"
echo '{"version":"0.1.37"}' > "$TREE/packages/api/package.json"
echo 'old tools' > "$TREE/packages/api/src/services/ai/tools.ts"
cd "$TREE"
check "version files listed" \
  "package.json packages/api/package.json packages/lib/package.json packages/api/src/services/ai/tools.ts" \
  "$(release_version_files | tr '\n' ' ' | sed 's/ $//')"
release_backup_version_files "$BACKUP"
echo '{"version":"0.1.38"}' > package.json
echo '{"version":"0.1.38"}' > packages/lib/package.json
echo 'new tools' > packages/api/src/services/ai/tools.ts
release_restore_version_files "$BACKUP"
check "root version restored" '{"version":"0.1.37"}' "$(cat package.json)"
check "package version restored" '{"version":"0.1.37"}' "$(cat packages/lib/package.json)"
check "untouched package kept" '{"version":"0.1.37"}' "$(cat packages/api/package.json)"
check "ai tools restored" 'old tools' "$(cat packages/api/src/services/ai/tools.ts)"
cd "$REPO"

# Command-line entry point
check "cli valid" yes "$(status_of bash "$SCRIPT_DIR/release-version.sh" release_tag_is_valid v1.2.3-beta.1)"
check "cli rc invalid" no "$(status_of bash "$SCRIPT_DIR/release-version.sh" release_tag_is_valid v1.2.3-rc.1)"
check "cli prerelease" no \
  "$(status_of bash "$SCRIPT_DIR/release-version.sh" release_tag_is_prerelease v1.2.3)"
check "cli previous" v0.1.37 "$(bash "$SCRIPT_DIR/release-version.sh" release_previous_tag v0.1.38)"

echo "release-version: $passes passed, $failures failed"
[ "$failures" -eq 0 ]
