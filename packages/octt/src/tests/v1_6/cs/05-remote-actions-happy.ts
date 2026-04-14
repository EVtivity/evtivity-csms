// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_010_CS: CsTestCase = {
  id: 'TC_010_CS',
  name: 'Remote Start Charging Session - Cable Plugged in First',
  module: '05-remote-actions-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to start a transaction remotely.',
  purpose:
    'To test if the Charge Point is able to start a transaction after receiving a RemoteStartTransaction.req.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';

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

    // Step 1: GetConfiguration for AuthorizeRemoteTxRequests
    const getConfResp = await ctx.server.sendCommand('GetConfiguration', {
      key: ['AuthorizeRemoteTxRequests'],
    });
    steps.push({
      step: 1,
      description: 'CS sends GetConfiguration for AuthorizeRemoteTxRequests',
      status: getConfResp !== undefined ? 'passed' : 'failed',
      expected: 'GetConfiguration.conf received',
      actual: getConfResp !== undefined ? 'Received' : 'Not received',
    });

    // Manual Action: Plugin cable
    await ctx.station.plugIn(1);

    // Step 3: Wait for StatusNotification Preparing
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Charge Point sends StatusNotification.req with status Preparing',
      status: sn1Status === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn1Status)}`,
    });

    // Step 5: CS sends RemoteStartTransaction
    const remoteStartResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId,
      idTag,
    });
    const rsStatus = remoteStartResp['status'] as string | undefined;
    steps.push({
      step: 6,
      description: 'Charge Point responds to RemoteStartTransaction with Accepted',
      status: rsStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rsStatus)}`,
    });

    // Step 9: StartTransaction
    const startTx = await ctx.server.waitForMessage('StartTransaction', 10_000);
    const startConnId = startTx['connectorId'] as number | undefined;
    steps.push({
      step: 9,
      description: 'Charge Point sends StartTransaction.req',
      status: startConnId === connectorId ? 'passed' : 'failed',
      expected: `connectorId = ${String(connectorId)}`,
      actual: `connectorId = ${String(startConnId)}`,
    });

    // Step 11: StatusNotification Charging
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn2Status = sn2['status'] as string | undefined;
    steps.push({
      step: 11,
      description: 'Charge Point sends StatusNotification.req with status Charging',
      status: sn2Status === 'Charging' ? 'passed' : 'failed',
      expected: 'status = Charging',
      actual: `status = ${String(sn2Status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_011_1_CS: CsTestCase = {
  id: 'TC_011_1_CS',
  name: 'Remote Start Charging Session - Remote Start First',
  module: '05-remote-actions-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to start a transaction remotely.',
  purpose:
    'To test if the Charge Point is able to start a transaction after receiving a RemoteStartTransaction.req.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';

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

    // Step 1: GetConfiguration
    const getConfResp = await ctx.server.sendCommand('GetConfiguration', {
      key: ['AuthorizeRemoteTxRequests'],
    });
    steps.push({
      step: 1,
      description: 'CS sends GetConfiguration for AuthorizeRemoteTxRequests',
      status: getConfResp !== undefined ? 'passed' : 'failed',
      expected: 'GetConfiguration.conf received',
      actual: getConfResp !== undefined ? 'Received' : 'Not received',
    });

    // Step 3: CS sends RemoteStartTransaction
    const remoteStartResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId,
      idTag,
    });
    const rsStatus = remoteStartResp['status'] as string | undefined;
    steps.push({
      step: 4,
      description: 'Charge Point responds to RemoteStartTransaction with Accepted',
      status: rsStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rsStatus)}`,
    });

    // Step 7: StatusNotification Preparing
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    steps.push({
      step: 7,
      description: 'Charge Point sends StatusNotification.req with status Preparing',
      status: sn1Status === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn1Status)}`,
    });

    // Manual Action: Plug in cable
    await ctx.station.plugIn(1);

    // Step 9: StartTransaction
    // plugIn() sends Preparing then auto-starts (sends Charging + StartTransaction).
    // Drain StatusNotification messages until we find StartTransaction.
    let startTxFound = false;
    for (let _d = 0; _d < 10; _d++) {
      try {
        const msg = await ctx.server.waitForMessage('StartTransaction', 500);
        if (msg != null) {
          startTxFound = true;
          break;
        }
      } catch {
        // Try draining a StatusNotification that might be ahead of StartTransaction
        try {
          await ctx.server.waitForMessage('StatusNotification', 500);
        } catch {
          break;
        }
      }
    }
    steps.push({
      step: 9,
      description: 'Charge Point sends StartTransaction.req',
      status: startTxFound ? 'passed' : 'failed',
      expected: 'StartTransaction.req received',
      actual: startTxFound ? 'Received' : 'Not received',
    });

    // Step 11: StatusNotification Charging
    // Find the Charging StatusNotification (may need to skip Preparing)
    let sn2Status: string | undefined;
    for (let _d = 0; _d < 5; _d++) {
      try {
        const sn2 = await ctx.server.waitForMessage('StatusNotification', 5000);
        sn2Status = sn2['status'] as string | undefined;
        if (sn2Status === 'Charging') break;
      } catch {
        break;
      }
    }
    steps.push({
      step: 11,
      description: 'Charge Point sends StatusNotification.req with status Charging',
      status: sn2Status === 'Charging' ? 'passed' : 'failed',
      expected: 'status = Charging',
      actual: `status = ${String(sn2Status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_011_2_CS: CsTestCase = {
  id: 'TC_011_2_CS',
  name: 'Remote Start Charging Session - Time Out',
  module: '05-remote-actions-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to set a connector back to available, after receiving a RemoteStartTransaction.req.',
  purpose:
    'To test if the Charge Point sets the connector back to available after reaching the configured connection timeout.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = 'OCTT_TAG_001';

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

    const getConfResp = await ctx.server.sendCommand('GetConfiguration', {
      key: ['AuthorizeRemoteTxRequests'],
    });
    steps.push({
      step: 1,
      description: 'CS sends GetConfiguration for AuthorizeRemoteTxRequests',
      status: getConfResp !== undefined ? 'passed' : 'failed',
      expected: 'GetConfiguration.conf received',
      actual: getConfResp !== undefined ? 'Received' : 'Not received',
    });

    const remoteStartResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId,
      idTag,
    });
    const rsStatus = remoteStartResp['status'] as string | undefined;
    steps.push({
      step: 4,
      description: 'Charge Point responds to RemoteStartTransaction with Accepted',
      status: rsStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rsStatus)}`,
    });

    // Step 7: StatusNotification Preparing
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    steps.push({
      step: 7,
      description: 'Charge Point sends StatusNotification.req with status Preparing',
      status: sn1Status === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn1Status)}`,
    });

    // Step 9: StatusNotification Available (after timeout, no plug-in)
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn2Status = sn2['status'] as string | undefined;
    steps.push({
      step: 9,
      description: 'Charge Point sends StatusNotification.req with status Available after timeout',
      status: sn2Status === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(sn2Status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_012_CS: CsTestCase = {
  id: 'TC_012_CS',
  name: 'Remote Stop Charging Session',
  module: '05-remote-actions-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to remotely stop a transaction.',
  purpose:
    'To test if the Charge Point will stop a transaction, when requested by the Central System.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const transactionId = 1;

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId, idTagInfo: { status: 'Accepted' } };
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Reusable State: Charging
    // Before: plug in cable for Charging state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain charging setup messages (StatusNotification, Authorize, StartTransaction/TransactionEvent)
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* may already be consumed */
    }

    // Step 1: CS sends RemoteStopTransaction
    const remoteStopResp = await ctx.server.sendCommand('RemoteStopTransaction', {
      transactionId,
    });
    const rsStatus = remoteStopResp['status'] as string | undefined;
    steps.push({
      step: 2,
      description: 'Charge Point responds to RemoteStopTransaction with Accepted',
      status: rsStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rsStatus)}`,
    });

    // Step 3: StopTransaction with reason Remote
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Charge Point sends StopTransaction.req with reason Remote',
      status: reason === 'Remote' ? 'passed' : 'failed',
      expected: 'reason = Remote',
      actual: `reason = ${String(reason)}`,
    });

    // Step 5: StatusNotification Finishing
    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const snStatus = sn['status'] as string | undefined;
    steps.push({
      step: 5,
      description: 'Charge Point sends StatusNotification.req with status Finishing',
      status: snStatus === 'Finishing' ? 'passed' : 'failed',
      expected: 'status = Finishing',
      actual: `status = ${String(snStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
