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

# Tear down existing containers (include all profiles to catch everything)
docker compose --profile tools --profile ocpi --profile monitoring down --remove-orphans --timeout 10

# Drop postgres volume for a clean database (migrations + seed run fresh)
docker volume rm evtivity-csms_pgdata 2>/dev/null || true

# Wait for TLS port to free up
while lsof -i :8443 >/dev/null 2>&1; do sleep 1; done

# Start services
CSMS_LOGIN=admin@evtivity.local \
PORTAL_LOGIN=driver@evtivity.local \
STATION_LIMIT=${STATION_LIMIT:-2000} \
CSS_MODE=${CSS_MODE:-chaos} \
docker compose ${PROFILES[@]+"${PROFILES[@]}"} up -d --build

# After a clean rebuild the postgres volume was dropped, so migrations leave an
# empty DB. Run seed explicitly to restore admin user + (optional) demo data.
# Honors SEED_DEMO from .env (or shell) -- no override here so .env wins.
echo ""
echo "Seeding database..."
npm run db:seed
npm run db:seed:dev

echo ""
echo "CSMS:     http://${BIND_IP}:${CSMS_PORT:-7100}"
echo "Portal:   http://${BIND_IP}:${PORTAL_PORT:-7101}"
echo "API:      http://${BIND_IP}:${API_PORT:-7102}"
echo "OCPP:     ws://${BIND_IP}:${OCPP_PORT:-7103}"
echo "OCPP TLS: wss://${BIND_IP}:8443"
echo "OCPI:     http://${BIND_IP}:${OCPI_PORT:-7104}"
