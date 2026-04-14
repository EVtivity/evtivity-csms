// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

function makeDefaultHandler(authStatus: string = 'Accepted') {
  return async (action: string): Promise<Record<string, unknown>> => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize') return { idTokenInfo: { status: authStatus } };
    if (action === 'TransactionEvent') return { idTokenInfo: { status: authStatus } };
    return {};
  };
}

/**
 * TC_C_08_CS: Authorization through authorization cache - Accepted
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, IdTokenCached valid
 * Scenario: Authorized (cached) -> EVConnectedPreSession -> EnergyTransferStarted
 * Post: Energy transfer is started
 */
export const TC_C_08_CS: CsTestCase = {
  id: 'TC_C_08_CS',
  name: 'Authorization through authorization cache - Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'EV Driver is authorized to start a transaction using a cached Accepted idToken.',
  purpose:
    'To verify if the Charging Station is able to Authorize an idToken which has status Accepted in its cache.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeDefaultHandler('Accepted'));

    // Setup: enable auth cache and local pre-authorize, add token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT-CACHED-VALID-001', 'Accepted');

    // Step 1: Reusable State Authorized (Cached idToken) - present idToken, auto-starts on cable
    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'OCTT-CACHED-VALID-001');

    // Step 2: Wait for EnergyTransferStarted (transaction auto-started on authorize)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Validate TransactionEvent was sent
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger = tx['triggerReason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Station authorizes from cache and starts energy transfer',
      status: tx != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest received',
      actual: `triggerReason = ${String(trigger)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_09_CS: Authorization through authorization cache - Invalid & Not Accepted
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, DisablePostAuthorize=false,
 *         IdTokenCached invalid
 * Scenario: Authorized for invalid token -> station sends Authorize, CSMS returns Invalid
 * Post: No energy transfer
 */
export const TC_C_09_CS: CsTestCase = {
  id: 'TC_C_09_CS',
  name: 'Authorization through authorization cache - Invalid & Not Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'EV Driver attempts authorization with an Invalid cached idToken.',
  purpose:
    'To verify if the Charging Station is able to Authorize an idToken which has status Invalid in its cache and does not start.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeDefaultHandler('Invalid'));

    // Setup: enable auth cache, local pre-authorize, add invalid token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCacheCtrlr.DisablePostAuthorize', 'false');
    ctx.station.addToAuthCache('OCTT-CACHED-INVALID-001', 'Invalid');

    // Present invalid cached token
    await ctx.station.authorize(1, 'OCTT-CACHED-INVALID-001');

    // Station should send AuthorizeRequest (post-authorize since DisablePostAuthorize=false)
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest for invalid cached token',
      status: idToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken present',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    // Station should NOT start a transaction
    let txReceived = false;
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
      txReceived = true;
    } catch {
      // Expected
    }
    steps.push({
      step: 2,
      description: 'Station does NOT start a transaction after Invalid response',
      status: !txReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest',
      actual: txReceived ? 'TransactionEventRequest received' : 'No TransactionEventRequest',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_10_CS: Authorization through authorization cache - Blocked
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, DisablePostAuthorize=false,
 *         IdTokenCached blocked
 * Scenario: Authorized for blocked token -> CSMS returns Blocked
 * Post: No energy transfer
 */
export const TC_C_10_CS: CsTestCase = {
  id: 'TC_C_10_CS',
  name: 'Authorization through authorization cache - Blocked',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'EV Driver attempts authorization with a Blocked cached idToken.',
  purpose:
    'To verify if the Charging Station is able to Authorize an idToken which has status Blocked in its cache.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeDefaultHandler('Blocked'));

    // Setup: enable auth cache, local pre-authorize, add blocked token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCacheCtrlr.DisablePostAuthorize', 'false');
    ctx.station.addToAuthCache('OCTT-CACHED-BLOCKED-001', 'Blocked');

    await ctx.station.authorize(1, 'OCTT-CACHED-BLOCKED-001');

    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest for blocked cached token',
      status: idToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken present',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    let txReceived = false;
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
      txReceived = true;
    } catch {
      // Expected
    }
    steps.push({
      step: 2,
      description: 'Station does NOT start a transaction after Blocked response',
      status: !txReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest',
      actual: txReceived ? 'TransactionEventRequest received' : 'No TransactionEventRequest',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_11_CS: Authorization through authorization cache - Expired
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, DisablePostAuthorize=false,
 *         IdTokenCached expired
 * Scenario: Authorized for expired token -> CSMS returns Expired
 * Post: No energy transfer
 */
export const TC_C_11_CS: CsTestCase = {
  id: 'TC_C_11_CS',
  name: 'Authorization through authorization cache - Expired',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'EV Driver attempts authorization with an Expired cached idToken.',
  purpose:
    'To verify if the Charging Station is able to Authorize an idToken which has status Expired in its cache.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeDefaultHandler('Expired'));

    // Setup: enable auth cache, local pre-authorize, add expired token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCacheCtrlr.DisablePostAuthorize', 'false');
    ctx.station.addToAuthCache('OCTT-CACHED-EXPIRED-001', 'Expired');

    await ctx.station.authorize(1, 'OCTT-CACHED-EXPIRED-001');

    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest for expired cached token',
      status: idToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken present',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    let txReceived = false;
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
      txReceived = true;
    } catch {
      // Expected
    }
    steps.push({
      step: 2,
      description: 'Station does NOT start a transaction after Expired response',
      status: !txReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest',
      actual: txReceived ? 'TransactionEventRequest received' : 'No TransactionEventRequest',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_12_CS: Authorization through authorization cache - Invalid & Accepted
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, DisablePostAuthorize=false,
 *         IdTokenCached invalid (but now valid on CSMS side)
 * Scenario: Present invalid cached token -> CSMS returns Accepted (outdated cache) ->
 *           EVConnectedPreSession -> EnergyTransferStarted
 * Post: Energy transfer is started
 */
export const TC_C_12_CS: CsTestCase = {
  id: 'TC_C_12_CS',
  name: 'Authorization through authorization cache - Invalid & Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'EV Driver attempts authorization with an Invalid cached idToken that is now valid (outdated cache).',
  purpose:
    'To verify if the Charging Station accepts an idToken that was Invalid in cache but now Accepted by CSMS.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // CSMS returns Accepted even though the cache says Invalid
    ctx.server.setMessageHandler(makeDefaultHandler('Accepted'));

    // Setup: enable auth cache, local pre-authorize, add invalid token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCacheCtrlr.DisablePostAuthorize', 'false');
    ctx.station.addToAuthCache('OCTT-CACHED-INVALID-002', 'Invalid');

    // Step 1: Present invalid cached token (CSMS overrides with Accepted)
    await ctx.station.authorize(1, 'OCTT-CACHED-INVALID-002');

    // Step 2: EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 3: EnergyTransferStarted
    await ctx.station.startCharging(1, 'OCTT-CACHED-INVALID-002');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 1,
      description: 'Station authorizes (outdated cache, CSMS returns Accepted) and starts charging',
      status: tx != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest received',
      actual: `received: ${tx != null}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_13_CS: Authorization through authorization cache - Accepted but cable not connected yet
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, IdTokenCached valid
 * Scenario: Authorized (cached, no cable) -> EVConnectedPreSession -> EnergyTransferStarted
 * Post: Energy transfer is started
 */
export const TC_C_13_CS: CsTestCase = {
  id: 'TC_C_13_CS',
  name: 'Authorization through authorization cache - Accepted but cable not connected yet',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'EV Driver authorized from cache but cable not yet connected.',
  purpose:
    'To verify if the Charging Station is able to Authorize an idToken which has status Accepted in its cache when cable is not connected.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeDefaultHandler('Accepted'));

    // Setup: enable auth cache, local pre-authorize, add token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT-CACHED-VALID-002', 'Accepted');

    // Step 1: Authorize first (cable not connected)
    await ctx.station.authorize(1, 'OCTT-CACHED-VALID-002');

    // Step 2: Then plug in (EVConnectedPreSession)
    await ctx.station.plugIn(1);

    // Step 3: EnergyTransferStarted
    await ctx.station.startCharging(1, 'OCTT-CACHED-VALID-002');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger = tx['triggerReason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Station authorizes from cache (cable not connected) and starts charging',
      status: tx != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest received',
      actual: `triggerReason = ${String(trigger)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_14_CS: Authorization through authorization cache - GroupID equal to MasterPassGroupId
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, MasterPassGroupId configured,
 *         State is EnergyTransferStarted
 * Scenario: Present MasterPass token from cache -> Station sends TransactionEvent StopAuthorized
 * Post: Transaction stopped
 */
export const TC_C_14_CS: CsTestCase = {
  id: 'TC_C_14_CS',
  name: 'Authorization through authorization cache - GroupID equal to MasterPassGroupId',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'EV Driver presents idToken with GroupId equal to MasterPassGroupId from cache.',
  purpose:
    'To verify if the Charging Station correctly stops a transaction with a MasterPass token from cache.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    const masterPassGroup = { idToken: 'MASTERPASS-GROUP-001', type: 'Central' };
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize')
        return { idTokenInfo: { status: 'Accepted', groupIdToken: masterPassGroup } };
      if (action === 'TransactionEvent')
        return { idTokenInfo: { status: 'Accepted', groupIdToken: masterPassGroup } };
      return {};
    });

    // Setup: enable auth cache and local pre-authorize, configure MasterPassGroupId, add token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.MasterPassGroupId', 'MASTERPASS-GROUP-001');
    ctx.station.addToAuthCache('MASTERPASS-TOKEN-001', 'Accepted', masterPassGroup);

    // Before: EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Present MasterPass token from cache
    await ctx.station.authorize(1, 'MASTERPASS-TOKEN-001');

    // Validate: TransactionEvent with triggerReason StopAuthorized (skip meter value events)
    let stopAuthorized = false;
    let lastTrigger = '';
    for (let i = 0; i < 10; i++) {
      try {
        const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
        const trigger = tx['triggerReason'] as string | undefined;
        lastTrigger = String(trigger);
        if (trigger === 'StopAuthorized') {
          stopAuthorized = true;
          break;
        }
      } catch {
        break;
      }
    }

    steps.push({
      step: 2,
      description:
        'Station sends TransactionEventRequest with StopAuthorized and MasterPass stoppedReason',
      status: stopAuthorized ? 'passed' : 'failed',
      expected: 'triggerReason = StopAuthorized',
      actual: stopAuthorized ? 'StopAuthorized found' : `last triggerReason = ${lastTrigger}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_15_CS: Authorization through authorization cache - StopTxOnInvalidId = false, MaxEnergyOnInvalidId > 0
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, LocalAuthorizeOffline=true,
 *         StopTxOnInvalidId=false, MaxEnergyOnInvalidId=10000, State=EVConnectedPreSession
 * Scenario: Disconnect -> present valid cached token offline -> reconnect ->
 *           station sends offline TransactionEvents -> CSMS returns Invalid ->
 *           station continues charging (limited energy)
 * Post: Energy transfer started but limited to MaxEnergyOnInvalidId
 */
export const TC_C_15_CS: CsTestCase = {
  id: 'TC_C_15_CS',
  name: 'Authorization through authorization cache - StopTxOnInvalidId = false, MaxEnergyOnInvalidId > 0',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Offline authorization with cached token, StopTxOnInvalidId false and MaxEnergyOnInvalidId > 0.',
  purpose:
    'To verify the station continues charging with limited energy when CSMS returns Invalid after reconnection.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action, payload) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') {
        const idToken = payload['idToken'];
        if (idToken != null) return { idTokenInfo: { status: 'Invalid' } };
        return {};
      }
      return {};
    });

    // Setup: enable auth cache, local pre-authorize, add token, configure behavior
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('TxCtrlr.StopTxOnInvalidId', 'false');
    ctx.station.setConfigValue('TxCtrlr.MaxEnergyOnInvalidId', '10000');
    ctx.station.addToAuthCache('OCTT-CACHED-VALID-003', 'Accepted');

    // Before: EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 1: Disconnect station (go offline, reject reconnect)
    ctx.server.disconnectStation(true);

    // Present valid cached token while offline (transaction auto-starts on authorize)
    await ctx.station.authorize(1, 'OCTT-CACHED-VALID-003');

    // Wait for offline transaction duration
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 2: Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 3: Station sends offline TransactionEventRequests
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const offline = tx['offline'] as boolean | undefined;
    steps.push({
      step: 3,
      description: 'Station sends offline TransactionEventRequest(s) after reconnection',
      status: offline === true ? 'passed' : 'failed',
      expected: 'offline = true',
      actual: `offline = ${String(offline)}`,
    });

    // Step 4: CSMS responds with Invalid (handled by message handler)
    // Validate: no Deauthorized or SuspendedEVSE (StopTxOnInvalidId=false, MaxEnergyOnInvalidId>0)
    let deauthorized = false;
    try {
      const txNext = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const nextTrigger = txNext['triggerReason'] as string | undefined;
      const nextTxInfo = txNext['transactionInfo'] as Record<string, unknown> | undefined;
      const chargingState = nextTxInfo?.['chargingState'] as string | undefined;
      if (nextTrigger === 'Deauthorized' || chargingState === 'SuspendedEVSE') {
        deauthorized = true;
      }
    } catch {
      // Expected: no deauthorization
    }
    steps.push({
      step: 4,
      description:
        'Station does NOT send Deauthorized or SuspendedEVSE (StopTxOnInvalidId=false, MaxEnergyOnInvalidId>0)',
      status: !deauthorized ? 'passed' : 'failed',
      expected: 'No Deauthorized or SuspendedEVSE',
      actual: deauthorized ? 'Deauthorized/SuspendedEVSE received' : 'No deauthorization',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_16_CS: Authorization through authorization cache - StopTxOnInvalidId = true
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, LocalAuthorizeOffline=true,
 *         StopTxOnInvalidId=true, MaxEnergyOnInvalidId=0, State=EVConnectedPreSession
 * Scenario: Disconnect -> present valid cached token offline -> reconnect ->
 *           station sends offline TransactionEvents -> CSMS returns Invalid ->
 *           station sends Deauthorized
 * Post: Energy flow stops on receiving Invalid
 */
export const TC_C_16_CS: CsTestCase = {
  id: 'TC_C_16_CS',
  name: 'Authorization through authorization cache - StopTxOnInvalidId = true',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Offline authorization with cached token, StopTxOnInvalidId true.',
  purpose:
    'To verify the station stops charging when CSMS returns Invalid after reconnection with StopTxOnInvalidId true.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action, payload) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') {
        const idToken = payload['idToken'];
        if (idToken != null) return { idTokenInfo: { status: 'Invalid' } };
        return {};
      }
      return {};
    });

    // Setup: enable auth cache, local pre-authorize, configure StopTxOnInvalidId
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('TxCtrlr.StopTxOnInvalidId', 'true');
    ctx.station.setConfigValue('TxCtrlr.MaxEnergyOnInvalidId', '0');
    ctx.station.addToAuthCache('OCTT-CACHED-VALID-004', 'Accepted');

    // Before: EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 1: Disconnect station (go offline, reject reconnect)
    ctx.server.disconnectStation(true);

    // Present valid cached token while offline (transaction auto-starts on authorize)
    await ctx.station.authorize(1, 'OCTT-CACHED-VALID-004');

    // Wait briefly for offline transaction
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 2: Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 3: Station sends offline TransactionEventRequests
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 3,
      description: 'Station sends offline TransactionEventRequest(s)',
      status: tx != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest received',
      actual: `received: ${tx != null}`,
    });

    // Step 5: Station sends Deauthorized after CSMS returns Invalid
    const txDeauth = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const deauthTrigger = txDeauth['triggerReason'] as string | undefined;
    steps.push({
      step: 5,
      description: 'Station sends TransactionEventRequest with triggerReason Deauthorized',
      status: deauthTrigger === 'Deauthorized' ? 'passed' : 'failed',
      expected: 'triggerReason = Deauthorized',
      actual: `triggerReason = ${String(deauthTrigger)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_17_CS: Authorization through authorization cache - StopTxOnInvalidId = false
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, StopTxOnInvalidId=false,
 *         MaxEnergyOnInvalidId=0, State=EVConnectedPreSession
 * Scenario: Disconnect -> present valid cached token offline -> reconnect ->
 *           station sends offline TransactionEvents -> CSMS returns Invalid ->
 *           station suspends EVSE (does NOT deauthorize)
 * Post: Energy flow stops, SuspendedEVSE
 */
export const TC_C_17_CS: CsTestCase = {
  id: 'TC_C_17_CS',
  name: 'Authorization through authorization cache - StopTxOnInvalidId = false',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Offline authorization with cached token, StopTxOnInvalidId false.',
  purpose:
    'To verify the station suspends EVSE when CSMS returns Invalid with StopTxOnInvalidId false.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action, payload) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') {
        const idToken = payload['idToken'];
        if (idToken != null) return { idTokenInfo: { status: 'Invalid' } };
        return {};
      }
      return {};
    });

    // Setup: enable auth cache, local pre-authorize, configure StopTxOnInvalidId=false
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('TxCtrlr.StopTxOnInvalidId', 'false');
    ctx.station.setConfigValue('TxCtrlr.MaxEnergyOnInvalidId', '0');
    ctx.station.addToAuthCache('OCTT-CACHED-VALID-005', 'Accepted');

    // Before: EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 1: Disconnect station (go offline, reject reconnect)
    ctx.server.disconnectStation(true);

    // Present valid cached token while offline (transaction auto-starts on authorize)
    await ctx.station.authorize(1, 'OCTT-CACHED-VALID-005');

    // Wait briefly
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 2: Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 2 validation: Station sends offline TransactionEventRequests
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const offline = tx['offline'] as boolean | undefined;
    steps.push({
      step: 2,
      description: 'Station sends offline TransactionEventRequest(s) with offline=true',
      status: offline === true ? 'passed' : 'failed',
      expected: 'offline = true',
      actual: `offline = ${String(offline)}`,
    });

    // Validate: no Deauthorized trigger (StopTxOnInvalidId=false means suspend, not stop)
    let deauthorized = false;
    try {
      const txNext = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const nextTrigger = txNext['triggerReason'] as string | undefined;
      if (nextTrigger === 'Deauthorized') {
        deauthorized = true;
      }
    } catch {
      // Expected
    }
    steps.push({
      step: 3,
      description: 'Station does NOT send Deauthorized (StopTxOnInvalidId=false, suspends instead)',
      status: !deauthorized ? 'passed' : 'failed',
      expected: 'No Deauthorized trigger',
      actual: deauthorized ? 'Deauthorized received' : 'No Deauthorized',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_18_CS: Authorization through authorization cache - StopTxOnInvalidId = true, MaxEnergyOnInvalidId > 0
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, LocalAuthorizeOffline=true,
 *         StopTxOnInvalidId=true, MaxEnergyOnInvalidId=500, State=EVConnectedPreSession
 * Scenario: Disconnect -> present valid cached token offline -> reconnect ->
 *           station sends offline TransactionEvents -> CSMS returns Invalid ->
 *           station sends Deauthorized (after limited energy)
 * Post: Energy flow stops after MaxEnergyOnInvalidId delivered
 */
export const TC_C_18_CS: CsTestCase = {
  id: 'TC_C_18_CS',
  name: 'Authorization through authorization cache - StopTxOnInvalidId = true, MaxEnergyOnInvalidId > 0',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Offline authorization with cached token, StopTxOnInvalidId true and MaxEnergyOnInvalidId > 0.',
  purpose:
    'To verify the station deauthorizes after delivering limited energy when CSMS returns Invalid.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action, payload) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') {
        const idToken = payload['idToken'];
        if (idToken != null) return { idTokenInfo: { status: 'Invalid' } };
        return {};
      }
      return {};
    });

    // Setup: enable auth cache, local pre-authorize, configure behavior
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalAuthorizeOffline', 'true');
    ctx.station.setConfigValue('TxCtrlr.StopTxOnInvalidId', 'true');
    ctx.station.setConfigValue('TxCtrlr.MaxEnergyOnInvalidId', '500');
    ctx.station.addToAuthCache('OCTT-CACHED-VALID-006', 'Accepted');

    // Before: EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 1: Disconnect station (go offline, reject reconnect)
    ctx.server.disconnectStation(true);

    // Present valid cached token while offline (transaction auto-starts on authorize)
    await ctx.station.authorize(1, 'OCTT-CACHED-VALID-006');

    // Wait for offline transaction duration
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 2: Accept reconnection
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(60000);

    // Step 3: Station sends offline TransactionEventRequests
    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 3,
      description: 'Station sends offline TransactionEventRequest(s)',
      status: tx != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest received',
      actual: `received: ${tx != null}`,
    });

    // Step 5: Station sends Deauthorized
    const txDeauth = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger = txDeauth['triggerReason'] as string | undefined;
    steps.push({
      step: 5,
      description: 'Station sends Deauthorized TransactionEventRequest',
      status: trigger === 'Deauthorized' ? 'passed' : 'failed',
      expected: 'triggerReason = Deauthorized',
      actual: `triggerReason = ${String(trigger)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_57_CS: Authorization through authorization cache - AuthCacheDisablePostAuthorize
 *
 * Before: AuthCacheEnabled=true, LocalPreAuthorize=true, DisablePostAuthorize=true,
 *         IdTokenCached invalid
 * Scenario: Present invalid cached token -> station should NOT send AuthorizeRequest ->
 *           station does NOT start charging
 * Post: No charging started
 */
export const TC_C_57_CS: CsTestCase = {
  id: 'TC_C_57_CS',
  name: 'Authorization through authorization cache - AuthCacheDisablePostAuthorize',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'EV Driver authorized via cached Invalid token with DisablePostAuthorize true.',
  purpose:
    'To verify that the Charging Station will not send an AuthorizeRequest for an IdToken in the cache when DisablePostAuthorize is true.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'RequestStartTransaction') return { status: 'Accepted' };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Setup: enable auth cache, local pre-authorize, disable post-authorize
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('AuthCacheCtrlr.DisablePostAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT-CACHED-INVALID-003', 'Invalid');

    // Present invalid cached token
    await ctx.station.authorize(1, 'OCTT-CACHED-INVALID-003');

    // Plug in (EVConnectedPreSession)
    await ctx.station.plugIn(1);

    // Station should NOT send AuthorizeRequest (DisablePostAuthorize = true)
    let authReceived = false;
    try {
      await ctx.server.waitForMessage('Authorize', 5000);
      authReceived = true;
    } catch {
      // Expected: no AuthorizeRequest
    }
    steps.push({
      step: 3,
      description: 'Station does NOT send AuthorizeRequest (DisablePostAuthorize=true)',
      status: !authReceived ? 'passed' : 'failed',
      expected: 'No AuthorizeRequest',
      actual: authReceived ? 'AuthorizeRequest received' : 'No AuthorizeRequest',
    });

    // Station should NOT start charging
    let txStarted = false;
    try {
      const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const txInfo = tx['transactionInfo'] as Record<string, unknown> | undefined;
      const chargingState = txInfo?.['chargingState'] as string | undefined;
      if (chargingState === 'Charging') txStarted = true;
    } catch {
      // Expected
    }
    steps.push({
      step: 5,
      description: 'Station does NOT start charging',
      status: !txStarted ? 'passed' : 'failed',
      expected: 'No charging started',
      actual: txStarted ? 'Charging started' : 'No charging',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
