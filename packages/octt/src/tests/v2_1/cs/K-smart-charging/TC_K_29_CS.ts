// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import type { OcppTestServer } from '../../../../cs-server.js';

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

/** Install a charging profile on the station as a precondition. */
async function installProfile(
  server: OcppTestServer,
  evseId: number,
  profile: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await server.sendCommand('SetChargingProfile', {
      evseId,
      chargingProfile: profile,
    });
    return (res as Record<string, unknown>).status === 'Accepted';
  } catch {
    return false;
  }
}

const txDefaultProfile = {
  id: 1,
  chargingProfileId: 1,
  stackLevel: 0,
  chargingProfilePurpose: 'TxDefaultProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: [
    {
      id: 1,
      chargingRateUnit: 'A',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 16, numberPhases: 3 }],
    },
  ],
};

const stationMaxProfile = {
  id: 2,
  chargingProfileId: 2,
  stackLevel: 0,
  chargingProfilePurpose: 'ChargingStationMaxProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: [
    {
      id: 2,
      chargingRateUnit: 'A',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 32, numberPhases: 3 }],
    },
  ],
};

/** TC_K_29_CS: Get Charging Profile - EvseId 0 */
export const TC_K_29_CS: CsTestCase = {
  id: 'TC_K_29_CS',
  name: 'Get Charging Profile - EvseId 0',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS asks a Charging Station to report charging profiles for evseId 0.',
  purpose: 'To verify if the Charging station reports profiles for evseId 0 (station-level).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install a ChargingStationMaxProfile on evseId 0
    const installed = await installProfile(ctx.server, 0, stationMaxProfile);
    steps.push({
      step: 1,
      description: 'Precondition: Install ChargingStationMaxProfile on evseId 0',
      status: installed ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: installed ? 'Accepted' : 'Failed to install',
    });

    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        evseId: 0,
        chargingProfile: {},
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      const report = await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      const profiles = (report as Record<string, unknown>).chargingProfile;
      const profileArr = Array.isArray(profiles) ? profiles : [profiles];
      const purpose = (profileArr[0] as Record<string, unknown> | undefined)
        ?.chargingProfilePurpose;
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest with ChargingStationMaxProfile',
        status: purpose === 'ChargingStationMaxProfile' ? 'passed' : 'failed',
        expected: 'chargingProfilePurpose ChargingStationMaxProfile',
        actual: `purpose: ${String(purpose)}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report received',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_30_CS: Get Charging Profile - EvseId > 0 */
export const TC_K_30_CS: CsTestCase = {
  id: 'TC_K_30_CS',
  name: 'Get Charging Profile - EvseId > 0',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS asks a Charging Station to report profiles for a specific EVSE.',
  purpose: 'To verify if the Charging station reports profiles for a specific EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install a TxDefaultProfile on evseId 1
    const installed = await installProfile(ctx.server, 1, txDefaultProfile);
    steps.push({
      step: 1,
      description: 'Precondition: Install TxDefaultProfile on evseId 1',
      status: installed ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: installed ? 'Accepted' : 'Failed to install',
    });

    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', { requestId: 1, evseId: 1 });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest received',
        status: 'passed',
        expected: 'Report received',
        actual: 'Report received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_31_CS: Get Charging Profile - No EvseId */
export const TC_K_31_CS: CsTestCase = {
  id: 'TC_K_31_CS',
  name: 'Get Charging Profile - No EvseId',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS asks for all installed profiles without specifying evseId.',
  purpose: 'To verify if the Charging station reports all installed charging profiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install a TxDefaultProfile
    const installed = await installProfile(ctx.server, 1, txDefaultProfile);
    steps.push({
      step: 1,
      description: 'Precondition: Install TxDefaultProfile',
      status: installed ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: installed ? 'Accepted' : 'Failed to install',
    });

    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', { requestId: 1 });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest received',
        status: 'passed',
        expected: 'Report',
        actual: 'Received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_32_CS: Get Charging Profile - chargingProfileId */
export const TC_K_32_CS: CsTestCase = {
  id: 'TC_K_32_CS',
  name: 'Get Charging Profile - chargingProfileId',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS asks for a specific charging profile by ID.',
  purpose: 'To verify if the Charging station reports a specific charging profile by ID.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install profile with ID 1
    const installed = await installProfile(ctx.server, 1, txDefaultProfile);
    steps.push({
      step: 1,
      description: 'Precondition: Install profile with chargingProfileId 1',
      status: installed ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: installed ? 'Accepted' : 'Failed to install',
    });

    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfileId: 1 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest received',
        status: 'passed',
        expected: 'Report',
        actual: 'Received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_33_CS: Get Charging Profile - EvseId > 0 + stackLevel */
export const TC_K_33_CS: CsTestCase = {
  id: 'TC_K_33_CS',
  name: 'Get Charging Profile - EvseId > 0 + stackLevel',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS asks for profiles with specific stackLevel.',
  purpose: 'To verify if the Charging station reports a profile with specific stackLevel.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install profile with stackLevel 0
    const installed = await installProfile(ctx.server, 1, txDefaultProfile);
    steps.push({
      step: 1,
      description: 'Precondition: Install profile with stackLevel 0',
      status: installed ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: installed ? 'Accepted' : 'Failed to install',
    });

    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        evseId: 1,
        chargingProfile: { stackLevel: 0 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest received',
        status: 'passed',
        expected: 'Report',
        actual: 'Received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_34_CS: Get Charging Profile - EvseId > 0 + chargingLimitSource */
export const TC_K_34_CS: CsTestCase = {
  id: 'TC_K_34_CS',
  name: 'Get Charging Profile - EvseId > 0 + chargingLimitSource',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS asks for profiles with specific chargingLimitSource.',
  purpose: 'To verify if the Charging station reports profiles filtered by chargingLimitSource.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install a TxDefaultProfile (CSO-sourced)
    const installed = await installProfile(ctx.server, 1, txDefaultProfile);
    steps.push({
      step: 1,
      description: 'Precondition: Install TxDefaultProfile (CSO source)',
      status: installed ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: installed ? 'Accepted' : 'Failed to install',
    });

    // Query with CSO source - should find profiles
    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        evseId: 1,
        chargingProfile: { chargingLimitSource: 'CSO' },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted (CSO)',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest received',
        status: 'passed',
        expected: 'Report',
        actual: 'Received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report',
        actual: 'Timeout',
      });
    }
    // Query with EMS source - should return NoProfiles
    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 2,
        evseId: 1,
        chargingProfile: { chargingLimitSource: 'EMS' },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 6,
        description: 'GetChargingProfilesResponse NoProfiles (EMS)',
        status: status === 'NoProfiles' ? 'passed' : 'failed',
        expected: 'NoProfiles',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 6,
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

/** TC_K_35_CS: Get Charging Profile - EvseId > 0 + chargingProfilePurpose */
export const TC_K_35_CS: CsTestCase = {
  id: 'TC_K_35_CS',
  name: 'Get Charging Profile - EvseId > 0 + chargingProfilePurpose',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS asks for profiles with specific chargingProfilePurpose.',
  purpose: 'To verify filtering by chargingProfilePurpose.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install TxDefaultProfile
    const installed = await installProfile(ctx.server, 1, txDefaultProfile);
    steps.push({
      step: 1,
      description: 'Precondition: Install TxDefaultProfile',
      status: installed ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: installed ? 'Accepted' : 'Failed to install',
    });

    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        evseId: 1,
        chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile' },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest received',
        status: 'passed',
        expected: 'Report',
        actual: 'Received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_36_CS: Get Charging Profile - EvseId > 0 + chargingProfilePurpose + stackLevel */
export const TC_K_36_CS: CsTestCase = {
  id: 'TC_K_36_CS',
  name: 'Get Charging Profile - EvseId > 0 + purpose + stackLevel',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS asks for profiles with specific purpose and stackLevel.',
  purpose: 'To verify filtering by purpose and stackLevel.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(handler);

    // Precondition: install TxDefaultProfile with stackLevel 0
    const installed = await installProfile(ctx.server, 1, txDefaultProfile);
    steps.push({
      step: 1,
      description: 'Precondition: Install TxDefaultProfile stackLevel 0',
      status: installed ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: installed ? 'Accepted' : 'Failed to install',
    });

    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        evseId: 1,
        chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 0 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest received',
        status: 'passed',
        expected: 'Report',
        actual: 'Received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'Report',
        actual: 'Timeout',
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
