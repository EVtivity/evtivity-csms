#!/usr/bin/env bash
set -euo pipefail

# Rebuild and restart one or more docker compose services without touching the
# rest of the stack. Useful for iterating on a single service after editing
# source without going through the full docker-build.sh teardown/seed cycle.
# Pass `all` to rebuild every core service.

CSMS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

VALID_SERVICES="api ocpp ocpi csms css portal migrate ocpi-simulator ocpi-cpo-sim worker"

get_compose_service() {
  case "$1" in
    api)            echo "api" ;;
    ocpp)           echo "ocpp" ;;
    ocpi)           echo "ocpi" ;;
    csms)           echo "csms" ;;
    css)            echo "simulator" ;;
    portal)         echo "portal" ;;
    migrate)        echo "migrate" ;;
    ocpi-simulator) echo "ocpi-simulator" ;;
    ocpi-cpo-sim)   echo "ocpi-cpo-sim" ;;
    worker)         echo "worker" ;;
    *)              return 1 ;;
  esac
}

usage() {
  echo "Usage: $0 <service> [service...]"
  echo ""
  echo "Rebuild Docker image(s) and restart the container(s) via docker compose."
  echo ""
  echo "Services: ${VALID_SERVICES}"
  echo ""
  echo "Examples:"
  echo "  $0 css                  # Rebuild and restart the simulator"
  echo "  $0 api ocpp             # Rebuild and restart API and OCPP"
  echo "  $0 all                  # Rebuild and restart everything"
  exit 1
}

if [ $# -eq 0 ]; then
  usage
fi

SERVICES=""
for arg in "$@"; do
  if [ "$arg" = "all" ]; then
    SERVICES="$VALID_SERVICES"
    break
  fi
  if ! get_compose_service "$arg" > /dev/null 2>&1; then
    echo "Error: unknown service '$arg'"
    echo "Valid services: ${VALID_SERVICES}"
    exit 1
  fi
  SERVICES="${SERVICES:+$SERVICES }$arg"
done

COMPOSE_SERVICES=""
for svc in $SERVICES; do
  COMPOSE_SERVICES="${COMPOSE_SERVICES:+$COMPOSE_SERVICES }$(get_compose_service "$svc")"
done

echo "Building: ${COMPOSE_SERVICES}"
docker compose -f "${CSMS_DIR}/docker-compose.yml" build $COMPOSE_SERVICES

echo ""
echo "Restarting: ${COMPOSE_SERVICES}"
docker compose -f "${CSMS_DIR}/docker-compose.yml" up -d --no-deps $COMPOSE_SERVICES

echo ""
echo "Done."
