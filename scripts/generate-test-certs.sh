#!/usr/bin/env bash
set -euo pipefail

# Generates self-signed test certificates for OCPP TLS and SP3 mTLS.
# Output: packages/css/test-certs/{ca,server,client}.{pem,key.pem}
#
# Safe to run multiple times. Skips generation if certs already exist.

CERT_DIR="${1:-packages/css/test-certs}"

if [ -f "$CERT_DIR/ca.pem" ] && [ -f "$CERT_DIR/server.pem" ] && [ -f "$CERT_DIR/client.pem" ]; then
  echo "Test certs already exist in $CERT_DIR, skipping."
  exit 0
fi

mkdir -p "$CERT_DIR"

echo "Generating test CA..."
openssl ecparam -genkey -name prime256v1 -noout -out "$CERT_DIR/ca-key.pem" 2>/dev/null
openssl req -new -x509 -key "$CERT_DIR/ca-key.pem" -out "$CERT_DIR/ca.pem" \
  -days 3650 -subj "/CN=EVtivity Test CA" 2>/dev/null

echo "Generating test server certificate..."
openssl ecparam -genkey -name prime256v1 -noout -out "$CERT_DIR/server-key.pem" 2>/dev/null
openssl req -new -key "$CERT_DIR/server-key.pem" -out /tmp/server.csr \
  -subj "/CN=localhost" 2>/dev/null
openssl x509 -req -in /tmp/server.csr -CA "$CERT_DIR/ca.pem" -CAkey "$CERT_DIR/ca-key.pem" \
  -CAcreateserial -out "$CERT_DIR/server.pem" -days 3650 \
  -extfile <(echo "subjectAltName=DNS:localhost,DNS:ocpp,IP:127.0.0.1") 2>/dev/null
rm -f /tmp/server.csr

echo "Generating test client certificate..."
openssl ecparam -genkey -name prime256v1 -noout -out "$CERT_DIR/client-key.pem" 2>/dev/null
openssl req -new -key "$CERT_DIR/client-key.pem" -out /tmp/client.csr \
  -subj "/CN=EVtivity Test Client" 2>/dev/null
openssl x509 -req -in /tmp/client.csr -CA "$CERT_DIR/ca.pem" -CAkey "$CERT_DIR/ca-key.pem" \
  -CAcreateserial -out "$CERT_DIR/client.pem" -days 3650 2>/dev/null
rm -f /tmp/client.csr "$CERT_DIR/ca.srl"

echo "Test certs generated in $CERT_DIR"
