// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

function makeHandler(authStatus: string) {
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
 * TC_C_27_CS: Online authorization through local authorization list - Accepted
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true, valid idToken in local auth list
 * Scenario: Authorized (stored idToken) -> EVConnectedPreSession -> EnergyTransferStarted
 * Post: Energy is transferred
 */
export const TC_C_27_CS: CsTestCase = {
  id: 'TC_C_27_CS',
  name: 'Online authorization through local authorization list - Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorize an IdToken via the Local Authorization List while online.',
  purpose:
    'To verify if the Charging Station is able to authorize an idToken with status Accepted in its local authorization list.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeHandler('Accepted'));

    // Step 1: Reusable State Authorized (Stored idToken)
    await ctx.station.authorize(1, 'OCTT-LOCAL-VALID-010');

    // Step 2: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 3: Reusable State EnergyTransferStarted
    await ctx.station.startCharging(1, 'OCTT-LOCAL-VALID-010');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const trigger = tx['triggerReason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Station authorizes from local auth list and starts energy transfer',
      status: tx != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest received',
      actual: `triggerReason = ${String(trigger)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_28_CS: Online authorization through local authorization list - Invalid & Not Accepted
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true,
 *         LocalAuthListDisablePostAuthorize=false, invalid idToken in local auth list
 * Scenario: Present invalid token -> station sends Authorize -> CSMS returns Invalid
 * Post: No energy transfer
 */
export const TC_C_28_CS: CsTestCase = {
  id: 'TC_C_28_CS',
  name: 'Online authorization through local authorization list - Invalid & Not Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorize an IdToken via the Local Authorization List with Invalid status.',
  purpose:
    'To verify if the Charging Station correctly handles an idToken with status Invalid in its local authorization list while online.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeHandler('Invalid'));

    // Present invalid local list token
    await ctx.station.authorize(1, 'OCTT-LOCAL-INVALID-010');

    // Station should send AuthorizeRequest (post-authorize)
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest for invalid local list token',
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
 * TC_C_29_CS: Online authorization through local authorization list - Blocked
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true,
 *         LocalAuthListDisablePostAuthorize=false, blocked idToken in local auth list
 * Scenario: Present blocked token -> station sends Authorize -> CSMS returns Blocked
 * Post: No energy transfer
 */
export const TC_C_29_CS: CsTestCase = {
  id: 'TC_C_29_CS',
  name: 'Online authorization through local authorization list - Blocked',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorize an IdToken via the Local Authorization List with Blocked status.',
  purpose:
    'To verify if the Charging Station correctly handles an idToken with status Blocked in its local authorization list while online.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeHandler('Blocked'));

    await ctx.station.authorize(1, 'OCTT-LOCAL-BLOCKED-010');

    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest for blocked local list token',
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
 * TC_C_30_CS: Online authorization through local authorization list - Expired
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true,
 *         LocalAuthListDisablePostAuthorize=false, expired idToken in local auth list
 * Scenario: Present expired token -> station sends Authorize -> CSMS returns Expired
 * Post: No energy transfer
 */
export const TC_C_30_CS: CsTestCase = {
  id: 'TC_C_30_CS',
  name: 'Online authorization through local authorization list - Expired',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorize an IdToken via the Local Authorization List with Expired status.',
  purpose:
    'To verify if the Charging Station correctly handles an idToken with status Expired in its local authorization list while online.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(makeHandler('Expired'));

    await ctx.station.authorize(1, 'OCTT-LOCAL-EXPIRED-010');

    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest for expired local list token',
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
 * TC_C_31_CS: Online authorization through local authorization list - Invalid & Accepted
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true,
 *         LocalAuthListDisablePostAuthorize=false, invalid idToken in local auth list
 * Scenario: Present invalid local token -> CSMS returns Accepted (outdated list) ->
 *           EVConnectedPreSession -> EnergyTransferStarted
 * Post: Energy is transferred
 */
export const TC_C_31_CS: CsTestCase = {
  id: 'TC_C_31_CS',
  name: 'Online authorization through local authorization list - Invalid & Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Authorize an IdToken via Local Authorization List with Invalid status but CSMS returns Accepted (outdated list).',
  purpose:
    'To verify if the Charging Station accepts an idToken that was Invalid in local list but now Accepted by CSMS.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // CSMS returns Accepted even though local list says Invalid
    ctx.server.setMessageHandler(makeHandler('Accepted'));

    // Step 1: Present invalid local token (CSMS overrides)
    await ctx.station.authorize(1, 'OCTT-LOCAL-INVALID-011');

    // Step 2: EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Step 3: EnergyTransferStarted
    await ctx.station.startCharging(1, 'OCTT-LOCAL-INVALID-011');
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    const tx = await ctx.server.waitForMessage('TransactionEvent', 10000);
    steps.push({
      step: 1,
      description:
        'Station authorizes (outdated local list, CSMS returns Accepted) and starts charging',
      status: tx != null ? 'passed' : 'failed',
      expected: 'TransactionEventRequest received',
      actual: `received: ${tx != null}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_58_CS: Online authorization through local authorization list - LocalAuthListDisablePostAuthorize
 *
 * Before: LocalAuthListEnabled=true, LocalPreAuthorize=true,
 *         LocalAuthListDisablePostAuthorize=true, invalid idToken in local auth list
 * Scenario: Present invalid local token -> station does NOT send AuthorizeRequest ->
 *           station does NOT start charging
 * Post: No charging started
 */
export const TC_C_58_CS: CsTestCase = {
  id: 'TC_C_58_CS',
  name: 'Online authorization through local authorization list - LocalAuthListDisablePostAuthorize',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorize an IdToken via Local Authorization List with DisablePostAuthorize true.',
  purpose:
    'To verify that the Charging Station will not send an AuthorizeRequest for an invalid idToken when DisablePostAuthorize is true.',
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

    // Setup: enable LocalPreAuthorize and LocalAuthListDisablePostAuthorize
    ctx.station.setConfigValue('AuthCtrlr.LocalPreAuthorize', 'true');
    ctx.station.setConfigValue('LocalAuthListCtrlr.DisablePostAuthorize', 'true');

    // Add invalid token to local auth list
    ctx.station.addToLocalAuthList('OCTT-LOCAL-INVALID-012', 'Invalid');

    // Present invalid local list token
    await ctx.station.authorize(1, 'OCTT-LOCAL-INVALID-012');

    // EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Station should NOT send AuthorizeRequest (DisablePostAuthorize=true)
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
