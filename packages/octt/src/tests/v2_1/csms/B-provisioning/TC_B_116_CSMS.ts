// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_116_CSMS: TestCase = {
  id: 'TC_B_116_CSMS',
  name: 'Reset ImmediateAndResume - With Ongoing Transaction and SmartCharging - resuming energytransfer',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset itself by sending a ResetRequest with type ImmediateAndResume while a transaction with a charging profile is ongoing.',
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

    let receivedSetChargingProfile = false;
    let receivedTxProfile = false;
    let receivedReset = false;
    let resetType: string | null = null;
    let bootResponseStatus: string | null = null;
    let receivedPostResumeProfile = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          if (!receivedReset) {
            // First SetChargingProfile before reset
            receivedSetChargingProfile = true;
            const profile = payload['chargingProfile'] as Record<string, unknown> | undefined;
            if (profile != null) {
              const purpose = profile['chargingProfilePurpose'] as string | undefined;
              if (purpose === 'TxProfile') {
                receivedTxProfile = true;
              }
            }
          } else {
            // SetChargingProfile after resume
            receivedPostResumeProfile = true;
          }
          return { status: 'Accepted' };
        }
        if (action === 'Reset') {
          receivedReset = true;
          resetType = payload['type'] as string;
          // Respond Accepted, then simulate ImmediateAndResume with SmartCharging
          setTimeout(async () => {
            try {
              // Updated for reset command
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
              // Status after reboot
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

    // Step 1: Send SetChargingProfile with TxProfile before reset
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          transactionId: txId,
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000.0 }],
            },
          ],
        },
      });

      // Step 2: Trigger ImmediateAndResume reset
      await ctx.triggerCommand('v21', 'Reset', {
        stationId: ctx.stationId,
        type: 'ImmediateAndResume',
      });

      // Wait for the async BootNotification/resume sequence from the setTimeout callback
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Step 3: Re-send SetChargingProfile after resume
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          transactionId: txId,
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with TxProfile purpose',
      status:
        receivedSetChargingProfile && receivedTxProfile
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'SetChargingProfileRequest received with TxProfile purpose',
      actual: receivedSetChargingProfile
        ? receivedTxProfile
          ? 'SetChargingProfileRequest received with TxProfile'
          : 'SetChargingProfileRequest received but without TxProfile purpose'
        : 'No SetChargingProfileRequest received',
    });

    steps.push({
      step: 2,
      description: 'CSMS sends ResetRequest with type ImmediateAndResume',
      status: receivedReset ? ('passed' as 'passed' | 'failed') : ('failed' as 'passed' | 'failed'),
      expected: 'ResetRequest received',
      actual: receivedReset ? 'ResetRequest received' : 'No ResetRequest received',
    });

    steps.push({
      step: 3,
      description: 'Reset type is ImmediateAndResume',
      status:
        resetType === 'ImmediateAndResume'
          ? ('passed' as 'passed' | 'failed')
          : ('failed' as 'passed' | 'failed'),
      expected: 'type = ImmediateAndResume',
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

    steps.push({
      step: 5,
      description: 'CSMS re-sends SetChargingProfile after resume',
      status: receivedPostResumeProfile
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'SetChargingProfileRequest received after resume',
      actual: receivedPostResumeProfile ? 'Received' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
