#!/usr/bin/env bash
set -euo pipefail

RELEASE="evtivity"
NAMESPACE="evtivity"
CSMS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHART_DIR="$(cd "$(dirname "$0")/../../evtivity-csms-helm" && pwd)"
IMAGE_TAG="dev"

# --- Verify prerequisites ---
if ! command -v minikube &>/dev/null; then
  echo "Error: minikube is not installed."
  exit 1
fi

if ! minikube status --format='{{.Host}}' 2>/dev/null | grep -q "Running"; then
  echo "Error: minikube is not running. Start it with 'minikube start'."
  exit 1
fi

if [ ! -d "$CHART_DIR" ]; then
  echo "Error: evtivity-csms-helm directory not found at $CHART_DIR"
  echo "Expected the helm chart and csms repos to be siblings."
  exit 1
fi

generate_secret() {
  openssl rand -base64 32 | tr -d '/+=' | cut -c1-32
}

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(generate_secret)}"
REDIS_PASSWORD="${REDIS_PASSWORD:-$(generate_secret)}"
JWT_SECRET="${JWT_SECRET:-$(generate_secret)}"
SETTINGS_ENCRYPTION_KEY="${SETTINGS_ENCRYPTION_KEY:-$(generate_secret)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(generate_secret)}"

POSTGRES_HOST="${RELEASE}-postgresql"
POSTGRES_PORT="5432"
POSTGRES_DB="evtivity"
POSTGRES_USER="evtivity"
REDIS_HOST="${RELEASE}-redis-master"
REDIS_PORT="6379"

DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
REDIS_URL="redis://default:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}"

echo "Release:   $RELEASE"
echo "Namespace: $NAMESPACE"
echo "CSMS dir:  $CSMS_DIR"
echo ""

# --- Select Gateway Implementation ---
echo "Select gateway implementation:"
echo "  1) Istio - service mesh with mTLS and authorization policies (recommended)"
echo "  2) Envoy Gateway - lightweight ingress-only routing"
echo ""
read -r -p "Choice [1]: " GATEWAY_CHOICE
GATEWAY_CHOICE="${GATEWAY_CHOICE:-1}"

case "$GATEWAY_CHOICE" in
  1)
    GATEWAY_CLASS="istio"
    ISTIO_ENABLED="true"
    ;;
  2)
    GATEWAY_CLASS="eg"
    ISTIO_ENABLED="false"
    ;;
  *)
    echo "Invalid choice. Exiting."
    exit 1
    ;;
esac

echo ""

# --- Build images inside minikube's Docker ---
echo "Switching to minikube Docker daemon..."
eval "$(minikube docker-env)"

IMAGES=(
  "api:packages/api/Dockerfile"
  "ocpp:packages/ocpp/Dockerfile"
  "ocpi:packages/ocpi/Dockerfile"
  "csms:packages/csms/Dockerfile"
  "portal:packages/portal/Dockerfile"
  "migrate:packages/database/Dockerfile"
  "css:packages/css/Dockerfile"
  "ocpi-simulator:packages/ocpi-simulator/Dockerfile"
  "worker:packages/worker/Dockerfile"
)

for entry in "${IMAGES[@]}"; do
  name="${entry%%:*}"
  dockerfile="${entry#*:}"
  echo "Building evtivity/${name}:${IMAGE_TAG}..."
  docker build -t "evtivity/${name}:${IMAGE_TAG}" \
    -f "${CSMS_DIR}/${dockerfile}" \
    "$CSMS_DIR" \
    --quiet
done

echo "All images built."
echo ""

# --- Install Gateway ---
if [ "$GATEWAY_CLASS" = "istio" ]; then
  if ! helm list -n istio-system 2>/dev/null | grep -q "istiod"; then
    echo "Installing Istio..."
    helm repo add istio https://istio-release.storage.googleapis.com/charts
    helm repo update istio

    helm install istio-base istio/base \
      --namespace istio-system \
      --create-namespace \
      --wait --timeout 5m \
      > /dev/null 2>&1

    helm install istiod istio/istiod \
      --namespace istio-system \
      --wait --timeout 5m \
      > /dev/null 2>&1

    echo "Istio ready."
  else
    echo "Istio already installed."
  fi
else
  if ! helm list -A 2>/dev/null | grep -q "eg "; then
    echo "Installing Envoy Gateway..."
    helm install eg oci://docker.io/envoyproxy/gateway-helm \
      --version v1.3.2 \
      --namespace envoy-gateway-system \
      --create-namespace \
      --wait --timeout 5m \
      > /dev/null 2>&1
    echo "Envoy Gateway ready."
  else
    echo "Envoy Gateway already installed."
  fi
fi

# --- Install PostgreSQL ---
echo "Installing PostgreSQL..."
helm repo add bitnami https://charts.bitnami.com/bitnami &>/dev/null || true
helm repo update bitnami &>/dev/null
helm upgrade --install "${RELEASE}-postgresql" bitnami/postgresql \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --wait --timeout 5m \
  --set auth.username="$POSTGRES_USER" \
  --set auth.password="$POSTGRES_PASSWORD" \
  --set auth.database="$POSTGRES_DB" \
  --set "primary.initdb.scripts.grant-schema\\.sql=GRANT CREATE ON DATABASE $POSTGRES_DB TO $POSTGRES_USER;" \
  > /dev/null 2>&1
echo "PostgreSQL ready."

# --- Install Redis ---
echo "Installing Redis..."
helm upgrade --install "${RELEASE}-redis" bitnami/redis \
  --namespace "$NAMESPACE" \
  --wait --timeout 5m \
  --set auth.enabled=true \
  --set auth.password="$REDIS_PASSWORD" \
  --set replica.replicaCount=0 \
  > /dev/null 2>&1
echo "Redis ready."

# --- Generate OCPP mTLS and CSS Client Certificates ---
OCPP_TLS_SECRET="${RELEASE}-ocpp-tls"
CSS_TLS_SECRET="${RELEASE}-css-tls"
CERT_DIR=$(mktemp -d)
trap 'rm -rf "$CERT_DIR"' EXIT

echo "Generating OCPP mTLS certificates..."

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$CERT_DIR/ca-key.pem" -out "$CERT_DIR/ca.pem" \
  -days 3650 -nodes -subj "/CN=EVtivity OCPP CA" 2>/dev/null

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$CERT_DIR/tls.key" -out "$CERT_DIR/server.csr" \
  -nodes -subj "/CN=EVtivity OCPP Server" 2>/dev/null
openssl x509 -req -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.pem" -CAkey "$CERT_DIR/ca-key.pem" -CAcreateserial \
  -out "$CERT_DIR/tls.crt" -days 3650 2>/dev/null

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$CERT_DIR/client-key.pem" -out "$CERT_DIR/client.csr" \
  -nodes -subj "/CN=css-simulator" 2>/dev/null
openssl x509 -req -in "$CERT_DIR/client.csr" \
  -CA "$CERT_DIR/ca.pem" -CAkey "$CERT_DIR/ca-key.pem" -CAcreateserial \
  -out "$CERT_DIR/client.pem" -days 3650 2>/dev/null

kubectl delete secret "$OCPP_TLS_SECRET" --namespace "$NAMESPACE" --ignore-not-found > /dev/null 2>&1
kubectl create secret generic "$OCPP_TLS_SECRET" \
  --namespace "$NAMESPACE" \
  --from-file=tls.crt="$CERT_DIR/tls.crt" \
  --from-file=tls.key="$CERT_DIR/tls.key" \
  --from-file=ca.crt="$CERT_DIR/ca.pem" \
  > /dev/null 2>&1

kubectl delete secret "$CSS_TLS_SECRET" --namespace "$NAMESPACE" --ignore-not-found > /dev/null 2>&1
kubectl create secret generic "$CSS_TLS_SECRET" \
  --namespace "$NAMESPACE" \
  --from-file=client.pem="$CERT_DIR/client.pem" \
  --from-file=client-key.pem="$CERT_DIR/client-key.pem" \
  --from-file=ca.pem="$CERT_DIR/ca.pem" \
  > /dev/null 2>&1

echo "OCPP mTLS and CSS client certificates ready."

# --- Install EVtivity CSMS ---
echo "Installing EVtivity CSMS..."
helm upgrade --install "$RELEASE" "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  --set fullnameOverride="$RELEASE" \
  --set image.registry=evtivity \
  --set image.tag="$IMAGE_TAG" \
  --set image.pullPolicy=Never \
  --set image.pullSecrets=null \
  --set gatewayAPI.gateway.gatewayClassName="$GATEWAY_CLASS" \
  --set istio.enabled="$ISTIO_ENABLED" \
  --set dependencies.postgresHost="$POSTGRES_HOST" \
  --set dependencies.postgresPort="$POSTGRES_PORT" \
  --set dependencies.redisHost="$REDIS_HOST" \
  --set dependencies.redisPort="$REDIS_PORT" \
  --set secrets.databaseUrl="$DATABASE_URL" \
  --set secrets.redisUrl="$REDIS_URL" \
  --set secrets.jwtSecret="$JWT_SECRET" \
  --set secrets.settingsEncryptionKey="$SETTINGS_ENCRYPTION_KEY" \
  --set ocpp.tls.enabled=true \
  --set ocpp.tls.certSecret="$OCPP_TLS_SECRET" \
  --set css.tls.enabled=true \
  --set css.tls.certSecret="$CSS_TLS_SECRET" \
  --set ocpi.enabled=true \
  --set ocpiSim.enabled=true \
  --set ocpiCpoSim.enabled=true \
  --set monitoring.enabled=true \
  --set initialAdmin.password="$ADMIN_PASSWORD" \
  --set api.env.cookieDomain=".evtivity.local" \
  > /dev/null 2>&1
echo "EVtivity CSMS ready."

echo ""
echo "Admin email: admin@evtivity.local"
echo "Admin password: $ADMIN_PASSWORD (must be changed on first login)"
echo ""
echo "Run 'kubectl get pods -n $NAMESPACE' to check status."
