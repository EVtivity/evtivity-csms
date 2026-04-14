// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';

const selectFn = vi.fn();
const fromFn = vi.fn();
const whereFn = vi.fn();

vi.mock('@evtivity/database', () => {
  fromFn.mockReturnValue({ where: whereFn });
  selectFn.mockReturnValue({ from: fromFn });

  return {
    db: { select: selectFn },
    driverTokens: {
      isActive: 'is_active',
      idToken: 'id_token',
      tokenType: 'token_type',
    },
    ocpiExternalTokens: {
      isValid: 'is_valid',
      uid: 'uid',
    },
    isRoamingEnabled: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
}));

const logger = pino({ level: 'silent' });

function makeCtx(payload: Record<string, unknown>): {
  ctx: HandlerContext;
  publishMock: ReturnType<typeof vi.fn>;
} {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const ctx: HandlerContext = {
    stationId: 'CS-001',
    stationDbId: null,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action: 'Authorize',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: {
      publish: publishMock,
      subscribe: vi.fn(),
    },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

beforeEach(() => {
  vi.clearAllMocks();
  fromFn.mockReturnValue({ where: whereFn });
  selectFn.mockReturnValue({ from: fromFn });
});

describe('v2_1 Authorize handler', () => {
  it('accepts NoAuthorization token without DB lookup', async () => {
    const { handleAuthorize } = await import('../handlers/v2_1/authorize.handler.js');
    const { ctx, publishMock } = makeCtx({
      idToken: { idToken: 'no-auth', type: 'NoAuthorization' },
    });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(selectFn).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.Authorize' }),
    );
  });

  it('accepts Central token not found in DB', async () => {
    whereFn.mockResolvedValue([]);
    const { handleAuthorize } = await import('../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'central-token', type: 'Central' },
    });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
  });

  it('returns Invalid for ISO14443 token not found in DB', async () => {
    whereFn.mockResolvedValue([]);
    const { handleAuthorize } = await import('../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'unknown-rfid', type: 'ISO14443' },
    });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Invalid' } });
  });

  it('accepts active token found in DB', async () => {
    whereFn.mockResolvedValue([{ isActive: true }]);
    const { handleAuthorize } = await import('../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'active-rfid', type: 'ISO14443' },
    });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: expect.objectContaining({ status: 'Accepted' }) as unknown,
    });
  });

  it('blocks inactive token found in DB', async () => {
    whereFn.mockResolvedValue([{ isActive: false }]);
    const { handleAuthorize } = await import('../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'blocked-rfid', type: 'ISO14443' },
    });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Blocked' } });
  });
});
