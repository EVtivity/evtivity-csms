// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

const defaultHandler = async (action: string) => {
  if (action === 'BootNotification')
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  if (action === 'StatusNotification') return {};
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  if (action === 'NotifyEvent') return {};
  if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
  if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
  return {};
};

/**
 * TC_K_01_CS: Set Charging Profile - TxDefaultProfile - Specific EVSE
 * Use case: K01 (K01.FR.07, K01.FR.15)
 */
export const TC_K_01_CS: CsTestCase = {
  id: 'TC_K_01_CS',
  name: 'Set Charging Profile - TxDefaultProfile - Specific EVSE',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE.',
  purpose:
    'To verify if the Charging station is able to accept and successfully change to the TxDefaultProfile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'ReportChargingProfiles') return {};
      return defaultHandler(action);
    });

    // Step 1-2: SetChargingProfile TxDefaultProfile
    try {
      const res = await ctx.server.sendCommand('SetChargingProfile', {
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
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 6, numberPhases: 3 }],
            },
          ],
        },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'SetChargingProfileResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'SetChargingProfileResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 3-4: GetChargingProfiles
    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfileId: 1 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 4,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 4,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 5: Wait for ReportChargingProfiles
    try {
      const report = await ctx.server.waitForMessage('ReportChargingProfiles', 30_000);
      const hasProfile = report != null;
      steps.push({
        step: 5,
        description: 'ReportChargingProfilesRequest received',
        status: hasProfile ? 'passed' : 'failed',
        expected: 'ReportChargingProfilesRequest with profile',
        actual: hasProfile ? 'Profile reported' : 'No report',
      });
    } catch {
      steps.push({
        step: 5,
        description: 'ReportChargingProfilesRequest',
        status: 'failed',
        expected: 'ReportChargingProfilesRequest',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_K_02_CS: Set Charging Profile - TxProfile without ongoing transaction on the specified EVSE
 * Use case: K01 (K01.FR.04, K01.FR.07, K01.FR.09)
 */
export const TC_K_02_CS: CsTestCase = {
  id: 'TC_K_02_CS',
  name: 'Set Charging Profile - TxProfile without ongoing transaction',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE.',
  purpose:
    'To verify if the Charging station rejects a TxProfile when there is no ongoing transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(defaultHandler);

    try {
      const res = await ctx.server.sendCommand('SetChargingProfile', {
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          transactionId: 'UNKNOWN-TRANSACTION-ID',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 6 }],
            },
          ],
        },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'SetChargingProfileResponse Rejected',
        status: status === 'Rejected' ? 'passed' : 'failed',
        expected: 'status Rejected',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'SetChargingProfileResponse',
        status: 'failed',
        expected: 'status Rejected',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
