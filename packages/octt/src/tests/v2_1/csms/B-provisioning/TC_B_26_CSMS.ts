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

export const TC_B_26_CSMS: TestCase = {
  id: 'TC_B_26_CSMS',
  name: 'Reset EVSE - With Ongoing Transaction - OnIdle',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset an EVSE by sending a ResetRequest with type OnIdle while a transaction is ongoing.',
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
    let resetSequence: StationSequence | null = null;
    let evseIdPresent = false;
    let evseIdValue: number | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'Reset') {
          receivedReset = true;
          resetType = payload['type'] as string;
          if (payload['evseId'] != null) {
            evseIdPresent = true;
            evseIdValue = payload['evseId'] as number;
          }
          // Respond with Scheduled (transaction ongoing), then end gracefully
          resetSequence = startStationSequence(async () => {
            await ctx.client.sendCall('TransactionEvent', {
              eventType: 'Updated',
              timestamp: new Date().toISOString(),
              triggerReason: 'StopAuthorized',
              seqNo: 1,
              transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
              idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
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
          });
          return { status: 'Scheduled' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'Reset', {
        stationId: ctx.stationId,
        type: 'OnIdle',
        evseId: 1,
      });
    } else {
      // Without the API, wait for a ResetRequest the CSMS sends on its own.
      await waitFor(() => resetSequence != null, 10_000);
    }
    // Let the station finish what it sends after the ResetRequest before the
    // test ends (the executor then stops open transactions and disconnects).
    const sequenceError = await waitForStationSequence(resetSequence);
    if (sequenceError != null) ctx.logger.warn({ sequenceError }, 'Reset sequence incomplete');

    steps.push({
      step: 1,
      description: 'CSMS sends ResetRequest for EVSE with type OnIdle',
      status: receivedReset ? ('passed' as 'passed' | 'failed') : ('failed' as 'passed' | 'failed'),
      expected: 'ResetRequest received',
      actual: receivedReset ? 'ResetRequest received' : 'No ResetRequest received',
    });

    steps.push({
      step: 2,
      description: 'Reset type is OnIdle',
      status:
        resetType === 'OnIdle'
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'type = OnIdle',
      actual: `type = ${String(resetType)}`,
    });

    steps.push({
      step: 3,
      description: 'evseId is present (EVSE-level reset)',
      status: evseIdPresent ? ('passed' as 'passed' | 'failed') : ('failed' as 'passed' | 'failed'),
      expected: 'evseId present',
      actual: evseIdPresent ? `evseId = ${String(evseIdValue)}` : 'evseId omitted',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
