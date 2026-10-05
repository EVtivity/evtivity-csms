#!/bin/sh
# Container entrypoint for the Node service images.
#
# When DATABASE_URL or REDIS_URL is not set but the individual connection fields are,
# build the URL from them before starting the service. Orchestrators that rotate
# credentials (ECS injecting Secrets Manager JSON fields) supply the fields; Docker
# Compose and Helm keep passing full URLs and are unaffected. Values are URL-encoded.
#
#   DB_HOST, DB_PORT (5432), DB_NAME (evtivity), DB_USER, DB_PASSWORD, DB_SSLMODE (optional)
#   REDIS_HOST, REDIS_PORT (6379), REDIS_USER (optional), REDIS_PASSWORD (optional),
#   REDIS_TLS (true|false, default false)
# A rediss:// URL with a private CA also needs REDIS_TLS_CA_PEM or REDIS_TLS_CA_FILE,
# read by the Redis client factory in @evtivity/lib (redis-client.ts).
set -eu

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  DATABASE_URL=$(node -e '
    const e = process.env;
    const auth = `${encodeURIComponent(e.DB_USER ?? "")}:${encodeURIComponent(e.DB_PASSWORD ?? "")}`;
    const query = e.DB_SSLMODE ? `?sslmode=${encodeURIComponent(e.DB_SSLMODE)}` : "";
    process.stdout.write(`postgres://${auth}@${e.DB_HOST}:${e.DB_PORT || "5432"}/${encodeURIComponent(e.DB_NAME || "evtivity")}${query}`);
  ')
  export DATABASE_URL
fi

if [ -z "${REDIS_URL:-}" ] && [ -n "${REDIS_HOST:-}" ]; then
  REDIS_URL=$(node -e '
    const e = process.env;
    const scheme = e.REDIS_TLS === "true" ? "rediss" : "redis";
    const user = encodeURIComponent(e.REDIS_USER ?? "");
    const auth = e.REDIS_PASSWORD ? `${user}:${encodeURIComponent(e.REDIS_PASSWORD)}@` : "";
    process.stdout.write(`${scheme}://${auth}${e.REDIS_HOST}:${e.REDIS_PORT || "6379"}`);
  ')
  export REDIS_URL
fi

exec "$@"
