// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { ConnectionManager } from '../server/connection-manager.js';
import { createSessionState } from '../server/session-state.js';

const logger = pino({ level: 'silent' });

function mockWs() {
  return {
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
  } as unknown as import('ws').default;
}

describe('ConnectionManager', () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    cm = new ConnectionManager(logger);
  });

  it('adds and retrieves a connection', () => {
    const ws = mockWs();
    const session = createSessionState('CS-001');
    cm.add('CS-001', ws, session);

    expect(cm.has('CS-001')).toBe(true);
    expect(cm.get('CS-001')?.ws).toBe(ws);
    expect(cm.count()).toBe(1);
  });

  it('removes a connection', () => {
    const ws = mockWs();
    cm.add('CS-001', ws, createSessionState('CS-001'));
    cm.remove('CS-001');

    expect(cm.has('CS-001')).toBe(false);
    expect(cm.count()).toBe(0);
  });

  it('replaces existing connection and closes old WebSocket', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    cm.add('CS-001', ws1, createSessionState('CS-001'));
    cm.add('CS-001', ws2, createSessionState('CS-001'));

    expect(cm.get('CS-001')?.ws).toBe(ws2);
    expect(ws1.close).toHaveBeenCalledWith(1000, 'Replaced by new connection');
    expect(cm.count()).toBe(1);
  });

  it('returns undefined for unknown station', () => {
    expect(cm.get('UNKNOWN')).toBeUndefined();
    expect(cm.has('UNKNOWN')).toBe(false);
  });

  it('lists all station IDs', () => {
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));
    cm.add('CS-002', mockWs(), createSessionState('CS-002'));

    const ids = cm.allStationIds();
    expect(ids).toContain('CS-001');
    expect(ids).toContain('CS-002');
    expect(ids).toHaveLength(2);
  });

  it('calls registry.register on add when registry is set', async () => {
    const registry = {
      register: vi.fn().mockResolvedValue(undefined),
      unregister: vi.fn().mockResolvedValue(undefined),
      getInstanceId: vi.fn().mockResolvedValue(null),
    };
    const cmWithRegistry = new ConnectionManager(logger, {
      registry,
      instanceId: 'instance-1',
    });

    cmWithRegistry.add('CS-001', mockWs(), createSessionState('CS-001'));

    await vi.waitFor(() => {
      expect(registry.register).toHaveBeenCalledWith('CS-001', 'instance-1');
    });
  });

  it('calls registry.unregister on remove when registry is set', async () => {
    const registry = {
      register: vi.fn().mockResolvedValue(undefined),
      unregister: vi.fn().mockResolvedValue(undefined),
      getInstanceId: vi.fn().mockResolvedValue(null),
    };
    const cmWithRegistry = new ConnectionManager(logger, {
      registry,
      instanceId: 'instance-1',
    });

    cmWithRegistry.add('CS-001', mockWs(), createSessionState('CS-001'));
    cmWithRegistry.remove('CS-001');

    await vi.waitFor(() => {
      expect(registry.unregister).toHaveBeenCalledWith('CS-001');
    });
  });

  it('does not fail when registry.register rejects', async () => {
    const registry = {
      register: vi.fn().mockRejectedValue(new Error('Redis down')),
      unregister: vi.fn().mockResolvedValue(undefined),
      getInstanceId: vi.fn().mockResolvedValue(null),
    };
    const cmWithRegistry = new ConnectionManager(logger, {
      registry,
      instanceId: 'instance-1',
    });

    cmWithRegistry.add('CS-001', mockWs(), createSessionState('CS-001'));

    await vi.waitFor(() => {
      expect(registry.register).toHaveBeenCalledWith('CS-001', 'instance-1');
    });

    expect(cmWithRegistry.has('CS-001')).toBe(true);
  });

  it('setRegistry configures registry after construction', async () => {
    const registry = {
      register: vi.fn().mockResolvedValue(undefined),
      unregister: vi.fn().mockResolvedValue(undefined),
      getInstanceId: vi.fn().mockResolvedValue(null),
    };

    cm.setRegistry(registry, 'instance-2');
    cm.add('CS-001', mockWs(), createSessionState('CS-001'));

    await vi.waitFor(() => {
      expect(registry.register).toHaveBeenCalledWith('CS-001', 'instance-2');
    });
  });
});
