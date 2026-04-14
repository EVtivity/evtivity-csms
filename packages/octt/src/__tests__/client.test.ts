// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { createTestClient, generateStationId } from '../client.js';

// Mock the OcppClient from @evtivity/css
vi.mock('@evtivity/css/ocpp-client', () => ({
  OcppClient: class MockOcppClient {
    private opts: Record<string, unknown>;
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    sendCall = vi.fn().mockResolvedValue({ status: 'Accepted' });
    setIncomingCallHandler = vi.fn();
    get isConnected() {
      return true;
    }
    get stationId() {
      return this.opts['stationId'] as string;
    }
    get protocol() {
      return this.opts['ocppProtocol'] as string;
    }
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
  },
}));

describe('createTestClient', () => {
  it('creates client with correct station ID format', () => {
    const client = createTestClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'OCTT-B-TC01-abc123',
      version: 'ocpp2.1',
    });
    expect(client.stationId).toBe('OCTT-B-TC01-abc123');
  });

  it('uses correct OCPP protocol', () => {
    const client = createTestClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'OCTT-TEST',
      version: 'ocpp1.6',
    });
    expect(client.protocol).toBe('ocpp1.6');
  });
});

describe('generateStationId', () => {
  it('generates station ID with correct prefix', () => {
    const id = generateStationId('B', 'TC01');
    expect(id).toMatch(/^OCTT-B-TC01-[a-z0-9]{6}$/);
  });

  it('generates unique IDs on each call', () => {
    const id1 = generateStationId('B', 'TC01');
    const id2 = generateStationId('B', 'TC01');
    expect(id1).not.toBe(id2);
  });
});
