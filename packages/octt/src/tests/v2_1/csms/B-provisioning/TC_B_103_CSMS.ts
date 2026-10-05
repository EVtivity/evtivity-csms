// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import {
  newTransactionId,
  startStationSequence,
  waitForStationSequence,
  type StationSequence,
} from '../../../../csms-test-helpers.js';
import { waitFor } from '../../../../security-test-helpers.js';
import { defaultReply } from '../../../../default-replies.js';

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
    const txId = newTransactionId('TX');
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
    });

    let receivedReset = false;
    let resetType: string | null = null;
    let bootResponseStatus: string | null = null;
    let resetSequence: StationSequence | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'Reset') {
          receivedReset = true;
          resetType = payload['type'] as string;
          // Respond Accepted, then simulate ImmediateAndResume flow
          resetSequence = startStationSequence(async () => {
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
          });
          return { status: 'Accepted' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'Reset', {
        stationId: ctx.stationId,
        type: 'ImmediateAndResume',
      });
    } else {
      // Without the API, wait for a ResetRequest the CSMS sends on its own.
      await waitFor(() => resetSequence != null, 10_000);
    }
    // The transaction end and reboot the station sends after the ResetRequest.
    const sequenceError = await waitForStationSequence(resetSequence);

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
      actual:
        bootResponseStatus != null
          ? `status = ${String(bootResponseStatus)}`
          : (sequenceError ?? 'No BootNotificationResponse'),
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
