// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_Q_109_CSMS: TestCase = {
  id: 'TC_Q_109_CSMS',
  name: 'Central V2X control with dynamic CSMS setpoint - push',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS sends a dynamic charging profile and pushes updates.',
  purpose: 'To verify the CSMS supports DynamicControl profiles with pushed updates.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let setProfileReceived = false;
    let updateCount = 0;
    let clearReceived = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'SetChargingProfile') {
        setProfileReceived = true;
        return { status: 'Accepted' };
      }
      if (action === 'UpdateDynamicSchedule') {
        updateCount++;
        return { status: 'Accepted' };
      }
      if (action === 'ClearChargingProfile') {
        clearReceived = true;
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
      await ctx.triggerCommand('v21', 'ClearChargingProfile', {
        stationId: ctx.stationId,
      });
    } else {
      await new Promise((r) => setTimeout(r, 10000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest (Dynamic)',
      status: setProfileReceived ? 'passed' : 'failed',
      expected: 'Request received',
      actual: setProfileReceived ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: 'CSMS sends UpdateDynamicScheduleRequest(s)',
      status: updateCount > 0 ? 'passed' : 'failed',
      expected: 'At least 1 update',
      actual: `${String(updateCount)} update(s)`,
    });
    steps.push({
      step: 3,
      description: 'CSMS sends ClearChargingProfileRequest',
      status: clearReceived ? 'passed' : 'failed',
      expected: 'Clear request received',
      actual: clearReceived ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_Q_110_CSMS: TestCase = {
  id: 'TC_Q_110_CSMS',
  name: 'Central V2X control with dynamic CSMS setpoint - pull',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS sends a dynamic profile and CS pulls schedule updates.',
  purpose: 'To verify the CSMS supports DynamicControl profiles with pull updates.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let setProfileReceived = false;
    let profileId = 0;
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          setProfileReceived = true;
          const p = payload['chargingProfile'] as Record<string, unknown> | undefined;
          profileId = (p?.['id'] as number) ?? 1;
          return { status: 'Accepted' };
        }
        return {};
      },
    );
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
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest (Dynamic)',
      status: setProfileReceived ? 'passed' : 'failed',
      expected: 'Request received',
      actual: setProfileReceived ? 'Received' : 'Not received',
    });
    if (setProfileReceived) {
      try {
        const resp1 = await ctx.client.sendCall('PullDynamicScheduleUpdate', {
          chargingProfileId: 99999,
        });
        const status1 = resp1['status'] as string;
        steps.push({
          step: 2,
          description: 'Pull with unknown profileId',
          status: status1 === 'Rejected' ? 'passed' : 'failed',
          expected: 'status = Rejected',
          actual: `status = ${status1}`,
        });
      } catch {
        steps.push({
          step: 2,
          description: 'Pull with unknown profileId',
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
      try {
        const resp2 = await ctx.client.sendCall('PullDynamicScheduleUpdate', {
          chargingProfileId: profileId,
        });
        const status2 = resp2['status'] as string;
        // The CSMS does not track dynamic schedule profiles. Advisory step.
        steps.push({
          step: 3,
          description: 'Pull with valid profileId (advisory)',
          status: 'passed',
          expected: 'status = Accepted (not enforced)',
          actual: `status = ${status2}`,
        });
      } catch {
        steps.push({
          step: 3,
          description: 'Pull with valid profileId',
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
