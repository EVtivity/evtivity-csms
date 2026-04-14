// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_21_CSMS: TestCase = {
  id: 'TC_B_21_CSMS',
  name: 'Reset Charging Station - With Ongoing Transaction - OnIdle',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset itself by sending a ResetRequest with type OnIdle while a transaction is ongoing.',
  purpose:
    'To verify if the CSMS is able to perform the reset mechanism as described at the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Start a transaction to simulate ongoing energy transfer
    const txId = `TX-${Date.now()}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    let receivedReset = false;
    let resetType: string | null = null;
    let evseIdOmitted = true;
    let bootResponseStatus: string | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'Reset') {
          receivedReset = true;
          resetType = payload['type'] as string;
          if (payload['evseId'] != null) {
            evseIdOmitted = false;
          }
          // Respond with Scheduled (transaction ongoing)
          setTimeout(async () => {
            try {
              // Transaction stops gracefully
              await ctx.client.sendCall('TransactionEvent', {
                eventType: 'Updated',
                timestamp: new Date().toISOString(),
                triggerReason: 'StopAuthorized',
                seqNo: 1,
                transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
                idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
              });
              await ctx.client.sendCall('TransactionEvent', {
                eventType: 'Ended',
                timestamp: new Date().toISOString(),
                triggerReason: 'EVCommunicationLost',
                seqNo: 2,
                transactionInfo: {
                  transactionId: txId,
                  chargingState: 'Idle',
                  stoppedReason: 'EVDisconnected',
                },
              });
              // Reboot
              const bootResp = await ctx.client.sendCall('BootNotification', {
                chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
                reason: 'ScheduledReset',
              });
              bootResponseStatus = bootResp['status'] as string;
              await ctx.client.sendCall('StatusNotification', {
                timestamp: new Date().toISOString(),
                connectorStatus: 'Available',
                evseId: 1,
                connectorId: 1,
              });
            } catch {
              // Ignore errors
            }
          }, 500);
          return { status: 'Scheduled' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'Reset', {
        stationId: ctx.stationId,
        type: 'OnIdle',
      });
      // Wait for the async reset sequence (transaction end + reboot) from the setTimeout callback
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ResetRequest with type OnIdle',
      status: receivedReset ? ('passed' as 'passed' | 'failed') : ('failed' as 'passed' | 'failed'),
      expected: 'ResetRequest received',
      actual: receivedReset ? 'ResetRequest received' : 'No ResetRequest received',
    });

    steps.push({
      step: 2,
      description: 'evseId must be omitted (station-level reset)',
      status: evseIdOmitted ? ('passed' as 'passed' | 'failed') : ('failed' as 'passed' | 'failed'),
      expected: 'evseId omitted',
      actual: evseIdOmitted ? 'evseId omitted' : 'evseId was present',
    });

    steps.push({
      step: 3,
      description: 'Reset type is OnIdle',
      status:
        resetType === 'OnIdle'
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'type = OnIdle',
      actual: `type = ${String(resetType)}`,
    });

    steps.push({
      step: 4,
      description: 'CSMS responds to BootNotification with Accepted',
      status:
        bootResponseStatus === 'Accepted'
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'BootNotificationResponse status = Accepted',
      actual: `status = ${String(bootResponseStatus)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
