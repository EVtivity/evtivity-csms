// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';
import { handleBootNotification } from '../handlers/v2_1/boot-notification.handler.js';
import { handleHeartbeat } from '../handlers/v2_1/heartbeat.handler.js';
import { handleDataTransfer } from '../handlers/v2_1/data-transfer.handler.js';

const logger = pino({ level: 'silent' });

function makeCtx(
  action: string,
  payload: Record<string, unknown>,
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
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action,
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

describe('BootNotification handler', () => {
  it('returns Accepted with heartbeat interval', async () => {
    const { ctx, publishMock } = makeCtx('BootNotification', {
      chargingStation: {
        vendorName: 'TestVendor',
        model: 'TestModel',
      },
      reason: 'PowerUp',
    });

    const response = await handleBootNotification(ctx);

    expect(response).toHaveProperty('status', 'Accepted');
    expect(response).toHaveProperty('interval', 300);
    expect(response).toHaveProperty('currentTime');
    expect(publishMock).toHaveBeenCalledOnce();
  });

  it('publishes an event with station info', async () => {
    const { ctx, publishMock } = makeCtx('BootNotification', {
      chargingStation: {
        vendorName: 'TestVendor',
        model: 'TestModel',
        serialNumber: 'SN-123',
        firmwareVersion: '1.0',
      },
      reason: 'PowerUp',
    });

    await handleBootNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.BootNotification',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
      }),
    );
  });
});

describe('Heartbeat handler', () => {
  it('returns currentTime', async () => {
    const { ctx } = makeCtx('Heartbeat', {});
    const before = new Date().toISOString();

    const response = await handleHeartbeat(ctx);

    expect(response).toHaveProperty('currentTime');
    const time = response['currentTime'] as string;
    expect(time >= before).toBe(true);
  });
});

describe('DataTransfer handler', () => {
  it('returns UnknownVendorId and publishes event', async () => {
    const { ctx, publishMock } = makeCtx('DataTransfer', {
      vendorId: 'TestVendor',
      messageId: 'custom-msg',
      data: 'test-data',
    });

    const response = await handleDataTransfer(ctx);

    expect(response).toEqual({ status: 'UnknownVendorId' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.DataTransfer',
        payload: expect.objectContaining({
          vendorId: 'TestVendor',
          messageId: 'custom-msg',
        }) as unknown,
      }),
    );
  });
});
