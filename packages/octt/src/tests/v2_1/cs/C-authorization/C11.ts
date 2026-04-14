// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

/**
 * TC_C_37_CS: Clear Authorization Data in Authorization Cache - Accepted
 *
 * CSMS sends ClearCacheRequest -> Station responds Accepted
 * -> Reusable State Authorized (station must send AuthorizeRequest since cache is cleared)
 * -> EVConnectedPreSession -> EnergyTransferStarted
 */
export const TC_C_37_CS: CsTestCase = {
  id: 'TC_C_37_CS',
  name: 'Clear Authorization Data in Authorization Cache - Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the Charging Station handles clearing the Authorization Cache.',
  purpose:
    'To verify if the Charging Station is able to clear all identifiers from the Authorization Cache.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
      if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
      return {};
    });

    // Setup: enable auth cache, add token to cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'true');
    ctx.station.addToAuthCache('OCTT-TOKEN-001', 'Accepted');

    // Step 1-2: Send ClearCacheRequest, validate Accepted response
    const clearRes = await ctx.server.sendCommand('ClearCache', {});
    const status = clearRes['status'] as string | undefined;

    steps.push({
      step: 2,
      description: 'Station responds with ClearCacheResponse status Accepted',
      status: status === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(status)}`,
    });

    // Step 3: Reusable State Authorized - station should send AuthorizeRequest (cache cleared)
    await ctx.station.plugIn(1);
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    const auth = await ctx.server.waitForMessage('Authorize', 10000);
    const idToken = auth['idToken'] as Record<string, unknown> | undefined;
    steps.push({
      step: 3,
      description: 'Station sends AuthorizeRequest after cache clear (cache is empty)',
      status: idToken?.['idToken'] != null ? 'passed' : 'failed',
      expected: 'AuthorizeRequest sent to CSMS',
      actual: `AuthorizeRequest received: ${idToken?.['idToken'] != null}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/**
 * TC_C_38_CS: Clear Authorization Data in Authorization Cache - Rejected
 *
 * CSMS sends ClearCacheRequest when cache is disabled -> Station responds Rejected
 */
export const TC_C_38_CS: CsTestCase = {
  id: 'TC_C_38_CS',
  name: 'Clear Authorization Data in Authorization Cache - Rejected',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the Charging Station handles a rejected clear cache request.',
  purpose:
    'To verify if the Charging Station is able to correctly respond on a request to clear all identifiers when cache is disabled.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyEvent') return {};
      return {};
    });

    // Setup: disable auth cache
    ctx.station.setConfigValue('AuthCacheCtrlr.Enabled', 'false');

    // Step 1-2: Send ClearCacheRequest (cache disabled, expect Rejected)
    const clearRes = await ctx.server.sendCommand('ClearCache', {});
    const status = clearRes['status'] as string | undefined;

    steps.push({
      step: 2,
      description: 'Station responds with ClearCacheResponse status Rejected',
      status: status === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
