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
  protocolVersion: 'ocpp1.6' | 'ocpp2.1' = 'ocpp2.1',
): HandlerContext {
  return {
    stationId: 'CS-ORDER',
    stationDbId: null,
    session: {
      stationId: 'CS-ORDER',
      stationDbId: null,
      ocppProtocol: protocolVersion,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      bootStatus,
      readyAnnounced: false,
    },
    protocolVersion,
    messageId: 'msg-order',
    action,
    payload,
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

// Run a ctx through the boot-guard + validate pair and return the thrown error
// (or undefined). 'validate-first' reproduces the pre-fix order so a test can
// show what that order would have leaked.
async function runOrdered(
  ctx: HandlerContext,
  order: 'guard-first' | 'validate-first' = 'guard-first',
): Promise<unknown> {
  const pipeline = new MiddlewarePipeline();
  const middlewares =
    order === 'guard-first'
      ? [createBootGuardMiddleware(), validateMiddleware]
      : [validateMiddleware, createBootGuardMiddleware()];
  for (const mw of middlewares) pipeline.use(mw);
  return pipeline.execute(ctx).catch((e: unknown) => e);
}

function expectSecurityError(err: unknown): void {
  expect(err).toBeInstanceOf(OcppError);
  expect((err as OcppError).errorCode).toBe('SecurityError');
}

function expectValidationError(err: unknown): void {
  expect(err).toBeInstanceOf(OcppError);
  expect((err as OcppError).errorCode).not.toBe('SecurityError');
}

// The OcppServer pipeline registers boot-guard before validate (ocpp-server.ts).
// These tests pin that contract: a non-booted (Pending/Rejected) station's malformed
// CALL must surface SecurityError (OCPP 2.1 B01.FR.10, and the Pending-specific
// B02.FR.09 - the CSMS-side rules; B02.FR.02 is the mirror Charging-Station "SHALL NOT
// send" obligation), not a schema error. An empty object is an invalid
// StatusNotificationRequest (required timestamp, connectorStatus, evseId,
// connectorId), so validate would throw on it.
describe('middleware order: boot-guard before validate', () => {
  const INVALID_STATUS = {};

  it('2.1: non-booted (Pending) station with a malformed payload gets SecurityError', async () => {
    expectSecurityError(await runOrdered(makeCtx('StatusNotification', 'Pending', INVALID_STATUS)));
  });

  it('2.1: reversed order leaks a validation error for the same station (why the order matters)', async () => {
    expectValidationError(
      await runOrdered(makeCtx('StatusNotification', 'Pending', INVALID_STATUS), 'validate-first'),
    );
  });

  it('2.1: booted (Accepted) station still gets schema validation', async () => {
    expectValidationError(
      await runOrdered(makeCtx('StatusNotification', 'Accepted', INVALID_STATUS)),
    );
  });

  it('2.1: BootNotification is never blocked by boot-guard and is still validated', async () => {
    expectValidationError(await runOrdered(makeCtx('BootNotification', 'Pending', {})));
  });

  it('1.6: non-booted (Pending) station with a malformed payload gets SecurityError', async () => {
    expectSecurityError(await runOrdered(makeCtx('StatusNotification', 'Pending', {}, 'ocpp1.6')));
  });

  it('1.6: booted (Accepted) station still gets schema validation', async () => {
    expectValidationError(
      await runOrdered(makeCtx('StatusNotification', 'Accepted', {}, 'ocpp1.6')),
    );
  });
});
