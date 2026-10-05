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
set -eu

dir=$(dirname "$0")
rules="$dir/acl-rules.conf"
acl=/tmp/users.acl

umask 077
: > "$acl"
echo 'user default on nopass ~* &* +@all' >> "$acl"

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
  echo "user $name on #$hash $rest" >> "$acl"
done < "$rules"

chown redis:redis "$acl"
# Extra arguments go to redis-server (for example TLS options in tests).
exec docker-entrypoint.sh redis-server --aclfile "$acl" "$@"
