// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_20_CSMS: TestCase = {
  id: 'TC_B_20_CSMS',
  name: 'Reset Charging Station - Without ongoing transaction - OnIdle',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS can request the Charging Station to reset itself by sending a ResetRequest with type OnIdle.',
  purpose:
    'To verify if the CSMS is able to perform the reset mechanism as described at the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedReset = false;
    let resetType: string | null = null;
    let evseIdOmitted = true;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'Reset') {
          receivedReset = true;
          resetType = payload['type'] as string;
          if (payload['evseId'] != null) {
            evseIdOmitted = false;
          }
          // Respond with Accepted, then simulate reboot
          setTimeout(async () => {
            try {
              // Send BootNotification after reset
              await ctx.client.sendCall('BootNotification', {
                chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
                reason: 'ScheduledReset',
              });
              // Send StatusNotification for connector
              await ctx.client.sendCall('StatusNotification', {
                timestamp: new Date().toISOString(),
                connectorStatus: 'Available',
                evseId: 1,
                connectorId: 1,
              });
            } catch {
              // Ignore errors during status notification
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
        type: 'OnIdle',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ResetRequest',
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

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
