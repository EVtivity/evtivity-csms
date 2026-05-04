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

# Network binding
if [ -z "${BIND_IP:-}" ]; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")
  if [ -n "$LAN_IP" ]; then
    read -rp "Bind to LAN IP ($LAN_IP) for external access? [y/N] " bind_ip
    if [[ "$bind_ip" == "y" || "$bind_ip" == "Y" ]]; then
      export BIND_IP="$LAN_IP"
    else
      export BIND_IP="0.0.0.0"
    fi
  else
    export BIND_IP="0.0.0.0"
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

echo ""
echo "Bind IP: $BIND_IP"
echo "Profiles: ${PROFILES[*]:-none}"
echo ""

# Tear down existing containers AND remove all named volumes so the next `up`
# starts with an empty postgres. Using --volumes here (instead of a separate
# `docker volume rm <name>`) avoids hard-coding the volume name -- compose
# derives `<project>_<volume>` from the `name:` field in docker-compose.yml,
# and a typo there silently leaves stale data in place across rebuilds.
docker compose --profile tools --profile ocpi --profile monitoring down --remove-orphans --volumes --timeout 10

# Wait for TLS port to free up
while lsof -i :8443 >/dev/null 2>&1; do sleep 1; done

# Bring up data services first so the seed scripts can run against postgres
# while the simulator/api are still down. Starting the simulator before the
# seed completes creates a race: the simulator caches css_stations.id at
# boot, and a subsequent `npm run db:seed` TRUNCATE wipes those rows out from
# under it, leaving the in-memory config.id stale and every css_transactions
# INSERT failing with FK violation.
# Auto-login defaults are forced here (not pulled from .env) because the
# public-repo sync expects these specific dev creds. CSS_MODE / CSS_STATION_LIMIT
# are NOT overridden -- compose reads them from .env, falling back to its own
# defaults in docker-compose.yml.
CSMS_LOGIN=admin@evtivity.local \
PORTAL_LOGIN=driver@evtivity.local \
docker compose up -d --build postgres redis

# Wait for postgres to be healthy before running migrations and seeds. The
# migrate container has its own healthcheck dependency, but the host-side
# `npm run db:seed` connects directly and would race postgres startup.
echo ""
echo "Waiting for postgres to be ready..."
until docker compose exec -T postgres pg_isready -U evtivity >/dev/null 2>&1; do
  sleep 1
done

# Run migrations and seeds against the freshly-started postgres. The migrate
# container exits 0 when done; we run it as a one-shot dependency.
echo "Running migrations..."
docker compose up --no-deps --build migrate

echo ""
echo "Seeding database..."
npm run db:seed
npm run db:seed:dev

# Now bring up the remaining services (api, ocpp, csms, portal, simulator,
# worker, plus any profiled services). They start with the final post-seed
# css_stations rows so the simulator's cached config.id matches what's in
# the DB.
echo ""
echo "Starting application services..."
CSMS_LOGIN=admin@evtivity.local \
PORTAL_LOGIN=driver@evtivity.local \
docker compose ${PROFILES[@]+"${PROFILES[@]}"} up -d --build

echo ""
echo "CSMS:     http://${BIND_IP}:${CSMS_PORT:-7100}"
echo "Portal:   http://${BIND_IP}:${PORTAL_PORT:-7101}"
echo "API:      http://${BIND_IP}:${API_PORT:-7102}"
echo "OCPP:     ws://${BIND_IP}:${OCPP_PORT:-7103}"
echo "OCPP TLS: wss://${BIND_IP}:8443"
echo "OCPI:     http://${BIND_IP}:${OCPI_PORT:-7104}"
