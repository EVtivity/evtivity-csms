#!/usr/bin/env bash
set -euo pipefail

# Local Docker build/test harness. Brings up the full stack from source via
# docker compose with a clean Postgres volume, then seeds the database.
# Used to smoke-test the build images locally before tagging a release.
#
# Seed strategy: `npm run db:seed` (admin + roles + settings, honors SEED_DEMO
# from .env) then `npm run db:seed:dev` (minimal dev fixture from
# packages/database/src/seed-dev-stations.ts) for testing without the full demo
# dataset.

unset DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH MINIKUBE_ACTIVE_DOCKERD

# Collect profile flags based on user choices
PROFILES=()

echo "=== EVtivity Docker Compose Build ==="
echo ""
echo "Core services (postgres, redis, api, ocpp, csms, portal, simulator, worker) always start."
echo ""

# Network binding. The whole point of an explicit BIND_IP is cross-device
# access (phone, tablet, another laptop on the same LAN). Default to YES so
# the URLs printed at the end are immediately reachable from any device on
# the network. Pick "n" to keep the stack loopback-only.
if [ -z "${BIND_IP:-}" ]; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")
  if [ -n "$LAN_IP" ]; then
    read -rp "Bind to LAN IP ($LAN_IP) for external access? [Y/n] " bind_ip
    if [[ "$bind_ip" == "n" || "$bind_ip" == "N" ]]; then
      export BIND_IP="127.0.0.1"
    else
      export BIND_IP="$LAN_IP"
    fi
  else
    export BIND_IP="127.0.0.1"
  fi
fi

# Tools: pgadmin, mailpit, ftp
read -rp "Start dev tools (pgadmin, mailpit, ftp)? [y/N] " tools
if [[ "$tools" == "y" || "$tools" == "Y" ]]; then
  PROFILES+=(--profile tools)
fi

# OCPI: ocpi server + simulators
read -rp "Start OCPI roaming (ocpi, ocpi-simulator, ocpi-cpo-sim)? [y/N] " ocpi
if [[ "$ocpi" == "y" || "$ocpi" == "Y" ]]; then
  PROFILES+=(--profile ocpi)
fi

# Monitoring: prometheus, grafana, loki, alloy
read -rp "Start monitoring (prometheus, grafana, loki, alloy)? [y/N] " monitoring
if [[ "$monitoring" == "y" || "$monitoring" == "Y" ]]; then
  PROFILES+=(--profile monitoring)
fi

# Restart postgres and redis (wipes all DB + Redis data and reseeds). Default
# no so iterating on app code does not throw away local state every rebuild.
read -rp "Restart postgres and redis (wipes DB + Redis data, reseeds)? [y/N] " restart_data
RESTART_DATA="n"
if [[ "$restart_data" == "y" || "$restart_data" == "Y" ]]; then
  RESTART_DATA="y"
fi

echo ""
if [ "$BIND_IP" != "127.0.0.1" ]; then
  echo "Bind IP: $BIND_IP (LAN)"
fi
echo "Profiles: ${PROFILES[*]:-none}"
echo "Restart data services: $RESTART_DATA"
echo ""

if [ "$RESTART_DATA" = "y" ]; then
  # Full teardown + volume removal so the next `up` starts with an empty
  # postgres + redis. --volumes avoids hard-coding the volume name -- compose
  # derives `<project>_<volume>` from the `name:` field in docker-compose.yml.
  docker compose --profile tools --profile ocpi --profile monitoring down --remove-orphans --volumes --timeout 10
else
  # Preserve postgres + redis (and their volumes). Stop only the app services
  # so they get rebuilt with the new image. The data services keep running so
  # iteration on app code does not lose local state.
  docker compose --profile tools --profile ocpi --profile monitoring stop --timeout 10 \
    api ocpp csms portal simulator worker migrate \
    ocpi ocpi-simulator ocpi-cpo-sim \
    pgadmin mailpit ftp prometheus grafana loki alloy 2>/dev/null || true
  docker compose --profile tools --profile ocpi --profile monitoring rm -f \
    api ocpp csms portal simulator worker migrate \
    ocpi ocpi-simulator ocpi-cpo-sim \
    pgadmin mailpit ftp prometheus grafana loki alloy 2>/dev/null || true
fi

# Wait for TLS port to free up
while lsof -i :8443 >/dev/null 2>&1; do sleep 1; done

# Bring up data services first so the seed scripts can run against postgres
# while the simulator/api are still down. Starting the simulator before the
# seed completes creates a race: the simulator caches css_stations.id at
# boot, and a subsequent `npm run db:seed` TRUNCATE wipes those rows out from
# under it, leaving the in-memory config.id stale and every css_transactions
# INSERT failing with FK violation.
# All env vars (auto-login, CSS_MODE, CSS_STATION_LIMIT, etc.) are read from
# .env via docker-compose's automatic .env loading. To enable dev auto-login,
# set VITE_CSMS_AUTO_LOGIN / VITE_PORTAL_AUTO_LOGIN in .env.
docker compose up -d postgres redis

# Wait for postgres to be healthy before running migrations and seeds. The
# migrate container has its own healthcheck dependency, but the host-side
# `npm run db:seed` connects directly and would race postgres startup.
echo ""
echo "Waiting for postgres to be ready..."
until docker compose exec -T postgres pg_isready -U evtivity >/dev/null 2>&1; do
  sleep 1
done

# Migrations are idempotent and safe to run on an existing database, so always
# apply them. Seeding only runs on a fresh DB to avoid clobbering operator
# changes.
echo "Running migrations..."
docker compose up --no-deps --build migrate

if [ "$RESTART_DATA" = "y" ]; then
  echo ""
  # The seed scripts run on the host and resolve `@evtivity/lib` to its compiled
  # `dist/`. New lib exports (like STATION_MESSAGE_DEFAULTS) only land in `dist/`
  # when lib is built. Compile lib + database before seeding so a fresh checkout
  # never fails with "module does not provide an export named X".
  echo "Building lib + database for host-side seed..."
  npm run build --workspace=@evtivity/lib --workspace=@evtivity/database

  echo ""
  echo "Seeding database..."
  npm run db:seed
  npm run db:seed:dev
else
  echo ""
  echo "Skipping seed (data services preserved)."
fi

# Now bring up the remaining services (api, ocpp, csms, portal, simulator,
# worker, plus any profiled services). They start with the final post-seed
# css_stations rows so the simulator's cached config.id matches what's in
# the DB.
echo ""
echo "Starting application services..."
docker compose ${PROFILES[@]+"${PROFILES[@]}"} up -d --build

echo ""
echo "CSMS:     http://${BIND_IP}:${CSMS_PORT:-7100}"
echo "Portal:   http://${BIND_IP}:${PORTAL_PORT:-7101}"
echo "API:      http://${BIND_IP}:${API_PORT:-7102}"
echo "OCPP:     ws://${BIND_IP}:${OCPP_PORT:-7103}"
echo "OCPP TLS: wss://${BIND_IP}:8443"
echo "OCPI:     http://${BIND_IP}:${OCPI_PORT:-7104}"
