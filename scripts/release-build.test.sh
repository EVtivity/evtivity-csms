#!/usr/bin/env bash
# Tests for scripts/release-build.sh with a stand-in docker on PATH (no image is built).
# Usage: bash scripts/release-build.test.sh   (npm run test:release)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-build.sh
source "$SCRIPT_DIR/release-build.sh"

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

work=$(mktemp -d "${TMPDIR:-/tmp}/release-build-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
# Stand-in docker: records the peak number of builds running at once, fails the image whose tag
# names "bad", sleeps a little so builds overlap.
cat > "$work/bin/docker" << 'EOF'
#!/usr/bin/env bash
tag=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-t" ]; then tag=$2; fi
  shift
done
touch "$STUB_DIR/run/$$"
n=$(find "$STUB_DIR/run" -type f | wc -l | tr -d ' ')
peak=$(cat "$STUB_DIR/peak" 2> /dev/null || echo 0)
[ "$n" -gt "$peak" ] && echo "$n" > "$STUB_DIR/peak"
echo "building $tag"
sleep 0.3
rm -f "$STUB_DIR/run/$$"
case "$tag" in *bad*) echo "boom in $tag"; exit 1 ;; esac
exit 0
EOF
chmod +x "$work/bin/docker"
export STUB_DIR="$work/stub"
mkdir -p "$STUB_DIR/run"
PATH="$work/bin:$PATH"

services="
a:packages/a/Dockerfile
b:packages/b/Dockerfile
c:packages/c/Dockerfile
d:packages/d/Dockerfile
e:packages/e/Dockerfile
"

out=$(release_build_images 2 "$services")
release_build_images 2 "$services" > /dev/null
check "all pass" 5 "$RELEASE_BUILD_PASS"
check "none fail" 0 "$RELEASE_BUILD_FAIL"
check "at most 2 at once" yes "$([ "$(cat "$STUB_DIR/peak")" -le 2 ] && echo yes || echo no)"
check "builds overlap" 2 "$(cat "$STUB_DIR/peak")"
check "results in service order" "a b c d e" \
  "$(printf '%b' "$RELEASE_BUILD_RESULTS" | awk 'NF {sub(":", "", $1); printf "%s ", $1}' | sed 's/ $//')"
check "start lines printed" 5 "$(printf '%s\n' "$out" | grep -c '^--- Building')"

rm -f "$STUB_DIR/peak"
services_bad="
a:packages/a/Dockerfile
bad:packages/bad/Dockerfile
c:packages/c/Dockerfile
"
out=$(release_build_images 3 "$services_bad")
release_build_images 3 "$services_bad" > /dev/null
check "one fails" 1 "$RELEASE_BUILD_FAIL"
check "two pass" 2 "$RELEASE_BUILD_PASS"
check "failed name" " bad" "$RELEASE_BUILD_FAILED"
check "failed log printed" yes "$(printf '%s\n' "$out" | grep -q 'boom in evtivity-bad:local-test' && echo yes || echo no)"
check "failure line" yes "$(printf '%b' "$RELEASE_BUILD_RESULTS" | grep -q 'bad: FAILED' && echo yes || echo no)"

check "one at a time" 0 "$(
  rm -f "$STUB_DIR/peak"
  release_build_images 1 "$services" > /dev/null
  [ "$(cat "$STUB_DIR/peak")" = 1 ] && echo 0 || echo 1
)"
check "refuses 0 jobs" no "$(release_build_images 0 "$services" > /dev/null && echo yes || echo no)"
check "refuses text" no "$(release_build_images x "$services" > /dev/null && echo yes || echo no)"

echo "release-build: $passes passed, $failures failed"
[ "$failures" -eq 0 ]
