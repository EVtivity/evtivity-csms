// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_K_58_CSMS: Renegotiating a Charging Schedule ISO 15118-2 - Initiated by CSMS
 * Use case: K16 (K16.FR.06)
 */
export const TC_K_58_CSMS: TestCase = {
  id: 'TC_K_58_CSMS',
  name: 'Renegotiating a Charging Schedule ISO 15118-2 - Initiated by CSMS',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS sends a SetChargingProfileRequest to renegotiate power/current drawn by the EV.',
  purpose: 'To verify if the CSMS is able to renegotiate power/current drawn by the EV.',
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
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest (renegotiate)',
      status: receivedProfile ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual: receivedProfile ? 'Received' : 'Not received',
    });

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
      const schedStatus = schedRes['status'] as string;
      steps.push({
        step: 2,
        description: 'Send NotifyEVChargingScheduleRequest',
        status: schedStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${schedStatus}`,
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
 * TC_K_59_CSMS: Renegotiating a Charging Schedule ISO 15118-2 - Initiated by CSMS - Send NotifyEVChargingNeeds
 * Use case: K16 (K16.FR.12)
 */
export const TC_K_59_CSMS: TestCase = {
  id: 'TC_K_59_CSMS',
  name: 'Renegotiating a Charging Schedule ISO 15118-2 - Initiated by CSMS - Send NotifyEVChargingNeeds',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS sends a SetChargingProfileRequest and the station resends charging needs.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station resending the charging needs of the EV.',
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

    let profileCount = 0;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          profileCount++;
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
      step: 1,
      description: 'CSMS sends first SetChargingProfileRequest',
      status: profileCount >= 1 ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual: `${String(profileCount)} received`,
    });

    // Resend NotifyEVChargingNeeds
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
      step: 2,
      description: 'Send NotifyEVChargingNeedsRequest',
      status:
        needsStatus === 'Accepted' ||
        needsStatus === 'Processing' ||
        needsStatus === 'NoChargingProfile'
          ? 'passed'
          : 'failed',
      expected: 'status = Accepted, Processing, or NoChargingProfile',
      actual: `status = ${needsStatus}`,
    });

    // Wait for second SetChargingProfile
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 2,
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
      step: 3,
      description: 'CSMS sends second SetChargingProfileRequest after needs',
      status: profileCount >= 2 ? 'passed' : 'failed',
      expected: 'Second SetChargingProfileRequest',
      actual: `${String(profileCount)} total received`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_113_CSMS: Renegotiating a Charging Schedule ISO 15118-20 - Initiated by CSMS
 * Use case: K16 (K16.FR.06)
 */
export const TC_K_113_CSMS: TestCase = {
  id: 'TC_K_113_CSMS',
  name: 'Renegotiating a Charging Schedule ISO 15118-20 - Initiated by CSMS',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS sends a SetChargingProfileRequest to renegotiate via ISO 15118-20.',
  purpose:
    'To verify if the CSMS is able to renegotiate power/current drawn by the EV via ISO 15118-20.',
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
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest (ISO 15118-20 renegotiate)',
      status: receivedProfile ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
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
        step: 2,
        description: 'Send NotifyEVChargingScheduleRequest',
        status: 'passed',
        expected: 'Response received',
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
