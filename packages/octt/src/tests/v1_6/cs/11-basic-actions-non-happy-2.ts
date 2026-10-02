// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_023_5_CS: CsTestCase = {
  id: 'TC_023_5_CS',
  name: 'Start remote Charging Session - Authorize invalid',
  module: '11-basic-actions-non-happy-2',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to inform the Charge Point that the EV Driver is not Authorized to start a transaction.',
  purpose:
    'To test if the Charge Point does not start a transaction after Authorization fails (remote).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Invalid' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const rsResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId: 1,
      idTag: 'INVALID_TAG',
    });
    steps.push({
      step: 2,
      description: 'RemoteStartTransaction Accepted',
      status: (rsResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rsResp['status'])}`,
    });

    // Plug in cable
    await ctx.station.plugIn(1);

    const sn = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 5,
      description: 'StatusNotification Preparing',
      status: (sn['status'] as string) === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(sn['status'])}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_024_CS: CsTestCase = {
  id: 'TC_024_CS',
  name: 'Start Charging Session - Lock Failure',
  module: '11-basic-actions-non-happy-2',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'This scenario is used to report a connector lock failure.',
  purpose: 'To test if the Charge Point is able to report a connector lock failure.',
  // Prerequisite: the Charge Point does not have a fixed cable.
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Steps 1-2: GetConfiguration AuthorizeRemoteTxRequests.
    const conf = await ctx.server.sendCommand('GetConfiguration', {
      key: ['AuthorizeRemoteTxRequests'],
    });
    const entry = (conf['configurationKey'] as Array<Record<string, unknown>> | undefined)?.find(
      (k) => k['key'] === 'AuthorizeRemoteTxRequests',
    );
    steps.push({
      step: 2,
      description: 'GetConfiguration.conf configurationKey.key is AuthorizeRemoteTxRequests',
      status: entry != null ? 'passed' : 'failed',
      expected: 'configurationKey contains AuthorizeRemoteTxRequests',
      actual: entry != null ? `value = ${String(entry['value'])}` : 'key not returned',
    });

    // Steps 3-4: RemoteStartTransaction.
    const rs = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId: 1,
      idTag: 'OCTT_TAG_001',
    });
    steps.push({
      step: 4,
      description: 'RemoteStartTransaction.conf status is Accepted',
      status: rs['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(rs['status'])}`,
    });

    // Steps 5-6: Authorize, only when AuthorizeRemoteTxRequests is true.
    if (entry?.['value'] === 'true') {
      let authorized = false;
      try {
        await ctx.server.waitForMessage('Authorize', 10_000);
        authorized = true;
      } catch {
        // reported below
      }
      steps.push({
        step: 5,
        description: 'Charge Point sends Authorize.req (AuthorizeRemoteTxRequests = true)',
        status: authorized ? 'passed' : 'failed',
        expected: 'Authorize.req',
        actual: authorized ? 'received' : 'no Authorize.req',
      });
    }

    // Steps 7-8: StatusNotification Preparing.
    const preparing = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 7,
      description: 'StatusNotification.req status is Preparing',
      status: preparing['status'] === 'Preparing' ? 'passed' : 'failed',
      expected: 'status = Preparing',
      actual: `status = ${String(preparing['status'])}`,
    });

    // Manual Action: the EV driver plugs in the cable halfway.
    await ctx.station.plugInHalfway(1);

    const faulted = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 9,
      description: 'StatusNotification.req errorCode ConnectorLockFailure, status Faulted',
      status:
        faulted['errorCode'] === 'ConnectorLockFailure' && faulted['status'] === 'Faulted'
          ? 'passed'
          : 'failed',
      expected: 'errorCode = ConnectorLockFailure, status = Faulted',
      actual: `errorCode = ${String(faulted['errorCode'])}, status = ${String(faulted['status'])}`,
    });

    // Expected result: the Charging Station does NOT start a transaction.
    let started = false;
    try {
      await ctx.server.waitForMessage('StartTransaction', 5_000);
      started = true;
    } catch {
      // no transaction, as expected
    }
    steps.push({
      step: 10,
      description: 'Expected result: the Charge Point does not start a transaction',
      status: started ? 'failed' : 'passed',
      expected: 'no StartTransaction.req',
      actual: started ? 'StartTransaction.req sent' : 'no StartTransaction.req within 5s',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
