// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { pushSendAckStep } from '../../../../csms-test-helpers.js';

export const TC_R_108_CSMS: TestCase = {
  id: 'TC_R_108_CSMS',
  name: 'Charging station reporting a DER event',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The charging station sends a DER alarm notification.',
  purpose: 'To check if the CSMS supports receiving DER alarm events.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      const resp1 = await ctx.client.sendCall('NotifyDERAlarm', {
        controlType: 'LVMustTrip',
        gridEventFault: 'UnderVoltage',
        alarmEnded: false,
        timestamp: new Date().toISOString(),
      });
      pushSendAckStep(steps, 1, 'Send NotifyDERAlarmRequest (alarm started)', resp1);
    } catch {
      steps.push({
        step: 1,
        description: 'Send NotifyDERAlarmRequest (alarm started)',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const resp2 = await ctx.client.sendCall('NotifyDERAlarm', {
        controlType: 'LVMustTrip',
        gridEventFault: 'UnderVoltage',
        alarmEnded: true,
        timestamp: new Date().toISOString(),
      });
      pushSendAckStep(steps, 2, 'Send NotifyDERAlarmRequest (alarm ended)', resp2);
    } catch {
      steps.push({
        step: 2,
        description: 'Send NotifyDERAlarmRequest (alarm ended)',
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
