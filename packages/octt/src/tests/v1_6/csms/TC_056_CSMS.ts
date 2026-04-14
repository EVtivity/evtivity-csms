// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_056_CSMS: TestCase = {
  id: 'TC_056_CSMS',
  name: 'Central Smart Charging - TxDefaultProfile (1.6)',
  module: 'smart-charging',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System sets a default schedule for new transactions.',
  purpose: 'Verify the CSMS can send SetChargingProfile with TxDefaultProfile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    let purpose = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'SetChargingProfile') {
        received = true;
        const profile = payload['csChargingProfiles'] as Record<string, unknown> | undefined;
        purpose = (profile?.['chargingProfilePurpose'] as string) || '';
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'SetChargingProfile', {
        stationId: ctx.stationId,
        connectorId: 0,
        csChargingProfiles: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: {
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
          },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive SetChargingProfile (TxDefaultProfile) and respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'SetChargingProfile.req with TxDefaultProfile',
      actual: received ? `Received, purpose=${purpose}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
