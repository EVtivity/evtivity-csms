// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeNotifyEventTest = (
  id: string,
  name: string,
  desc: string,
  eventPayload: Record<string, unknown>,
): TestCase => ({
  id,
  name,
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: desc,
  purpose: 'To verify the CSMS handles the NotifyEventRequest.',
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
            trigger: 'Delta',
            component: { name: 'EVSE', evse: { id: 1 } },
            variable: { name: 'AvailabilityState' },
            eventNotificationType: 'HardWiredNotification',
            ...eventPayload,
          },
        ],
      });
      steps.push({
        step: 1,
        description: `Send NotifyEventRequest`,
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send NotifyEventRequest',
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
});

export const TC_N_21_CSMS = makeNotifyEventTest(
  'TC_N_21_CSMS',
  'Alert Event - HardWiredMonitor',
  'CS sends NotifyEventRequest for a HardWiredMonitor.',
  { actualValue: 'Available' },
);
export const TC_N_48_CSMS = makeNotifyEventTest(
  'TC_N_48_CSMS',
  'Alert Event - Variable monitoring on write only',
  'NotifyEventRequest with empty actualValue for write-only variable.',
  { actualValue: '' },
);
export const TC_N_49_CSMS = makeNotifyEventTest(
  'TC_N_49_CSMS',
  'Alert Event - LowerThreshold/UpperThreshold cleared after reboot',
  'NotifyEventRequest with empty actualValue after reboot.',
  { actualValue: '' },
);
export const TC_N_50_CSMS = makeNotifyEventTest(
  'TC_N_50_CSMS',
  'Alert Event - Periodic Triggered',
  'NotifyEventRequest with cleared flag after periodic trigger.',
  { cleared: true, actualValue: '0' },
);
