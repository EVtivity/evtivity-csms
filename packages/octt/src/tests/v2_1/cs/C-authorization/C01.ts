// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

/**
 * TC_C_02_CS: Local start transaction - Authorization Invalid/Unknown
 */
export const TC_C_02_CS: CsTestCase = {
  id: 'TC_C_02_CS',
  name: 'Local start transaction - Authorization Invalid/Unknown',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'When a Charging Station needs to charge an EV, it needs to authorize the EV Driver first at the CSMS before starting.',
  purpose: 'To verify whether the Charging Station is able to handle receiving an invalid idToken.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Set handler: Authorize returns Invalid
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Invalid' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Before: Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);

    // Manual Action: Present idToken
    await ctx.station.authorize(1, 'INVALID-TOKEN-99999');

    // Step 1: Validate station sent AuthorizeRequest
    const authPayload = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = authPayload['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with invalid idToken',
      status: idToken?.['idToken'] != null && idToken?.['type'] != null ? 'passed' : 'failed',
      expected: 'idToken.idToken and idToken.type present',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    // Step 2: Station SHALL NOT send TransactionEventRequest after Invalid response
    let txReceived = false;
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
      txReceived = true;
    } catch {
      // Expected: no TransactionEventRequest
    }
    steps.push({
      step: 2,
      description: 'Station SHALL NOT send TransactionEventRequest after Invalid response',
      status: !txReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest',
      actual: txReceived ? 'TransactionEventRequest received' : 'No TransactionEventRequest',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_05_CS: Local start transaction - Authorization invalid - Cable lock
 * Prerequisite: Station has cable lock (no cable before auth)
 */
export const TC_C_05_CS: CsTestCase = {
  id: 'TC_C_05_CS',
  name: 'Local start transaction - Authorization invalid - Cable lock',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'When a Charging Station needs to charge an EV, it needs to authorize the EV Driver first before the charging can start.',
  purpose:
    'To verify whether a Charging Station with a cable lock handles receiving an invalid idToken.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Set handler: Authorize returns Invalid
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Invalid' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // No EVConnected state needed (cable lock prevents it before auth)
    // Manual Action: Present idToken
    await ctx.station.authorize(1, 'INVALID-TOKEN-99999');

    // Step 1: Validate station sent AuthorizeRequest
    const authPayload = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = authPayload['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with invalid idToken',
      status: idToken?.['idToken'] != null && idToken?.['type'] != null ? 'passed' : 'failed',
      expected: 'idToken.idToken and idToken.type present',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    // Station SHALL NOT send TransactionEventRequest
    let txReceived = false;
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
      txReceived = true;
    } catch {
      // Expected
    }
    steps.push({
      step: 2,
      description: 'Station SHALL NOT send TransactionEventRequest after Invalid response',
      status: !txReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest',
      actual: txReceived ? 'TransactionEventRequest received' : 'No TransactionEventRequest',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_04_CS: Local Stop Transaction - Different idToken
 * Before: Reusable State EnergyTransferStarted
 */
export const TC_C_04_CS: CsTestCase = {
  id: 'TC_C_04_CS',
  name: 'Local Stop Transaction - Different idToken',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The EV Driver tries to stop an ongoing transaction, by locally presenting a different IdToken.',
  purpose:
    'To verify whether the Charging Station does not stop the charging session when a different idToken is presented.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Set handler: Authorize returns Accepted for all tokens
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Before: Reusable State EnergyTransferStarted
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Drain TransactionEvent Started
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
    } catch {
      /* may already be consumed */
    }

    // Manual Action: Present different idToken
    await ctx.station.authorize(1, 'DIFFERENT-TOKEN-002');

    // Step 1: Validate AuthorizeRequest with different token
    const authPayload = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = authPayload['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with different idToken',
      status: idToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest with idToken',
      actual: `idToken.idToken = ${String(idToken?.['idToken'])}`,
    });

    // Step 2: Station SHALL NOT send TransactionEventRequest(Ended)
    let endedReceived = false;
    try {
      const txPayload = await ctx.server.waitForMessage('TransactionEvent', 5000);
      if ((txPayload['eventType'] as string) === 'Ended') endedReceived = true;
    } catch {
      // Expected: no Ended event
    }
    steps.push({
      step: 2,
      description: 'Station SHALL NOT send TransactionEventRequest(Ended)',
      status: !endedReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest(Ended)',
      actual: endedReceived ? 'Ended received' : 'No Ended event',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_06_CS: Local start transaction - Authorization Blocked
 */
export const TC_C_06_CS: CsTestCase = {
  id: 'TC_C_06_CS',
  name: 'Local start transaction - Authorization Blocked',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'When a Charging Station needs to charge an EV, it needs to authorize the EV Driver first at the CSMS before starting.',
  purpose: 'To verify whether the Charging Station is able to handle receiving a Blocked idToken.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Blocked' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    // Before: EVConnectedPreSession
    await ctx.station.plugIn(1);
    // Manual Action: Present idToken
    await ctx.station.authorize(1, 'BLOCKED-TOKEN-99999');

    const authPayload = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = authPayload['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with blocked idToken',
      status: idToken?.['idToken'] != null && idToken?.['type'] != null ? 'passed' : 'failed',
      expected: 'idToken present',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    let txReceived = false;
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
      txReceived = true;
    } catch {
      /* Expected */
    }
    steps.push({
      step: 2,
      description: 'Station SHALL NOT send TransactionEventRequest after Blocked response',
      status: !txReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest',
      actual: txReceived ? 'TransactionEventRequest received' : 'No TransactionEventRequest',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_07_CS: Local start transaction - Authorization Expired
 */
export const TC_C_07_CS: CsTestCase = {
  id: 'TC_C_07_CS',
  name: 'Local start transaction - Authorization Expired',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'When a Charging Station needs to charge an EV, it needs to authorize the EV Driver first at the CSMS before starting.',
  purpose: 'To verify whether the Charging Station is able to handle receiving an Expired idToken.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Expired' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'EXPIRED-TOKEN-99999');

    const authPayload = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = authPayload['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with expired idToken',
      status: idToken?.['idToken'] != null && idToken?.['type'] != null ? 'passed' : 'failed',
      expected: 'idToken present',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    let txReceived = false;
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
      txReceived = true;
    } catch {
      /* Expected */
    }
    steps.push({
      step: 2,
      description: 'Station SHALL NOT send TransactionEventRequest after Expired response',
      status: !txReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest',
      actual: txReceived ? 'TransactionEventRequest received' : 'No TransactionEventRequest',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_56_CS: Local start transaction - Authorization Unknown
 */
export const TC_C_56_CS: CsTestCase = {
  id: 'TC_C_56_CS',
  name: 'Local start transaction - Authorization Unknown',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'When a Charging Station needs to charge an EV, it needs to authorize the EV Driver first at the CSMS before starting.',
  purpose: 'To verify whether the Charging Station is able to handle receiving an Unknown idToken.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Unknown' } };
      if (action === 'TransactionEvent') return {};
      return {};
    });

    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'UNKNOWN-TOKEN-99999');

    const authPayload = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = authPayload['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Station sends AuthorizeRequest with unknown idToken',
      status: idToken?.['idToken'] != null && idToken?.['type'] != null ? 'passed' : 'failed',
      expected: 'idToken present',
      actual: `idToken = ${JSON.stringify(idToken)}`,
    });

    let txReceived = false;
    try {
      await ctx.server.waitForMessage('TransactionEvent', 5000);
      txReceived = true;
    } catch {
      /* Expected */
    }
    steps.push({
      step: 2,
      description: 'Station SHALL NOT send TransactionEventRequest after Unknown response',
      status: !txReceived ? 'passed' : 'failed',
      expected: 'No TransactionEventRequest',
      actual: txReceived ? 'TransactionEventRequest received' : 'No TransactionEventRequest',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_100_CS: Local start transaction - Authorization first - Cable plugin timeout
 * Skipped: requires EVConnectionTimeout behavior which triggers TransactionEvent
 * with triggerReason EVConnectTimeout. The CSS does not implement this timer.
 */
export const TC_C_100_CS: CsTestCase = {
  id: 'TC_C_100_CS',
  name: 'Local start transaction - Authorization first - Cable plugin timeout',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the Charging Station is able to deauthorize the transaction after the EVConnectionTimeout has expired.',
  execute: async (_ctx) => {
    // Requires EVConnectionTimeout timer in CSS that sends TransactionEvent
    // with triggerReason EVConnectTimeout when cable is not plugged in time.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
