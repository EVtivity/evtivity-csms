// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_007_1_CS: CsTestCase = {
  id: 'TC_007_1_CS',
  name: 'Regular Start Charging Session - Cached Id',
  module: '04-cache',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to start a transaction with an id stored in the Authorization cache.',
  purpose:
    'To test if the Charge Point is able to start a transaction with an id stored in the Authorization cache.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Prerequisites: enable LocalPreAuthorize and populate auth cache
    ctx.station.setConfigValue('AuthorizationCacheEnabled', 'true');
    ctx.station.setConfigValue('LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT_TAG_001', 'Accepted');

    // Manual Action: Present idTag (cached - should not send Authorize)
    await ctx.station.authorize(1, 'OCTT_TAG_001');

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

    // Manual Action: Plug in cable
    await ctx.station.plugIn(1);

    // Step 3: StartTransaction
    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    steps.push({
      step: 3,
      description: 'Charge Point sends StartTransaction.req',
      status: startTx !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction.req received',
      actual: startTx !== undefined ? 'Received' : 'Not received',
    });

    // Step 5: StatusNotification Charging
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn2Status = sn2['status'] as string | undefined;
    steps.push({
      step: 5,
      description: 'Charge Point sends StatusNotification.req with status Charging',
      status: sn2Status === 'Charging' ? 'passed' : 'failed',
      expected: 'status = Charging',
      actual: `status = ${String(sn2Status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_007_2_CS: CsTestCase = {
  id: 'TC_007_2_CS',
  name: 'Remote Start Charging Session - Cached Id',
  module: '04-cache',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to start a transaction with an id stored in the Authorization cache.',
  purpose:
    'To test if the Charge Point is able to start a transaction with a cached id via remote start.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Prerequisites: enable LocalPreAuthorize and populate auth cache
    ctx.station.setConfigValue('AuthorizationCacheEnabled', 'true');
    ctx.station.setConfigValue('LocalPreAuthorize', 'true');
    ctx.station.addToAuthCache('OCTT_TAG_001', 'Accepted');

    // Step 1: CS sends RemoteStartTransaction
    const rsResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId: 1,
      idTag: 'OCTT_TAG_001',
    });
    const rsStatus = rsResp['status'] as string | undefined;
    steps.push({
      step: 2,
      description: 'Charge Point responds to RemoteStartTransaction with Accepted',
      status: rsStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rsStatus)}`,
    });

    // Step 3: StatusNotification Preparing
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Charge Point sends StatusNotification.req with status Preparing',
      status: sn1Status === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn1Status)}`,
    });

    // Manual Action: Plugin cable
    await ctx.station.plugIn(1);

    // Step 5: StartTransaction
    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    steps.push({
      step: 5,
      description: 'Charge Point sends StartTransaction.req',
      status: startTx !== undefined ? 'passed' : 'failed',
      expected: 'StartTransaction.req received',
      actual: startTx !== undefined ? 'Received' : 'Not received',
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

export const TC_061_1_CS: CsTestCase = {
  id: 'TC_061_1_CS',
  name: 'Clear Authorization Data in Authorization Cache - Local',
  module: '04-cache',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System can clear the Authorization Cache of a Charge Point.',
  purpose:
    'Check whether the Charge Point can handle the message to clear the Authorization Cache.',
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

    // Step 5: CS sends ClearCache
    const clearResp = await ctx.server.sendCommand('ClearCache', {});
    const clearStatus = clearResp['status'] as string | undefined;
    steps.push({
      step: 6,
      description: 'Charge Point responds to ClearCache.req with Accepted',
      status: clearStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(clearStatus)}`,
    });

    // After cache clear, authorize should go to CS (not local cache)
    await ctx.station.authorize(1, 'OCTT_TAG_001');

    // Step 7: Authorize.req sent to CS (cache was cleared)
    const auth = await ctx.server.waitForMessage('Authorize', 10_000);
    steps.push({
      step: 7,
      description: 'Charge Point sends Authorize.req after cache clear',
      status: auth !== undefined ? 'passed' : 'failed',
      expected: 'Authorize.req received (cache was cleared)',
      actual: auth !== undefined ? 'Received' : 'Not received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_061_2_CS: CsTestCase = {
  id: 'TC_061_2_CS',
  name: 'Clear Authorization Data in Authorization Cache - Remote',
  module: '04-cache',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System can clear the Authorization Cache of a Charge Point.',
  purpose:
    'Check whether the Charge Point can handle the message to clear the Authorization Cache (remote).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Step 1: CS sends ClearCache
    const clearResp = await ctx.server.sendCommand('ClearCache', {});
    const clearStatus = clearResp['status'] as string | undefined;
    steps.push({
      step: 2,
      description: 'Charge Point responds to ClearCache.req with Accepted',
      status: clearStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(clearStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
