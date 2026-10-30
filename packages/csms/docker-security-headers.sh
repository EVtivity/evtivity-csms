#!/bin/sh
# Render the security headers at container startup, adding the object storage
# origins in STORAGE_IMG_SRC to the CSP img-src so images stored with an
# S3-compatible provider show. Runs from /docker-entrypoint.d/ before nginx
# starts and writes under /tmp, which stays writable when the root filesystem
# is read-only. Helm renders its own headers in the nginx ConfigMap.
#
# STORAGE_IMG_SRC: space-separated origins (scheme, host name or IPv4 address,
# optional port, optional *. wildcard), for example
# "https://s3.example.com https://*.example.net http://minio.local:9000".
# Anything else (a path, a quote, a semicolon) stops the container, so the
# variable cannot change the rest of the policy.
set -eu
# A wildcard origin must not expand to file names.
set -f

template="${1:-/etc/nginx/evtivity-security-headers.conf.template}"
out="${2:-/tmp/evtivity/security-headers.conf}"

origins=''
for origin in ${STORAGE_IMG_SRC:-}; do
  if ! printf '%s\n' "$origin" |
    grep -Eq '^https?://(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'; then
    echo "STORAGE_IMG_SRC: invalid origin '$origin' (expected scheme://host[:port])" >&2
    exit 1
  fi
  origins="$origins $origin"
done

mkdir -p "$(dirname "$out")"
sed "/Content-Security-Policy/s| __STORAGE_IMG_SRC__|$origins|" "$template" > "$out"
