// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_003_CS: CsTestCase = {
  id: 'TC_003_CS',
  name: 'Regular Charging Session - Plugin First',
  module: '02-start-charging-session',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to start a Charging session.',
  purpose:
    'To test if the Charge Point is able to start a Charging Session when first doing plugin cable.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Manual Action: Plug in cable
    await ctx.station.plugIn(1);

    // Step 1: StatusNotification Preparing
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Charge Point sends StatusNotification.req with status Preparing',
      status: sn1Status === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn1Status)}`,
    });

    // Manual Action: Present idTag
    await ctx.station.authorize(1, 'OCTT_TAG_001');

    // Step 3: Authorize
    const auth = await ctx.server.waitForMessage('Authorize', 10_000);
    const authIdTag = auth['idTag'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Charge Point sends Authorize.req',
      status: authIdTag !== undefined ? 'passed' : 'failed',
      expected: 'Authorize.req with idTag',
      actual: `idTag = ${String(authIdTag)}`,
    });

    // Step 5: StartTransaction
    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    const startConnId = startTx['connectorId'] as number | undefined;
    steps.push({
      step: 5,
      description: 'Charge Point sends StartTransaction.req',
      status: startConnId === 1 ? 'passed' : 'failed',
      expected: 'connectorId = 1',
      actual: `connectorId = ${String(startConnId)}`,
    });

    // Step 7: StatusNotification Charging
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn2Status = sn2['status'] as string | undefined;
    steps.push({
      step: 7,
      description: 'Charge Point sends StatusNotification.req with status Charging',
      status: sn2Status === 'Charging' ? 'passed' : 'failed',
      expected: 'status = Charging',
      actual: `status = ${String(sn2Status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_004_1_CS: CsTestCase = {
  id: 'TC_004_1_CS',
  name: 'Regular Charging Session - Identification First',
  module: '02-start-charging-session',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to start a Charging session.',
  purpose:
    'To test if the Charge Point is able to start a Charging Session when first doing authorization.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Reusable State: Authorized
    await ctx.station.authorize(1, 'OCTT_TAG_001');

    // Drain Authorize message
    try {
      await ctx.server.waitForMessage('Authorize', 5000);
    } catch {
      /* may already be consumed */
    }

    // Manual Action: Plug in cable
    await ctx.station.plugIn(1);

    // Step 3: StartTransaction
    // Drain StatusNotification Preparing from plugIn before looking for StartTransaction
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* drain */
    }

    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    const startIdTag = startTx['idTag'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Charge Point sends StartTransaction.req',
      status: startIdTag !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction.req received',
      actual: `idTag = ${String(startIdTag)}`,
    });

    // Step 5: StatusNotification Charging
    // May need to drain additional StatusNotification messages
    let snStatus: string | undefined;
    for (let i = 0; i < 3; i++) {
      const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
      snStatus = sn['status'] as string | undefined;
      if (snStatus === 'Charging') break;
    }
    steps.push({
      step: 5,
      description: 'Charge Point sends StatusNotification.req with status Charging',
      status: snStatus === 'Charging' ? 'passed' : 'failed',
      expected: 'status = Charging',
      actual: `status = ${String(snStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_004_2_CS: CsTestCase = {
  id: 'TC_004_2_CS',
  name: 'Regular Charging Session - Identification First - ConnectionTimeOut',
  module: '02-start-charging-session',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to make a connector available when it is not used.',
  purpose:
    'To test if the Charge Point sets the connector back to Available, when the connectionTimeOut is reached.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Set short ConnectionTimeOut for test
    ctx.station.setConfigValue('ConnectionTimeOut', '3');

    // Reusable State: Authorized (no plug-in, wait for timeout)
    await ctx.station.authorize(1, 'OCTT_TAG_001');

    // Drain Authorize and Preparing StatusNotification
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('Authorize', 500);
      } catch {
        break;
      }
    }
    for (let _d = 0; _d < 5; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }

    // Step 2: Wait for StatusNotification Available after connectionTimeOut (3s)
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const snStatus = sn['status'] as string | undefined;
    steps.push({
      step: 2,
      description: 'Charge Point sends StatusNotification.req with status Available after timeout',
      status: snStatus === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(snStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
