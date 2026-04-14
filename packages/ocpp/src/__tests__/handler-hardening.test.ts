// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';

const {
  mockSelect,
  mockFrom,
  mockWhere,
  mockLimit,
  mockGetHeartbeatInterval,
  mockIsRoamingEnabled,
} = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockLimit = vi.fn();
  const mockGetHeartbeatInterval = vi.fn().mockResolvedValue(300);
  const mockIsRoamingEnabled = vi.fn().mockResolvedValue(false);

  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });

  return {
    mockSelect,
    mockFrom,
    mockWhere,
    mockLimit,
    mockGetHeartbeatInterval,
    mockIsRoamingEnabled,
  };
});

vi.mock('@evtivity/database', () => ({
  db: { select: mockSelect },
  driverTokens: { idToken: 'idToken', isActive: 'isActive' },
  chargingStations: { id: 'id', availability: 'availability' },
  ocpiExternalTokens: { uid: 'uid', isValid: 'isValid' },
  getHeartbeatIntervalSeconds: () => mockGetHeartbeatInterval(),
  isRoamingEnabled: () => mockIsRoamingEnabled(),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => val),
}));

import { handleAuthorize } from '../handlers/v1_6/authorize.handler.js';
import { handleBootNotification } from '../handlers/v1_6/boot-notification.handler.js';

const logger = pino({ level: 'silent' });

function makeCtx(
  action: string,
  payload: Record<string, unknown>,
  stationDbId: string | null = null,
): HandlerContext {
  return {
    stationId: 'CS-001',
    stationDbId,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp1.6',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action,
    protocolVersion: 'ocpp1.6',
    payload,
    logger,
    eventBus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('Authorize 1.6 - hardened', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
  });

  it('returns Invalid when token is not found', async () => {
    mockWhere.mockResolvedValueOnce([]);

    const ctx = makeCtx('Authorize', { idTag: 'UNKNOWN-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Invalid' } });
  });

  it('returns Blocked when all matching tokens are inactive', async () => {
    mockWhere.mockResolvedValueOnce([{ isActive: false }, { isActive: false }]);

    const ctx = makeCtx('Authorize', { idTag: 'BLOCKED-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('returns Accepted when at least one matching token is active', async () => {
    mockWhere.mockResolvedValueOnce([{ isActive: false }, { isActive: true }]);

    const ctx = makeCtx('Authorize', { idTag: 'GOOD-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Accepted on database error (fail-open)', async () => {
    mockSelect.mockImplementationOnce(() => {
      throw new Error('DB unavailable');
    });

    const ctx = makeCtx('Authorize', { idTag: 'ANY-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });
});

describe('BootNotification 1.6 - hardened', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
  });

  it('uses configurable heartbeat interval', async () => {
    mockGetHeartbeatInterval.mockResolvedValueOnce(600);

    const ctx = makeCtx('BootNotification', {
      chargePointVendor: 'TestVendor',
      chargePointModel: 'TestModel',
    });
    const response = await handleBootNotification(ctx);

    expect(response).toHaveProperty('status', 'Accepted');
    expect(response).toHaveProperty('interval', 600);
  });

  it('returns default 300 interval when setting is unavailable', async () => {
    mockGetHeartbeatInterval.mockResolvedValueOnce(300);

    const ctx = makeCtx('BootNotification', {
      chargePointVendor: 'TestVendor',
      chargePointModel: 'TestModel',
    });
    const response = await handleBootNotification(ctx);

    expect(response).toHaveProperty('interval', 300);
  });

  it('rejects station that is blocked', async () => {
    mockGetHeartbeatInterval.mockResolvedValueOnce(300);
    mockWhere.mockResolvedValueOnce([{ onboardingStatus: 'blocked' }]);

    const ctx = makeCtx(
      'BootNotification',
      { chargePointVendor: 'TestVendor', chargePointModel: 'TestModel' },
      'station-uuid-1',
    );
    const response = await handleBootNotification(ctx);

    expect(response).toHaveProperty('status', 'Rejected');
    expect(response).toHaveProperty('interval', 300);
  });

  it('accepts station with accepted onboarding status', async () => {
    mockGetHeartbeatInterval.mockResolvedValueOnce(300);
    mockWhere.mockResolvedValueOnce([{ onboardingStatus: 'accepted' }]);

    const ctx = makeCtx(
      'BootNotification',
      { chargePointVendor: 'TestVendor', chargePointModel: 'TestModel' },
      'station-uuid-1',
    );
    const response = await handleBootNotification(ctx);

    expect(response).toHaveProperty('status', 'Accepted');
  });

  it('accepts station when availability check fails (DB error)', async () => {
    mockGetHeartbeatInterval.mockResolvedValueOnce(300);
    mockWhere.mockRejectedValueOnce(new Error('DB unavailable'));

    const ctx = makeCtx(
      'BootNotification',
      { chargePointVendor: 'TestVendor', chargePointModel: 'TestModel' },
      'station-uuid-1',
    );
    const response = await handleBootNotification(ctx);

    expect(response).toHaveProperty('status', 'Accepted');
  });

  it('skips availability check when stationDbId is null', async () => {
    mockGetHeartbeatInterval.mockResolvedValueOnce(300);

    const ctx = makeCtx('BootNotification', {
      chargePointVendor: 'TestVendor',
      chargePointModel: 'TestModel',
    });
    const response = await handleBootNotification(ctx);

    expect(response).toHaveProperty('status', 'Accepted');
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
