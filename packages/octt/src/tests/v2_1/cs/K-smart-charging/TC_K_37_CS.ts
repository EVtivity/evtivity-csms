// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

/**
 * TC_K_37_CS: Remote start transaction with charging profile - Success
 * Use case: K05, F01 (K05.FR.03, E01.FR.02, F01.FR.10, F01.FR.13)
 */
export const TC_K_37_CS: CsTestCase = {
  id: 'TC_K_37_CS',
  name: 'Remote start transaction with charging profile - Success',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sets a TxProfile on a specific EVSE inside a RequestStartTransactionRequest message.',
  purpose:
    'To verify if the Charging Station is able to set a TxProfile on a specific EVSE when receiving one in a RequestStartTransaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'ReportChargingProfiles') return {};
      return {};
    });

    // Before: EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 1-2: RequestStartTransaction with TxProfile
    try {
      const res = await ctx.server.sendCommand('RequestStartTransaction', {
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Relative',
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
        description: 'RequestStartTransactionResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'RequestStartTransactionResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 5: Wait for TransactionEventRequest with RemoteStart trigger
    try {
      const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10_000);
      const trigger = (txPayload as Record<string, unknown>).triggerReason;
      const txInfo = (txPayload as Record<string, unknown>).transactionInfo as
        | Record<string, unknown>
        | undefined;
      const hasRemoteStartId = txInfo?.remoteStartId != null;

      steps.push({
        step: 5,
        description: 'TransactionEventRequest with RemoteStart',
        status: trigger === 'RemoteStart' && hasRemoteStartId ? 'passed' : 'failed',
        expected: 'triggerReason RemoteStart, remoteStartId present',
        actual: `trigger: ${String(trigger)}, hasRemoteStartId: ${String(hasRemoteStartId)}`,
      });
    } catch {
      steps.push({
        step: 5,
        description: 'TransactionEventRequest RemoteStart',
        status: 'failed',
        expected: 'RemoteStart trigger',
        actual: 'Timeout',
      });
    }

    // Step 7: EnergyTransferStarted - the remote start already started charging.
    // Wait for the Charging state TransactionEvent (drains intermediate events).
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 8-11: GetChargingProfiles and verify profile is installed
    try {
      const res = await ctx.server.sendCommand('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfileId: 1 },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 9,
        description: 'GetChargingProfilesResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 9,
        description: 'GetChargingProfilesResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      const report = await ctx.server.waitForMessage('ReportChargingProfiles', 10_000);
      steps.push({
        step: 10,
        description: 'ReportChargingProfilesRequest received',
        status: report != null ? 'passed' : 'failed',
        expected: 'Profile report received',
        actual: 'Report received',
      });
    } catch {
      steps.push({
        step: 10,
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
 * TC_K_38_CS: Remote start transaction with charging profile - Ignore chargingProfile
 * Use case: F01 (F01.FR.12, F01.FR.13)
 */
export const TC_K_38_CS: CsTestCase = {
  id: 'TC_K_38_CS',
  name: 'Remote start transaction with charging profile - Ignore chargingProfile',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sets a TxProfile on a specific EVSE inside a RequestStartTransactionRequest message.',
  purpose:
    'To verify if the Charging Station ignores a TxProfile when it does not support Smart Charging.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      return {};
    });

    // Before: EVConnectedPreSession
    await ctx.station.plugIn(1);

    try {
      const res = await ctx.server.sendCommand('RequestStartTransaction', {
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Relative',
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
        description: 'RequestStartTransactionResponse Accepted (profile ignored)',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'RequestStartTransactionResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      const txPayload = await ctx.server.waitForMessage('TransactionEvent', 10_000);
      const trigger = (txPayload as Record<string, unknown>).triggerReason;
      const txInfo = (txPayload as Record<string, unknown>).transactionInfo as
        | Record<string, unknown>
        | undefined;
      steps.push({
        step: 5,
        description: 'TransactionEventRequest with RemoteStart',
        status: trigger === 'RemoteStart' && txInfo?.remoteStartId != null ? 'passed' : 'failed',
        expected: 'triggerReason RemoteStart, remoteStartId present',
        actual: `trigger: ${String(trigger)}`,
      });
    } catch {
      steps.push({
        step: 5,
        description: 'TransactionEventRequest RemoteStart',
        status: 'failed',
        expected: 'RemoteStart trigger',
        actual: 'Timeout',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
