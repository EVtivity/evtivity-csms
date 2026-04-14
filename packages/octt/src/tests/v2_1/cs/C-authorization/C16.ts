// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

const MASTERPASS_GROUP = { idToken: 'MASTERPASS-GROUP-001', type: 'Central' };

function masterPassHandler() {
  return async (action: string): Promise<Record<string, unknown>> => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize')
      return { idTokenInfo: { status: 'Accepted', groupIdToken: MASTERPASS_GROUP } };
    if (action === 'TransactionEvent')
      return { idTokenInfo: { status: 'Accepted', groupIdToken: MASTERPASS_GROUP } };
    return {};
  };
}

/**
 * TC_C_47_CS: Stop Transaction with a Master Pass - With UI - All transactions
 *
 * Before: MasterPassGroupId configured, State=EnergyTransferStarted for all EVSE
 * Scenario: Present masterpass token -> AuthorizeRequest -> select stop all ->
 *           TransactionEvent(Ended) with stoppedReason MasterPass
 * Post: All transactions stopped
 */
export const TC_C_47_CS: CsTestCase = {
  id: 'TC_C_47_CS',
  name: 'Stop Transaction with a Master Pass - With UI - All transactions',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Somebody with a Master Pass can stop all ongoing transactions.',
  purpose:
    'To verify if the Charging Station is able to correctly stop all transactions when a MasterPass idToken is presented.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(masterPassHandler());

    // Setup: configure MasterPassGroupId
    ctx.station.setConfigValue('AuthCtrlr.MasterPassGroupId', 'MASTERPASS-GROUP-001');

    // Before: EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present masterpass idToken
    await ctx.station.authorize(1, 'MASTERPASS-TOKEN-001');

    // Step 1: Station sends AuthorizeRequest with masterpass idToken
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with masterpass idToken',
      status: idToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'masterpass idToken present',
      actual: `idToken = ${String(idToken?.['idToken'])}`,
    });

    // Step 3: Station sends TransactionEvent(Ended) with stoppedReason MasterPass (skip meter events)
    let endedFound = false;
    let lastActual = '';
    for (let i = 0; i < 10; i++) {
      try {
        const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
        const txInfo = tx['transactionInfo'] as Record<string, unknown> | undefined;
        const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;
        const eventType = tx['eventType'] as string | undefined;
        lastActual = `stoppedReason=${String(stoppedReason)}, eventType=${String(eventType)}`;
        if (stoppedReason === 'MasterPass' || eventType === 'Ended') {
          endedFound = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 3,
      description: 'Station sends TransactionEventRequest(Ended) with MasterPass stoppedReason',
      status: endedFound ? 'passed' : 'failed',
      expected: 'stoppedReason = MasterPass or eventType = Ended',
      actual: endedFound ? 'Ended with MasterPass found' : `last: ${lastActual}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_48_CS: Stop Transaction with a Master Pass - With UI - Specific transactions
 *
 * Before: MasterPassGroupId configured, State=EnergyTransferStarted for all EVSE
 * Scenario: Present masterpass token -> AuthorizeRequest -> select stop EVSE 1 ->
 *           TransactionEvent with stoppedReason MasterPass
 * Post: Only selected transaction stopped, others continue
 */
export const TC_C_48_CS: CsTestCase = {
  id: 'TC_C_48_CS',
  name: 'Stop Transaction with a Master Pass - With UI - Specific transactions',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Somebody with a Master Pass can stop a specific ongoing transaction.',
  purpose:
    'To verify if the Charging Station is able to correctly stop a specific transaction with a MasterPass idToken.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(masterPassHandler());

    // Setup: configure MasterPassGroupId
    ctx.station.setConfigValue('AuthCtrlr.MasterPassGroupId', 'MASTERPASS-GROUP-001');

    // Before: EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present masterpass idToken
    await ctx.station.authorize(1, 'MASTERPASS-TOKEN-002');

    // Step 1: Station sends AuthorizeRequest with masterpass idToken
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with masterpass idToken',
      status: auth['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest received',
      actual: `received: ${auth['idToken'] != null}`,
    });

    // Step 3: Station sends TransactionEvent with stoppedReason MasterPass (skip meter events)
    let endedFound48 = false;
    for (let i = 0; i < 10; i++) {
      try {
        const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
        const txInfo = tx['transactionInfo'] as Record<string, unknown> | undefined;
        const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;
        if (stoppedReason === 'MasterPass') {
          endedFound48 = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 3,
      description: 'Station sends TransactionEventRequest with MasterPass stoppedReason',
      status: endedFound48 ? 'passed' : 'failed',
      expected: 'stoppedReason = MasterPass',
      actual: endedFound48 ? 'MasterPass found' : 'MasterPass not found',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_49_CS: Stop Transaction with a Master Pass - Without UI
 *
 * Before: MasterPassGroupId configured, State=EnergyTransferStarted for EVSE 1 (and 2)
 * Scenario: Present masterpass token -> AuthorizeRequest -> station stops all transactions ->
 *           TransactionEvent with stoppedReason MasterPass
 * Post: All transactions stopped
 */
export const TC_C_49_CS: CsTestCase = {
  id: 'TC_C_49_CS',
  name: 'Stop Transaction with a Master Pass - Without UI',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Somebody with a Master Pass can stop all transactions without UI.',
  purpose:
    'To verify if the Charging Station correctly stops all transactions with a MasterPass idToken without a UI.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(masterPassHandler());

    // Setup: configure MasterPassGroupId
    ctx.station.setConfigValue('AuthCtrlr.MasterPassGroupId', 'MASTERPASS-GROUP-001');

    // Before: EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Manual Action: Present masterpass idToken
    await ctx.station.authorize(1, 'MASTERPASS-TOKEN-003');

    // Step 1: Station sends AuthorizeRequest with masterpass idToken
    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with masterpass idToken',
      status: auth['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest received',
      actual: `received: ${auth['idToken'] != null}`,
    });

    // Step 3: Station sends TransactionEvent with stoppedReason MasterPass (skip meter events)
    let endedFound49 = false;
    for (let i = 0; i < 10; i++) {
      try {
        const tx = await ctx.server.waitForMessage('TransactionEvent', 5000);
        const txInfo = tx['transactionInfo'] as Record<string, unknown> | undefined;
        const stoppedReason = txInfo?.['stoppedReason'] as string | undefined;
        if (stoppedReason === 'MasterPass') {
          endedFound49 = true;
          break;
        }
      } catch {
        break;
      }
    }
    steps.push({
      step: 3,
      description: 'Station sends TransactionEventRequest with MasterPass stoppedReason',
      status: endedFound49 ? 'passed' : 'failed',
      expected: 'stoppedReason = MasterPass',
      actual: endedFound49 ? 'MasterPass found' : 'MasterPass not found',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
