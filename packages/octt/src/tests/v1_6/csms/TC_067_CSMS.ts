// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_067_CSMS: TestCase = {
  id: 'TC_067_CSMS',
  name: 'Clear Charging Profile (1.6)',
  module: 'smart-charging',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System sets charging profiles and clears them.',
  purpose: 'Verify the CSMS can send SetChargingProfile and ClearChargingProfile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Start a session for TxProfile
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
    });
    await ctx.client.sendCall('Authorize', { idTag });
    const startResult = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const transactionId = (startResult as Record<string, unknown>)['transactionId'] as
      | number
      | undefined;
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp,
    });

    // Track received profiles for clear-by-id
    const receivedProfileIds: number[] = [];
    let setProfileCount = 0;
    let clearProfileCount = 0;

    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'SetChargingProfile') {
        setProfileCount++;
        const profile = payload['csChargingProfiles'] as Record<string, unknown> | undefined;
        if (profile?.['chargingProfileId'] != null) {
          receivedProfileIds.push(profile['chargingProfileId'] as number);
        }
        return { status: 'Accepted' };
      }
      if (action === 'ClearChargingProfile') {
        clearProfileCount++;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      // 1. SetChargingProfile connectorId=0, ChargePointMaxProfile
      await ctx.triggerCommand('v16', 'SetChargingProfile', {
        stationId: ctx.stationId,
        connectorId: 0,
        csChargingProfiles: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'ChargePointMaxProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: {
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 32.0 }],
          },
        },
      });

      // 2. SetChargingProfile connectorId=1, TxDefaultProfile
      await ctx.triggerCommand('v16', 'SetChargingProfile', {
        stationId: ctx.stationId,
        connectorId: 1,
        csChargingProfiles: {
          chargingProfileId: 2,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: {
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
          },
        },
      });

      // 3. SetChargingProfile connectorId=1, TxProfile with transactionId
      await ctx.triggerCommand('v16', 'SetChargingProfile', {
        stationId: ctx.stationId,
        connectorId: 1,
        csChargingProfiles: {
          chargingProfileId: 3,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          transactionId: transactionId ?? 1,
          chargingSchedule: {
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 8.0 }],
          },
        },
      });

      // 4. ClearChargingProfile by id (profile 1)
      await ctx.triggerCommand('v16', 'ClearChargingProfile', {
        stationId: ctx.stationId,
        id: receivedProfileIds[0] ?? 1,
      });

      // 5. ClearChargingProfile by criteria (connectorId=1, TxDefaultProfile)
      await ctx.triggerCommand('v16', 'ClearChargingProfile', {
        stationId: ctx.stationId,
        connectorId: 1,
        chargingProfilePurpose: 'TxDefaultProfile',
      });

      // 6. ClearChargingProfile (clear all, no criteria)
      await ctx.triggerCommand('v16', 'ClearChargingProfile', {
        stationId: ctx.stationId,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'Receive 3 SetChargingProfile requests (MaxProfile, TxDefault, TxProfile)',
      status: setProfileCount >= 3 ? 'passed' : 'failed',
      expected: '3 SetChargingProfile.req received',
      actual: `Received ${String(setProfileCount)} SetChargingProfile(s)`,
    });

    steps.push({
      step: 2,
      description: 'Receive 3 ClearChargingProfile requests (by id, by criteria, clear all)',
      status: clearProfileCount >= 3 ? 'passed' : 'failed',
      expected: '3 ClearChargingProfile.req received',
      actual: `Received ${String(clearProfileCount)} ClearChargingProfile(s)`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
