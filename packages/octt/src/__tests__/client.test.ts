// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { createTestClient, generateStationId, TransactionTracker } from '../client.js';

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

  it('passes the CSMS TLS CA to the client so wss:// connections are verified against it', () => {
    const client = createTestClient({
      serverUrl: 'wss://localhost:8443',
      stationId: 'OCTT-TLS',
      version: 'ocpp2.1',
      caCert: 'CA-PEM',
    });
    expect((client as unknown as { opts: Record<string, unknown> }).opts['caCert']).toBe('CA-PEM');
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

describe('TransactionTracker', () => {
  it('opens a 1.6 transaction on StartTransaction.conf and closes it on StopTransaction', () => {
    const tracker = new TransactionTracker();
    const start = { connectorId: 2, idTag: 'TAG', meterStart: 100, timestamp: 't' };
    tracker.onRequest('StartTransaction', start);
    tracker.onResponse('StartTransaction', start, { transactionId: 7, idTagInfo: {} });
    expect(tracker.open).toEqual([
      { version: 'ocpp1.6', transactionId: 7, connectorId: 2, meterStart: 100, idTag: 'TAG' },
    ]);
    tracker.onRequest('StopTransaction', { transactionId: 7, meterStop: 200, timestamp: 't' });
    expect(tracker.open).toEqual([]);
  });

  it('tracks a 2.1 transaction with its highest seqNo until Ended', () => {
    const tracker = new TransactionTracker();
    const evse = { id: 1, connectorId: 1 };
    tracker.onRequest('TransactionEvent', {
      eventType: 'Started',
      seqNo: 0,
      transactionInfo: { transactionId: 'TX1' },
      evse,
    });
    tracker.onRequest('TransactionEvent', {
      eventType: 'Updated',
      seqNo: 3,
      transactionInfo: { transactionId: 'TX1' },
    });
    expect(tracker.open).toEqual([{ version: 'ocpp2.1', transactionId: 'TX1', seqNo: 3, evse }]);
    tracker.onRequest('TransactionEvent', {
      eventType: 'Ended',
      seqNo: 4,
      transactionInfo: { transactionId: 'TX1' },
    });
    expect(tracker.open).toEqual([]);
  });

  it('ignores other actions and responses without a transactionId', () => {
    const tracker = new TransactionTracker();
    tracker.onRequest('Heartbeat', {});
    tracker.onResponse('StartTransaction', { connectorId: 1 }, { idTagInfo: {} });
    expect(tracker.open).toEqual([]);
  });
});
