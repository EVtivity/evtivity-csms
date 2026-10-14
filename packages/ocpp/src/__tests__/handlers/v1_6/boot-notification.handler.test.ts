// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

const { selectFn, fromFn, whereFn, updateFn, setFn, returningFn, writeAuditMock } = vi.hoisted(
  () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'sta_pending_auto' }]);
    const set = vi.fn((_values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning })),
    }));
    return {
      selectFn: vi.fn(),
      fromFn: vi.fn(),
      whereFn: vi.fn(),
      updateFn: vi.fn(() => ({ set })),
      setFn: set,
      returningFn: returning,
      writeAuditMock: vi.fn().mockResolvedValue(undefined),
    };
  },
);

vi.mock('@evtivity/database', () => ({
  db: { select: selectFn, update: updateFn },
  chargingStations: { id: 'id', onboardingStatus: 'onboarding_status' },
  stationAuditLog: { __name: 'stationAuditLog' },
  writeAudit: writeAuditMock,
  getHeartbeatIntervalSeconds: vi.fn().mockResolvedValue(300),
  getRegistrationPolicy: vi.fn().mockResolvedValue('open'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...conds: unknown[]) => ({ type: 'and', conds })),
}));

import { handleBootNotification } from '../../../handlers/v1_6/boot-notification.handler.js';
import { getHeartbeatIntervalSeconds, getRegistrationPolicy } from '@evtivity/database';

const logger = pino({ level: 'silent' });

function makeCtx(
  payload: Record<string, unknown>,
  overrides?: Partial<HandlerContext>,
): { ctx: HandlerContext; publishMock: ReturnType<typeof vi.fn> } {
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
      ocppProtocol: 'ocpp1.6',
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action: 'BootNotification',
    protocolVersion: 'ocpp1.6',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn(), drain: vi.fn(), track: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
    ...overrides,
  };
  return { ctx, publishMock };
}

beforeEach(() => {
  vi.clearAllMocks();
  whereFn.mockResolvedValue([{ onboardingStatus: 'accepted' }]);
  fromFn.mockReturnValue({ where: whereFn });
  selectFn.mockReturnValue({ from: fromFn });
  returningFn.mockResolvedValue([{ id: 'sta_pending_auto' }]);
  vi.mocked(getHeartbeatIntervalSeconds).mockResolvedValue(300);
  vi.mocked(getRegistrationPolicy).mockResolvedValue('open');
});

describe('OCPP 1.6 BootNotification handler', () => {
  it('emits ocpp.BootNotification with normalized vendor/model/serial/firmware/iccid/imsi', async () => {
    const { ctx, publishMock } = makeCtx({
      chargePointVendor: 'AcmeCharge',
      chargePointModel: 'AC-22',
      chargePointSerialNumber: 'SN-9',
      firmwareVersion: '2.3.1',
      iccid: 'ICCID-1',
      imsi: 'IMSI-2',
    });

    await handleBootNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.BootNotification',
      aggregateType: 'ChargingStation',
      aggregateId: 'CS-001',
      payload: {
        vendorName: 'AcmeCharge',
        model: 'AC-22',
        serialNumber: 'SN-9',
        firmwareVersion: '2.3.1',
        iccid: 'ICCID-1',
        imsi: 'IMSI-2',
      },
    });
  });

  it('returns Accepted with interval and a currentTime when stationDbId is null (no DB lookup)', async () => {
    const { ctx } = makeCtx({ chargePointVendor: 'V', chargePointModel: 'M' });

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Accepted', interval: 300 });
    expect(typeof response.currentTime).toBe('string');
    expect(Number.isNaN(Date.parse(response.currentTime as string))).toBe(false);
    expect(ctx.session.bootStatus).toBe('Accepted');
    // No onboarding lookup when stationDbId is null.
    expect(selectFn).not.toHaveBeenCalled();
  });

  it('uses the configured heartbeat interval value in the response', async () => {
    vi.mocked(getHeartbeatIntervalSeconds).mockResolvedValue(90);
    const { ctx } = makeCtx({ chargePointVendor: 'V', chargePointModel: 'M' });

    const response = await handleBootNotification(ctx);

    expect(response.interval).toBe(90);
  });

  it('returns Accepted when the station onboardingStatus is accepted', async () => {
    whereFn.mockResolvedValue([{ onboardingStatus: 'accepted' }]);
    const { ctx } = makeCtx(
      { chargePointVendor: 'V', chargePointModel: 'M' },
      { stationDbId: 'sta_001' },
    );

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Accepted', interval: 300 });
    expect(ctx.session.bootStatus).toBe('Accepted');
    expect(selectFn).toHaveBeenCalledTimes(1);
  });

  it('returns Rejected when the station onboardingStatus is blocked', async () => {
    whereFn.mockResolvedValue([{ onboardingStatus: 'blocked' }]);
    const { ctx } = makeCtx(
      { chargePointVendor: 'V', chargePointModel: 'M' },
      { stationDbId: 'sta_blocked' },
    );

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Rejected', interval: 300 });
    expect(typeof response.currentTime).toBe('string');
    expect(ctx.session.bootStatus).toBe('Rejected');
    // Registration policy is never consulted for a blocked station.
    expect(getRegistrationPolicy).not.toHaveBeenCalled();
  });

  it('returns Pending when onboardingStatus is pending and policy is approval-required', async () => {
    whereFn.mockResolvedValue([{ onboardingStatus: 'pending' }]);
    vi.mocked(getRegistrationPolicy).mockResolvedValue('approval-required');
    const { ctx } = makeCtx(
      { chargePointVendor: 'V', chargePointModel: 'M' },
      { stationDbId: 'sta_pending' },
    );

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Pending', interval: 300 });
    expect(ctx.session.bootStatus).toBe('Pending');
    expect(getRegistrationPolicy).toHaveBeenCalledTimes(1);
  });

  it('returns Accepted when onboardingStatus is pending but policy is open', async () => {
    whereFn.mockResolvedValue([{ onboardingStatus: 'pending' }]);
    vi.mocked(getRegistrationPolicy).mockResolvedValue('open');
    const { ctx } = makeCtx(
      { chargePointVendor: 'V', chargePointModel: 'M' },
      { stationDbId: 'sta_pending_auto' },
    );

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Accepted', interval: 300 });
    expect(ctx.session.bootStatus).toBe('Accepted');
    expect(getRegistrationPolicy).toHaveBeenCalledTimes(1);
    // The station is accepted for good, audited as an OCPP change.
    expect(setFn.mock.calls[0]?.[0]).toMatchObject({ onboardingStatus: 'accepted' });
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'onboarding_status_changed', actor: 'ocpp' }),
      undefined,
      expect.anything(),
    );
  });

  it('returns Pending when an open-policy station left pending while it booted', async () => {
    whereFn.mockResolvedValue([{ onboardingStatus: 'pending' }]);
    returningFn.mockResolvedValue([]);
    const { ctx } = makeCtx(
      { chargePointVendor: 'V', chargePointModel: 'M' },
      { stationDbId: 'sta_pending_auto' },
    );

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Pending' });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('returns Accepted when the station row is not found (undefined row)', async () => {
    whereFn.mockResolvedValue([]);
    const { ctx } = makeCtx(
      { chargePointVendor: 'V', chargePointModel: 'M' },
      { stationDbId: 'sta_missing' },
    );

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Accepted', interval: 300 });
    expect(ctx.session.bootStatus).toBe('Accepted');
  });

  it('fails closed with Pending when the onboarding DB lookup throws (Error)', async () => {
    whereFn.mockRejectedValue(new Error('db down'));
    const { ctx } = makeCtx(
      { chargePointVendor: 'V', chargePointModel: 'M' },
      { stationDbId: 'sta_dberr' },
    );

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Pending', interval: 300 });
    expect(typeof response.currentTime).toBe('string');
    expect(ctx.session.bootStatus).toBe('Pending');
  });

  it('fails closed with Pending when the DB lookup rejects with a non-Error value', async () => {
    whereFn.mockRejectedValue('string failure');
    const { ctx } = makeCtx(
      { chargePointVendor: 'V', chargePointModel: 'M' },
      { stationDbId: 'sta_dberr2' },
    );

    const response = await handleBootNotification(ctx);

    expect(response).toMatchObject({ status: 'Pending', interval: 300 });
    expect(ctx.session.bootStatus).toBe('Pending');
  });
});
