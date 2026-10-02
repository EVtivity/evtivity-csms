// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { parseClientHelloCipherSuites } from '../cs-server.js';

/** A minimal TLS ClientHello record offering the given cipher suites. */
function clientHello(suites: number[]): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version
    Buffer.alloc(32), // random
    Buffer.from([0x00]), // session_id length
    Buffer.from([0x00, suites.length * 2]),
    Buffer.from(suites.flatMap((s) => [s >> 8, s & 0xff])),
    Buffer.from([0x01, 0x00]), // compression methods
  ]);
  const handshake = Buffer.concat([
    Buffer.from([0x01, 0x00, body.length >> 8, body.length & 0xff]),
    body,
  ]);
  return Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01, handshake.length >> 8, handshake.length & 0xff]),
    handshake,
  ]);
}

describe('parseClientHelloCipherSuites', () => {
  it('returns the offered cipher suites', () => {
    expect(parseClientHelloCipherSuites(clientHello([0xc02b, 0xc02c, 0x009c]))).toEqual([
      0xc02b, 0xc02c, 0x009c,
    ]);
  });

  it('returns null while the record is incomplete', () => {
    expect(parseClientHelloCipherSuites(clientHello([0xc02b]).subarray(0, 10))).toBeNull();
  });

  it('throws on data that is not a TLS handshake', () => {
    expect(() => parseClientHelloCipherSuites(Buffer.from('GET / HTTP/1.1\r\n'))).toThrow();
  });
});
