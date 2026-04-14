// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { OcppError } from '@evtivity/lib';
import { MessageRouter } from '../server/message-router.js';
import type { HandlerContext } from '../server/middleware/pipeline.js';

const logger = pino({ level: 'silent' });

function makeCtx(action: string, protocolVersion = 'ocpp2.1'): HandlerContext {
  return {
    stationId: 'CS-001',
    stationDbId: null,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      ocppProtocol: protocolVersion,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      bootStatus: null,
    },
    protocolVersion,
    messageId: 'msg-1',
    action,
    payload: {},
    logger,
    eventBus: { publish: vi.fn(), subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('MessageRouter', () => {
  it('registers and retrieves a handler', () => {
    const router = new MessageRouter(logger);
    const handler = vi.fn();
    router.register('ocpp2.1', 'BootNotification', handler);

    expect(router.has('ocpp2.1', 'BootNotification')).toBe(true);
    expect(router.get('ocpp2.1', 'BootNotification')).toBe(handler);
  });

  it('lists registered actions', () => {
    const router = new MessageRouter(logger);
    router.register('ocpp2.1', 'Heartbeat', vi.fn());
    router.register('ocpp2.1', 'Authorize', vi.fn());

    const actions = router.registeredActions('ocpp2.1');
    expect(actions).toContain('Heartbeat');
    expect(actions).toContain('Authorize');
  });

  it('asMiddleware calls the registered handler', async () => {
    const router = new MessageRouter(logger);
    const handler = vi.fn().mockResolvedValue({ status: 'Accepted' });
    router.register('ocpp2.1', 'BootNotification', handler);

    const middleware = router.asMiddleware();
    const ctx = makeCtx('BootNotification', 'ocpp2.1');
    const next = vi.fn();

    await middleware(ctx, next);

    expect(handler).toHaveBeenCalledWith(ctx);
    expect(ctx.response).toEqual({ status: 'Accepted' });
    expect(next).toHaveBeenCalled();
  });

  it('asMiddleware throws OcppError for unknown action', async () => {
    const router = new MessageRouter(logger);
    const middleware = router.asMiddleware();
    const ctx = makeCtx('UnknownAction', 'ocpp2.1');
    const next = vi.fn();

    await expect(middleware(ctx, next)).rejects.toThrow(OcppError);
    expect(next).not.toHaveBeenCalled();
  });

  it('routes 1.6 actions to 1.6 handlers', async () => {
    const router = new MessageRouter(logger);
    const handler21 = vi.fn().mockResolvedValue({ version: '2.1' });
    const handler16 = vi.fn().mockResolvedValue({ version: '1.6' });
    router.register('ocpp2.1', 'BootNotification', handler21);
    router.register('ocpp1.6', 'BootNotification', handler16);

    const middleware = router.asMiddleware();
    const ctx = makeCtx('BootNotification', 'ocpp1.6');
    const next = vi.fn();

    await middleware(ctx, next);

    expect(handler16).toHaveBeenCalledWith(ctx);
    expect(handler21).not.toHaveBeenCalled();
    expect(ctx.response).toEqual({ version: '1.6' });
  });

  it('returns NotImplemented for action not registered in version', async () => {
    const router = new MessageRouter(logger);
    router.register('ocpp2.1', 'TransactionEvent', vi.fn());

    const middleware = router.asMiddleware();
    const ctx = makeCtx('TransactionEvent', 'ocpp1.6');
    const next = vi.fn();

    await expect(middleware(ctx, next)).rejects.toThrow(OcppError);
  });

  it('has returns false for unregistered version', () => {
    const router = new MessageRouter(logger);
    router.register('ocpp2.1', 'Heartbeat', vi.fn());
    expect(router.has('ocpp1.6', 'Heartbeat')).toBe(false);
  });

  it('has returns false for unregistered action', () => {
    const router = new MessageRouter(logger);
    router.register('ocpp2.1', 'Heartbeat', vi.fn());
    expect(router.has('ocpp2.1', 'Reset')).toBe(false);
  });

  it('get returns undefined for unregistered version', () => {
    const router = new MessageRouter(logger);
    router.register('ocpp2.1', 'Heartbeat', vi.fn());
    expect(router.get('ocpp1.6', 'Heartbeat')).toBeUndefined();
  });

  it('warns when overwriting existing handler', () => {
    const router = new MessageRouter(logger);
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    router.register('ocpp2.1', 'Heartbeat', handler1);
    router.register('ocpp2.1', 'Heartbeat', handler2);

    // Second handler should replace first
    expect(router.get('ocpp2.1', 'Heartbeat')).toBe(handler2);
  });

  it('registeredActions returns empty array for unknown version', () => {
    const router = new MessageRouter(logger);
    expect(router.registeredActions('ocpp99.9')).toEqual([]);
  });

  it('registeredActions without version returns all actions across versions', () => {
    const router = new MessageRouter(logger);
    router.register('ocpp2.1', 'Heartbeat', vi.fn());
    router.register('ocpp2.1', 'BootNotification', vi.fn());
    router.register('ocpp1.6', 'Heartbeat', vi.fn());
    router.register('ocpp1.6', 'MeterValues', vi.fn());

    const all = router.registeredActions();
    expect(all).toContain('Heartbeat');
    expect(all).toContain('BootNotification');
    expect(all).toContain('MeterValues');
    // Heartbeat deduplicated
    expect(all.filter((a) => a === 'Heartbeat')).toHaveLength(1);
  });

  it('asMiddleware error includes version and action in message', async () => {
    const router = new MessageRouter(logger);
    const middleware = router.asMiddleware();
    const ctx = makeCtx('FooBar', 'ocpp1.6');
    const next = vi.fn();

    try {
      await middleware(ctx, next);
      expect.fail('Should have thrown');
    } catch (err) {
      const ocppErr = err as OcppError;
      expect(ocppErr.errorCode).toBe('NotImplemented');
      expect(ocppErr.errorDescription).toContain('FooBar');
      expect(ocppErr.errorDescription).toContain('ocpp1.6');
    }
  });
});
