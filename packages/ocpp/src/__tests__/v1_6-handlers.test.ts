// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';

vi.mock('@evtivity/database', () => {
  const where = vi.fn().mockResolvedValue([{ isActive: true }]);
  const limit = vi.fn().mockReturnValue({ where });
  const innerJoin = vi.fn().mockReturnValue({ where, limit });
  const from = vi.fn().mockReturnValue({ where, innerJoin, limit });
  return {
    db: {
      select: vi.fn().mockReturnValue({ from }),
      execute: vi.fn().mockResolvedValue([{ nextval: '12345' }]),
    },
    driverTokens: { isActive: 'is_active', idToken: 'id_token', tokenType: 'token_type' },
    chargingStations: {
      id: 'id',
      stationId: 'station_id',
      siteId: 'site_id',
      onboardingStatus: 'onboarding_status',
    },
    sites: { id: 'id', freeVendEnabled: 'free_vend_enabled' },
    ocpiExternalTokens: { isValid: 'is_valid', uid: 'uid' },
    getHeartbeatIntervalSeconds: vi.fn().mockResolvedValue(300),
    getRegistrationPolicy: vi.fn().mockResolvedValue('auto'),
    isRoamingEnabled: vi.fn().mockResolvedValue(false),
  };
});
import { handleBootNotification } from '../handlers/v1_6/boot-notification.handler.js';

import { handleAuthorize } from '../handlers/v1_6/authorize.handler.js';
import { handleStartTransaction } from '../handlers/v1_6/start-transaction.handler.js';
import { handleStopTransaction } from '../handlers/v1_6/stop-transaction.handler.js';
import { handleStatusNotification } from '../handlers/v1_6/status-notification.handler.js';
import { handleMeterValues } from '../handlers/v1_6/meter-values.handler.js';
import { handleDataTransfer } from '../handlers/v1_6/data-transfer.handler.js';
import { handleDiagnosticsStatusNotification } from '../handlers/v1_6/diagnostics-status-notification.handler.js';
import { handleFirmwareStatusNotification } from '../handlers/v1_6/firmware-status-notification.handler.js';
import { handleHeartbeat } from '../handlers/v1_6/heartbeat.handler.js';

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
      ocppProtocol: 'ocpp1.6',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action,
    protocolVersion: 'ocpp1.6',
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

describe('OCPP 1.6 BootNotification handler', () => {
  it('emits ocpp.BootNotification with vendorName from chargePointVendor', async () => {
    const { ctx, publishMock } = makeCtx('BootNotification', {
      chargePointVendor: 'TestVendor',
      chargePointModel: 'TestModel',
      chargePointSerialNumber: 'SN-001',
      firmwareVersion: '1.0.0',
    });

    await handleBootNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.BootNotification',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
        payload: expect.objectContaining({
          vendorName: 'TestVendor',
          model: 'TestModel',
          serialNumber: 'SN-001',
          firmwareVersion: '1.0.0',
        }) as unknown,
      }),
    );
  });

  it('returns Accepted with interval 300', async () => {
    const { ctx } = makeCtx('BootNotification', {
      chargePointVendor: 'TestVendor',
      chargePointModel: 'TestModel',
    });

    const response = await handleBootNotification(ctx);

    expect(response).toHaveProperty('status', 'Accepted');
    expect(response).toHaveProperty('interval', 300);
    expect(response).toHaveProperty('currentTime');
  });
});

describe('OCPP 1.6 Authorize handler', () => {
  it('emits ocpp.Authorize with idToken from idTag', async () => {
    const { ctx, publishMock } = makeCtx('Authorize', {
      idTag: 'TAG-ABC',
    });

    await handleAuthorize(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.Authorize',
        aggregateType: 'Driver',
        aggregateId: 'TAG-ABC',
        payload: expect.objectContaining({
          idToken: 'TAG-ABC',
          tokenType: 'ISO14443',
          stationId: 'CS-001',
        }) as unknown,
      }),
    );
  });
});

describe('OCPP 1.6 StartTransaction handler', () => {
  it('emits ocpp.TransactionEvent with eventType Started and returns numeric transactionId', async () => {
    const { ctx, publishMock } = makeCtx('StartTransaction', {
      connectorId: 2,
      idTag: 'TAG-123',
      meterStart: 1000,
      timestamp: '2026-02-15T10:00:00Z',
    });

    const response = await handleStartTransaction(ctx);

    expect(typeof response.transactionId).toBe('number');
    expect(response.idTagInfo).toEqual({ status: 'Accepted' });

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.TransactionEvent',
        aggregateType: 'Transaction',
        payload: expect.objectContaining({
          eventType: 'Started',
          idToken: 'TAG-123',
          evseId: 2,
          meterStart: 1000,
          stationId: 'CS-001',
        }) as unknown,
      }),
    );
  });
});

describe('OCPP 1.6 StopTransaction handler', () => {
  it('emits ocpp.TransactionEvent with eventType Ended', async () => {
    const { ctx, publishMock } = makeCtx('StopTransaction', {
      transactionId: 42,
      timestamp: '2026-02-15T11:00:00Z',
      meterStop: 5000,
      reason: 'Local',
    });

    await handleStopTransaction(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.TransactionEvent',
        aggregateType: 'Transaction',
        aggregateId: '42',
        payload: expect.objectContaining({
          eventType: 'Ended',
          transactionId: '42',
          meterStop: 5000,
          stationId: 'CS-001',
        }) as unknown,
      }),
    );
  });

  it('returns idTagInfo when idTag is present', async () => {
    const { ctx } = makeCtx('StopTransaction', {
      transactionId: 42,
      timestamp: '2026-02-15T11:00:00Z',
      meterStop: 5000,
      idTag: 'TAG-123',
    });

    const response = await handleStopTransaction(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns empty object when idTag is absent', async () => {
    const { ctx } = makeCtx('StopTransaction', {
      transactionId: 42,
      timestamp: '2026-02-15T11:00:00Z',
      meterStop: 5000,
    });

    const response = await handleStopTransaction(ctx);

    expect(response).toEqual({});
  });
});

describe('OCPP 1.6 StatusNotification handler', () => {
  it('passes through Charging status unchanged', async () => {
    const { ctx, publishMock } = makeCtx('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Charging',
    });

    await handleStatusNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.StatusNotification',
        payload: expect.objectContaining({
          connectorStatus: 'Charging',
          evseId: 1,
        }) as unknown,
      }),
    );
  });

  it('maps Available to Available in event', async () => {
    const { ctx, publishMock } = makeCtx('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });

    await handleStatusNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.StatusNotification',
        payload: expect.objectContaining({
          connectorStatus: 'Available',
        }) as unknown,
      }),
    );
  });
});

describe('OCPP 1.6 MeterValues handler', () => {
  it('emits ocpp.MeterValues with evseId from connectorId', async () => {
    const { ctx, publishMock } = makeCtx('MeterValues', {
      connectorId: 3,
      meterValue: [
        {
          timestamp: '2026-02-15T10:30:00Z',
          sampledValue: [{ value: '1500', measurand: 'Energy.Active.Import.Register' }],
        },
      ],
    });

    await handleMeterValues(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.MeterValues',
        aggregateType: 'EVSE',
        aggregateId: 'CS-001',
        payload: expect.objectContaining({
          stationId: 'CS-001',
          evseId: 3,
        }) as unknown,
      }),
    );
  });
});

describe('OCPP 1.6 DataTransfer handler', () => {
  it('returns status UnknownVendorId', async () => {
    const { ctx } = makeCtx('DataTransfer', {
      vendorId: 'TestVendor',
      messageId: 'custom-msg',
      data: 'test-data',
    });

    const response = await handleDataTransfer(ctx);

    expect(response).toEqual({ status: 'UnknownVendorId' });
  });
});

describe('OCPP 1.6 DiagnosticsStatusNotification handler', () => {
  it('emits ocpp.DiagnosticsStatus', async () => {
    const { ctx, publishMock } = makeCtx('DiagnosticsStatusNotification', {
      status: 'Uploaded',
    });

    await handleDiagnosticsStatusNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.DiagnosticsStatus',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
        payload: expect.objectContaining({
          stationId: 'CS-001',
          status: 'Uploaded',
        }) as unknown,
      }),
    );
  });
});

describe('OCPP 1.6 FirmwareStatusNotification handler', () => {
  it('maps known status and publishes event', async () => {
    const { ctx, publishMock } = makeCtx('FirmwareStatusNotification', {
      status: 'Installed',
    });

    const response = await handleFirmwareStatusNotification(ctx);

    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.FirmwareStatusNotification',
        payload: expect.objectContaining({
          status: 'Installed',
        }) as unknown,
      }),
    );
  });

  it('passes through unknown status', async () => {
    const { ctx, publishMock } = makeCtx('FirmwareStatusNotification', {
      status: 'SomeNewStatus',
    });

    await handleFirmwareStatusNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: 'SomeNewStatus',
        }) as unknown,
      }),
    );
  });
});

describe('OCPP 1.6 Heartbeat handler', () => {
  it('returns currentTime', async () => {
    const { ctx } = makeCtx('Heartbeat', {});
    const response = await handleHeartbeat(ctx);
    expect(response).toHaveProperty('currentTime');
  });
});

describe('OCPP 1.6 StopTransaction handler - transactionData', () => {
  it('emits MeterValues when transactionData is present', async () => {
    const { ctx, publishMock } = makeCtx('StopTransaction', {
      transactionId: 42,
      timestamp: '2026-02-15T11:00:00Z',
      meterStop: 5000,
      transactionData: [{ timestamp: '2026-02-15T10:30:00Z', sampledValue: [{ value: '3000' }] }],
    });

    await handleStopTransaction(ctx);

    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.TransactionEvent' }),
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.MeterValues' }),
    );
  });
});

describe('OCPP 1.6 StatusNotification handler - passes through raw status', () => {
  const statuses = [
    'Available',
    'Preparing',
    'Charging',
    'SuspendedEVSE',
    'SuspendedEV',
    'Finishing',
    'Reserved',
    'Unavailable',
    'Faulted',
  ];

  for (const v16Status of statuses) {
    it(`passes through ${v16Status} unchanged`, async () => {
      const { ctx, publishMock } = makeCtx('StatusNotification', {
        connectorId: 1,
        errorCode: 'NoError',
        status: v16Status,
      });

      await handleStatusNotification(ctx);

      expect(publishMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            connectorStatus: v16Status,
          }) as unknown,
        }),
      );
    });
  }

  it('passes through unknown status as-is', async () => {
    const { ctx, publishMock } = makeCtx('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'SomeNewStatus',
    });

    await handleStatusNotification(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          connectorStatus: 'SomeNewStatus',
        }) as unknown,
      }),
    );
  });

  it('uses current time when timestamp is absent', async () => {
    const { ctx, publishMock } = makeCtx('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });

    await handleStatusNotification(ctx);

    const call = publishMock.mock.calls[0]?.[0] as { payload: { timestamp: string } };
    expect(call.payload.timestamp).toBeDefined();
  });
});

describe('OCPP 1.6 DataTransfer handler - publishes event', () => {
  it('publishes event with payload', async () => {
    const { ctx, publishMock } = makeCtx('DataTransfer', {
      vendorId: 'TestVendor',
      messageId: 'custom-msg',
      data: 'test-data',
    });

    await handleDataTransfer(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.DataTransfer',
        payload: expect.objectContaining({
          vendorId: 'TestVendor',
        }) as unknown,
      }),
    );
  });
});
