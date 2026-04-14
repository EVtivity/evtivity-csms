#!/usr/bin/env bash
set -euo pipefail

RELEASE="evtivity"
NAMESPACE="evtivity"
IMAGE_TAG="dev"

read -rp "Uninstall '$RELEASE' (including PostgreSQL and Redis) from namespace '$NAMESPACE'? (y/n) " confirm

if [ "$confirm" != "y" ]; then
  echo "Aborted."
  exit 1
fi

helm uninstall "$RELEASE" --namespace "$NAMESPACE" 2>/dev/null || echo "Release '$RELEASE' not found, skipping."
helm uninstall "${RELEASE}-postgresql" --namespace "$NAMESPACE" 2>/dev/null || echo "Release '${RELEASE}-postgresql' not found, skipping."
helm uninstall "${RELEASE}-redis" --namespace "$NAMESPACE" 2>/dev/null || echo "Release '${RELEASE}-redis' not found, skipping."

kubectl delete jobs --all -n "$NAMESPACE" 2>/dev/null || true
kubectl delete secret "${RELEASE}-ocpp-tls" -n "$NAMESPACE" 2>/dev/null || true
kubectl delete secret "${RELEASE}-css-tls" -n "$NAMESPACE" 2>/dev/null || true
kubectl delete pvc --all -n "$NAMESPACE" 2>/dev/null || true

echo ""
echo "Uninstalled all releases and deleted all PVCs from $NAMESPACE."

read -rp "Remove dev images from minikube? (y/n) " remove_images

if [ "$remove_images" = "y" ]; then
  eval "$(minikube docker-env)"
  for name in api ocpp ocpi csms portal migrate css ocpi-simulator worker; do
    docker rmi "evtivity/${name}:${IMAGE_TAG}" 2>/dev/null || true
  done
  echo "Removed dev images."
fi

read -rp "Delete namespace '$NAMESPACE'? (y/n) " delete_ns

if [ "$delete_ns" = "y" ]; then
  kubectl delete namespace "$NAMESPACE" 2>/dev/null || echo "Namespace not found."
  echo "Deleted namespace $NAMESPACE."
fi
