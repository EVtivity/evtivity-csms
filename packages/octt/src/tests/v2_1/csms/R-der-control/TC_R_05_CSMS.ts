// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

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
      await ctx.client.sendCall('NotifyDERAlarm', {
        controlType: 'LVMustTrip',
        gridEventFault: 'UnderVoltage',
        alarmEnded: false,
        timestamp: new Date().toISOString(),
      });
      steps.push({
        step: 1,
        description: 'Send NotifyDERAlarmRequest (alarm started)',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
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
      await ctx.client.sendCall('NotifyDERAlarm', {
        controlType: 'LVMustTrip',
        gridEventFault: 'UnderVoltage',
        alarmEnded: true,
        timestamp: new Date().toISOString(),
      });
      steps.push({
        step: 2,
        description: 'Send NotifyDERAlarmRequest (alarm ended)',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
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
