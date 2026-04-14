// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_066_CSMS: TestCase = {
  id: 'TC_066_CSMS',
  name: 'Get Composite Schedule (1.6)',
  module: 'smart-charging',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System requests a composite schedule.',
  purpose: 'Verify the CSMS can send GetCompositeSchedule.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'GetCompositeSchedule') {
        received = true;
        return {
          status: 'Accepted',
          connectorId: 1,
          scheduleStart: new Date().toISOString(),
          chargingSchedule: {
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 22000.0 }],
          },
        };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'GetCompositeSchedule', {
        stationId: ctx.stationId,
        connectorId: 1,
        duration: 3600,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive GetCompositeSchedule and respond with schedule',
      status: received ? 'passed' : 'failed',
      expected: 'GetCompositeSchedule.req received',
      actual: received ? 'Received, responded with composite schedule' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
