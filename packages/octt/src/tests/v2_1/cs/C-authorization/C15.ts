// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

/**
 * TC_C_26_CS: Offline Authorization - Unknown Id
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true, OfflineTxForUnknownIdEnabled=true,
 *         LocalAuthorizeOffline=true, MaxEnergyOnInvalidId=0, StopTxOnInvalidId=false,
 *         State=StartOfflineTransaction
 * Scenario: Station reconnects after offline transaction with unknown id ->
 *           StatusNotification Occupied -> TransactionEvents offline=true ->
 *           CSMS returns Invalid -> station suspends EVSE
 * Validations: StatusNotification Occupied, offline=true, chargingState=SuspendedEVSE
 */
export const TC_C_26_CS: CsTestCase = {
  id: 'TC_C_26_CS',
  name: 'Offline Authorization - Unknown Id',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station is allowed to start a transaction for unknown idTokens when offline and OfflineTxForUnknownIdEnabled is true.',
  purpose:
    'To verify if the Charging Station is able to start a transaction while being offline for an unknown idToken.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Invalid' } };
      return {};
    });

    // Setup: enable AllowOfflineTxForUnknownId, configure StopTxOnInvalidId=false
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('AllowOfflineTxForUnknownId', 'true');
    ctx.station.setConfigValue('TxCtrlr.StopTxOnInvalidId', 'false');
    ctx.station.setConfigValue('TxCtrlr.MaxEnergyOnInvalidId', '0');

    // Before: StartOfflineTransaction - go offline, plug in, authorize, start charging
    ctx.server.disconnectStation(true);

    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'OCTT-UNKNOWN-TOKEN-001');
    // Transaction auto-starts on authorize (cable already plugged)

    // Wait for offline transaction to accumulate events
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 1: Wait for StatusNotification with Occupied
    const status = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connStatus = status['connectorStatus'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Station sends StatusNotificationRequest with connectorStatus Occupied',
      status: connStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'connectorStatus = Occupied',
      actual: `connectorStatus = ${String(connStatus)}`,
    });

    // Step 3: All TransactionEventRequests have offline=true
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const offline = tx['offline'] as boolean | undefined;
    steps.push({
      step: 3,
      description: 'TransactionEventRequests have offline = true',
      status: offline === true ? 'passed' : 'failed',
      expected: 'offline = true',
      actual: `offline = ${String(offline)}`,
    });

    // Step 4: After Invalid response, look for SuspendedEVSE chargingState
    let suspendedFound = false;
    try {
      const txNext = await ctx.server.waitForMessage('TransactionEvent', 10000);
      const txInfo = txNext['transactionInfo'] as Record<string, unknown> | undefined;
      const chargingState = txInfo?.['chargingState'] as string | undefined;
      if (chargingState === 'SuspendedEVSE') suspendedFound = true;
    } catch {
      // May not arrive
    }
    steps.push({
      step: 4,
      description: 'Station sends TransactionEventRequest with chargingState SuspendedEVSE',
      status: suspendedFound ? 'passed' : 'failed',
      expected: 'chargingState = SuspendedEVSE',
      actual: suspendedFound ? 'SuspendedEVSE found' : 'SuspendedEVSE not found',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
