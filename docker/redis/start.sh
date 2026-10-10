#!/bin/sh
# Starts Redis with one ACL user per EVtivity service (Docker Compose).
#
# Reads the users from acl-rules.conf next to this script, takes each password
# from REDIS_<USER>_PASSWORD (for example REDIS_API_PASSWORD), stores it as a
# SHA-256 hash, and starts redis-server through the image's entrypoint (which
# drops to the redis user). Extra arguments are passed to redis-server. Fails
# when a password is missing.
#
# The default user stays open (nopass) for host tooling: `npm run dev:*`, the
# integration tests and redis-cli. Compose publishes the port on 127.0.0.1 only.
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
echo 'user default on nopass ~* &* +@all' >> "$out"

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
  result=$(redis-cli ACL LOAD 2>&1 || true)
  if [ "$result" != "OK" ]; then
    echo "start.sh: ACL LOAD failed: $result" >&2
    exit 1
  fi
  echo "Redis ACL reloaded from $rules"
  exit 0
fi
# Extra arguments go to redis-server (for example TLS options in tests).
exec docker-entrypoint.sh redis-server --aclfile "$acl" "$@"
