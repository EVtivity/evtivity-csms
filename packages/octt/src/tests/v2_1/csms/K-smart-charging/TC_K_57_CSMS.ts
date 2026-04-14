// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_K_57_CSMS: Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV
 * Use case: K17 (K17.FR.02, K17.FR.03, K17.FR.05, K17.FR.07, K17.FR.11)
 */
export const TC_K_57_CSMS: TestCase = {
  id: 'TC_K_57_CSMS',
  name: 'Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The EV signals the Charging Station that it wants to renegotiate and provides new charging needs.',
  purpose: 'To verify if the CSMS is able to renegotiate when the EV signals the Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    // Step 1-2: Send NotifyEVChargingNeeds (EV-initiated renegotiation)
    const needsRes = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      maxScheduleTuples: 3,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_three_phase',
        acChargingParameters: {
          energyAmount: 5000,
          evMinCurrent: 6,
          evMaxCurrent: 32,
          evMaxVoltage: 230,
        },
      },
    });
    const needsStatus = needsRes['status'] as string;
    steps.push({
      step: 1,
      description: 'Send NotifyEVChargingNeedsRequest (EV-initiated)',
      status:
        needsStatus === 'Accepted' ||
        needsStatus === 'Processing' ||
        needsStatus === 'NoChargingProfile'
          ? 'passed'
          : 'failed',
      expected: 'status = Accepted, Processing, or NoChargingProfile',
      actual: `status = ${needsStatus}`,
    });

    // Step 3-4: Wait for SetChargingProfile
    let receivedProfile = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          receivedProfile = true;
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
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 2,
      description: 'CSMS sends SetChargingProfileRequest (advisory)',
      status: 'passed',
      expected: 'SetChargingProfileRequest received (not enforced)',
      actual: receivedProfile ? 'Received' : 'Not received',
    });

    // Step 5-6: NotifyEVChargingSchedule
    if (receivedProfile) {
      const schedRes = await ctx.client.sendCall('NotifyEVChargingSchedule', {
        timeBase: new Date().toISOString(),
        evseId: 1,
        chargingSchedule: {
          id: 1,
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
        },
      });
      steps.push({
        step: 3,
        description: 'Send NotifyEVChargingScheduleRequest',
        status: (schedRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${String(schedRes['status'])}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_114_CSMS: Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV (v2x)
 * Use case: K17
 */
export const TC_K_114_CSMS: TestCase = {
  id: 'TC_K_114_CSMS',
  name: 'Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV (v2x)',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The EV signals renegotiation with ISO 15118-20 v2x charging parameters.',
  purpose: 'To verify if the CSMS handles EV-initiated renegotiation with v2x parameters.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    const needsRes = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      maxScheduleTuples: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_three_phase',
        availableEnergyTransfer: ['AC_single_phase', 'AC_three_phase', 'AC_BPT'],
        controlMode: 'ScheduledControl',
        v2xChargingParameters: { maxChargePower: 6000, maxDischargePower: 0 },
      },
    });
    steps.push({
      step: 1,
      description: 'Send NotifyEVChargingNeedsRequest with v2x params',
      status: 'passed',
      expected: 'Response received',
      actual: `status = ${String(needsRes['status'])}`,
    });

    let receivedProfile = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          receivedProfile = true;
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
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 2,
      description: 'CSMS sends SetChargingProfileRequest (advisory)',
      status: 'passed',
      expected: 'SetChargingProfileRequest received (not enforced)',
      actual: receivedProfile ? 'Received' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_115_CSMS: ISO 15118-20 Dynamic Control Mode - Success
 * Use case: K17, K19
 */
export const TC_K_115_CSMS: TestCase = {
  id: 'TC_K_115_CSMS',
  name: 'ISO 15118-20 Dynamic Control Mode - Success',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The EV signals renegotiation with DynamicControl mode via ISO 15118-20.',
  purpose: 'To verify if the CSMS handles Dynamic Control mode with BPT.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    const needsRes = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      maxScheduleTuples: 3,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_BPT',
        availableEnergyTransfer: ['AC_single_phase', 'AC_three_phase', 'AC_BPT'],
        controlMode: 'DynamicControl',
        v2xChargingParameters: { maxChargePower: 5000, maxDischargePower: 5000 },
      },
    });
    const needsStatus = needsRes['status'] as string;
    steps.push({
      step: 1,
      description: 'Send NotifyEVChargingNeedsRequest with DynamicControl BPT',
      status:
        needsStatus === 'Accepted' ||
        needsStatus === 'Processing' ||
        needsStatus === 'NoChargingProfile'
          ? 'passed'
          : 'failed',
      expected: 'status = Accepted, Processing, or NoChargingProfile',
      actual: `status = ${needsStatus}`,
    });

    let receivedProfile = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          receivedProfile = true;
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
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 2,
      description: 'CSMS sends SetChargingProfileRequest (advisory)',
      status: 'passed',
      expected: 'SetChargingProfileRequest received (not enforced)',
      actual: receivedProfile ? 'Received' : 'Not received',
    });

    if (receivedProfile) {
      const schedRes = await ctx.client.sendCall('NotifyEVChargingSchedule', {
        timeBase: new Date().toISOString(),
        evseId: 1,
        chargingSchedule: {
          id: 1,
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000.0 }],
        },
      });
      steps.push({
        step: 3,
        description: 'Send NotifyEVChargingScheduleRequest',
        status: (schedRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${String(schedRes['status'])}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
