// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_103_CSMS: TestCase = {
  id: 'TC_B_103_CSMS',
  name: 'Reset ImmediateAndResume - With Ongoing Transaction - Resuming Energy Transfer',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset itself by sending a ResetRequest with type ImmediateAndResume while a transaction is ongoing.',
  purpose:
    'To verify if the CSMS is able to perform the reset mechanism as described at the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Start a transaction
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
    let bootResponseStatus: string | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'Reset') {
          receivedReset = true;
          resetType = payload['type'] as string;
          // Respond Accepted, then simulate ImmediateAndResume flow
          setTimeout(async () => {
            try {
              // Updated event for reset command
              await ctx.client.sendCall('TransactionEvent', {
                eventType: 'Updated',
                timestamp: new Date().toISOString(),
                triggerReason: 'ResetCommand',
                seqNo: 1,
                transactionInfo: { transactionId: txId, chargingState: 'SuspendedEVSE' },
              });
              // Reboot
              const bootResp = await ctx.client.sendCall('BootNotification', {
                chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
                reason: 'RemoteReset',
              });
              bootResponseStatus = bootResp['status'] as string;
              // StatusNotification after reboot
              await ctx.client.sendCall('StatusNotification', {
                timestamp: new Date().toISOString(),
                connectorStatus: 'Occupied',
                evseId: 1,
                connectorId: 1,
              });
              // Resume transaction
              await ctx.client.sendCall('TransactionEvent', {
                eventType: 'Updated',
                timestamp: new Date().toISOString(),
                triggerReason: 'TxResumed',
                seqNo: 2,
                transactionInfo: { transactionId: txId, chargingState: 'Charging' },
              });
            } catch {
              // Ignore errors
            }
          }, 500);
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'Reset', {
        stationId: ctx.stationId,
        type: 'ImmediateAndResume',
      });
      // Wait for the async BootNotification sent from the setTimeout callback
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ResetRequest with type ImmediateAndResume',
      status: receivedReset ? ('passed' as 'passed' | 'failed') : ('failed' as 'passed' | 'failed'),
      expected: 'ResetRequest received',
      actual: receivedReset ? 'ResetRequest received' : 'No ResetRequest received',
    });

    steps.push({
      step: 2,
      description: 'Reset type is ImmediateAndResume',
      status:
        resetType === 'ImmediateAndResume'
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'type = ImmediateAndResume',
      actual: `type = ${String(resetType)}`,
    });

    steps.push({
      step: 3,
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
