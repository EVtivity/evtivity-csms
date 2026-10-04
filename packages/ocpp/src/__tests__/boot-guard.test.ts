// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { OcppError } from '@evtivity/lib';
import { createBootGuardMiddleware } from '../server/middleware/boot-guard.js';
import type { HandlerContext } from '../server/middleware/pipeline.js';

function makeCtx(
  action: string,
  bootStatus: HandlerContext['session']['bootStatus'],
): HandlerContext {
  return {
    stationId: 'CS-BOOT',
    stationDbId: null,
    session: {
      stationId: 'CS-BOOT',
      stationDbId: null,
      ocppProtocol: 'ocpp2.1',
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      bootStatus,
      readyAnnounced: false,
    },
    protocolVersion: 'ocpp2.1',
    messageId: 'msg-boot',
    action,
    payload: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as HandlerContext['logger'],
    eventBus: { publish: vi.fn(), subscribe: vi.fn(), drain: vi.fn(), track: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('createBootGuardMiddleware', () => {
  it('always lets BootNotification through, even before boot', async () => {
    const middleware = createBootGuardMiddleware();
    const ctx = makeCtx('BootNotification', null);
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lets BootNotification through even when boot status is Rejected', async () => {
    const middleware = createBootGuardMiddleware();
    const ctx = makeCtx('BootNotification', 'Rejected');
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lets other actions through once boot is Accepted', async () => {
    const middleware = createBootGuardMiddleware();
    const ctx = makeCtx('Heartbeat', 'Accepted');
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.logger.info).not.toHaveBeenCalled();
  });

  it('lets other actions through when no BootNotification has arrived yet (null)', async () => {
    const middleware = createBootGuardMiddleware();
    const ctx = makeCtx('StatusNotification', null);
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects non-boot actions while boot status is Pending', async () => {
    const middleware = createBootGuardMiddleware();
    const ctx = makeCtx('Heartbeat', 'Pending');
    const next = vi.fn();

    const err = await middleware(ctx, next).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OcppError);
    expect((err as OcppError).errorCode).toBe('SecurityError');
    expect((err as OcppError).errorDescription).toBe('Station boot status is not Accepted');
    expect(next).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        stationId: 'CS-BOOT',
        action: 'Heartbeat',
        bootStatus: 'Pending',
      }),
      'Rejecting message: BootNotification was not Accepted',
    );
  });

  it('rejects non-boot actions while boot status is Rejected', async () => {
    const middleware = createBootGuardMiddleware();
    const ctx = makeCtx('MeterValues', 'Rejected');
    const next = vi.fn();

    await expect(middleware(ctx, next)).rejects.toMatchObject({ errorCode: 'SecurityError' });
    expect(next).not.toHaveBeenCalled();
  });
});
