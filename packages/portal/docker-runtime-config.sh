#!/bin/sh
# Generate runtime-config.js from env vars at container startup so the SPA
# can discover the API URL without rebuilding the image. Runs from
# /docker-entrypoint.d/ before nginx starts.
#
# The file goes under /tmp so it works with a read-only root filesystem.
# This is only used in the CDK / ECS Fargate path. Helm replaces nginx.conf
# with a ConfigMap that returns runtime-config.js inline (URL baked at chart
# render time), so the script is dead code there. Docker Compose leaves the
# URLs empty and uses the /v1 proxy in nginx.dev.conf.
set -eu

mkdir -p /tmp/evtivity
cat > /tmp/evtivity/runtime-config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  apiUrl: "${RUNTIME_API_URL:-}"
};
EOF
