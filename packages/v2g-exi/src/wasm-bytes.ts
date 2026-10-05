// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';

/**
 * The committed libcbv2g WebAssembly module. The production bundles
 * (scripts/build.mjs) replace this module with one that embeds the bytes, so
 * the service images need no file next to the bundle.
 */
export function getWasmBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(new URL('../wasm/v2g_exi.wasm', import.meta.url)));
}
