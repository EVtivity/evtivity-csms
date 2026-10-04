#!/usr/bin/env bash
# Release tag helpers shared by scripts/release.sh and .github/workflows/release.yml.
#
# Source this file; it defines functions only. Tags are `v` plus a semver 2.0.0
# version (https://semver.org). A tag with a prerelease suffix
# (`v0.1.38-beta.1`, `v0.1.38-nightly.2`, `v0.1.38-rc.1`) is a prerelease.
# Build metadata (`+...`) is rejected because Docker image tags cannot hold `+`.
#
# Usage from a shell: bash scripts/release-version.sh <function> [args...]

# Semver 2.0.0 core and prerelease grammar (semver.org regex without build metadata).
RELEASE_NUM='(0|[1-9][0-9]*)'
RELEASE_PRE_ID='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
RELEASE_STABLE_RE="^v${RELEASE_NUM}\\.${RELEASE_NUM}\\.${RELEASE_NUM}\$"
RELEASE_TAG_RE="^v${RELEASE_NUM}\\.${RELEASE_NUM}\\.${RELEASE_NUM}(-${RELEASE_PRE_ID}(\\.${RELEASE_PRE_ID})*)?\$"

# release_tag_is_valid <tag>: exit 0 when the tag is v + semver (stable or prerelease).
release_tag_is_valid() {
  [[ "${1:-}" =~ $RELEASE_TAG_RE ]]
}

# release_tag_is_prerelease <tag>: exit 0 when the tag is a valid prerelease tag.
release_tag_is_prerelease() {
  release_tag_is_valid "${1:-}" && ! [[ "$1" =~ $RELEASE_STABLE_RE ]]
}

# release_latest_stable_tag: print the highest stable tag in the repo (prereleases
# skipped), or nothing when there is none.
release_latest_stable_tag() {
  git tag -l 'v*' --sort=-v:refname | grep -E "$RELEASE_STABLE_RE" | sed -n '1p' || true
}

# release_next_stable_tag <major|minor|patch>: print the next stable tag after the
# latest stable tag, or v0.1.0 when the repo has no stable tag.
release_next_stable_tag() {
  local bump="${1:-patch}" latest version major minor patch
  latest=$(release_latest_stable_tag)
  if [ -z "$latest" ]; then
    echo "v0.1.0"
    return 0
  fi
  version="${latest#v}"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  patch="${version##*.}"
  case "$bump" in
    major) echo "v$((major + 1)).0.0" ;;
    minor) echo "v${major}.$((minor + 1)).0" ;;
    patch) echo "v${major}.${minor}.$((patch + 1))" ;;
    *)
      echo "Unknown bump: $bump" >&2
      return 1
      ;;
  esac
}

# release_previous_tag <tag>: print the tag the changelog for <tag> starts from,
# or nothing for the first tag. <tag> must exist in the repo.
# A stable tag compares against the previous stable tag, so its notes cover every
# change since the last stable release, prereleases included. A prerelease
# compares against the previous tag of any kind, so its notes cover only what
# changed since the last build that was tested. Order is semver precedence:
# versionsort.suffix=- sorts v0.1.38-beta.1 before v0.1.38.
release_previous_tag() {
  local tag="${1:?release_previous_tag needs a tag}" tags
  tags=$(git -c versionsort.suffix=- tag -l 'v*' --sort=v:refname | grep -E "$RELEASE_TAG_RE" || true)
  if ! release_tag_is_prerelease "$tag"; then
    tags=$(printf '%s\n' "$tags" | grep -E "$RELEASE_STABLE_RE" || true)
  fi
  # The tag must exist (the release workflow runs on it). The first tag prints nothing.
  printf '%s\n' "$tags" | awk -v cur="$tag" '
    $0 == cur { found = 1; exit }
    { prev = $0 }
    END { if (found) print prev }
  '
}

# release_version_files: print the files release.sh changes before its release
# commit (the version bumps and the regenerated AI tools), relative to the repo root.
release_version_files() {
  local f
  for f in package.json packages/*/package.json packages/api/src/services/ai/tools.ts; do
    if [ -f "$f" ]; then printf '%s\n' "$f"; fi
  done
}

# release_backup_version_files <dir>: copy the files of release_version_files into <dir>.
release_backup_version_files() {
  local dir="${1:?release_backup_version_files needs a directory}" f
  while IFS= read -r f; do
    mkdir -p "$dir/$(dirname "$f")"
    cp -p "$f" "$dir/$f"
  done < <(release_version_files)
}

# release_restore_version_files <dir>: put back every file saved by
# release_backup_version_files, so a failed release leaves no version bump behind.
release_restore_version_files() {
  local dir="${1:?release_restore_version_files needs a directory}" f
  while IFS= read -r f; do
    f="${f#"$dir"/}"
    mkdir -p "$(dirname "$f")"
    cp -p "$dir/$f" "$f"
  done < <(find "$dir" -type f)
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  fn="${1:?Usage: release-version.sh <function> [args...]}"
  shift
  case "$fn" in
    release_tag_is_valid | release_tag_is_prerelease | release_latest_stable_tag | \
      release_next_stable_tag | release_previous_tag) "$fn" "$@" ;;
    *)
      echo "Unknown function: $fn" >&2
      exit 1
      ;;
  esac
fi
