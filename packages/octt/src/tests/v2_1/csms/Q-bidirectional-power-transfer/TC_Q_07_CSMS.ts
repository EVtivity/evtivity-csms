// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_Q_117_CSMS: TestCase = {
  id: 'TC_Q_117_CSMS',
  name: 'Frequency Support - Central V2X control - push',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS sends a dynamic charging profile for frequency support and pushes updates.',
  purpose: 'To verify the CSMS supports DynamicControl profiles for frequency support.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let setProfileReceived = false;
    let updateReceived = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'SetChargingProfile') {
        setProfileReceived = true;
        return { status: 'Accepted' };
      }
      if (action === 'UpdateDynamicSchedule') {
        updateReceived = true;
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
      await ctx.triggerCommand('v21', 'UpdateDynamicSchedule', {
        stationId: ctx.stationId,
        chargingProfileId: 1,
        scheduleUpdate: { limit: 2000 },
      });
    } else {
      await new Promise((r) => setTimeout(r, 8000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest (Dynamic/Frequency)',
      status: setProfileReceived ? 'passed' : 'failed',
      expected: 'Request received',
      actual: setProfileReceived ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: 'CSMS sends UpdateDynamicScheduleRequest',
      status: updateReceived ? 'passed' : 'failed',
      expected: 'Update received',
      actual: updateReceived ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
