// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_019_2_CSMS: TestCase = {
  id: 'TC_019_2_CSMS',
  name: 'Retrieve Specific Configuration Key (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System retrieves a specific configuration key.',
  purpose: 'Verify the CSMS can send GetConfiguration for SupportedFeatureProfiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let getConfigReceived = false;
    let requestedKey = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'GetConfiguration') {
        getConfigReceived = true;
        const keys = payload['key'] as string[] | undefined;
        requestedKey = keys?.[0] || '';
        return {
          configurationKey: [
            {
              key: 'SupportedFeatureProfiles',
              readonly: true,
              value: 'Core,LocalAuthListManagement,SmartCharging',
            },
          ],
          unknownKey: [],
        };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'GetConfiguration', {
        stationId: ctx.stationId,
        key: ['SupportedFeatureProfiles'],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive GetConfiguration for specific key',
      status: getConfigReceived ? 'passed' : 'failed',
      expected: 'GetConfiguration.req with key=SupportedFeatureProfiles',
      actual: getConfigReceived ? `Received, key=${requestedKey}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
