// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

/**
 * TC_C_21_CS: Offline authorization through local authorization list - Accepted
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true, OfflineTxForUnknownIdEnabled=false,
 *         LocalAuthorizeOffline=true, IdTokenLocalAuthList valid, State=StartOfflineTransaction
 * Scenario: Station is offline with active transaction -> present valid token (stop auth) ->
 *           unplug -> reconnect -> station sends offline TransactionEvents
 * Post: offline=true, triggerReason=StopAuthorized
 */
export const TC_C_21_CS: CsTestCase = {
  id: 'TC_C_21_CS',
  name: 'Offline authorization through local authorization list - Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorize an IdToken via the Local Authorization List while offline.',
  purpose:
    'To verify if the Charging Station is able to authorize an idToken with status Accepted in its local authorization list while offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });

    // Setup: enable local auth list, add valid token
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.addToLocalAuthList('OCTT-LOCAL-VALID-001', 'Accepted');

    // Before: StartOfflineTransaction - plug in and start charging, then go offline
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-LOCAL-VALID-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Go offline (disconnect and reject reconnect)
    ctx.server.disconnectStation(true);

    // Manual Action: Present idToken (stop authorization)
    await ctx.station.authorize(1, 'OCTT-LOCAL-VALID-001');

    // Manual Action: Unplug cable
    await ctx.station.unplug(1);

    // Wait briefly for offline events to accumulate
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Search all TransactionEventRequests for StopAuthorized with offline=true
    let stopAuthorizedFound = false;
    let offlineFound = false;
    for (let i = 0; i < 15; i++) {
      try {
        const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
        if (tx['offline'] === true) offlineFound = true;
        if (tx['triggerReason'] === 'StopAuthorized') {
          stopAuthorizedFound = true;
          if (tx['offline'] === true) offlineFound = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 1,
      description: 'Station sends offline TransactionEventRequest(s)',
      status: offlineFound ? 'passed' : 'failed',
      expected: 'offline = true',
      actual: offlineFound ? 'offline=true found' : 'offline=true not found',
    });
    steps.push({
      step: 2,
      description: 'One of the TransactionEventRequests has triggerReason StopAuthorized',
      status: stopAuthorizedFound ? 'passed' : 'failed',
      expected: 'triggerReason = StopAuthorized',
      actual: stopAuthorizedFound ? 'StopAuthorized found' : 'StopAuthorized not found',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_22_CS: Offline authorization through local authorization list - Invalid
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true, OfflineTxForUnknownIdEnabled=false,
 *         LocalAuthorizeOffline=true, IdTokenLocalAuthList invalid
 * Scenario: Disconnect -> drive EV in (plug in) -> present invalid token ->
 *           reconnect -> station sends EVDetected with offline=true
 * Post: No transaction started for the invalid token
 */
export const TC_C_22_CS: CsTestCase = {
  id: 'TC_C_22_CS',
  name: 'Offline authorization through local authorization list - Invalid',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Authorize an IdToken via the Local Authorization List while offline with Invalid status.',
  purpose:
    'To verify if the Charging Station correctly handles an idToken with status Invalid in its local authorization list while offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Setup: enable local auth list, add invalid token
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.addToLocalAuthList('OCTT-LOCAL-INVALID-001', 'Invalid');

    // Step 1: Disconnect station (go offline, reject reconnect)
    ctx.server.disconnectStation(true);

    // Step 2: Drive EV into parking bay (plug in)
    await ctx.station.plugIn(1);

    // Step 3: Present invalid idToken (should be rejected by local auth list)
    await ctx.station.authorize(1, 'OCTT-LOCAL-INVALID-001');

    // Wait briefly
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 4: Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 5: Station does NOT start a transaction for the invalid token
    let txStarted = false;
    try {
      const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const trigger = tx['triggerReason'] as string | undefined;
      if (trigger === 'Authorized') txStarted = true;
    } catch {
      // Expected: no Authorized transaction
    }
    steps.push({
      step: 5,
      description: 'Station does NOT start a transaction for the invalid token offline',
      status: !txStarted ? 'passed' : 'failed',
      expected: 'No Authorized TransactionEventRequest',
      actual: txStarted ? 'Transaction started' : 'No transaction started',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_23_CS: Offline authorization through local authorization list - Blocked
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true, OfflineTxForUnknownIdEnabled=false,
 *         LocalAuthorizeOffline=true, IdTokenLocalAuthList blocked
 * Scenario: Disconnect -> plug in -> present blocked token -> reconnect ->
 *           station sends EVDetected with offline=true
 * Post: No transaction started
 */
export const TC_C_23_CS: CsTestCase = {
  id: 'TC_C_23_CS',
  name: 'Offline authorization through local authorization list - Blocked',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Authorize an IdToken via the Local Authorization List while offline with Blocked status.',
  purpose:
    'To verify if the Charging Station correctly handles an idToken with status Blocked in its local authorization list while offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Setup: enable local auth list, add blocked token
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.addToLocalAuthList('OCTT-LOCAL-BLOCKED-001', 'Blocked');

    // Step 1: Disconnect station
    ctx.server.disconnectStation(true);

    // Step 2: Plug in
    await ctx.station.plugIn(1);

    // Step 3: Present blocked idToken (should be rejected by local auth list)
    await ctx.station.authorize(1, 'OCTT-LOCAL-BLOCKED-001');

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 4: Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 5: Station does NOT start a transaction for the blocked token
    let txStarted = false;
    try {
      const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const trigger = tx['triggerReason'] as string | undefined;
      if (trigger === 'Authorized') txStarted = true;
    } catch {
      // Expected: no Authorized transaction
    }
    steps.push({
      step: 5,
      description: 'Station does NOT start a transaction for the blocked token offline',
      status: !txStarted ? 'passed' : 'failed',
      expected: 'No Authorized TransactionEventRequest',
      actual: txStarted ? 'Transaction started' : 'No transaction started',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_24_CS: Offline authorization through local authorization list - Expired
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true, OfflineTxForUnknownIdEnabled=false,
 *         LocalAuthorizeOffline=true, IdTokenLocalAuthList expired
 * Scenario: Disconnect -> plug in -> present expired token -> reconnect ->
 *           station sends EVDetected with offline=true
 * Post: No transaction started
 */
export const TC_C_24_CS: CsTestCase = {
  id: 'TC_C_24_CS',
  name: 'Offline authorization through local authorization list - Expired',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Authorize an IdToken via the Local Authorization List while offline with Expired status.',
  purpose:
    'To verify if the Charging Station correctly handles an idToken with status Expired in its local authorization list while offline.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Setup: enable local auth list, add expired token
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.addToLocalAuthList('OCTT-LOCAL-EXPIRED-001', 'Expired');

    // Step 1: Disconnect station
    ctx.server.disconnectStation(true);

    // Step 2: Plug in
    await ctx.station.plugIn(1);

    // Step 3: Present expired idToken (should be rejected by local auth list)
    await ctx.station.authorize(1, 'OCTT-LOCAL-EXPIRED-001');

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 4: Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 5: Station does NOT start a transaction for the expired token
    let txStarted = false;
    try {
      const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const trigger = tx['triggerReason'] as string | undefined;
      if (trigger === 'Authorized') txStarted = true;
    } catch {
      // Expected: no Authorized transaction
    }
    steps.push({
      step: 5,
      description: 'Station does NOT start a transaction for the expired token offline',
      status: !txStarted ? 'passed' : 'failed',
      expected: 'No Authorized TransactionEventRequest',
      actual: txStarted ? 'Transaction started' : 'No transaction started',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_25_CS: Offline authorization through local authorization list -
 *             Local Authorization List > Authorization Cache
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true, OfflineTxForUnknownIdEnabled=true,
 *         LocalAuthorizeOffline=true, StopTxOnInvalidId=false,
 *         IdTokenCached valid + IdTokenLocalAuthList invalid (same token)
 *         State=EVConnectedPreSession
 * Scenario: Disconnect -> present token (valid in cache, invalid in local list) ->
 *           reconnect -> station does NOT start a transaction
 * Post: Local auth list takes precedence over cache
 */
export const TC_C_25_CS: CsTestCase = {
  id: 'TC_C_25_CS',
  name: 'Offline authorization through local authorization list - Local Authorization List > Authorization Cache',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Local Authorization List takes precedence over Authorization Cache when offline.',
  purpose:
    'To verify if the Charging Station does not start a transaction while offline for an idToken stored in cache as valid but invalid in the local authorization list.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Setup: enable local auth list, add token as invalid in local list but valid in cache
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('TxCtrlr.StopTxOnInvalidId', 'false');
    ctx.station.addToAuthCache('OCTT-LOCAL-CACHE-CONFLICT-001', 'Accepted');
    ctx.station.addToLocalAuthList('OCTT-LOCAL-CACHE-CONFLICT-001', 'Invalid');

    // Before: EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 1: Disconnect station (go offline, reject reconnect)
    ctx.server.disconnectStation(true);

    // Present token (valid in cache but invalid in local auth list)
    await ctx.station.authorize(1, 'OCTT-LOCAL-CACHE-CONFLICT-001');

    // Wait for configured transaction duration
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 2: Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 3: Station should NOT start a transaction (local list overrides cache)
    let txStarted = false;
    try {
      const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const trigger = tx['triggerReason'] as string | undefined;
      if (trigger === 'Authorized') txStarted = true;
    } catch {
      // Expected: no Authorized transaction
    }
    steps.push({
      step: 3,
      description: 'Station does NOT start a transaction (local auth list > cache)',
      status: !txStarted ? 'passed' : 'failed',
      expected: 'No Authorized TransactionEventRequest',
      actual: txStarted ? 'Transaction started' : 'No transaction started',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
