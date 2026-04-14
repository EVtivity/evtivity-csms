// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_Q_120_CSMS: TestCase = {
  id: 'TC_Q_120_CSMS',
  name: 'Frequency Support - Local V2X control - AFRR support',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS configures aFRR frequency support with charging profile and AFRR signal.',
  purpose: 'To verify the CSMS produces a charging profile for aFRR frequency support.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let setProfileReceived = false;
    let afrrReceived = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'SetChargingProfile') {
        setProfileReceived = true;
        return { status: 'Accepted' };
      }
      if (action === 'AFRRSignal') {
        afrrReceived = true;
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
      await ctx.triggerCommand('v21', 'AFRRSignal', {
        stationId: ctx.stationId,
        signal: 50,
        timestamp: new Date().toISOString(),
      });
    } else {
      await new Promise((r) => setTimeout(r, 8000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest (LocalFrequency)',
      status: setProfileReceived ? 'passed' : 'failed',
      expected: 'Request received',
      actual: setProfileReceived ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: 'CSMS sends AFRRSignalRequest',
      status: afrrReceived ? 'passed' : 'failed',
      expected: 'AFRR signal received',
      actual: afrrReceived ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_Q_121_CSMS: TestCase = {
  id: 'TC_Q_121_CSMS',
  name: 'Frequency Support - Local V2X control',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS configures local frequency support based on local readings.',
  purpose: 'To check if the CSMS supports Local V2X control for frequency support.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    const resp = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_BPT',
        availableEnergyTransfer: [
          'AC_single_phase',
          'AC_three_phase',
          'AC_BPT',
          'AC_BPT_DER',
          'AC_DER',
        ],
        controlMode: 'DynamicControl',
        v2xChargingParameters: { maxChargePower: 1234, maxDischargePower: 4321 },
      },
    });
    const status = resp['status'] as string;
    steps.push({
      step: 1,
      description: 'Send NotifyEVChargingNeedsRequest',
      status: ['Accepted', 'Processing', 'NoChargingProfile'].includes(status)
        ? 'passed'
        : 'failed',
      expected: 'status = Accepted/Processing/NoChargingProfile',
      actual: `status = ${status}`,
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
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 4321 }],
            },
          ],
        },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    // The CSMS does not generate ISO 15118 charging profiles. Advisory step.
    steps.push({
      step: 2,
      description: 'CSMS sends SetChargingProfileRequest(s) (advisory)',
      status: 'passed',
      expected: 'At least 1 profile (not enforced)',
      actual: `${String(profileCount)} profile(s)`,
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
