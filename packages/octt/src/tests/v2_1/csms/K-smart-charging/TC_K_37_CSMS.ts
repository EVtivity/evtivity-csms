// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_K_37_CSMS: Remote start transaction with charging profile - Success
 * Use case: K05, F01 (K05.FR.02, F01.FR.08, F01.FR.09, F01.FR.11)
 */
export const TC_K_37_CSMS: TestCase = {
  id: 'TC_K_37_CSMS',
  name: 'Remote start transaction with charging profile - Success',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS sets a TxProfile on a specific EVSE inside a RequestStartTransactionRequest message.',
  purpose:
    'To verify if the CSMS is able to set a TxProfile on a specific EVSE in a RequestStartTransactionRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

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

    let receivedRemoteStart = false;
    let remoteStartPayload: Record<string, unknown> = {};
    let remoteStartId = 0;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'RequestStartTransaction') {
          receivedRemoteStart = true;
          remoteStartPayload = payload;
          remoteStartId = (payload['remoteStartId'] as number) ?? 1;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'RequestStartTransaction', {
        stationId: ctx.stationId,
        remoteStartId: 1,
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const profile = remoteStartPayload['chargingProfile'] as Record<string, unknown> | undefined;
    const purpose = profile?.['chargingProfilePurpose'];
    const txIdInProfile = profile?.['transactionId'];

    steps.push({
      step: 1,
      description: 'CSMS sends RequestStartTransactionRequest with chargingProfile',
      status: receivedRemoteStart ? 'passed' : 'failed',
      expected: 'RequestStartTransactionRequest with TxProfile, transactionId omitted',
      actual: receivedRemoteStart
        ? `purpose=${String(purpose)}, transactionId=${String(txIdInProfile)}`
        : 'Not received',
    });

    // Send TransactionEvent Started with RemoteStart
    if (receivedRemoteStart) {
      const txId = `OCTT-TX-${String(Date.now())}`;
      const res = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'RemoteStart',
        seqNo: 0,
        transactionInfo: {
          transactionId: txId,
          chargingState: 'Charging',
          remoteStartId,
        },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      });

      steps.push({
        step: 2,
        description: 'TransactionEvent Started with RemoteStart',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(res).join(', ')}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
