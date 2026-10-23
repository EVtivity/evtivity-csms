#!/usr/bin/env bash
# Tests for scripts/lib/compose-secrets.sh, the secrets step of scripts/docker-build.sh.
# Runs in a throwaway directory. Usage: bash scripts/docker-build.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/compose-secrets.sh
source "$SCRIPT_DIR/lib/compose-secrets.sh"

failures=0
passes=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    passes=$((passes + 1))
  else
    failures=$((failures + 1))
    echo "FAIL: $name: expected '$expected', got '$actual'"
  fi
}

is_random() {
  if [[ "$1" =~ ^[0-9a-f]{64}$ ]]; then echo yes; else echo no; fi
}

# A new stack without an env file gets random values for every secret.
env="$work/new.env"
ensure_compose_secrets "$env" no > /dev/null 2>&1
check "new JWT_SECRET" yes "$(is_random "$(env_file_value "$env" JWT_SECRET)")"
check "new SETTINGS_ENCRYPTION_KEY" yes "$(is_random "$(env_file_value "$env" SETTINGS_ENCRYPTION_KEY)")"
check "new REDIS_ADMIN_PASSWORD" yes "$(is_random "$(env_file_value "$env" REDIS_ADMIN_PASSWORD)")"
check "new REDIS_URL uses the admin user" \
  "redis://admin:$(env_file_value "$env" REDIS_ADMIN_PASSWORD)@localhost:6379" \
  "$(env_file_value "$env" REDIS_URL)"
first="$(env_file_value "$env" JWT_SECRET)"
ensure_compose_secrets "$env" no > /dev/null 2>&1
check "a second run keeps the generated JWT_SECRET" "$first" "$(env_file_value "$env" JWT_SECRET)"
check "one JWT_SECRET line" 1 "$(grep -c '^JWT_SECRET=' "$env")"

# The published example values of .env.example are replaced on a new stack.
env="$work/example.env"
printf '%s\n' 'API_PORT=7102' 'JWT_SECRET=dev-jwt-secret-change-in-production!!' \
  'SETTINGS_ENCRYPTION_KEY=dev-encryption-key-32chars-long!' 'REDIS_URL=redis://localhost:6379' \
  > "$env"
ensure_compose_secrets "$env" no > /dev/null 2>&1
check "example JWT_SECRET replaced" yes "$(is_random "$(env_file_value "$env" JWT_SECRET)")"
check "example key replaced" yes "$(is_random "$(env_file_value "$env" SETTINGS_ENCRYPTION_KEY)")"
check "other lines kept" 7102 "$(env_file_value "$env" API_PORT)"

# An existing database volume keeps (or gets) the earlier built-in settings key, with a warning.
env="$work/existing.env"
printf '%s\n' 'JWT_SECRET=dev-jwt-secret-change-in-production!!' > "$env"
warning="$(ensure_compose_secrets "$env" yes 2>&1 > /dev/null)"
check "existing volume gets the built-in key" 'dev-encryption-key-32chars-long!' \
  "$(env_file_value "$env" SETTINGS_ENCRYPTION_KEY)"
warned=no
[[ "$warning" == *Warning:* ]] && warned=yes
check "existing volume warns" yes "$warned"
check "existing volume still gets a new JWT_SECRET" yes "$(is_random "$(env_file_value "$env" JWT_SECRET)")"

# Every service Redis password is generated, and the published defaults are replaced.
env="$work/redis.env"
printf '%s\n' 'REDIS_API_PASSWORD=api-dev-password' 'REDIS_CSS_PASSWORD=own-css-password' > "$env"
ensure_compose_secrets "$env" no > /dev/null 2>&1
for name in REDIS_API_PASSWORD REDIS_OCPP_PASSWORD REDIS_OCPI_PASSWORD REDIS_WORKER_PASSWORD; do
  check "generates the service Redis password $name" yes "$(is_random "$(env_file_value "$env" "$name")")"
done
check "keeps an own service Redis password" own-css-password "$(env_file_value "$env" REDIS_CSS_PASSWORD)"
api_pw="$(env_file_value "$env" REDIS_API_PASSWORD)"
ensure_compose_secrets "$env" no > /dev/null 2>&1
check "a second run keeps the service Redis password" "$api_pw" "$(env_file_value "$env" REDIS_API_PASSWORD)"

# An existing volume with an own key keeps it, silently.
env="$work/own.env"
own="$(openssl rand -hex 32)"
printf '%s\n' "SETTINGS_ENCRYPTION_KEY=$own" > "$env"
warning="$(ensure_compose_secrets "$env" yes 2>&1 > /dev/null)"
check "own key kept" "$own" "$(env_file_value "$env" SETTINGS_ENCRYPTION_KEY)"
check "own key no warning" "" "$warning"

echo "docker-build secrets: $passes passed, $failures failed"
[ "$failures" -eq 0 ]
