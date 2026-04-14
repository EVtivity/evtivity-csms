// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_B_42_CSMS: TestCase = {
  id: 'TC_B_42_CSMS',
  name: 'Set new NetworkConnectionProfile - Accepted',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS updates the connection details on the Charging Station.',
  purpose:
    'To verify if the CSMS is able to set a new network connection profile at one of the supported configuration slots.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedSetNetworkProfile = false;
    let hasConfigurationSlot = false;
    let hasConnectionData = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetNetworkProfile') {
          receivedSetNetworkProfile = true;
          const configurationSlot = payload['configurationSlot'] as number | undefined;
          const connectionData = payload['connectionData'] as Record<string, unknown> | undefined;
          if (typeof configurationSlot === 'number') {
            hasConfigurationSlot = true;
          }
          if (connectionData != null) {
            hasConnectionData = true;
          }
          return { status: 'Accepted' };
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
      description: 'Request contains configurationSlot',
      status: hasConfigurationSlot
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'configurationSlot present',
      actual: hasConfigurationSlot ? 'configurationSlot present' : 'configurationSlot missing',
    });

    steps.push({
      step: 3,
      description: 'Request contains connectionData',
      status: hasConnectionData
        ? ('passed' as 'passed' | 'failed')
        : ('failed' as 'passed' | 'failed'),
      expected: 'connectionData present',
      actual: hasConnectionData ? 'connectionData present' : 'connectionData missing',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
