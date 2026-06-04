// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

let whereResult: { onboardingStatus: string }[] | Error;
const whereFn = vi.fn((): Promise<{ onboardingStatus: string }[]> => {
  if (whereResult instanceof Error) return Promise.reject(whereResult);
  return Promise.resolve(whereResult);
});
const fromFn = vi.fn(() => ({ where: whereFn }));
const selectFn = vi.fn(() => ({ from: fromFn }));

const getHeartbeatIntervalSecondsMock = vi.fn().mockResolvedValue(300);
const getRegistrationPolicyMock = vi.fn().mockResolvedValue('auto-approve');

vi.mock('@evtivity/database', () => ({
  db: { select: selectFn },
  chargingStations: { id: 'id', onboardingStatus: 'onboarding_status' },
  getHeartbeatIntervalSeconds: getHeartbeatIntervalSecondsMock,
  getRegistrationPolicy: getRegistrationPolicyMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
}));

const logger = pino({ level: 'silent' });

function makeCtx(
  payload: Record<string, unknown>,
  stationDbId: string | null = null,
): { ctx: HandlerContext; publishMock: ReturnType<typeof vi.fn> } {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const ctx: HandlerContext = {
    stationId: 'CS-001',
    stationDbId,
    session: {
      stationId: 'CS-001',
      stationDbId,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action: 'BootNotification',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

const bootPayload = {
  reason: 'PowerUp',
  chargingStation: {
    vendorName: 'EVtivity',
    model: 'Model-X',
    serialNumber: 'SN-123',
    firmwareVersion: '1.2.3',
    modem: { iccid: 'ICC-1', imsi: 'IMSI-1' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  whereResult = [];
  getHeartbeatIntervalSecondsMock.mockResolvedValue(300);
  getRegistrationPolicyMock.mockResolvedValue('auto-approve');
});

describe('v2_1 BootNotification handler', () => {
  it('publishes ocpp.BootNotification with normalized station fields', async () => {
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx, publishMock } = makeCtx(bootPayload);
    await handleBootNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.BootNotification',
      aggregateType: 'ChargingStation',
      aggregateId: 'CS-001',
      payload: {
        stationDbId: null,
        vendorName: 'EVtivity',
        model: 'Model-X',
        serialNumber: 'SN-123',
        firmwareVersion: '1.2.3',
        iccid: 'ICC-1',
        imsi: 'IMSI-1',
      },
    });
  });

  it('accepts and returns the configured heartbeat interval when stationDbId is null', async () => {
    getHeartbeatIntervalSecondsMock.mockResolvedValue(120);
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx } = makeCtx(bootPayload);
    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Accepted', interval: 120 });
    expect(typeof response['currentTime']).toBe('string');
    expect(ctx.session.bootStatus).toBe('Accepted');
    // No DB lookup when stationDbId is null
    expect(selectFn).not.toHaveBeenCalled();
  });

  it('handles a boot payload with no modem (iccid/imsi undefined)', async () => {
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx, publishMock } = makeCtx({
      reason: 'PowerUp',
      chargingStation: { vendorName: 'V', model: 'M' },
    });
    await handleBootNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ iccid: undefined, imsi: undefined }) as unknown,
      }),
    );
  });

  it('accepts an onboarded station (status not blocked/pending)', async () => {
    whereResult = [{ onboardingStatus: 'accepted' }];
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx } = makeCtx(bootPayload, 'sta_1');
    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Accepted' });
    expect(ctx.session.bootStatus).toBe('Accepted');
    expect(selectFn).toHaveBeenCalled();
  });

  it('rejects a blocked station', async () => {
    whereResult = [{ onboardingStatus: 'blocked' }];
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx } = makeCtx(bootPayload, 'sta_2');
    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Rejected', interval: 300 });
    expect(ctx.session.bootStatus).toBe('Rejected');
    expect(getRegistrationPolicyMock).not.toHaveBeenCalled();
  });

  it('returns Pending for a pending station when policy is approval-required', async () => {
    whereResult = [{ onboardingStatus: 'pending' }];
    getRegistrationPolicyMock.mockResolvedValue('approval-required');
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx } = makeCtx(bootPayload, 'sta_3');
    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Pending' });
    expect(ctx.session.bootStatus).toBe('Pending');
  });

  it('accepts a pending station when policy is auto-approve', async () => {
    whereResult = [{ onboardingStatus: 'pending' }];
    getRegistrationPolicyMock.mockResolvedValue('auto-approve');
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx } = makeCtx(bootPayload, 'sta_4');
    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Accepted' });
    expect(ctx.session.bootStatus).toBe('Accepted');
  });

  it('accepts when the station row is not found (undefined onboardingStatus)', async () => {
    whereResult = [];
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx } = makeCtx(bootPayload, 'sta_missing');
    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Accepted' });
    expect(ctx.session.bootStatus).toBe('Accepted');
  });

  it('fails closed to Pending when the onboarding lookup throws', async () => {
    whereResult = new Error('db unreachable');
    const { handleBootNotification } =
      await import('../../../handlers/v2_1/boot-notification.handler.js');
    const { ctx } = makeCtx(bootPayload, 'sta_5');
    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Pending', interval: 300 });
    expect(ctx.session.bootStatus).toBe('Pending');
  });
});
