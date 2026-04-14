// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { OcppClient } from '../ocpp-client.js';

// We cannot easily test WebSocket connections in unit tests without a real server.
// Test the constructor, option handling, and state management.

describe('OcppClient', () => {
  it('constructs with required options', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    expect(client.stationId).toBe('TEST-001');
    expect(client.protocol).toBe('ocpp2.1');
    expect(client.isConnected).toBe(false);
  });

  it('constructs with OCPP 1.6', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-16',
      ocppProtocol: 'ocpp1.6',
    });
    expect(client.protocol).toBe('ocpp1.6');
  });

  it('rejects sendCall when not connected', async () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    await expect(client.sendCall('Heartbeat', {})).rejects.toThrow('Not connected');
  });

  it('does not throw on sendCallResult when not connected', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    // Should not throw, just silently skip
    expect(() => client.sendCallResult('msg-1', { status: 'Accepted' })).not.toThrow();
  });

  it('accepts handler registrations', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    const handler = vi.fn();
    const connHandler = vi.fn();
    const disconnHandler = vi.fn();
    client.setIncomingCallHandler(handler);
    client.setConnectedHandler(connHandler);
    client.setDisconnectedHandler(disconnHandler);
    // No error means handlers are set
    expect(client.isConnected).toBe(false);
  });

  it('disconnect is safe to call when not connected', () => {
    const client = new OcppClient({
      serverUrl: 'ws://localhost:3003',
      stationId: 'TEST-001',
      ocppProtocol: 'ocpp2.1',
    });
    expect(() => client.disconnect()).not.toThrow();
  });
});
