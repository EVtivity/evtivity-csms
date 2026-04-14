// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_Q_107_CSMS: TestCase = {
  id: 'TC_Q_107_CSMS',
  name: 'V2X Authorisation - Charging only before starting V2X',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Start a transaction with ChargingOnly operationMode before upgrading to V2X.',
  purpose: 'To check if the CSMS supports starting in a non-bidirectional way.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      const resp = await ctx.client.sendCall('NotifyEVChargingNeeds', {
        evseId: 1,
        chargingNeeds: {
          requestedEnergyTransfer: 'AC_three_phase',
          availableEnergyTransfer: ['AC_single_phase', 'AC_three_phase', 'AC_BPT'],
          controlMode: 'ScheduledControl',
          v2xChargingParameters: { maxChargePower: 1234, maxDischargePower: 1234 },
        },
      });
      const status = resp['status'] as string;
      steps.push({
        step: 1,
        description: 'Send NotifyEVChargingNeedsRequest',
        status: ['Accepted', 'Processing', 'NoChargingProfile'].includes(status)
          ? 'passed'
          : 'failed',
        expected: 'status = Accepted, Processing, or NoChargingProfile',
        actual: `status = ${status}`,
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send NotifyEVChargingNeedsRequest',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }
    let setProfileReceived = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'SetChargingProfile') {
        setProfileReceived = true;
        return { status: 'Accepted' };
      }
      if (action === 'NotifyAllowedEnergyTransfer') {
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
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 2,
      description: 'CSMS sends SetChargingProfileRequest',
      status: setProfileReceived ? 'passed' : 'failed',
      expected: 'Profile request received',
      actual: setProfileReceived ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
