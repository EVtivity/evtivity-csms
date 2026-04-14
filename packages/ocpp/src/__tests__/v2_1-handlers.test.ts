// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';

// Mock isPncEnabled to return true for certificate handler tests
vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isPncEnabled: vi.fn().mockResolvedValue(true),
  };
});

// Mock PKI provider for SignCertificate handler
vi.mock('../services/pki/index.js', () => ({
  getPkiProvider: vi.fn().mockResolvedValue({
    signCsr: vi.fn().mockResolvedValue({
      certificateChain: 'mock-chain',
      providerReference: 'mock-ref',
    }),
    getContractCertificate: vi.fn().mockResolvedValue({
      status: 'Accepted',
      exiResponse: 'mock-exi',
    }),
    getOcspStatus: vi.fn().mockResolvedValue({
      status: 'Accepted',
      ocspResult: 'mock-ocsp',
    }),
    getRootCertificates: vi.fn().mockResolvedValue([]),
  }),
}));

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

describe('BatterySwap handler', () => {
  it('publishes event and returns Accepted', async () => {
    const { handleBatterySwap } = await import('../handlers/v2_1/battery-swap.handler.js');
    const { ctx, publishMock } = makeCtx('BatterySwap', {
      eventType: 'Started',
      transactionId: 'tx-1',
      idToken: { idToken: 'token-1', type: 'ISO14443' },
    });
    const response = await handleBatterySwap(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.BatterySwap' }),
    );
  });
});

describe('ClearedChargingLimit handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleClearedChargingLimit } =
      await import('../handlers/v2_1/cleared-charging-limit.handler.js');
    const { ctx, publishMock } = makeCtx('ClearedChargingLimit', {
      chargingLimitSource: 'EMS',
      evseId: 1,
    });
    const response = await handleClearedChargingLimit(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.ClearedChargingLimit' }),
    );
  });
});

describe('FirmwareStatusNotification handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleFirmwareStatusNotification } =
      await import('../handlers/v2_1/firmware-status-notification.handler.js');
    const { ctx, publishMock } = makeCtx('FirmwareStatusNotification', {
      status: 'Installed',
      requestId: 42,
    });
    const response = await handleFirmwareStatusNotification(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.FirmwareStatusNotification' }),
    );
  });
});

describe('Get15118EVCertificate handler', () => {
  it('publishes event and returns Accepted with empty exiResponse', async () => {
    const { handleGet15118EVCertificate } =
      await import('../handlers/v2_1/get-15118-ev-certificate.handler.js');
    const { ctx, publishMock } = makeCtx('Get15118EVCertificate', {
      iso15118SchemaVersion: '2',
      action: 'Install',
      exiRequest: 'base64data',
    });
    const response = await handleGet15118EVCertificate(ctx);
    expect(response).toEqual({ status: 'Accepted', exiResponse: 'mock-exi' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.Get15118EVCertificate' }),
    );
  });
});

describe('GetCertificateChainStatus handler', () => {
  it('publishes event and returns certificateStatus array', async () => {
    const { handleGetCertificateChainStatus } =
      await import('../handlers/v2_1/get-certificate-chain-status.handler.js');
    const { ctx, publishMock } = makeCtx('GetCertificateChainStatus', {
      certificateStatusRequests: [
        {
          source: 'OCSP',
          urls: ['http://ocsp.example.com'],
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash: 'abc',
            issuerKeyHash: 'def',
            serialNumber: '123',
          },
        },
      ],
    });
    const response = await handleGetCertificateChainStatus(ctx);
    expect(response).toHaveProperty('certificateStatus');
    const status = response['certificateStatus'] as Array<Record<string, unknown>>;
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      source: 'OCSP',
      status: 'Unknown',
      certificateHashData: {
        hashAlgorithm: 'SHA256',
        issuerNameHash: 'abc',
        issuerKeyHash: 'def',
        serialNumber: '123',
      },
    });
    expect(status[0]).toHaveProperty('nextUpdate');
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.GetCertificateChainStatus' }),
    );
  });
});

describe('GetCertificateStatus handler', () => {
  it('publishes event and returns Accepted', async () => {
    const { handleGetCertificateStatus } =
      await import('../handlers/v2_1/get-certificate-status.handler.js');
    const { ctx, publishMock } = makeCtx('GetCertificateStatus', {
      ocspRequestData: { hashAlgorithm: 'SHA256' },
    });
    const response = await handleGetCertificateStatus(ctx);
    expect(response).toEqual({ status: 'Accepted', ocspResult: 'mock-ocsp' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.GetCertificateStatus' }),
    );
  });
});

describe('LogStatusNotification handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleLogStatusNotification } =
      await import('../handlers/v2_1/log-status-notification.handler.js');
    const { ctx, publishMock } = makeCtx('LogStatusNotification', {
      status: 'Uploaded',
      requestId: 1,
    });
    const response = await handleLogStatusNotification(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.LogStatusNotification' }),
    );
  });
});

describe('MeterValues handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleMeterValues } = await import('../handlers/v2_1/meter-values.handler.js');
    const { ctx, publishMock } = makeCtx('MeterValues', {
      evseId: 1,
      meterValue: [{ timestamp: '2024-01-01T00:00:00Z', sampledValue: [] }],
    });
    const response = await handleMeterValues(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.MeterValues' }),
    );
  });
});

describe('NotifyAllowedEnergyTransfer handler', () => {
  it('publishes event and returns Accepted', async () => {
    const { handleNotifyAllowedEnergyTransfer } =
      await import('../handlers/v2_1/notify-allowed-energy-transfer.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyAllowedEnergyTransfer', {
      allowedEnergyTransfer: ['AC_single_phase'],
    });
    const response = await handleNotifyAllowedEnergyTransfer(ctx);
    expect(response).toEqual({ status: 'Accepted' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyAllowedEnergyTransfer' }),
    );
  });
});

describe('NotifyChargingLimit handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyChargingLimit } =
      await import('../handlers/v2_1/notify-charging-limit.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyChargingLimit', {
      chargingLimit: { chargingLimitSource: 'EMS' },
    });
    const response = await handleNotifyChargingLimit(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyChargingLimit' }),
    );
  });
});

describe('NotifyCustomerInformation handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyCustomerInformation } =
      await import('../handlers/v2_1/notify-customer-information.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyCustomerInformation', {
      data: 'customer-info',
      seqNo: 0,
      generatedAt: '2024-01-01T00:00:00Z',
      requestId: 1,
    });
    const response = await handleNotifyCustomerInformation(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyCustomerInformation' }),
    );
  });
});

describe('NotifyDERAlarm handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyDERAlarm } = await import('../handlers/v2_1/notify-der-alarm.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyDERAlarm', {
      controlType: 'FreqDroop',
      gridEventFault: 'OverVoltage',
      timestamp: '2024-01-01T00:00:00Z',
    });
    const response = await handleNotifyDERAlarm(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyDERAlarm' }),
    );
  });
});

describe('NotifyDERStartStop handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyDERStartStop } =
      await import('../handlers/v2_1/notify-der-start-stop.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyDERStartStop', {
      controlType: 'FreqDroop',
      started: true,
      timestamp: '2024-01-01T00:00:00Z',
    });
    const response = await handleNotifyDERStartStop(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyDERStartStop' }),
    );
  });
});

describe('NotifyDisplayMessages handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyDisplayMessages } =
      await import('../handlers/v2_1/notify-display-messages.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyDisplayMessages', {
      requestId: 1,
      messageInfo: [{ id: 1, priority: 'AlwaysFront', message: { content: 'test' } }],
    });
    const response = await handleNotifyDisplayMessages(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyDisplayMessages' }),
    );
  });
});

describe('NotifyEVChargingNeeds handler', () => {
  it('publishes event and returns NoChargingProfile', async () => {
    const { handleNotifyEVChargingNeeds } =
      await import('../handlers/v2_1/notify-ev-charging-needs.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyEVChargingNeeds', {
      evseId: 1,
      chargingNeeds: { requestedEnergyTransfer: 'AC_single_phase' },
    });
    const response = await handleNotifyEVChargingNeeds(ctx);
    expect(response).toEqual({ status: 'NoChargingProfile' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyEVChargingNeeds' }),
    );
  });
});

describe('NotifyEVChargingSchedule handler', () => {
  it('publishes event and returns Accepted', async () => {
    const { handleNotifyEVChargingSchedule } =
      await import('../handlers/v2_1/notify-ev-charging-schedule.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyEVChargingSchedule', {
      timeBase: '2024-01-01T00:00:00Z',
      evseId: 1,
      chargingSchedule: { id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [] },
    });
    const response = await handleNotifyEVChargingSchedule(ctx);
    expect(response).toEqual({ status: 'Accepted' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyEVChargingSchedule' }),
    );
  });
});

describe('NotifyEvent handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyEvent } = await import('../handlers/v2_1/notify-event.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyEvent', {
      generatedAt: '2024-01-01T00:00:00Z',
      seqNo: 0,
      eventData: [{ eventId: 1, timestamp: '2024-01-01T00:00:00Z', trigger: 'Alerting' }],
    });
    const response = await handleNotifyEvent(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyEvent' }),
    );
  });
});

describe('NotifyMonitoringReport handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyMonitoringReport } =
      await import('../handlers/v2_1/notify-monitoring-report.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyMonitoringReport', {
      requestId: 1,
      seqNo: 0,
      generatedAt: '2024-01-01T00:00:00Z',
    });
    const response = await handleNotifyMonitoringReport(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyMonitoringReport' }),
    );
  });
});

describe('NotifyPeriodicEventStream handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyPeriodicEventStream } =
      await import('../handlers/v2_1/notify-periodic-event-stream.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyPeriodicEventStream', {
      id: 1,
      data: [{ timestamp: '2024-01-01T00:00:00Z' }],
    });
    const response = await handleNotifyPeriodicEventStream(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyPeriodicEventStream' }),
    );
  });
});

describe('NotifyPriorityCharging handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyPriorityCharging } =
      await import('../handlers/v2_1/notify-priority-charging.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyPriorityCharging', {
      transactionId: 'tx-1',
      activated: true,
    });
    const response = await handleNotifyPriorityCharging(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyPriorityCharging' }),
    );
  });
});

describe('NotifyQRCodeScanned handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyQRCodeScanned } =
      await import('../handlers/v2_1/notify-qr-code-scanned.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyQRCodeScanned', {
      evseId: 1,
      timeout: 30,
    });
    const response = await handleNotifyQRCodeScanned(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyQRCodeScanned' }),
    );
  });
});

describe('NotifyReport handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyReport } = await import('../handlers/v2_1/notify-report.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyReport', {
      requestId: 1,
      generatedAt: '2024-01-01T00:00:00Z',
      seqNo: 0,
    });
    const response = await handleNotifyReport(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyReport' }),
    );
  });

  it('sends SetChargingProfile when MaxExternalConstraintsId is reported', async () => {
    const { handleNotifyReport } = await import('../handlers/v2_1/notify-report.handler.js');
    const sendCommandMock = vi.fn().mockResolvedValue({ status: 'Accepted' });
    const { ctx } = makeCtx('NotifyReport', {
      requestId: 1,
      generatedAt: '2024-01-01T00:00:00Z',
      seqNo: 0,
      reportData: [
        {
          component: { name: 'SmartChargingCtrlr' },
          variable: { name: 'MaxExternalConstraintsId' },
          variableAttribute: [{ value: '2147400000' }],
        },
      ],
    });
    ctx.dispatcher = { sendCommand: sendCommandMock } as unknown as HandlerContext['dispatcher'];
    const response = await handleNotifyReport(ctx);
    expect(response).toEqual({});
    expect(sendCommandMock).toHaveBeenCalledWith(
      'CS-001',
      'SetChargingProfile',
      expect.objectContaining({
        evseId: 0,
        chargingProfile: expect.objectContaining({
          id: 2147400000,
          chargingProfilePurpose: 'ChargingStationExternalConstraints',
        }),
      }),
    );
  });
});

describe('NotifySettlement handler', () => {
  it('publishes event and returns Accepted', async () => {
    const { handleNotifySettlement } =
      await import('../handlers/v2_1/notify-settlement.handler.js');
    const { ctx, publishMock } = makeCtx('NotifySettlement', {
      pspRef: 'psp-123',
      status: 'Received',
      transactionId: 'tx-1',
    });
    const response = await handleNotifySettlement(ctx);
    expect(response).toEqual({ receiptUrl: expect.stringContaining('tx-1') });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifySettlement' }),
    );
  });
});

describe('NotifyWebPaymentStarted handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleNotifyWebPaymentStarted } =
      await import('../handlers/v2_1/notify-web-payment-started.handler.js');
    const { ctx, publishMock } = makeCtx('NotifyWebPaymentStarted', {
      evseId: 1,
      timeout: 60,
    });
    const response = await handleNotifyWebPaymentStarted(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.NotifyWebPaymentStarted' }),
    );
  });
});

describe('PublishFirmwareStatusNotification handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handlePublishFirmwareStatusNotification } =
      await import('../handlers/v2_1/publish-firmware-status-notification.handler.js');
    const { ctx, publishMock } = makeCtx('PublishFirmwareStatusNotification', {
      status: 'Published',
      requestId: 1,
    });
    const response = await handlePublishFirmwareStatusNotification(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.PublishFirmwareStatusNotification' }),
    );
  });
});

describe('PullDynamicScheduleUpdate handler', () => {
  it('publishes event and returns Accepted', async () => {
    const { handlePullDynamicScheduleUpdate } =
      await import('../handlers/v2_1/pull-dynamic-schedule-update.handler.js');
    const { ctx, publishMock } = makeCtx('PullDynamicScheduleUpdate', {
      chargingProfileId: 1,
    });
    const response = await handlePullDynamicScheduleUpdate(ctx);
    expect(response).toEqual({ status: 'Rejected' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.PullDynamicScheduleUpdate' }),
    );
  });
});

describe('ReportChargingProfiles handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleReportChargingProfiles } =
      await import('../handlers/v2_1/report-charging-profiles.handler.js');
    const { ctx, publishMock } = makeCtx('ReportChargingProfiles', {
      requestId: 1,
      chargingLimitSource: 'EMS',
      chargingProfile: [],
      evseId: 1,
    });
    const response = await handleReportChargingProfiles(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.ReportChargingProfiles' }),
    );
  });
});

describe('ReportDERControl handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleReportDERControl } =
      await import('../handlers/v2_1/report-der-control.handler.js');
    const { ctx, publishMock } = makeCtx('ReportDERControl', {
      requestId: 1,
      derControlStatus: [],
    });
    const response = await handleReportDERControl(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.ReportDERControl' }),
    );
  });
});

describe('ReservationStatusUpdate handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleReservationStatusUpdate } =
      await import('../handlers/v2_1/reservation-status-update.handler.js');
    const { ctx, publishMock } = makeCtx('ReservationStatusUpdate', {
      reservationId: 1,
      reservationUpdateStatus: 'Expired',
    });
    const response = await handleReservationStatusUpdate(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.ReservationStatusUpdate' }),
    );
  });
});

describe('SecurityEventNotification handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleSecurityEventNotification } =
      await import('../handlers/v2_1/security-event-notification.handler.js');
    const { ctx, publishMock } = makeCtx('SecurityEventNotification', {
      type: 'FirmwareUpdated',
      timestamp: '2024-01-01T00:00:00Z',
    });
    const response = await handleSecurityEventNotification(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.SecurityEventNotification' }),
    );
  });
});

describe('SignCertificate handler', () => {
  it('publishes event and returns Accepted', async () => {
    const { handleSignCertificate } = await import('../handlers/v2_1/sign-certificate.handler.js');
    const { ctx, publishMock } = makeCtx('SignCertificate', {
      csr: 'certificate-signing-request',
    });
    const response = await handleSignCertificate(ctx);
    expect(response).toEqual({ status: 'Accepted' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.SignCertificate' }),
    );
  });

  it('accepts ChargingStationCertificate even when PnC is disabled', async () => {
    // Override isPncEnabled to return false for this test
    const { isPncEnabled } = await import('@evtivity/database');
    vi.mocked(isPncEnabled).mockResolvedValueOnce(false);

    const { handleSignCertificate } = await import('../handlers/v2_1/sign-certificate.handler.js');
    const { ctx } = makeCtx('SignCertificate', {
      csr: 'csr-data',
      certificateType: 'ChargingStationCertificate',
    });
    const response = await handleSignCertificate(ctx);
    expect(response).toEqual({ status: 'Accepted' });
  });

  it('rejects V2GCertificate when PnC is disabled', async () => {
    const { isPncEnabled } = await import('@evtivity/database');
    vi.mocked(isPncEnabled).mockResolvedValueOnce(false);

    const { handleSignCertificate } = await import('../handlers/v2_1/sign-certificate.handler.js');
    const { ctx } = makeCtx('SignCertificate', {
      csr: 'csr-data',
      certificateType: 'V2GCertificate',
    });
    const response = await handleSignCertificate(ctx);
    expect(response).toEqual({ status: 'Rejected' });
  });
});

describe('StatusNotification handler', () => {
  it('publishes event and returns empty object', async () => {
    const { handleStatusNotification } =
      await import('../handlers/v2_1/status-notification.handler.js');
    const { ctx, publishMock } = makeCtx('StatusNotification', {
      timestamp: '2024-01-01T00:00:00Z',
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });
    const response = await handleStatusNotification(ctx);
    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.StatusNotification' }),
    );
  });
});

describe('TransactionEvent handler', () => {
  it('returns idTokenInfo Accepted for Started events with idToken', async () => {
    const { handleTransactionEvent } =
      await import('../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx('TransactionEvent', {
      eventType: 'Started',
      timestamp: '2024-01-01T00:00:00Z',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-1' },
      idToken: { idToken: 'TEST-TOKEN-001', type: 'ISO14443' },
    });
    const response = await handleTransactionEvent(ctx);
    expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.TransactionEvent' }),
    );
  });

  it('returns empty object for Updated events', async () => {
    const { handleTransactionEvent } =
      await import('../handlers/v2_1/transaction-event.handler.js');
    const { ctx } = makeCtx('TransactionEvent', {
      eventType: 'Updated',
      timestamp: '2024-01-01T00:30:00Z',
      triggerReason: 'MeterValuePeriodic',
      seqNo: 1,
      transactionInfo: { transactionId: 'tx-1' },
    });
    const response = await handleTransactionEvent(ctx);
    expect(response).toEqual({});
  });

  it('emits ocpp.MeterValues when meterValue is present', async () => {
    const { handleTransactionEvent } =
      await import('../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx('TransactionEvent', {
      eventType: 'Updated',
      timestamp: '2024-01-01T00:30:00Z',
      triggerReason: 'MeterValuePeriodic',
      seqNo: 1,
      transactionInfo: { transactionId: 'tx-1' },
      evse: { id: 1 },
      meterValue: [
        {
          timestamp: '2024-01-01T00:30:00Z',
          sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: 5000 }],
        },
      ],
    });
    await handleTransactionEvent(ctx);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.MeterValues',
        payload: expect.objectContaining({ source: 'TransactionEvent' }),
      }),
    );
  });

  it('does not emit ocpp.MeterValues when meterValue is absent', async () => {
    const { handleTransactionEvent } =
      await import('../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx('TransactionEvent', {
      eventType: 'Started',
      timestamp: '2024-01-01T00:00:00Z',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-1' },
    });
    await handleTransactionEvent(ctx);
    const meterValuesCall = publishMock.mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'ocpp.MeterValues',
    );
    expect(meterValuesCall).toBeUndefined();
  });
});

describe('VatNumberValidation handler', () => {
  it('publishes event and returns Accepted', async () => {
    const { handleVatNumberValidation } =
      await import('../handlers/v2_1/vat-number-validation.handler.js');
    const { ctx, publishMock } = makeCtx('VatNumberValidation', {
      vatNumber: 'VAT123',
      evseId: 1,
    });
    const response = await handleVatNumberValidation(ctx);
    expect(response).toEqual({ status: 'Accepted', vatNumber: 'VAT123' });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ocpp.VatNumberValidation' }),
    );
  });
});
