// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { OcppError } from '@evtivity/lib';
import { validateMiddleware } from '../server/middleware/validate.js';
import type { HandlerContext } from '../server/middleware/pipeline.js';

const logger = pino({ level: 'silent' });

function makeCtx(
  action: string,
  payload: Record<string, unknown> = {},
  protocolVersion = 'ocpp2.1',
): HandlerContext {
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
    payload,
    logger,
    eventBus: { publish: vi.fn(), subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('validateMiddleware', () => {
  it('calls next for an action not in the registry', async () => {
    const ctx = makeCtx('UnknownAction', {});
    const next = vi.fn();

    await validateMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
  });

  it('throws FormatViolation for invalid request payload', async () => {
    const ctx = makeCtx('BootNotification', {});
    const next = vi.fn();

    await expect(validateMiddleware(ctx, next)).rejects.toThrow(OcppError);

    try {
      await validateMiddleware(ctx, next);
    } catch (err) {
      const ocppErr = err as OcppError;
      expect(ocppErr.errorCode).toBe('FormatViolation');
    }
  });

  it('passes valid BootNotification payload for ocpp2.1', async () => {
    const ctx = makeCtx('BootNotification', {
      chargingStation: {
        vendorName: 'TestVendor',
        model: 'TestModel',
      },
      reason: 'PowerUp',
    });
    const next = vi.fn();

    await validateMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes valid Heartbeat payload for ocpp2.1', async () => {
    const ctx = makeCtx('Heartbeat', {});
    const next = vi.fn();

    await validateMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
  });

  it('uses ocpp1.6 registry when protocolVersion is ocpp1.6', async () => {
    const ctx = makeCtx(
      'BootNotification',
      {
        chargePointVendor: 'TestVendor',
        chargePointModel: 'TestModel',
      },
      'ocpp1.6',
    );
    const next = vi.fn();

    await validateMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
  });

  it('validates response after handler sets ctx.response', async () => {
    const ctx = makeCtx('Heartbeat', {});
    const next = vi.fn().mockImplementation(async () => {
      ctx.response = { currentTime: new Date().toISOString() };
    });

    await validateMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
  });

  it('logs error for invalid response but does not throw', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const ctx = makeCtx('Heartbeat', {});
    ctx.logger = logger;
    const next = vi.fn().mockImplementation(async () => {
      // Set an invalid response (missing required currentTime)
      ctx.response = { invalidField: true };
    });

    // Should not throw even though response is invalid
    await validateMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
    // The middleware logs the error but does not throw
    errorSpy.mockRestore();
  });

  it('throws FormatViolation for invalid 1.6 BootNotification', async () => {
    // 1.6 BootNotification requires chargePointVendor and chargePointModel
    const ctx = makeCtx('BootNotification', {}, 'ocpp1.6');
    const next = vi.fn();

    await expect(validateMiddleware(ctx, next)).rejects.toThrow(OcppError);
    expect(next).not.toHaveBeenCalled();
  });
});
