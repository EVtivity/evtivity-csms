#!/usr/bin/env bash
set -euo pipefail

# Tears down everything brought up by docker-build.sh: stops all containers
# across every profile (tools, ocpi, monitoring) and drops the named volumes
# (postgres data, redis state). Pair with docker-build.sh to fully reset the
# local stack between test runs.

unset DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH MINIKUBE_ACTIVE_DOCKERD
docker compose --profile tools --profile ocpi --profile monitoring down --remove-orphans --timeout 10
docker compose down --volumes
