// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

const GROUP_ID_TOKEN = { idToken: 'GROUP-ID-001', type: 'Central' };

/**
 * TC_C_39_CS: Authorization by GroupId - Success
 *
 * Present first idToken -> Authorize(Accepted + groupId) -> TransactionEvent(Authorized)
 * -> EnergyTransferStarted -> Present second idToken -> Authorize(Accepted + groupId)
 * -> TransactionEvent(StopAuthorized)
 */
export const TC_C_39_CS: CsTestCase = {
  id: 'TC_C_39_CS',
  name: 'Authorization by GroupId - Success',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId.',
  purpose:
    'To verify if the Charging Station is able to correctly handle the Authorization of idTokens with the same GroupId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') {
        return { idTokenInfo: { status: 'Accepted', groupIdToken: GROUP_ID_TOKEN } };
      }
      if (action === 'TransactionEvent') {
        return { idTokenInfo: { status: 'Accepted', groupIdToken: GROUP_ID_TOKEN } };
      }
      return {};
    });

    // Before: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Manual Action: Present valid idToken with GroupId
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 1: Station sends AuthorizeRequest
    const auth1 = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken1 = auth1['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with valid idToken',
      status: idToken1?.['idToken'] != null && idToken1?.['type'] != null ? 'passed' : 'failed',
      expected: 'idToken.idToken and idToken.type present',
      actual: `idToken = ${JSON.stringify(idToken1)}`,
    });

    // Step 3: TransactionEventRequest with triggerReason Authorized
    const tx1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger1 = tx1['triggerReason'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Station sends TransactionEventRequest with triggerReason Authorized',
      status: trigger1 === 'Authorized' ? 'passed' : 'failed',
      expected: 'triggerReason = Authorized',
      actual: `triggerReason = ${String(trigger1)}`,
    });

    // Step 5: Wait for EnergyTransferStarted (transaction auto-started on authorize)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present other valid idToken with same GroupId
    await ctx.station.authorize(1, 'OCTT-TOKEN-002');

    // Step 6: Second AuthorizeRequest
    const auth2 = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken2 = auth2['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 6,
      description: 'Station sends second AuthorizeRequest with other valid idToken',
      status: idToken2?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken',
      actual: `idToken.idToken = ${String(idToken2?.['idToken'])}`,
    });

    // Step 8: TransactionEventRequest with triggerReason StopAuthorized (skip meter events)
    let stopFound = false;
    let lastTx = '';
    for (let i = 0; i < 10; i++) {
      try {
        const tx2 = await ctx.server.waitForMessage('TransactionEvent', 5000);
        const trigger2 = tx2['triggerReason'] as string | undefined;
        lastTx = String(trigger2);
        if (trigger2 === 'StopAuthorized') {
          stopFound = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 8,
      description: 'Station sends TransactionEventRequest with triggerReason StopAuthorized',
      status: stopFound ? 'passed' : 'failed',
      expected: 'triggerReason = StopAuthorized',
      actual: stopFound ? 'StopAuthorized found' : `last = ${lastTx}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_40_CS: Authorization by GroupId - Success with Local Authorization List
 *
 * Station uses local auth list to authorize first token (no AuthorizeRequest).
 * TransactionEvent(Authorized) -> EnergyTransferStarted -> Present second token
 * -> TransactionEvent(StopAuthorized)
 */
export const TC_C_40_CS: CsTestCase = {
  id: 'TC_C_40_CS',
  name: 'Authorization by GroupId - Success with Local Authorization List',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId using Local Authorization List.',
  purpose:
    'To verify if the Charging Station is able to correctly handle the Authorization of idTokens with the same GroupId from the Local Authorization List.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') {
        return { idTokenInfo: { status: 'Accepted', groupIdToken: GROUP_ID_TOKEN } };
      }
      return {};
    });

    // Setup: add tokens to local auth list with same groupIdToken
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.addToLocalAuthList('OCTT-TOKEN-001', 'Accepted', GROUP_ID_TOKEN);
    ctx.station.addToLocalAuthList('OCTT-TOKEN-002', 'Accepted', GROUP_ID_TOKEN);

    // Before: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Manual Action: Present valid idToken from local auth list
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 1: TransactionEventRequest with triggerReason Authorized (from local list, no Authorize)
    const tx1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger1 = tx1['triggerReason'] as string | undefined;
    const txIdToken1 = tx1['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends TransactionEventRequest with Authorized trigger',
      status: trigger1 === 'Authorized' && txIdToken1?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'triggerReason = Authorized, idToken present',
      actual: `triggerReason = ${String(trigger1)}, idToken = ${String(txIdToken1?.['idToken'])}`,
    });

    // Step 3: Wait for EnergyTransferStarted (transaction auto-started on authorize)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present second valid idToken from local auth list
    await ctx.station.authorize(1, 'OCTT-TOKEN-002');

    // Step 4: TransactionEventRequest with StopAuthorized (skip meter events)
    let stopAuth = false;
    for (let i = 0; i < 10; i++) {
      try {
        const tx2 = await ctx.server.waitForMessage('TransactionEvent', 5000);
        if (tx2['triggerReason'] === 'StopAuthorized') {
          stopAuth = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 4,
      description: 'Station sends TransactionEventRequest with StopAuthorized trigger',
      status: stopAuth ? 'passed' : 'failed',
      expected: 'triggerReason = StopAuthorized',
      actual: stopAuth ? 'StopAuthorized found' : 'StopAuthorized not found',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_41_CS: Authorization by GroupId - Success with Authorization Cache
 *
 * Station uses auth cache to authorize first token (no AuthorizeRequest).
 * TransactionEvent(Authorized) -> EnergyTransferStarted -> Present second token
 * -> TransactionEvent(StopAuthorized)
 */
export const TC_C_41_CS: CsTestCase = {
  id: 'TC_C_41_CS',
  name: 'Authorization by GroupId - Success with Authorization Cache',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId using the Authorization Cache.',
  purpose:
    'To verify if the Charging Station is able to correctly handle the Authorization of idTokens with the same GroupId from the Authorization Cache.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'TransactionEvent') {
        return { idTokenInfo: { status: 'Accepted', groupIdToken: GROUP_ID_TOKEN } };
      }
      return {};
    });

    // Setup: add tokens to auth cache with same groupIdToken
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT-TOKEN-001', 'Accepted', GROUP_ID_TOKEN);
    ctx.station.addToAuthCache('OCTT-TOKEN-002', 'Accepted', GROUP_ID_TOKEN);

    // Before: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Manual Action: Present valid idToken from auth cache
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 1: TransactionEventRequest with triggerReason Authorized (from cache, no Authorize)
    const tx1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger1 = tx1['triggerReason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Station sends TransactionEventRequest with Authorized trigger (cached)',
      status: trigger1 === 'Authorized' ? 'passed' : 'failed',
      expected: 'triggerReason = Authorized',
      actual: `triggerReason = ${String(trigger1)}`,
    });

    // Step 3: Wait for EnergyTransferStarted (transaction auto-started on authorize)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present second valid idToken from auth cache
    await ctx.station.authorize(1, 'OCTT-TOKEN-002');

    // Step 4: TransactionEventRequest with StopAuthorized (skip meter events)
    let stopAuth41 = false;
    for (let i = 0; i < 10; i++) {
      try {
        const tx2 = await ctx.server.waitForMessage('TransactionEvent', 5000);
        if (tx2['triggerReason'] === 'StopAuthorized') {
          stopAuth41 = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 4,
      description: 'Station sends TransactionEventRequest with StopAuthorized trigger',
      status: stopAuth41 ? 'passed' : 'failed',
      expected: 'triggerReason = StopAuthorized',
      actual: stopAuth41 ? 'StopAuthorized found' : 'StopAuthorized not found',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_42_CS: Authorization by GroupId - Not stopped by GroupId
 *
 * Present valid idToken -> Authorize(Accepted + groupId) -> TransactionEvent(Authorized)
 * -> EnergyTransferStarted -> Present invalid idToken with same GroupId
 * -> Authorize(Invalid + groupId) -> Energy transfer is NOT stopped
 */
export const TC_C_42_CS: CsTestCase = {
  id: 'TC_C_42_CS',
  name: 'Authorization by GroupId - Not stopped by GroupId',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId.',
  purpose:
    'To verify if the Charging Station does not stop a transaction when an invalid idToken with the same GroupId is presented.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    let authCount = 0;
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') {
        authCount++;
        return {
          idTokenInfo: {
            status: authCount <= 1 ? 'Accepted' : 'Invalid',
            groupIdToken: GROUP_ID_TOKEN,
          },
        };
      }
      if (action === 'TransactionEvent') {
        return { idTokenInfo: { status: 'Accepted', groupIdToken: GROUP_ID_TOKEN } };
      }
      return {};
    });

    // Before: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Manual Action: Present valid idToken with GroupId
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 1: First AuthorizeRequest
    const auth1 = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken1 = auth1['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends first AuthorizeRequest',
      status: idToken1?.['idToken'] != null && idToken1?.['type'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken',
      actual: `idToken = ${JSON.stringify(idToken1)}`,
    });

    // Step 3: TransactionEventRequest with Authorized
    const tx1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger1 = tx1['triggerReason'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Station sends TransactionEventRequest with Authorized',
      status: trigger1 === 'Authorized' ? 'passed' : 'failed',
      expected: 'triggerReason = Authorized',
      actual: `triggerReason = ${String(trigger1)}`,
    });

    // Step 5: Wait for EnergyTransferStarted (transaction auto-started on authorize)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present invalid idToken with same GroupId
    await ctx.station.authorize(1, 'OCTT-INVALID-TOKEN');

    // Step 6: Second AuthorizeRequest (invalid token)
    const auth2 = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken2 = auth2['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 6,
      description: 'Station sends second AuthorizeRequest with invalid idToken',
      status: idToken2?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken',
      actual: `idToken.idToken = ${String(idToken2?.['idToken'])}`,
    });

    // Post: energy transfer should NOT be stopped
    let stoppedTx = false;
    try {
      const txEnd = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const trigger = txEnd['triggerReason'] as string | undefined;
      if (trigger === 'StopAuthorized') stoppedTx = true;
    } catch {
      // Expected: no StopAuthorized
    }

    steps.push({
      step: 7,
      description: 'Energy transfer is not stopped after invalid idToken',
      status: !stoppedTx ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest with StopAuthorized',
      actual: stoppedTx ? 'Transaction stopped' : 'Transaction still running',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_43_CS: Authorization by GroupId - Invalid status with Local Authorization List
 *
 * Present valid idToken from local list -> TransactionEvent(Authorized)
 * -> EnergyTransferStarted -> Present invalid idToken from local list
 * -> AuthorizeRequest(Invalid) -> Energy transfer NOT stopped
 */
export const TC_C_43_CS: CsTestCase = {
  id: 'TC_C_43_CS',
  name: 'Authorization by GroupId - Invalid status with Local Authorization List',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId with invalid status in the Local Authorization List.',
  purpose:
    'To verify if the Charging Station is able to correctly handle the Authorization of idTokens with the same GroupId when one is invalid.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') {
        return { idTokenInfo: { status: 'Invalid', groupIdToken: GROUP_ID_TOKEN } };
      }
      if (action === 'TransactionEvent') {
        return { idTokenInfo: { status: 'Accepted', groupIdToken: GROUP_ID_TOKEN } };
      }
      return {};
    });

    // Setup: add valid token to local auth list with groupIdToken
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.addToLocalAuthList('OCTT-TOKEN-001', 'Accepted', GROUP_ID_TOKEN);

    // Before: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Manual Action: Present valid idToken from local auth list
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 1: TransactionEventRequest with Authorized (from local list)
    const tx1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger1 = tx1['triggerReason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Station sends TransactionEventRequest with Authorized trigger',
      status: trigger1 === 'Authorized' ? 'passed' : 'failed',
      expected: 'triggerReason = Authorized',
      actual: `triggerReason = ${String(trigger1)}`,
    });

    // Step 3: Wait for EnergyTransferStarted (transaction auto-started on authorize)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present invalid idToken from local auth list
    await ctx.station.authorize(1, 'OCTT-INVALID-TOKEN');

    // Step 4: AuthorizeRequest with invalid idToken
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const authIdToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 4,
      description: 'Station sends AuthorizeRequest with invalid idToken',
      status: authIdToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken',
      actual: `idToken present: ${authIdToken?.['idToken'] != null}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_44_CS: Authorization by GroupId - Invalid status with Authorization Cache
 *
 * Present valid idToken from cache -> TransactionEvent(Authorized)
 * -> EnergyTransferStarted -> Present invalid idToken from cache
 * -> AuthorizeRequest(Invalid) -> Energy transfer NOT stopped
 */
export const TC_C_44_CS: CsTestCase = {
  id: 'TC_C_44_CS',
  name: 'Authorization by GroupId - Invalid status with Authorization Cache',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId with invalid status in the Authorization Cache.',
  purpose:
    'To verify if the Charging Station is able to correctly handle the Authorization of idTokens with the same GroupId when one is invalid in the cache.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') {
        return { idTokenInfo: { status: 'Invalid', groupIdToken: GROUP_ID_TOKEN } };
      }
      if (action === 'TransactionEvent') {
        return { idTokenInfo: { status: 'Accepted', groupIdToken: GROUP_ID_TOKEN } };
      }
      return {};
    });

    // Setup: add valid token to auth cache with groupIdToken
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT-TOKEN-001', 'Accepted', GROUP_ID_TOKEN);

    // Before: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Manual Action: Present valid idToken from auth cache
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 1: TransactionEventRequest with Authorized (from cache)
    const tx1 = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger1 = tx1['triggerReason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Station sends TransactionEventRequest with Authorized trigger (cached)',
      status: trigger1 === 'Authorized' ? 'passed' : 'failed',
      expected: 'triggerReason = Authorized',
      actual: `triggerReason = ${String(trigger1)}`,
    });

    // Step 3: Wait for EnergyTransferStarted (transaction auto-started on authorize)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present invalid idToken from cache
    await ctx.station.authorize(1, 'OCTT-INVALID-TOKEN');

    // Step 4: AuthorizeRequest with invalid cached idToken
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const authIdToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 4,
      description: 'Station sends AuthorizeRequest with invalid cached idToken',
      status: authIdToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken',
      actual: `idToken present: ${authIdToken?.['idToken'] != null}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_45_CS: Authorization by GroupId - Master pass - Not able to start transaction + groupId
 *
 * Present masterpass idToken -> Authorize(Accepted + masterPassGroupId)
 * -> Station does NOT start charging (MasterPass cannot start transaction)
 */
export const TC_C_45_CS: CsTestCase = {
  id: 'TC_C_45_CS',
  name: 'Authorization by GroupId - Master pass - Not able to start transaction + groupId',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how a Charging Station can authorize an action for an EV Driver based on GroupId with a MasterPass.',
  purpose:
    'To verify if the Charging Station is able to correctly handle the Authorization of an idToken with the same GroupId as MasterPassGroupId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const masterPassGroupId = { idToken: 'MASTERPASS-GROUP-001', type: 'Central' };

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') {
        return { idTokenInfo: { status: 'Accepted', groupIdToken: masterPassGroupId } };
      }
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Setup: configure MasterPassGroupId
    ctx.station.setConfigValue('AuthCtrlr.MasterPassGroupId', 'MASTERPASS-GROUP-001');

    // Manual Action: Present configured masterpass idToken
    await ctx.station.authorize(1, 'MASTERPASS-TOKEN-001');

    // Step 1: AuthorizeRequest with masterpass idToken
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with masterpass idToken',
      status: idToken?.['idToken'] != null && idToken?.['type'] != null ? 'passed' : 'failed',
      expected: 'idToken present with type',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    // Step 3: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 4: Station should NOT start charging with MasterPass token
    let chargingStarted = false;
    try {
      const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
      const txInfo = tx['transactionInfo'] as Record<string, unknown> | undefined;
      const chargingState = txInfo?.['chargingState'] as string | undefined;
      const trigger = tx['triggerReason'] as string | undefined;
      if (chargingState === 'Charging' && trigger === 'ChargingStateChanged') {
        chargingStarted = true;
      }
    } catch {
      // Expected: no charging started
    }

    steps.push({
      step: 4,
      description: 'Station will NOT start charging with MasterPass token',
      status: !chargingStarted ? 'passed' : 'failed',
      expected: 'No charging started',
      actual: chargingStarted ? 'Charging started' : 'No charging',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
