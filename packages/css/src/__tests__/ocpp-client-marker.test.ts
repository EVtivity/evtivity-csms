// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { WebSocketServer } from 'ws';
import { SIMULATOR_CONNECTION_HEADER, SIMULATOR_CONNECTION_HEADER_VALUE } from '@evtivity/lib';
import { OcppClient } from '../ocpp-client.js';

let server: WebSocketServer | null = null;
let client: OcppClient | null = null;

afterEach(async () => {
  client?.disconnect();
  client = null;
  await new Promise<void>((resolve) => {
    if (server == null) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
  server = null;
});

async function connectAndCaptureHeaders(securityProfile: number): Promise<IncomingHttpHeaders> {
  const wss = new WebSocketServer({ port: 0, handleProtocols: () => 'ocpp2.1' });
  server = wss;
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const { port } = wss.address() as AddressInfo;
  const captured = new Promise<IncomingHttpHeaders>((resolve) => {
    wss.once('connection', (_ws, req) => {
      resolve(req.headers);
    });
  });
  client = new OcppClient({
    serverUrl: `ws://127.0.0.1:${String(port)}`,
    stationId: 'MARKER-01',
    ocppProtocol: 'ocpp2.1',
    securityProfile,
    password: 'abcdefghij0123456789',
  });
  await client.connect();
  return captured;
}

describe('OcppClient simulator marker', () => {
  it('sends the simulator marker header without credentials on profile 0', async () => {
    const headers = await connectAndCaptureHeaders(0);
    expect(headers[SIMULATOR_CONNECTION_HEADER]).toBe(SIMULATOR_CONNECTION_HEADER_VALUE);
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends the simulator marker header next to Basic auth on profile 1', async () => {
    const headers = await connectAndCaptureHeaders(1);
    expect(headers[SIMULATOR_CONNECTION_HEADER]).toBe(SIMULATOR_CONNECTION_HEADER_VALUE);
    expect(headers['authorization']).toBe(
      'Basic ' + Buffer.from('MARKER-01:abcdefghij0123456789').toString('base64'),
    );
  });
});
