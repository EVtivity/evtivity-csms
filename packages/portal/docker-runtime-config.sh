#!/bin/sh
# Generate runtime-config.js from env vars at container startup so the SPA
# can discover the API URL without rebuilding the image. Runs from
# /docker-entrypoint.d/ before nginx starts.
#
# This is only used in the CDK / ECS Fargate path. Helm replaces nginx.conf
# with a ConfigMap that returns runtime-config.js inline (URL baked at chart
# render time), so the script is dead code there. Docker Compose builds from
# packages/portal/Dockerfile.dev and never copies this script in.
set -eu

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  apiUrl: "${RUNTIME_API_URL:-}"
};
EOF
