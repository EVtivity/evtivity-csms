#!/bin/sh
# Starts Redis with one ACL user per EVtivity service (Docker Compose).
#
# Reads the users from acl-rules.conf next to this script, takes each password
# from REDIS_<USER>_PASSWORD (for example REDIS_API_PASSWORD), stores it as a
# SHA-256 hash, and starts redis-server through the image's entrypoint (which
# drops to the redis user). Extra arguments are passed to redis-server. Fails
# when a password is missing.
#
# The default user is off, so no container on the Compose network reaches
# Redis without a password. Host tooling (`npm run dev:*`, the integration
# tests, redis-cli) signs in as the dev-only `admin` user (all keys, channels
# and commands) with REDIS_ADMIN_PASSWORD. The admin user exists only here,
# never in acl-rules.conf: the Helm chart and the CDK app have none. Compose
# publishes the port on 127.0.0.1 only.
#
# `start.sh --reload` (run in the running container with docker compose exec)
# rewrites the ACL file from the current rules and loads it with ACL LOAD, so
# an upgrade applies new rules without restarting Redis. Redis keeps its
# current users when the new file does not load.
set -eu

dir=$(dirname "$0")
rules="$dir/acl-rules.conf"
acl=/tmp/users.acl
reload=false
if [ "${1:-}" = "--reload" ]; then
  reload=true
  shift
fi

umask 077
out="$acl"
[ "$reload" = true ] && out="$acl.new"
: > "$out"
echo 'user default off' >> "$out"
admin_password=$(printenv REDIS_ADMIN_PASSWORD || true)
if [ -z "$admin_password" ]; then
  echo "start.sh: REDIS_ADMIN_PASSWORD is not set" >&2
  exit 1
fi
admin_hash=$(printf '%s' "$admin_password" | sha256sum | cut -d ' ' -f 1)
echo "user admin on #$admin_hash ~* &* +@all" >> "$out"

while read -r keyword name rest; do
  case "$keyword" in
    '' | '#'*) continue ;;
    user) ;;
    *) echo "start.sh: unexpected line in $rules: $keyword $name" >&2; exit 1 ;;
  esac
  var="REDIS_$(echo "$name" | tr '[:lower:]' '[:upper:]')_PASSWORD"
  password=$(printenv "$var" || true)
  if [ -z "$password" ]; then
    echo "start.sh: $var is not set" >&2
    exit 1
  fi
  hash=$(printf '%s' "$password" | sha256sum | cut -d ' ' -f 1)
  echo "user $name on #$hash $rest" >> "$out"
done < "$rules"

chown redis:redis "$out"
if [ "$reload" = true ]; then
  mv "$out" "$acl"
  # A Redis started by a start.sh older than the admin user still runs with the
  # open default user and no admin: redis-cli reports the failed AUTH and runs
  # ACL LOAD as that default user, which loads the new users. Every later
  # reload signs in as admin. The last line is the ACL LOAD reply.
  result=$(redis-cli --user admin --pass "$admin_password" --no-auth-warning ACL LOAD 2>&1 | tail -n 1 || true)
  if [ "$result" != "OK" ]; then
    echo "start.sh: ACL LOAD failed: $result" >&2
    exit 1
  fi
  echo "Redis ACL reloaded from $rules"
  exit 0
fi
# Extra arguments go to redis-server (for example TLS options in tests).
exec docker-entrypoint.sh redis-server --aclfile "$acl" "$@"
