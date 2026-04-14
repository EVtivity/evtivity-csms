#!/usr/bin/env bash
set -euo pipefail

# Usage: generate-changelog.sh <from-tag> <to-tag>
# If from-tag is empty, includes all commits up to to-tag.

FROM_TAG="${1:-}"
TO_TAG="${2:?Usage: generate-changelog.sh <from-tag> <to-tag>}"

# Resolve repo URL for commit links
if [ -z "${REPO_URL:-}" ]; then
  REMOTE=$(git remote get-url origin 2>/dev/null || true)
  REPO_URL=$(echo "$REMOTE" | sed -e 's/\.git$//' -e 's|git@github.com:|https://github.com/|')
fi

if [ -n "$FROM_TAG" ]; then
  RANGE="${FROM_TAG}..${TO_TAG}"
else
  RANGE="$TO_TAG"
fi

# Collect commits (hash + message), skip release commits and merge commits
COMMITS=$(git log "$RANGE" --pretty=format:"%H %s" --no-merges | grep -v "^[a-f0-9]* release:" || true)

if [ -z "$COMMITS" ]; then
  echo "No notable changes."
  exit 0
fi

# Conventional commit types and their display names
# Uses parallel arrays for bash 3.x compatibility (macOS default)
TYPES=(feat fix perf refactor docs test build ci chore revert style)
NAMES=("Features" "Bug Fixes" "Performance" "Refactoring" "Documentation" "Tests" "Build" "CI" "Chores" "Reverts" "Style")

# Temporary files for grouped output
TMPDIR_CL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_CL"' EXIT

for TYPE in "${TYPES[@]}"; do
  : > "$TMPDIR_CL/$TYPE"
done
: > "$TMPDIR_CL/_ungrouped"

while IFS= read -r line; do
  HASH="${line%% *}"
  MSG="${line#* }"
  SHORT="${HASH:0:7}"

  # Extract type from conventional commit
  # First try to get the prefix before the colon
  if [[ "$MSG" == *:\ * ]]; then
    PREFIX="${MSG%%: *}"
    SUBJECT="${MSG#*: }"

    # Check if prefix matches "type" or "type(scope)"
    # Extract the bare type (everything before an open paren)
    BARE_TYPE="${PREFIX%%(*}"
    SCOPE=""
    if [[ "$PREFIX" == *"("*")"* ]]; then
      SCOPE="${PREFIX#*(}"
      SCOPE="(${SCOPE%%)*})"
    fi

    # Check if the bare type is a known conventional commit type
    MATCHED=0
    for i in "${!TYPES[@]}"; do
      if [ "$BARE_TYPE" = "${TYPES[$i]}" ]; then
        if [ -n "$SCOPE" ]; then
          echo "- **${SCOPE}**: ${SUBJECT} ([${SHORT}](${REPO_URL}/commit/${HASH}))" >> "$TMPDIR_CL/${TYPES[$i]}"
        else
          echo "- ${SUBJECT} ([${SHORT}](${REPO_URL}/commit/${HASH}))" >> "$TMPDIR_CL/${TYPES[$i]}"
        fi
        MATCHED=1
        break
      fi
    done

    if [ "$MATCHED" -eq 0 ]; then
      echo "- ${MSG} ([${SHORT}](${REPO_URL}/commit/${HASH}))" >> "$TMPDIR_CL/_ungrouped"
    fi
  else
    echo "- ${MSG} ([${SHORT}](${REPO_URL}/commit/${HASH}))" >> "$TMPDIR_CL/_ungrouped"
  fi
done <<< "$COMMITS"

# Output grouped sections
for i in "${!TYPES[@]}"; do
  TYPE="${TYPES[$i]}"
  NAME="${NAMES[$i]}"
  if [ -s "$TMPDIR_CL/$TYPE" ]; then
    echo "## ${NAME}"
    echo ""
    cat "$TMPDIR_CL/$TYPE"
    echo ""
  fi
done

# Output ungrouped commits
if [ -s "$TMPDIR_CL/_ungrouped" ]; then
  echo "## Other Changes"
  echo ""
  cat "$TMPDIR_CL/_ungrouped"
  echo ""
fi
