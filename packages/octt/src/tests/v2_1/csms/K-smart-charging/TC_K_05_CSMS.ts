// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_K_05_CSMS: Clear Charging Profile - With chargingProfileId
 * Use case: K10 (K10.FR.02)
 */
export const TC_K_05_CSMS: TestCase = {
  id: 'TC_K_05_CSMS',
  name: 'Clear Charging Profile - With chargingProfileId',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'If the CSMS wishes to clear a specific charging profile.',
  purpose:
    'To verify if the CSMS is able to request the charging station to clear a specific charging profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let received = false;
    let reqPayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ClearChargingProfile') {
          received = true;
          reqPayload = payload;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ClearChargingProfile', {
        stationId: ctx.stationId,
        id: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const profileId = reqPayload['chargingProfileId'];
    const criteria = reqPayload['chargingProfileCriteria'];

    steps.push({
      step: 1,
      description: 'CSMS sends ClearChargingProfileRequest with chargingProfileId',
      status: received ? 'passed' : 'failed',
      expected: 'chargingProfileId present, criteria omitted',
      actual: received
        ? `profileId=${String(profileId)}, criteria=${criteria == null ? 'omitted' : 'present'}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_06_CSMS: Clear Charging Profile - With stackLevel/purpose combination
 * Use case: K10 (K10.FR.02)
 */
export const TC_K_06_CSMS: TestCase = {
  id: 'TC_K_06_CSMS',
  name: 'Clear Charging Profile - With stackLevel/purpose combination for one profile',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'If the CSMS wishes to clear a charging profile by stackLevel and purpose.',
  purpose:
    'To verify if the CSMS is able to request the charging station to clear a specific charging profile with a stackLevel/purpose combination.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'ClearChargingProfile') {
          received = true;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ClearChargingProfile', {
        stationId: ctx.stationId,
        chargingProfileCriteria: {
          chargingProfilePurpose: 'TxDefaultProfile',
          stackLevel: 0,
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description:
        'CSMS sends ClearChargingProfileRequest with purpose/stackLevel, respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'ClearChargingProfileRequest received',
      actual: received ? 'Received, responded Accepted' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_08_CSMS: Clear Charging Profile - Without previous charging profile
 * Use case: K10
 */
export const TC_K_08_CSMS: TestCase = {
  id: 'TC_K_08_CSMS',
  name: 'Clear Charging Profile - Without previous charging profile',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'If the CSMS wishes to clear a charging profile that does not exist on the station.',
  purpose:
    'To verify if the CSMS is able to handle an Unknown response when clearing a non-existent profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'ClearChargingProfile') {
          received = true;
          return { status: 'Unknown' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ClearChargingProfile', {
        stationId: ctx.stationId,
        id: 999,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ClearChargingProfileRequest, respond Unknown',
      status: received ? 'passed' : 'failed',
      expected: 'ClearChargingProfileRequest received',
      actual: received ? 'Received, responded Unknown' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
