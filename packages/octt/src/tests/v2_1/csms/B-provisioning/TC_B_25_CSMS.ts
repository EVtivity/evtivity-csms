// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_25_CSMS: TestCase = {
  id: 'TC_B_25_CSMS',
  name: 'Reset EVSE - Without ongoing transaction',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS can request the Charging Station to reset an EVSE by sending a ResetRequest.',
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
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'Reset', {
        stationId: ctx.stationId,
        type: 'OnIdle',
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ResetRequest for EVSE',
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
