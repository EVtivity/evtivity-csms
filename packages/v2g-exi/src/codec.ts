// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getWasmBytes } from './wasm-bytes.js';

/** EXI schema of an ISO 15118 message: 2 (ISO 15118-2) or 20 (ISO 15118-20). */
export type Iso15118Schema = 2 | 20;

interface GlueExports {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  v2g_malloc: (size: number) => number;
  v2g_free: (ptr: number) => void;
  v2g_result_ptr: () => number;
  v2g_decode: (schema: number, ptr: number, len: number) => number;
  v2g_encode: (schema: number, ptr: number, len: number) => number;
}

const GLUE_ERRORS: Record<number, string> = {
  [-1001]: 'out of memory',
  [-1002]: 'malformed encode record',
  [-1003]: 'unsupported message',
  [-1004]: 'unsupported schema',
  [-1005]: 'result too large',
  [-1]: 'bitstream overflow',
  [-22]: 'incorrect EXI header',
  [-50]: 'unknown event for decoding',
  [-70]: 'unknown event for encoding',
  [-110]: 'array out of bounds',
  [-111]: 'character buffer too small',
  [-112]: 'byte buffer too small',
  [-150]: 'unknown event code',
};

/** An EXI decode or encode failure, with the libcbv2g or glue error code. */
export class ExiCodecError extends Error {
  constructor(
    readonly code: number,
    operation: 'decode' | 'encode',
  ) {
    super(`EXI ${operation} failed: ${GLUE_ERRORS[code] ?? 'error'} (${String(code)})`);
    this.name = 'ExiCodecError';
  }
}

let instance: GlueExports | null = null;

function glue(): GlueExports {
  if (instance != null) return instance;
  const module = new WebAssembly.Module(getWasmBytes());
  const created = new WebAssembly.Instance(module, {
    // Standalone Emscripten output imports this hook only; memory growth
    // needs no action because every read builds a fresh view.
    env: { emscripten_notify_memory_growth: () => undefined },
  });
  const exports = created.exports as unknown as GlueExports;
  exports._initialize();
  instance = exports;
  return exports;
}

function call(
  fn: 'v2g_decode' | 'v2g_encode',
  schema: Iso15118Schema,
  input: Uint8Array,
): Record<string, unknown> {
  const g = glue();
  const ptr = g.v2g_malloc(Math.max(input.length, 1));
  if (ptr === 0) throw new ExiCodecError(-1001, fn === 'v2g_decode' ? 'decode' : 'encode');
  try {
    new Uint8Array(g.memory.buffer, ptr, input.length).set(input);
    const len = g[fn](schema, ptr, input.length);
    if (len < 0) throw new ExiCodecError(len, fn === 'v2g_decode' ? 'decode' : 'encode');
    const json = new TextDecoder().decode(new Uint8Array(g.memory.buffer, g.v2g_result_ptr(), len));
    return JSON.parse(json) as Record<string, unknown>;
  } finally {
    g.v2g_free(ptr);
  }
}

/** Decodes an EXI document to the glue's JSON shape. */
export function decodeRaw(schema: Iso15118Schema, exi: Uint8Array): Record<string, unknown> {
  return call('v2g_decode', schema, exi);
}

/** Encodes a tag-length-value record (see c/glue.c) to the glue's JSON shape. */
export function encodeRaw(schema: Iso15118Schema, record: Uint8Array): Record<string, unknown> {
  return call('v2g_encode', schema, record);
}

/** Record tags of c/glue.c. */
export const Tag = {
  MSG_TYPE: 1,
  SESSION_ID: 2,
  TIMESTAMP: 3,
  SIG_REF_URI: 10,
  SIG_REF_DIGEST: 11,
  SIG_METHOD: 12,
  SIG_DIGEST_METHOD: 13,
  SIG_VALUE: 14,
  BODY_ID: 20,
  OEM_CERT: 21,
  OEM_SUBCERT: 22,
  OEM_CHAIN_ID: 23,
  ROOT_ISSUER: 24,
  ROOT_SERIAL: 25,
  MAX_CHAINS: 26,
  PRIORITIZED_EMAID: 27,
  RESPONSE_CODE: 30,
  SA_CERT: 31,
  SA_SUBCERT: 32,
  CONTRACT_CHAIN_ID: 33,
  CONTRACT_CERT: 34,
  CONTRACT_SUBCERT: 35,
  ENC_KEY_ID: 36,
  ENC_KEY: 37,
  DH_ID: 38,
  DH_KEY: 39,
  EMAID_ID: 40,
  EMAID: 41,
  RETRY_COUNTER: 42,
  SIGNED_DATA_ID: 43,
  ECDH_CURVE: 44,
  REMAINING: 45,
  EVSE_PROCESSING: 46,
  ENC_KEY_KIND: 47,
} as const;

/** Builds the tag-length-value record c/glue.c reads. */
export class RecordWriter {
  private readonly parts: Uint8Array[] = [];

  bytes(tag: number, value: Uint8Array): this {
    const header = new Uint8Array(5);
    header[0] = tag;
    new DataView(header.buffer).setUint32(1, value.length);
    this.parts.push(header, value);
    return this;
  }

  string(tag: number, value: string): this {
    return this.bytes(tag, new TextEncoder().encode(value));
  }

  u32(tag: number, value: number): this {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value >>> 0);
    return this.bytes(tag, buf);
  }

  u64(tag: number, value: bigint): this {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, value);
    return this.bytes(tag, buf);
  }

  toBytes(): Uint8Array {
    const total = this.parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}
