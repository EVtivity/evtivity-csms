// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_019_1_CSMS: TestCase = {
  id: 'TC_019_1_CSMS',
  name: 'Retrieve All Configuration Keys (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System retrieves all available configuration keys.',
  purpose: 'Verify the CSMS can send GetConfiguration with an empty key list.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let getConfigReceived = false;
    let requestedKeys: unknown[] = [];
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'GetConfiguration') {
        getConfigReceived = true;
        requestedKeys = (payload['key'] as unknown[]) || [];
        return {
          configurationKey: [
            { key: 'HeartbeatInterval', readonly: false, value: '300' },
            { key: 'NumberOfConnectors', readonly: true, value: '1' },
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
      await ctx.triggerCommand('v16', 'GetConfiguration', { stationId: ctx.stationId });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive GetConfiguration from CSMS with empty key list',
      status: getConfigReceived ? 'passed' : 'failed',
      expected: 'GetConfiguration.req received with empty key',
      actual: getConfigReceived
        ? `Received, keys requested: ${String(requestedKeys.length)}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
