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
      readyAnnounced: false,
    },
    protocolVersion,
    messageId: 'msg-1',
    action,
    payload,
    logger,
    eventBus: { publish: vi.fn(), subscribe: vi.fn(), drain: vi.fn(), track: vi.fn() },
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

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'treats the Object.prototype name %s as an action not in the registry',
    async (action) => {
      for (const version of ['ocpp2.1', 'ocpp1.6']) {
        const next = vi.fn();
        await validateMiddleware(makeCtx(action, {}, version), next);
        expect(next).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('throws OccurrenceConstraintViolation for missing required field', async () => {
    const ctx = makeCtx('BootNotification', {});
    const next = vi.fn();

    await expect(validateMiddleware(ctx, next)).rejects.toThrow(OcppError);

    try {
      await validateMiddleware(ctx, next);
    } catch (err) {
      const ocppErr = err as OcppError;
      expect(ocppErr.errorCode).toBe('OccurrenceConstraintViolation');
    }
  });

  it('throws TypeConstraintViolation for wrong primitive type', async () => {
    const ctx = makeCtx('BootNotification', {
      chargingStation: { vendorName: 'V', model: 'M' },
      reason: 123,
    });
    const next = vi.fn();

    try {
      await validateMiddleware(ctx, next);
      throw new Error('expected throw');
    } catch (err) {
      const ocppErr = err as OcppError;
      expect(ocppErr.errorCode).toBe('TypeConstraintViolation');
    }
  });

  it('throws PropertyConstraintViolation for invalid enum value', async () => {
    const ctx = makeCtx('BootNotification', {
      chargingStation: { vendorName: 'V', model: 'M' },
      reason: 'NotARealReason',
    });
    const next = vi.fn();

    try {
      await validateMiddleware(ctx, next);
      throw new Error('expected throw');
    } catch (err) {
      const ocppErr = err as OcppError;
      expect(ocppErr.errorCode).toBe('PropertyConstraintViolation');
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

  it('throws InternalError when handler produces an invalid response', async () => {
    const ctx = makeCtx('Heartbeat', {});
    ctx.logger = logger;
    const next = vi.fn().mockImplementation(async () => {
      ctx.response = { invalidField: true };
    });

    try {
      await validateMiddleware(ctx, next);
      throw new Error('expected throw');
    } catch (err) {
      const ocppErr = err as OcppError;
      expect(ocppErr.errorCode).toBe('InternalError');
    }
    expect(next).toHaveBeenCalled();
  });

  it('throws OcppError for invalid 1.6 BootNotification', async () => {
    const ctx = makeCtx('BootNotification', {}, 'ocpp1.6');
    const next = vi.fn();

    await expect(validateMiddleware(ctx, next)).rejects.toThrow(OcppError);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('validateMiddleware on an OCPP 2.0.1 connection', () => {
  const monitoringReport201 = {
    requestId: 1,
    seqNo: 0,
    generatedAt: '2026-10-17T10:00:00.000Z',
    monitor: [
      {
        component: { name: 'EVSE' },
        variable: { name: 'Power' },
        variableMonitoring: [
          { id: 1, transaction: false, value: 10, type: 'UpperThreshold', severity: 5 },
        ],
      },
    ],
  };
  const authorizeRequest = { idToken: { idToken: 'TAG1', type: 'ISO14443' } };

  it('accepts a 2.0.1 NotifyMonitoringReport without eventNotificationType', async () => {
    const next = vi.fn();

    await validateMiddleware(
      makeCtx('NotifyMonitoringReport', monitoringReport201, 'ocpp2.0.1'),
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('still refuses the same report on a 2.1 connection', async () => {
    const next = vi.fn();

    await expect(
      validateMiddleware(makeCtx('NotifyMonitoringReport', monitoringReport201, 'ocpp2.1'), next),
    ).rejects.toMatchObject({ errorCode: 'OccurrenceConstraintViolation' });
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a request field the 2.0.1 schema does not define', async () => {
    const ctx = makeCtx('Heartbeat', { extra: 1 }, 'ocpp2.0.1');

    await expect(validateMiddleware(ctx, vi.fn())).rejects.toMatchObject({
      errorCode: 'PropertyConstraintViolation',
    });
  });

  it('removes 2.1-only fields from the reply before it is sent', async () => {
    const ctx = makeCtx('Authorize', authorizeRequest, 'ocpp2.0.1');
    const next = vi.fn().mockImplementation(async () => {
      ctx.response = {
        idTokenInfo: { status: 'Accepted' },
        tariff: { tariffId: 't1', currency: 'EUR' },
        allowedEnergyTransfer: ['AC_single_phase'],
      };
    });

    await validateMiddleware(ctx, next);

    expect(ctx.response).toEqual({ idTokenInfo: { status: 'Accepted' } });
  });

  it('keeps the reply unchanged on a 2.1 connection', async () => {
    const ctx = makeCtx('Authorize', authorizeRequest, 'ocpp2.1');
    const response = {
      idTokenInfo: { status: 'Accepted' },
      allowedEnergyTransfer: ['AC_single_phase'],
    };
    const next = vi.fn().mockImplementation(async () => {
      ctx.response = response;
    });

    await validateMiddleware(ctx, next);

    expect(ctx.response).toBe(response);
  });

  it('answers InternalError for a reply the fit cannot repair', async () => {
    const ctx = makeCtx(
      'Get15118EVCertificate',
      { iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef', action: 'Install', exiRequest: 'AA' },
      'ocpp2.0.1',
    );
    const next = vi.fn().mockImplementation(async () => {
      // 2.0.1 allows 5600 characters, 2.1 allows 17000: cutting an EXI stream would break it.
      ctx.response = { status: 'Accepted', exiResponse: 'A'.repeat(5601) };
    });

    await expect(validateMiddleware(ctx, next)).rejects.toMatchObject({
      errorCode: 'InternalError',
    });
  });

  it('leaves out a group token outside the 2.0.1 token types instead of failing the reply', async () => {
    const ctx = makeCtx('Authorize', authorizeRequest, 'ocpp2.0.1');
    const next = vi.fn().mockImplementation(async () => {
      ctx.response = {
        idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'G1', type: 'DirectPayment' } },
      };
    });

    await validateMiddleware(ctx, next);

    expect(ctx.response).toEqual({ idTokenInfo: { status: 'Accepted' } });
  });

  it('sends a 2.0.1 station a TransactionEvent reply without the 2.1-only fields', async () => {
    const event = {
      eventType: 'Updated',
      timestamp: '2026-10-17T10:00:00Z',
      triggerReason: 'MeterValuePeriodic',
      seqNo: 2,
      transactionInfo: { transactionId: 'T1' },
    };
    const ctx = makeCtx('TransactionEvent', event, 'ocpp2.0.1');
    const handlerReply = {
      totalCost: 3.2,
      transactionLimit: { maxCost: 20 },
      updatedPersonalMessage: { format: 'QRCODE', content: 'https://pay.example/1' },
      updatedPersonalMessageExtra: [{ format: 'UTF8', language: 'de', content: 'Hallo' }],
    };
    const next = vi.fn().mockImplementation(async () => {
      ctx.response = handlerReply;
    });

    await validateMiddleware(ctx, next);

    expect(ctx.response).toEqual({ totalCost: 3.2 });
    expect(handlerReply).toHaveProperty('transactionLimit');
  });

  it('refuses a negative evseId from a 2.0.1 station before any handler runs', async () => {
    const next = vi.fn();
    const status = {
      timestamp: '2026-10-17T10:00:00Z',
      connectorStatus: 'Available',
      evseId: -1,
      connectorId: 1,
    };

    await expect(
      validateMiddleware(makeCtx('StatusNotification', status, 'ocpp2.0.1'), next),
    ).rejects.toMatchObject({ errorCode: 'PropertyConstraintViolation' });
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a negative seqNo in a 2.0.1 TransactionEvent', async () => {
    const next = vi.fn();
    const event = {
      eventType: 'Started',
      timestamp: '2026-10-17T10:00:00Z',
      triggerReason: 'Authorized',
      seqNo: -1,
      transactionInfo: { transactionId: 'T1' },
    };

    await expect(
      validateMiddleware(makeCtx('TransactionEvent', event, 'ocpp2.0.1'), next),
    ).rejects.toMatchObject({ errorCode: 'PropertyConstraintViolation' });
    expect(next).not.toHaveBeenCalled();
  });
});
