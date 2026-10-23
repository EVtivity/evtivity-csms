#!/usr/bin/env bash
# Sourced by scripts/docker-build.sh (tests: scripts/docker-build.test.sh).
#
# ensure_compose_secrets <env file> <database volume exists: yes|no>
#
# docker-compose.yml has no defaults for JWT_SECRET and SETTINGS_ENCRYPTION_KEY,
# so this writes them into the env file:
# - JWT_SECRET: a new random value when it is missing, shorter than 32
#   characters or a published example value. Everyone signs in again.
# - SETTINGS_ENCRYPTION_KEY: a new random value when it is missing or a
#   published example value, except when the database volume already exists:
#   the stored credentials are encrypted with the earlier built-in key, which a
#   new key cannot decrypt. Then it writes or keeps that built-in value and
#   prints a warning.
# - REDIS_ADMIN_PASSWORD: a new random value when it is missing or the Compose
#   default. A REDIS_URL that still names the default user or the old admin
#   password is pointed at the admin user with it (npm run dev:* on the host).
# - REDIS_API_PASSWORD, REDIS_OCPP_PASSWORD, REDIS_OCPI_PASSWORD,
#   REDIS_WORKER_PASSWORD, REDIS_CSS_PASSWORD: a new random value when missing
#   or the published `<user>-dev-password` Compose default, so a compromised
#   container on the Compose network cannot sign in as another service
#   Redis loads them when its container is recreated.
#
# Values are 64 hexadecimal characters from `openssl rand -hex 32`.

COMPOSE_BUILTIN_SETTINGS_KEY='dev-encryption-key-32chars-long!'
COMPOSE_KNOWN_JWT_SECRETS=('dev-secret-change-in-production' 'dev-jwt-secret-change-in-production!!')
COMPOSE_DEFAULT_REDIS_ADMIN_PASSWORD='admin-dev-password'

# Prints the value of KEY in the env file (the last assignment wins), or nothing.
env_file_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  awk -v k="$key" '
    index($0, k "=") == 1 { v = substr($0, length(k) + 2) }
    END { if (v != "") print v }
  ' "$file"
}

# Sets KEY=VALUE in the env file: replaces every assignment of KEY, or appends one.
env_file_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  if [ -f "$file" ] && grep -q "^$key=" "$file"; then
    awk -v k="$key" -v v="$value" '
      index($0, k "=") == 1 { print k "=" v; next }
      { print }
    ' "$file" > "$tmp"
  else
    { [ -f "$file" ] && cat "$file"; printf '%s=%s\n' "$key" "$value"; } > "$tmp"
  fi
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

compose_random_secret() {
  openssl rand -hex 32
}

ensure_compose_secrets() {
  local file="$1" volume_exists="$2" jwt key admin redis_url known=no k
  jwt="$(env_file_value "$file" JWT_SECRET)"
  for k in "${COMPOSE_KNOWN_JWT_SECRETS[@]}"; do [ "$jwt" = "$k" ] && known=yes; done
  if [ -z "$jwt" ] || [ "${#jwt}" -lt 32 ] || [ "$known" = yes ]; then
    env_file_set "$file" JWT_SECRET "$(compose_random_secret)"
    echo "Generated JWT_SECRET in $file (everyone signs in again)."
  fi

  key="$(env_file_value "$file" SETTINGS_ENCRYPTION_KEY)"
  if [ "$volume_exists" = yes ]; then
    if [ -z "$key" ]; then
      env_file_set "$file" SETTINGS_ENCRYPTION_KEY "$COMPOSE_BUILTIN_SETTINGS_KEY"
      key="$COMPOSE_BUILTIN_SETTINGS_KEY"
    fi
    if [ "$key" = "$COMPOSE_BUILTIN_SETTINGS_KEY" ]; then
      echo "Warning: SETTINGS_ENCRYPTION_KEY is the published built-in value, kept because the" >&2
      echo "  database volume already exists and its stored credentials are encrypted with it." >&2
      echo "  Anyone with a database copy can decrypt them. To change it, wipe the data" >&2
      echo "  (answer y to the restart question) and enter the credentials again." >&2
    fi
  elif [ -z "$key" ] || [ "$key" = "$COMPOSE_BUILTIN_SETTINGS_KEY" ]; then
    env_file_set "$file" SETTINGS_ENCRYPTION_KEY "$(compose_random_secret)"
    echo "Generated SETTINGS_ENCRYPTION_KEY in $file."
  fi

  admin="$(env_file_value "$file" REDIS_ADMIN_PASSWORD)"
  if [ -z "$admin" ] || [ "$admin" = "$COMPOSE_DEFAULT_REDIS_ADMIN_PASSWORD" ]; then
    admin="$(compose_random_secret)"
    env_file_set "$file" REDIS_ADMIN_PASSWORD "$admin"
    echo "Generated REDIS_ADMIN_PASSWORD in $file."
  fi
  local user name value
  for user in api ocpp ocpi worker css; do
    name="REDIS_$(printf '%s' "$user" | tr '[:lower:]' '[:upper:]')_PASSWORD"
    value="$(env_file_value "$file" "$name")"
    if [ -z "$value" ] || [ "$value" = "$user-dev-password" ]; then
      env_file_set "$file" "$name" "$(compose_random_secret)"
      echo "Generated $name in $file."
    fi
  done

  redis_url="$(env_file_value "$file" REDIS_URL)"
  case "$redis_url" in
    '' | redis://localhost:6379 | redis://127.0.0.1:6379 | "redis://admin:$COMPOSE_DEFAULT_REDIS_ADMIN_PASSWORD@localhost:6379")
      env_file_set "$file" REDIS_URL "redis://admin:$admin@localhost:6379"
      ;;
  esac
}
