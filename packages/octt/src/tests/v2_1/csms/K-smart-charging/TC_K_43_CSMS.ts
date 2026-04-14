// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_K_43_CSMS: Get Composite Schedule - Specific EVSE
 * Use case: K08 (K08.FR.01)
 */
export const TC_K_43_CSMS: TestCase = {
  id: 'TC_K_43_CSMS',
  name: 'Get Composite Schedule - Specific EVSE',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS requests a composite schedule from the Charging Station for a specific EVSE.',
  purpose:
    'To verify if the CSMS is able to request a composite schedule from the Charging Station for a specific EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let received = false;
    let reqPayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetCompositeSchedule') {
          received = true;
          reqPayload = payload;
          const rateUnit = payload['chargingRateUnit'] as string;
          return {
            status: 'Accepted',
            schedule: {
              evseId: 1,
              duration: 300,
              chargingRateUnit: rateUnit,
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: rateUnit === 'W' ? 10000.0 : 10.0 },
              ],
            },
          };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetCompositeSchedule', {
        stationId: ctx.stationId,
        duration: 3600,
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const evseId = reqPayload['evseId'];
    const duration = reqPayload['duration'];

    steps.push({
      step: 1,
      description: 'CSMS sends GetCompositeScheduleRequest for specific EVSE',
      status: received ? 'passed' : 'failed',
      expected: 'GetCompositeScheduleRequest with evseId=1',
      actual: received ? `evseId=${String(evseId)}, duration=${String(duration)}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_44_CSMS: Get Composite Schedule - Charging Station
 * Use case: K08 (K08.FR.01)
 */
export const TC_K_44_CSMS: TestCase = {
  id: 'TC_K_44_CSMS',
  name: 'Get Composite Schedule - Charging Station',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS requests a composite schedule from the Charging Station.',
  purpose:
    'To verify if the CSMS is able to request a composite schedule from the Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let received = false;
    let reqPayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetCompositeSchedule') {
          received = true;
          reqPayload = payload;
          const rateUnit = payload['chargingRateUnit'] as string;
          return {
            status: 'Accepted',
            schedule: {
              evseId: 0,
              duration: 300,
              chargingRateUnit: rateUnit,
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: rateUnit === 'W' ? 10000.0 : 10.0 },
              ],
            },
          };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetCompositeSchedule', {
        stationId: ctx.stationId,
        duration: 3600,
        evseId: 0,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const evseId = reqPayload['evseId'];

    steps.push({
      step: 1,
      description: 'CSMS sends GetCompositeScheduleRequest for Charging Station',
      status: received ? 'passed' : 'failed',
      expected: 'GetCompositeScheduleRequest received',
      actual: received ? `evseId=${String(evseId)}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
