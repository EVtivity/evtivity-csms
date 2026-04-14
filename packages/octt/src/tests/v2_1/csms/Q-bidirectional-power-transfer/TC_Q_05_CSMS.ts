// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeExternalV2XTest = (id: string, name: string, desc: string): TestCase => ({
  id,
  name,
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: desc,
  purpose: 'To verify the CSMS can configure External V2X control profiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let profileCount = 0;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'SetChargingProfile') {
        profileCount++;
        return { status: 'Accepted' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 1234 }],
            },
          ],
        },
      });
    } else {
      await new Promise((r) => setTimeout(r, 8000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest(s) for external V2X',
      status: profileCount > 0 ? 'passed' : 'failed',
      expected: 'At least 1 profile',
      actual: `${String(profileCount)} profile(s)`,
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
});

export const TC_Q_111_CSMS = makeExternalV2XTest(
  'TC_Q_111_CSMS',
  'External V2X control - setpoint',
  'CSMS configures External V2X setpoint control.',
);
export const TC_Q_112_CSMS = makeExternalV2XTest(
  'TC_Q_112_CSMS',
  'External V2X control - limit',
  'CSMS configures External V2X limit control.',
);
