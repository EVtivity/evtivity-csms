// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_057_CSMS: TestCase = {
  id: 'TC_057_CSMS',
  name: 'Central Smart Charging - TxProfile (1.6)',
  module: 'smart-charging',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System sets a schedule for a running transaction.',
  purpose: 'Verify the CSMS can send SetChargingProfile with TxProfile during an active session.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Start a session
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
    });
    await ctx.client.sendCall('Authorize', { idTag });
    await ctx.client.sendCall('StartTransaction', { connectorId, idTag, meterStart: 0, timestamp });
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp,
    });

    let received = false;
    let purpose = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'SetChargingProfile') {
        received = true;
        const profile = payload['csChargingProfiles'] as Record<string, unknown> | undefined;
        purpose = (profile?.['chargingProfilePurpose'] as string) || '';
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'SetChargingProfile', {
        stationId: ctx.stationId,
        connectorId: 1,
        csChargingProfiles: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: {
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 32.0 }],
          },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive SetChargingProfile (TxProfile) and respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'SetChargingProfile.req with TxProfile',
      actual: received ? `Received, purpose=${purpose}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
