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
import { logger } from '../lib/logger.js';
import { config as cssConfig } from '../lib/config.js';

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
  it('never logs the password of a firmware URL', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const image = await call(
      h,
      'downloadFirmware16',
      'ftp://fw:s3cret-pass@169.254.169.254/fw.bin',
      0,
      0,
    );
    expect(image).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cret-pass');
    expect(JSON.stringify(warn.mock.calls)).toContain('169.254.169.254');
  });

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

// Outside development and test (Helm, CDK) a station reaches a loopback firmware server only
// when its owner named the host in code (extraAllowedFileTransferHosts, the OCTT CS runner).
describe('simulator firmware download in production', () => {
  let nodeEnv: string | undefined;
  beforeEach(() => {
    nodeEnv = cssConfig.NODE_ENV;
    cssConfig.NODE_ENV = 'production';
  });
  afterEach(() => {
    cssConfig.NODE_ENV = nodeEnv;
  });

  it('downloads from 127.0.0.1 only for a station whose owner allowed that host and port', async () => {
    const url = await serve(16);
    const hostPort = new URL(url).host;
    const allowed = await makeHarness({
      protocol: 'ocpp1.6',
      config: { extraAllowedFileTransferHosts: [hostPort] },
    });
    const image = await call(allowed, 'downloadFirmware16', url, 0, 0);
    expect((image as Buffer).length).toBe(16);

    const other = await makeHarness({ protocol: 'ocpp1.6' });
    expect(await call(other, 'downloadFirmware16', url, 0, 0)).toBeNull();

    const otherPort = await makeHarness({
      protocol: 'ocpp1.6',
      config: { extraAllowedFileTransferHosts: ['127.0.0.1:1'] },
    });
    expect(await call(otherPort, 'downloadFirmware16', url, 0, 0)).toBeNull();
  });

  it('reads the allowance at each download, so a server added later is reached', async () => {
    const url = await serve(8);
    const hosts: string[] = [];
    const h = await makeHarness({
      protocol: 'ocpp1.6',
      config: { extraAllowedFileTransferHosts: hosts },
    });
    expect(await call(h, 'downloadFirmware16', url, 0, 0)).toBeNull();
    hosts.push(new URL(url).host);
    expect(((await call(h, 'downloadFirmware16', url, 0, 0)) as Buffer).length).toBe(8);
  });

  it('refuses the cloud metadata address even when the owner names it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const h = await makeHarness({
      protocol: 'ocpp1.6',
      config: { extraAllowedFileTransferHosts: ['169.254.169.254'] },
    });
    const image = await call(h, 'downloadFirmware16', 'http://169.254.169.254/latest/x', 0, 0);
    expect(image).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
