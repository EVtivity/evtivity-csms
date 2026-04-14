// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_N_24_CSMS: TestCase = {
  id: 'TC_N_24_CSMS',
  name: 'Set Variable Monitoring - Periodic event',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Charging Station sends a periodic NotifyEventRequest.',
  purpose: 'To test that CSMS returns a NotifyEventResponse.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      await ctx.client.sendCall('NotifyEvent', {
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        eventData: [
          {
            eventId: 1,
            timestamp: new Date().toISOString(),
            trigger: 'Periodic',
            actualValue: '42',
            component: { name: 'EVSE', evse: { id: 1 } },
            variable: { name: 'Power' },
            eventNotificationType: 'HardWiredNotification',
          },
        ],
      });
      steps.push({
        step: 1,
        description: 'Send periodic NotifyEventRequest',
        status: 'passed',
        expected: 'Empty NotifyEventResponse',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send periodic NotifyEventRequest',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
