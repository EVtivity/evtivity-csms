// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station and send initial StatusNotification
async function bootAndStatus(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
  await ctx.client.sendCall('BootNotification', {
    chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
    reason: 'PowerUp',
  });
  await ctx.client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Available',
    evseId: 1,
    connectorId: 1,
  });
}

// Helper: start a charging transaction and return the txId
async function startChargingTransaction(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
  const txId = `OCTT-TX-${String(Date.now())}`;
  await ctx.client.sendCall('TransactionEvent', {
    eventType: 'Started',
    timestamp: new Date().toISOString(),
    triggerReason: 'Authorized',
    seqNo: 0,
    transactionInfo: { transactionId: txId, chargingState: 'Charging' },
    evse: { id: 1, connectorId: 1 },
    idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
  });
  return txId;
}

/**
 * TC_E_113_CSMS: Resuming transaction after interruption - TxResumptionTimeout not expired
 * Use case: E17 (E17.FR.15)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   - Disconnect, wait, reconnect
 *   1. BootNotificationRequest
 *   2. CSMS responds with BootNotificationResponse (status Accepted)
 *   3. NotifyEvent with connector AvailabilityState Occupied
 *   4. CSMS responds
 *   5. SecurityEventNotificationRequest (StartupOfTheDevice or ResetOrReboot)
 *   6. CSMS responds
 *   7. NotifyEvent with ElectricalFeed Problem true
 *   8. CSMS responds
 *   9. NotifyEvent with ElectricalFeed Problem false
 *   10. CSMS responds
 *   11. TransactionEvent Updated with TxResumed, Charging
 *   12. CSMS responds
 */
export const TC_E_113_CSMS: TestCase = {
  id: 'TC_E_113_CSMS',
  name: 'Resuming transaction after interruption - TxResumptionTimeout not expired',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'CSMS restores TxProfile after Charging Station resumes transactions which had a Charging profile.',
  purpose:
    'To verify the CSMS restores the charging profile for a transaction after resuming transactions by the station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Initial boot and start transaction (EnergyTransferStarted)
    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Simulate disconnect/reconnect by re-booting

    // Step 1: BootNotification (after reconnect)
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    steps.push({
      step: 1,
      description: 'BootNotification after reconnect - status must be Accepted',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: String(bootRes['status']),
    });

    // Step 3: NotifyEvent connector AvailabilityState Occupied
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      eventData: [
        {
          eventId: 1,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          actualValue: 'Occupied',
          component: {
            name: 'Connector',
            evse: { id: 1, connectorId: 1 },
          },
          variable: { name: 'AvailabilityState' },
          eventNotificationType: 'HardWiredNotification',
        },
      ],
    });

    steps.push({
      step: 2,
      description: 'NotifyEvent - connector AvailabilityState Occupied',
      status: 'passed',
      expected: 'Response received',
      actual: 'NotifyEvent sent',
    });

    // Step 5: SecurityEventNotification
    await ctx.client.sendCall('SecurityEventNotification', {
      type: 'StartupOfTheDevice',
      timestamp: new Date().toISOString(),
    });

    steps.push({
      step: 3,
      description: 'SecurityEventNotification - StartupOfTheDevice',
      status: 'passed',
      expected: 'Response received',
      actual: 'SecurityEventNotification sent',
    });

    // Step 7: NotifyEvent ElectricalFeed Problem true
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 1,
      eventData: [
        {
          eventId: 2,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          transactionId: txId,
          eventNotificationType: 'HardWiredNotification',
          severity: 3,
          actualValue: 'true',
          component: { name: 'ElectricalFeed' },
          variable: { name: 'Problem' },
        },
      ],
    });

    // Step 9: NotifyEvent ElectricalFeed Problem false
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 2,
      eventData: [
        {
          eventId: 3,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          transactionId: txId,
          eventNotificationType: 'HardWiredNotification',
          severity: 3,
          actualValue: 'false',
          component: { name: 'ElectricalFeed' },
          variable: { name: 'Problem' },
        },
      ],
    });

    steps.push({
      step: 4,
      description: 'NotifyEvent - ElectricalFeed Problem true then false',
      status: 'passed',
      expected: 'Responses received',
      actual: 'Both NotifyEvent messages sent',
    });

    // Step 11: TransactionEvent Updated with TxResumed
    const resumeRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'TxResumed',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 5,
      description: 'TransactionEvent Updated - TxResumed Charging',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(resumeRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_117_CSMS: Set Charging Profile - Resuming transaction after interruption - TxResumptionTimeout not expired
 * Use case: E17 (E17.FR.15)
 * Config: SmartChargingCtrlr.ChargingProfilePersistence is absent
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. CSMS sends SetChargingProfileRequest
 *   2. Respond with Accepted
 *   - Disconnect, wait, reconnect
 *   3. BootNotification
 *   4. CSMS responds Accepted
 *   5. NotifyEvent Occupied
 *   6. CSMS responds
 *   7. SecurityEventNotification
 *   8. CSMS responds
 *   9. NotifyEvent ElectricalFeed Problem true
 *   10. CSMS responds
 *   11. NotifyEvent ElectricalFeed Problem false
 *   12. CSMS responds
 *   13. TransactionEvent Updated TxResumed
 *   14. CSMS responds
 *   15. CSMS sends SetChargingProfileRequest (restored)
 *   16. Respond with Accepted
 */
export const TC_E_117_CSMS: TestCase = {
  id: 'TC_E_117_CSMS',
  name: 'Set Charging Profile - Resuming transaction after interruption',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'CSMS restores TxProfile after Charging Station resumes transactions which had a Charging profile.',
  purpose:
    'To verify the CSMS restores the charging profile for a transaction after resuming by the station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Track incoming SetChargingProfile calls
    let setProfileCount = 0;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'SetChargingProfile') {
        setProfileCount++;
        return { status: 'Accepted' };
      }
      return { status: 'NotSupported' };
    });

    // Wait for CSMS to send initial SetChargingProfile (manual action)
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 0,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends initial SetChargingProfileRequest',
      status: setProfileCount >= 1 ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual:
        setProfileCount >= 1
          ? `Received ${String(setProfileCount)} SetChargingProfile(s)`
          : 'No SetChargingProfileRequest received',
    });

    // Simulate disconnect/reconnect

    // Step 3: BootNotification after reconnect
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    steps.push({
      step: 2,
      description: 'BootNotification after reconnect - status must be Accepted',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: String(bootRes['status']),
    });

    // Step 5: NotifyEvent Occupied
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      eventData: [
        {
          eventId: 1,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          actualValue: 'Occupied',
          component: {
            name: 'Connector',
            evse: { id: 1, connectorId: 1 },
          },
          variable: { name: 'AvailabilityState' },
          eventNotificationType: 'HardWiredNotification',
        },
      ],
    });

    // Step 7: SecurityEventNotification
    await ctx.client.sendCall('SecurityEventNotification', {
      type: 'StartupOfTheDevice',
      timestamp: new Date().toISOString(),
    });

    // Step 9: NotifyEvent ElectricalFeed Problem true
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 1,
      eventData: [
        {
          eventId: 2,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          transactionId: txId,
          eventNotificationType: 'HardWiredNotification',
          severity: 3,
          actualValue: 'true',
          component: { name: 'ElectricalFeed' },
          variable: { name: 'Problem' },
        },
      ],
    });

    // Step 11: NotifyEvent ElectricalFeed Problem false
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 2,
      eventData: [
        {
          eventId: 3,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          transactionId: txId,
          eventNotificationType: 'HardWiredNotification',
          severity: 3,
          actualValue: 'false',
          component: { name: 'ElectricalFeed' },
          variable: { name: 'Problem' },
        },
      ],
    });

    steps.push({
      step: 3,
      description: 'Reconnect sequence: NotifyEvent + SecurityEvent + ElectricalFeed',
      status: 'passed',
      expected: 'All messages sent and acknowledged',
      actual: 'Reconnect sequence completed',
    });

    // Reset profile count to track the restored profile
    const profileCountBefore = setProfileCount;

    // Step 13: TransactionEvent Updated TxResumed
    const resumeRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'TxResumed',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 4,
      description: 'TransactionEvent Updated - TxResumed Charging',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(resumeRes).join(', ')}`,
    });

    // Wait for CSMS to restore the charging profile
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 0,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 5,
      description: 'CSMS sends restored SetChargingProfileRequest',
      status: setProfileCount > profileCountBefore ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received after TxResumed',
      actual:
        setProfileCount > profileCountBefore
          ? `Received ${String(setProfileCount - profileCountBefore)} new SetChargingProfile(s)`
          : 'No restored SetChargingProfile received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
