// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { OcppError } from '@evtivity/lib';
import { MiddlewarePipeline } from '../server/middleware/pipeline.js';
import type { HandlerContext } from '../server/middleware/pipeline.js';
import { validateMiddleware } from '../server/middleware/validate.js';
import { createBootGuardMiddleware } from '../server/middleware/boot-guard.js';

function makeCtx(
  action: string,
  bootStatus: HandlerContext['session']['bootStatus'],
  payload: Record<string, unknown>,
): HandlerContext {
  return {
    stationId: 'CS-ORDER',
    stationDbId: null,
    session: {
      stationId: 'CS-ORDER',
      stationDbId: null,
      ocppProtocol: 'ocpp2.1',
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      bootStatus,
    },
    protocolVersion: 'ocpp2.1',
    messageId: 'msg-order',
    action,
    payload,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as HandlerContext['logger'],
    eventBus: { publish: vi.fn(), subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

// The OcppServer pipeline registers boot-guard before validate (ocpp-server.ts).
// These tests pin that contract: a non-booted station's malformed CALL must
// surface SecurityError (OCPP 2.1 B02.FR.02), not a schema error. An empty
// object is an invalid StatusNotificationRequest (required timestamp,
// connectorStatus, evseId, connectorId), so validate would throw on it.
describe('middleware order: boot-guard before validate', () => {
  const INVALID_STATUS = {};

  it('non-booted (Pending) station with a malformed payload gets SecurityError', async () => {
    const pipeline = new MiddlewarePipeline();
    pipeline.use(createBootGuardMiddleware());
    pipeline.use(validateMiddleware);

    const err = await pipeline
      .execute(makeCtx('StatusNotification', 'Pending', INVALID_STATUS))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OcppError);
    expect((err as OcppError).errorCode).toBe('SecurityError');
  });

  it('reversed order leaks a validation error for the same station (why the order matters)', async () => {
    const pipeline = new MiddlewarePipeline();
    pipeline.use(validateMiddleware);
    pipeline.use(createBootGuardMiddleware());

    const err = await pipeline
      .execute(makeCtx('StatusNotification', 'Pending', INVALID_STATUS))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OcppError);
    expect((err as OcppError).errorCode).not.toBe('SecurityError');
  });

  it('booted (Accepted) station still gets schema validation', async () => {
    const pipeline = new MiddlewarePipeline();
    pipeline.use(createBootGuardMiddleware());
    pipeline.use(validateMiddleware);

    const err = await pipeline
      .execute(makeCtx('StatusNotification', 'Accepted', INVALID_STATUS))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OcppError);
    expect((err as OcppError).errorCode).not.toBe('SecurityError');
  });

  it('BootNotification is never blocked by boot-guard and is still validated', async () => {
    const pipeline = new MiddlewarePipeline();
    pipeline.use(createBootGuardMiddleware());
    pipeline.use(validateMiddleware);

    const err = await pipeline
      .execute(makeCtx('BootNotification', 'Pending', {}))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OcppError);
    expect((err as OcppError).errorCode).not.toBe('SecurityError');
  });
});
