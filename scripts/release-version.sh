#!/usr/bin/env bash
# Release tag helpers shared by scripts/release.sh and .github/workflows/release.yml.
#
# Source this file; it defines functions only. Tags are `v` plus a semver 2.0.0
# version (https://semver.org) in one of three channels: stable `v0.1.38`, alpha
# `v0.1.39-alpha.1` and beta `v0.1.38-beta.2` (the number is optional). No other
# prerelease label (nightly, rc, preview) is used, so this grammar rejects them.
# Older `-nightly` tags stay in the repo as history and are ignored, including as a
# changelog base. Build metadata (`+...`) is rejected because Docker image tags
# cannot hold `+`.
#
# Usage from a shell: bash scripts/release-version.sh <function> [args...]

RELEASE_NUM='(0|[1-9][0-9]*)'
RELEASE_STABLE_RE="^v${RELEASE_NUM}\\.${RELEASE_NUM}\\.${RELEASE_NUM}\$"
RELEASE_TAG_RE="^v${RELEASE_NUM}\\.${RELEASE_NUM}\\.${RELEASE_NUM}(-(alpha|beta)(\\.${RELEASE_NUM})?)?\$"

# Printed when a tag does not match the grammar.
RELEASE_TAG_HELP='Use v + semver: v1.2.3 (stable), v1.2.3-alpha.N or v1.2.3-beta.N. The only prerelease channels are alpha and beta (no nightly, rc or preview, no +build metadata).'

# release_tag_is_valid <tag>: exit 0 when the tag is a stable, alpha or beta tag.
release_tag_is_valid() {
  [[ "${1:-}" =~ $RELEASE_TAG_RE ]]
}

# release_tag_is_prerelease <tag>: exit 0 when the tag is a valid prerelease tag.
release_tag_is_prerelease() {
  release_tag_is_valid "${1:-}" && ! [[ "$1" =~ $RELEASE_STABLE_RE ]]
}

# release_tag_channel <tag>: print the release channel, which is also the floating
# image tag (alias) the release moves: `stable`, `alpha` or `beta`. Exit 1 for an
# invalid tag.
release_tag_channel() {
  local tag="${1:-}" pre
  release_tag_is_valid "$tag" || return 1
  if ! release_tag_is_prerelease "$tag"; then
    echo stable
    return 0
  fi
  pre="${tag#*-}"
  echo "${pre%%.*}"
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
# versionsort.suffix=- sorts v0.1.38-beta.1 before v0.1.38. Tags outside the
# grammar (old -nightly tags, rc) are skipped.
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
