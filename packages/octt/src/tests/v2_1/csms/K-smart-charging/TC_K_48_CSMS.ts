// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_K_48_CSMS: EMS Control - Set / Update External Charging Limit (not on a transaction)
 * Use case: K12
 */
export const TC_K_48_CSMS: TestCase = {
  id: 'TC_K_48_CSMS',
  name: 'EMS Control - Set / Update External Charging Limit (not on a transaction)',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'A charging schedule or charging limit can be imposed by an external system on the Charging Station.',
  purpose:
    'To verify if the CSMS is able to receive the request from a charging station and respond correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    const res = await ctx.client.sendCall('NotifyChargingLimit', {
      chargingLimit: { chargingLimitSource: 'EMS' },
    });

    steps.push({
      step: 1,
      description: 'Send NotifyChargingLimitRequest with chargingLimitSource EMS',
      status: 'passed',
      expected: 'NotifyChargingLimitResponse received',
      actual: `Response keys: ${Object.keys(res).join(', ') || 'empty (accepted)'}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_52_CSMS: EMS Control - Set / Update External Charging Limit - Report
 * Use case: K12
 */
export const TC_K_52_CSMS: TestCase = {
  id: 'TC_K_52_CSMS',
  name: 'EMS Control - Set / Update External Charging Limit - Report',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'A charging schedule or charging limit can be removed by an external system. The station reports its current external constraints.',
  purpose:
    'To verify if the CSMS is able to correctly receive the report when a charging limit has been externally changed.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedGet = false;
    let requestId = 0;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetChargingProfiles') {
          receivedGet = true;
          requestId = (payload['requestId'] as number) ?? 1;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetChargingProfiles', {
        stationId: ctx.stationId,
        requestId: 1,
        chargingProfile: { chargingProfilePurpose: 'ChargingStationExternalConstraints' },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetChargingProfilesRequest',
      status: receivedGet ? 'passed' : 'failed',
      expected: 'GetChargingProfilesRequest received',
      actual: receivedGet ? 'Received' : 'Not received',
    });

    if (receivedGet) {
      const reportRes = await ctx.client.sendCall('ReportChargingProfiles', {
        requestId,
        chargingLimitSource: 'EMS',
        evseId: 0,
        chargingProfile: [
          {
            id: 1,
            stackLevel: 0,
            chargingProfilePurpose: 'ChargingStationExternalConstraints',
            chargingProfileKind: 'Absolute',
            chargingSchedule: [
              {
                id: 1,
                chargingRateUnit: 'A',
                chargingSchedulePeriod: [{ startPeriod: 0, limit: 32.0 }],
              },
            ],
          },
        ],
        tbc: false,
      });

      steps.push({
        step: 2,
        description: 'Send ReportChargingProfilesRequest with ExternalConstraints',
        status: 'passed',
        expected: 'ReportChargingProfilesResponse received',
        actual: `Response keys: ${Object.keys(reportRes).join(', ')}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
