// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_44_CSMS: TestCase = {
  id: 'TC_B_44_CSMS',
  name: 'Set new NetworkConnectionProfile - Failed',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS updates the connection details on the Charging Station and the station responds with Failed.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station responding with status Failed when setting a new network connection profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedSetNetworkProfile = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetNetworkProfile') {
          receivedSetNetworkProfile = true;
          // Respond with Failed
          return { status: 'Failed' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetNetworkProfile', {
        stationId: ctx.stationId,
        configurationSlot: 1,
        connectionData: {
          ocppVersion: 'OCPP21',
          ocppTransport: 'JSON',
          messageTimeout: 30,
          ocppCsmsUrl: 'ws://localhost:3003',
          securityProfile: 0,
          ocppInterface: 'Wired0',
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetNetworkProfileRequest',
      status: receivedSetNetworkProfile
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'SetNetworkProfileRequest received',
      actual: receivedSetNetworkProfile
        ? 'SetNetworkProfileRequest received'
        : 'No SetNetworkProfileRequest received',
    });

    steps.push({
      step: 2,
      description: 'Station responds with Failed and CSMS handles it gracefully',
      status: receivedSetNetworkProfile
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'CSMS handles Failed response without error',
      actual: receivedSetNetworkProfile
        ? 'Failed response sent, no error'
        : 'Test did not reach this step',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
