#!/usr/bin/env bash
# Local smoke build of the release images, sourced by scripts/release.sh.
# Tests: bash scripts/release-build.test.sh (npm run test:release).
#
# release_build_images <jobs> <services>
#   Builds every "name:Dockerfile" entry of <services> as evtivity-<name>:local-test, <jobs> at
#   a time (BuildKit shares its layer cache between the builds). Each build logs to its own file;
#   a failed build prints the end of its log. Every image must build: the pass rule of a serial
#   build. Sets RELEASE_BUILD_PASS, RELEASE_BUILD_FAIL, RELEASE_BUILD_FAILED (names) and
#   RELEASE_BUILD_RESULTS (one "  name: OK (Ns)" line per image, in <services> order).
#   Returns 1 when <jobs> is not a positive number.

release_build_images() {
  local jobs=$1 services=$2
  case "$jobs" in
    '' | *[!0-9]* | 0)
      echo "RELEASE_BUILD_JOBS must be a positive number, not '$jobs'"
      return 1
      ;;
  esac
  local build_dir entry name dockerfile pids="" running=0 oldest pid rc elapsed
  build_dir=$(mktemp -d "${TMPDIR:-/tmp}/evtivity-release-build.XXXXXX")
  RELEASE_BUILD_PASS=0
  RELEASE_BUILD_FAIL=0
  RELEASE_BUILD_FAILED=""
  RELEASE_BUILD_RESULTS=""

  for entry in $services; do
    name="${entry%%:*}"
    dockerfile="${entry#*:}"
    if [ "$running" -ge "$jobs" ]; then
      # bash 3.2 (macOS) has no wait -n: wait for the oldest build to free a slot.
      oldest="${pids%% *}"
      pids="${pids#* }"
      wait "$oldest" || true
      running=$((running - 1))
    fi
    echo "--- Building $name ($dockerfile)"
    _release_build_one "$build_dir" "$name" "$dockerfile" &
    pids="$pids$! "
    running=$((running + 1))
  done
  for pid in $pids; do
    wait "$pid" || true
  done
  echo ""

  for entry in $services; do
    name="${entry%%:*}"
    rc=1
    elapsed=0
    if [ -f "$build_dir/$name.rc" ]; then
      read -r rc elapsed < "$build_dir/$name.rc"
    fi
    if [ "$rc" = "0" ]; then
      RELEASE_BUILD_PASS=$((RELEASE_BUILD_PASS + 1))
      RELEASE_BUILD_RESULTS="$RELEASE_BUILD_RESULTS\n  $name: OK (${elapsed}s)"
    else
      RELEASE_BUILD_FAIL=$((RELEASE_BUILD_FAIL + 1))
      RELEASE_BUILD_FAILED="$RELEASE_BUILD_FAILED $name"
      RELEASE_BUILD_RESULTS="$RELEASE_BUILD_RESULTS\n  $name: FAILED (${elapsed}s)"
      echo "--- $name build log (last 60 lines)"
      tail -n 60 "$build_dir/$name.log" 2> /dev/null || echo "    no build log"
      echo ""
    fi
  done
  rm -rf "$build_dir"
}

_release_build_one() {
  local dir=$1 name=$2 dockerfile=$3 start rc=0
  start=$(date +%s)
  docker build -f "$dockerfile" -t "evtivity-${name}:local-test" . > "$dir/$name.log" 2>&1 || rc=$?
  echo "$rc $(($(date +%s) - start))" > "$dir/$name.rc"
}
