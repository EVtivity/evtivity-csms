// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';
import * as notifyReportHandlerModule from '../../../handlers/v2_1/notify-report.handler.js';

const logger = pino({ level: 'silent' });

function makeCtx(payload: Record<string, unknown>): {
  ctx: HandlerContext;
  publishMock: ReturnType<typeof vi.fn>;
  sendCommandMock: ReturnType<typeof vi.fn>;
} {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const sendCommandMock = vi.fn().mockResolvedValue(undefined);
  const ctx: HandlerContext = {
    stationId: 'CS-001',
    stationDbId: 'sta_db_1',
    session: {
      stationId: 'CS-001',
      stationDbId: 'sta_db_1',
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action: 'NotifyReport',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn(), drain: vi.fn(), track: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: { sendCommand: sendCommandMock } as unknown as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock, sendCommandMock };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2_1 NotifyReport handler', () => {
  it('publishes ocpp.NotifyReport with the report metadata and returns empty', async () => {
    const { handleNotifyReport } = notifyReportHandlerModule;
    const reportData = [{ component: { name: 'X' }, variable: { name: 'Y' } }];
    const { ctx, publishMock } = makeCtx({
      requestId: 42,
      generatedAt: '2026-06-04T00:00:00Z',
      seqNo: 0,
      tbc: false,
      reportData,
    });
    const response = await handleNotifyReport(ctx);

    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.NotifyReport',
      aggregateType: 'ChargingStation',
      aggregateId: 'CS-001',
      payload: {
        stationId: 'CS-001',
        stationDbId: 'sta_db_1',
        requestId: 42,
        generatedAt: '2026-06-04T00:00:00Z',
        seqNo: 0,
        tbc: false,
        reportData,
      },
    });
  });

  it('does not send a command when reportData is absent', async () => {
    const { handleNotifyReport } = notifyReportHandlerModule;
    const { ctx, sendCommandMock } = makeCtx({
      requestId: 1,
      generatedAt: '2026-06-04T00:00:00Z',
      seqNo: 0,
    });
    await handleNotifyReport(ctx);

    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('does not send a command when MaxExternalConstraintsId is not in the report', async () => {
    const { handleNotifyReport } = notifyReportHandlerModule;
    const { ctx, sendCommandMock } = makeCtx({
      requestId: 1,
      generatedAt: '2026-06-04T00:00:00Z',
      seqNo: 0,
      reportData: [
        {
          component: { name: 'SmartChargingCtrlr' },
          variable: { name: 'OtherVar' },
          variableAttribute: [{ value: '5' }],
        },
      ],
    });
    await handleNotifyReport(ctx);

    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('sends SetChargingProfile with the reported MaxExternalConstraintsId', async () => {
    const { handleNotifyReport } = notifyReportHandlerModule;
    const { ctx, sendCommandMock } = makeCtx({
      requestId: 1,
      generatedAt: '2026-06-04T00:00:00Z',
      seqNo: 0,
      reportData: [
        {
          component: { name: 'SmartChargingCtrlr' },
          variable: { name: 'MaxExternalConstraintsId' },
          variableAttribute: [{ value: '77' }],
        },
      ],
    });
    await handleNotifyReport(ctx);

    expect(sendCommandMock).toHaveBeenCalledWith(
      'CS-001',
      'SetChargingProfile',
      expect.objectContaining({
        evseId: 0,
        chargingProfile: expect.objectContaining({
          id: 77,
          chargingProfilePurpose: 'ChargingStationExternalConstraints',
        }) as unknown,
      }),
    );
  });

  it('does not send a command when MaxExternalConstraintsId is not a number', async () => {
    const { handleNotifyReport } = notifyReportHandlerModule;
    const { ctx, sendCommandMock } = makeCtx({
      requestId: 1,
      generatedAt: '2026-06-04T00:00:00Z',
      seqNo: 0,
      reportData: [
        {
          component: { name: 'SmartChargingCtrlr' },
          variable: { name: 'MaxExternalConstraintsId' },
          variableAttribute: [{ value: 'not-a-number' }],
        },
      ],
    });
    await handleNotifyReport(ctx);

    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('handles a report entry with no variableAttribute (value resolves null)', async () => {
    const { handleNotifyReport } = notifyReportHandlerModule;
    const { ctx, sendCommandMock } = makeCtx({
      requestId: 1,
      generatedAt: '2026-06-04T00:00:00Z',
      seqNo: 0,
      reportData: [
        {
          component: { name: 'SmartChargingCtrlr' },
          variable: { name: 'MaxExternalConstraintsId' },
        },
      ],
    });
    await handleNotifyReport(ctx);

    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('swallows a dispatcher.sendCommand failure and still returns empty', async () => {
    const { handleNotifyReport } = notifyReportHandlerModule;
    const { ctx, sendCommandMock } = makeCtx({
      requestId: 1,
      generatedAt: '2026-06-04T00:00:00Z',
      seqNo: 0,
      reportData: [
        {
          component: { name: 'SmartChargingCtrlr' },
          variable: { name: 'MaxExternalConstraintsId' },
          variableAttribute: [{ value: '12' }],
        },
      ],
    });
    sendCommandMock.mockRejectedValue(new Error('station offline'));
    const response = await handleNotifyReport(ctx);

    expect(response).toEqual({});
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
  });

  it('treats an empty reportData array as no constraints to apply', async () => {
    const { handleNotifyReport } = notifyReportHandlerModule;
    const { ctx, sendCommandMock } = makeCtx({
      requestId: 1,
      generatedAt: '2026-06-04T00:00:00Z',
      seqNo: 0,
      reportData: [],
    });
    await handleNotifyReport(ctx);

    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});
