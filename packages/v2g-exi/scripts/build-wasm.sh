#!/usr/bin/env bash
# Copyright (c) 2024-2026 EVtivity. All rights reserved.
# SPDX-License-Identifier: BUSL-1.1
#
# Builds wasm/v2g_exi.wasm from the pinned EVerest libcbv2g release and
# c/glue.c with the pinned Emscripten image. The build is reproducible: the
# same inputs give the same bytes, which wasm/v2g_exi.wasm.sha256 records.
#
# Usage (from the repo root or anywhere):
#   bash packages/v2g-exi/scripts/build-wasm.sh            # rebuild and update the committed files
#   bash packages/v2g-exi/scripts/build-wasm.sh --check    # rebuild and fail when the hash differs
#
# Needs curl, tar, and Docker. npm ci and the service images never run this:
# they use the committed wasm/v2g_exi.wasm.

set -euo pipefail

LIBCBV2G_TAG="v0.3.2"
LIBCBV2G_SHA256="ea6c07bc0584711e12a8c234b9bfa5eda1538672688832babe1347a54b831c93"
EMSDK_IMAGE="emscripten/emsdk:6.0.11@sha256:cdefec943f04fd4b2b2fe23b0a1a346be9fc560ef5784a83faa27dd351381372"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="$PKG_DIR/wasm/v2g_exi.wasm"
HASH_FILE="$PKG_DIR/wasm/v2g_exi.wasm.sha256"

MODE="write"
if [ "${1:-}" = "--check" ]; then MODE="check"; fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL -o "$WORK/libcbv2g.tar.gz" \
  "https://github.com/EVerest/libcbv2g/archive/refs/tags/${LIBCBV2G_TAG}.tar.gz"
ACTUAL="$(sha256 "$WORK/libcbv2g.tar.gz")"
if [ "$ACTUAL" != "$LIBCBV2G_SHA256" ]; then
  echo "libcbv2g ${LIBCBV2G_TAG} checksum mismatch: $ACTUAL" >&2
  exit 1
fi
tar -xzf "$WORK/libcbv2g.tar.gz" -C "$WORK"
mv "$WORK/libcbv2g-${LIBCBV2G_TAG#v}" "$WORK/libcbv2g"
cp "$PKG_DIR/c/glue.c" "$WORK/glue.c"

# The ISO 15118-20 CommonMessages encoder is compiled through glue.c (it
# includes the file to reach a static encoder), so it is not listed here.
SOURCES=(
  libcbv2g/lib/cbv2g/common/exi_basetypes.c
  libcbv2g/lib/cbv2g/common/exi_basetypes_decoder.c
  libcbv2g/lib/cbv2g/common/exi_basetypes_encoder.c
  libcbv2g/lib/cbv2g/common/exi_bitstream.c
  libcbv2g/lib/cbv2g/common/exi_header.c
  libcbv2g/lib/cbv2g/common/exi_types_decoder.c
  libcbv2g/lib/cbv2g/iso_2/iso2_msgDefDatatypes.c
  libcbv2g/lib/cbv2g/iso_2/iso2_msgDefDecoder.c
  libcbv2g/lib/cbv2g/iso_2/iso2_msgDefEncoder.c
  libcbv2g/lib/cbv2g/iso_20/iso20_CommonMessages_Datatypes.c
  libcbv2g/lib/cbv2g/iso_20/iso20_CommonMessages_Decoder.c
  glue.c
)

# Runs as root (the image keeps its prebuilt system libraries in a root-owned
# cache), then hands the work directory back to the calling user.
docker run --rm -v "$WORK:/src" -w /src "$EMSDK_IMAGE" sh -c "
  emcc -O2 -g0 -std=gnu11 \
    -ffile-prefix-map=/src/= \
    -I/src/libcbv2g/include -I/src/libcbv2g \
    -sSTANDALONE_WASM --no-entry \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4MB -sSTACK_SIZE=1MB \
    -sFILESYSTEM=0 \
    ${SOURCES[*]} -o /src/v2g_exi.wasm &&
  chown -R $(id -u):$(id -g) /src
"

BUILT_HASH="$(sha256 "$WORK/v2g_exi.wasm")"
if [ "$MODE" = "check" ]; then
  EXPECTED="$(cut -d' ' -f1 "$HASH_FILE")"
  COMMITTED="$(sha256 "$WASM")"
  if [ "$BUILT_HASH" != "$EXPECTED" ] || [ "$COMMITTED" != "$EXPECTED" ]; then
    echo "v2g_exi.wasm is not reproducible: built $BUILT_HASH, recorded $EXPECTED, committed $COMMITTED" >&2
    exit 1
  fi
  echo "v2g_exi.wasm reproduced: $BUILT_HASH"
else
  cp "$WORK/v2g_exi.wasm" "$WASM"
  echo "$BUILT_HASH  v2g_exi.wasm" > "$HASH_FILE"
  echo "wrote $WASM ($BUILT_HASH)"
fi
