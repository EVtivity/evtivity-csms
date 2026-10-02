// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import { startAndWaitForCharging } from '../../../../cs-test-helpers.js';

const handler = async (action: string) => {
  if (action === 'BootNotification')
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  if (action === 'ReportChargingProfiles') return {};
  if (action === 'StatusNotification') return {};
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  if (action === 'NotifyEvent') return {};
  if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
  if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
  return {};
};

/**
 * Memory State: install a TxDefaultProfile (stackLevel 0, Absolute, limit 6 A)
 * with the given id on an EVSE. A station leaves the factory without charging
 * profiles, so every clear test installs the profile it clears.
 */
async function installProfile(
  ctx: CsTestContext,
  steps: StepResult[],
  evseId: number,
  id: number,
  duration?: number,
): Promise<void> {
  const res = await ctx.server.sendCommand('SetChargingProfile', {
    evseId,
    chargingProfile: {
      id,
      stackLevel: 0,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: [
        {
          id,
          chargingRateUnit: 'A',
          startSchedule: new Date().toISOString(),
          ...(duration != null ? { duration } : {}),
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 6, numberPhases: 3 }],
        },
      ],
    },
  });
  steps.push({
    step: 0,
    description: `Memory State: TxDefaultProfile ${String(id)} on EVSE ${String(evseId)}`,
    status: res['status'] === 'Accepted' ? 'passed' : 'failed',
    expected: 'Accepted',
    actual: String(res['status']),
  });
}

/** Reusable State EnergyTransferStarted. */
async function energyTransferStarted(ctx: CsTestContext, steps: StepResult[]): Promise<void> {
  const charging = await startAndWaitForCharging(ctx, 1, 'OCTT-TOKEN-001');
  steps.push({
    step: 0,
    description: 'Reusable State EnergyTransferStarted',
    status: charging != null ? 'passed' : 'failed',
    expected: 'chargingState Charging',
    actual: charging != null ? 'Charging' : 'not reached',
  });
}

const firstLimit = (res: Record<string, unknown>): number | undefined =>
  (
    (res['schedule'] as Record<string, unknown> | undefined)?.['chargingSchedulePeriod'] as
      | Array<Record<string, unknown>>
      | undefined
  )?.[0]?.['limit'] as number | undefined;

/** TC_K_05_CS: Clear Charging Profile - With chargingProfileId */
export const TC_K_05_CS: CsTestCase = {
  id: 'TC_K_05_CS',
  name: 'Clear Charging Profile - With chargingProfileId',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears a specific charging profile by ID.',
  purpose: 'To verify if the Charging station clears a specific charging profile by ID.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);
    await installProfile(ctx, steps, 1, 1);
    try {
      const res = await ctx.server.sendCommand('ClearChargingProfile', { chargingProfileId: 1 });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfileId: 1 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 4,
        description: 'GetChargingProfilesResponse NoProfiles',
        status: status === 'NoProfiles' ? 'passed' : 'failed',
        expected: 'NoProfiles',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 4,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'NoProfiles',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_06_CS: Clear Charging Profile - With stackLevel/purpose combination */
export const TC_K_06_CS: CsTestCase = {
  id: 'TC_K_06_CS',
  name: 'Clear Charging Profile - With stackLevel/purpose combination',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears profiles matching a stackLevel and purpose combination.',
  purpose: 'To verify clearing by stackLevel and purpose combination.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);
    await installProfile(ctx, steps, 1, 1);
    await energyTransferStarted(ctx, steps);
    try {
      const res = await ctx.server.sendCommand('ClearChargingProfile', {
        chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 0 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 0 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 4,
        description: 'GetChargingProfilesResponse NoProfiles',
        status: status === 'NoProfiles' ? 'passed' : 'failed',
        expected: 'NoProfiles',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 4,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'NoProfiles',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_07_CS: Clear Charging Profile - With unknown stackLevel/purpose combination */
export const TC_K_07_CS: CsTestCase = {
  id: 'TC_K_07_CS',
  name: 'Clear Charging Profile - Unknown stackLevel/purpose',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS tries to clear a non-existent profile combination.',
  purpose: 'To verify if the station denies clearing when the combination does not match.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);
    try {
      const res = await ctx.server.sendCommand('ClearChargingProfile', {
        chargingProfileCriteria: {
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          stackLevel: 0,
        },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse Unknown',
        status: status === 'Unknown' ? 'passed' : 'failed',
        expected: 'Unknown',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse',
        status: 'failed',
        expected: 'Unknown',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_08_CS: Clear Charging Profile - Without previous charging profile */
export const TC_K_08_CS: CsTestCase = {
  id: 'TC_K_08_CS',
  name: 'Clear Charging Profile - Without previous profile',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS tries to clear a profile when none are installed.',
  purpose: 'To verify if the station denies clearing when no profiles exist.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);
    try {
      const res = await ctx.server.sendCommand('ClearChargingProfile', { chargingProfileId: 999 });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse Unknown',
        status: status === 'Unknown' ? 'passed' : 'failed',
        expected: 'Unknown',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse',
        status: 'failed',
        expected: 'Unknown',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_09_CS: Clear Charging Profile - Clearing TxDefaultProfile with ongoing transaction */
export const TC_K_09_CS: CsTestCase = {
  id: 'TC_K_09_CS',
  name: 'Clear Charging Profile - TxDefaultProfile with ongoing transaction',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS clears a TxDefaultProfile during an ongoing transaction.',
  purpose:
    'To verify the station clears TxDefaultProfile during a transaction and uses local limits.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);
    // Memory State: TxDefaultProfile, duration 400 + max time deviation, limit 6 A
    await installProfile(ctx, steps, 1, 1, 402);
    await energyTransferStarted(ctx, steps);

    // Step 1-2: GetCompositeSchedule before clear
    try {
      const res = await ctx.server.sendCommand('GetCompositeSchedule', {
        evseId: 1,
        duration: 300,
        chargingRateUnit: 'A',
      });
      const status = (res as Record<string, unknown>).status;
      const limit = firstLimit(res);
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse Accepted (before clear), limit of the profile',
        status: status === 'Accepted' && limit === 6 ? 'passed' : 'failed',
        expected: 'Accepted, limit 6',
        actual: `status: ${String(status)}, limit ${String(limit)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 3-4: ClearChargingProfile TxDefaultProfile
    try {
      const res = await ctx.server.sendCommand('ClearChargingProfile', {
        chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile' },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 4,
        description: 'ClearChargingProfileResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 4,
        description: 'ClearChargingProfileResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 5-6: GetCompositeSchedule after clear - limit should be higher
    try {
      const res = await ctx.server.sendCommand('GetCompositeSchedule', {
        evseId: 1,
        duration: 300,
        chargingRateUnit: 'A',
      });
      const status = (res as Record<string, unknown>).status;
      const limit = firstLimit(res);
      steps.push({
        step: 5,
        description: 'GetCompositeScheduleResponse Accepted (after clear), the local limit',
        status: status === 'Accepted' && limit != null && limit > 6 ? 'passed' : 'failed',
        expected: 'Accepted with a limit above 6 (local limit)',
        actual: `status: ${String(status)}, limit ${String(limit)}`,
      });
    } catch (err) {
      steps.push({
        step: 5,
        description: 'GetCompositeScheduleResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_24_CS: Clear Charging Profile - With stackLevel/purpose for multiple profiles */
export const TC_K_24_CS: CsTestCase = {
  id: 'TC_K_24_CS',
  name: 'Clear Charging Profile - stackLevel/purpose for multiple profiles',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS clears multiple profiles matching a stackLevel and purpose combination across EVSEs.',
  purpose: 'To verify clearing multiple profiles across EVSEs by purpose and stackLevel.',
  // Prerequisite: the Charging Station has 2 or more EVSE.
  stationConfig: { evseCount: 2 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);
    await installProfile(ctx, steps, 1, 1);
    await installProfile(ctx, steps, 2, 2);
    try {
      const res = await ctx.server.sendCommand('ClearChargingProfile', {
        chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 0 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'ClearChargingProfileResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 0 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 4,
        description: 'GetChargingProfilesResponse NoProfiles',
        status: status === 'NoProfiles' ? 'passed' : 'failed',
        expected: 'NoProfiles',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 4,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'NoProfiles',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
