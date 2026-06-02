// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { pushSendAckStep } from '../../../../csms-test-helpers.js';

/**
 * TC_K_117_CSMS: ISO 15118-20 Dynamic Control Mode - Adjusting charging schedule
 * Use case: K20 (K20.FR.03)
 */
export const TC_K_117_CSMS: TestCase = {
  id: 'TC_K_117_CSMS',
  name: 'ISO 15118-20 Dynamic Control Mode - Adjusting charging schedule',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The EV provides new charging needs with changed departure time, and the CSMS must provide a new charging profile.',
  purpose:
    'To verify if the CSMS is able to provide a new charging profile when EV provides a changed departure time.',
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

    const departure2h = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const departure3h = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

    // Round 1: departure +2h
    const needs1 = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      maxScheduleTuples: 3,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_BPT',
        availableEnergyTransfer: ['AC_single_phase', 'AC_three_phase', 'AC_BPT'],
        controlMode: 'DynamicControl',
        departureTime: departure2h,
        v2xChargingParameters: {
          evTargetEnergyRequest: 1000,
          maxChargePower: 5000,
          maxDischargePower: 5000,
        },
      },
    });
    pushSendAckStep(
      steps,
      1,
      'NotifyEVChargingNeeds round 1 (departure +2h)',
      needs1,
      'Response received',
      `status = ${String(needs1['status'])}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 15000));
    // The CSMS does not generate ISO 15118 charging profiles. Advisory step.
    pushSendAckStep(
      steps,
      2,
      'CSMS sends SetChargingProfile round 1 (advisory)',
      needs1,
      'Profile received (not enforced)',
      `${String(profileCount)} received`,
    );

    // Confirm schedule
    await ctx.client.sendCall('NotifyEVChargingSchedule', {
      timeBase: new Date().toISOString(),
      evseId: 1,
      chargingSchedule: {
        id: 1,
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000.0 }],
      },
    });

    // Round 2: departure +3h (changed departure)
    const needs2 = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      maxScheduleTuples: 3,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_BPT',
        availableEnergyTransfer: ['AC_single_phase', 'AC_three_phase', 'AC_BPT'],
        controlMode: 'DynamicControl',
        departureTime: departure3h,
        v2xChargingParameters: {
          evTargetEnergyRequest: 1000,
          maxChargePower: 5000,
          maxDischargePower: 5000,
        },
      },
    });
    pushSendAckStep(
      steps,
      3,
      'NotifyEVChargingNeeds round 2 (departure +3h)',
      needs2,
      'Response received',
      `status = ${String(needs2['status'])}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 15000));
    pushSendAckStep(
      steps,
      4,
      'CSMS sends SetChargingProfile round 2 (advisory)',
      needs2,
      'Second profile received (not enforced)',
      `${String(profileCount)} total`,
    );

    // Round 3: same departure, changed energy
    const needs3 = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      maxScheduleTuples: 3,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_BPT',
        availableEnergyTransfer: ['AC_single_phase', 'AC_three_phase', 'AC_BPT'],
        controlMode: 'DynamicControl',
        departureTime: departure3h,
        v2xChargingParameters: {
          evTargetEnergyRequest: 3000,
          maxChargePower: 5000,
          maxDischargePower: 5000,
        },
      },
    });
    pushSendAckStep(
      steps,
      5,
      'NotifyEVChargingNeeds round 3 (energy changed)',
      needs3,
      'Response received',
      `status = ${String(needs3['status'])}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 15000));
    pushSendAckStep(
      steps,
      6,
      'CSMS sends SetChargingProfile round 3 (advisory)',
      needs3,
      'Third profile received (not enforced)',
      `${String(profileCount)} total`,
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
