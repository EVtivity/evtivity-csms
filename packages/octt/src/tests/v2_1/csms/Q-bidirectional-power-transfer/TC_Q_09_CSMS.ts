// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_Q_124_CSMS: TestCase = {
  id: 'TC_Q_124_CSMS',
  name: 'Local V2X control for load balancing - good flow',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS configures local load balancing via SetVariables and charging profiles.',
  purpose: 'To verify the CSMS can configure a CS for locally controlled load balancing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let setVarsReceived = false;
    let setProfileReceived = false;
    ctx.client.setIncomingCallHandler(
      async (_mid: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetVariables') {
          setVarsReceived = true;
          const data = payload['setVariableData'] as Record<string, unknown>[];
          return {
            setVariableResult: (data ?? []).map((d: Record<string, unknown>) => ({
              attributeStatus: 'Accepted',
              component: d['component'],
              variable: d['variable'],
            })),
          };
        }
        if (action === 'SetChargingProfile') {
          setProfileReceived = true;
          return { status: 'Accepted' };
        }
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetVariables', {
        stationId: ctx.stationId,
        setVariableData: [
          {
            attributeValue: 'true',
            component: { name: 'V2XChargingCtrlr' },
            variable: { name: 'V2XEnabled' },
          },
        ],
      });
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 0,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 10000 }],
            },
          ],
        },
      });
    } else {
      await new Promise((r) => setTimeout(r, 8000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetVariablesRequest for V2X load balancing',
      status: setVarsReceived ? 'passed' : 'failed',
      expected: 'SetVariables received',
      actual: setVarsReceived ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: 'CSMS sends SetChargingProfileRequest (LocalLoadBalancing)',
      status: setProfileReceived ? 'passed' : 'failed',
      expected: 'Profile received',
      actual: setProfileReceived ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
