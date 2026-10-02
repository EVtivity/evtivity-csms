// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { setVariables, sleep } from '../../../../cs-test-helpers.js';

/** <Configured RetryBackOffWaitMinimum> (seconds). */
const WAIT_MINIMUM_S = 5;

const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');

export const TC_B_57_CS: CsTestCase = {
  id: 'TC_B_57_CS',
  name: 'Network Reconnection - After connection loss',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'When the connection is lost, the Charging Station SHALL try to reconnect, using an increasing back-off time until it has successfully reconnected.',
  purpose:
    'To verify if the Charging Station is able to reconnect to the CSMS using the described OCPP reconnecting mechanism from part 4.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action: string) => {
      if (action === 'BootNotification')
        return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    const notAccepted = await setVariables(ctx.server, [
      { component: 'OCPPCommCtrlr', variable: 'NetworkProfileConnectionAttempts', value: '3' },
      { component: 'OCPPCommCtrlr', variable: 'RetryBackOffRepeatTimes', value: '2' },
      { component: 'OCPPCommCtrlr', variable: 'RetryBackOffRandomRange', value: '0' },
      {
        component: 'OCPPCommCtrlr',
        variable: 'RetryBackOffWaitMinimum',
        value: String(WAIT_MINIMUM_S),
      },
    ]);
    steps.push({
      step: 0,
      description: 'Before: Configuration State (SetVariablesRequest)',
      status: passOrFail(notAccepted.length === 0),
      expected: 'All Accepted',
      actual: notAccepted.length === 0 ? 'All Accepted' : notAccepted.join(', '),
    });

    // Step 1-3: close the connection; the station reconnects after the back-off
    const closedAt = Date.now();
    ctx.server.disconnectStation(false);
    await sleep(100);
    await ctx.server.waitForConnection(60_000);
    const firstS = (Date.now() - closedAt) / 1000;
    steps.push({
      step: 2,
      description: `Reconnection after at least RetryBackOffWaitMinimum (${String(WAIT_MINIMUM_S)} s)`,
      status: passOrFail(firstS >= WAIT_MINIMUM_S),
      expected: `>= ${String(WAIT_MINIMUM_S)} s`,
      actual: `${firstS.toFixed(1)} s`,
    });
    await sleep(2000);

    // Step 4-6: close again; the next attempt is refused
    const refusedBefore = ctx.server.refusedAttempts.length;
    ctx.server.disconnectStation(true);
    const deadline = Date.now() + 60_000;
    while (ctx.server.refusedAttempts.length === refusedBefore && Date.now() < deadline) {
      await sleep(100);
    }
    const refusedAt = ctx.server.refusedAttempts[refusedBefore];
    steps.push({
      step: 6,
      description: 'The Charging Station tries to reconnect (attempt refused)',
      status: passOrFail(refusedAt != null),
      expected: 'reconnection attempt',
      actual: refusedAt != null ? 'refused attempt seen' : 'no attempt',
    });
    if (refusedAt == null) return { status: 'failed', durationMs: 0, steps };

    // Step 7-8: the next attempt follows after double the back-off, and is accepted
    ctx.server.acceptConnections();
    await ctx.server.waitForConnection(90_000);
    const secondS = (Date.now() - refusedAt) / 1000;
    steps.push({
      step: 7,
      description: 'Next attempt after at least 2 times the reconnection time of step 2',
      status: passOrFail(secondS >= 2 * WAIT_MINIMUM_S && secondS >= 2 * firstS - 1),
      expected: `>= ${(2 * firstS).toFixed(1)} s`,
      actual: `${secondS.toFixed(1)} s`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
