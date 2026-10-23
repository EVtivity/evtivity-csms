// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The simulator downloads an operator firmware URL from the platform network,
// so it refuses cloud metadata and other unroutable addresses before any
// request, and caps the image size.

import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { call, makeHarness, silenceConsole } from './sim-harness.js';
import { SIMULATOR_FIRMWARE_MAX_BYTES } from '../station-simulator.js';

let server: Server | null = null;

beforeEach(() => {
  silenceConsole();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (server != null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

async function serve(bytes: number): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(bytes) });
    res.end(Buffer.alloc(bytes));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/fw.bin`;
}

describe('simulator firmware download', () => {
  it('refuses the cloud metadata address without a request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const image = await call(h, 'downloadFirmware16', 'http://169.254.169.254/latest/x', 0, 0);
    expect(image).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('downloads from a private test server and refuses an image over the cap', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const small = await call(h, 'downloadFirmware16', await serve(16), 0, 0);
    expect((small as Buffer).length).toBe(16);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    const large = await call(
      h,
      'downloadFirmware16',
      await serve(SIMULATOR_FIRMWARE_MAX_BYTES + 1),
      0,
      0,
    );
    expect(large).toBeNull();
  });
});
