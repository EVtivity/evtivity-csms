// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';
import type { OcppTestServer } from '../../../cs-server.js';
import { drainMessages, waitForMatchingMessage } from '../../../cs-test-helpers.js';

/** StatusNotifications after the boot, keyed by connectorId, until every connector reported. */
async function collectConnectorStatuses(
  server: OcppTestServer,
  connectorIds: number[],
  timeoutMs: number,
): Promise<Map<number, string>> {
  const statuses = new Map<number, string>();
  const deadline = Date.now() + timeoutMs;
  while (statuses.size < connectorIds.length && Date.now() < deadline) {
    const sn = await server.waitForMessageOrNull('StatusNotification', deadline - Date.now());
    if (sn == null) break;
    const connectorId = sn['connectorId'] as number;
    if (connectorIds.includes(connectorId)) statuses.set(connectorId, sn['status'] as string);
  }
  return statuses;
}

export const TC_032_1_CS: CsTestCase = {
  id: 'TC_032_1_CS',
  name: 'Power failure - stop transaction(s) before going down',
  module: '14-power-failure-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to stop all transactions before going down, when a power failure occurs.',
  purpose:
    'To test if the Charge Point first stops all transactions before going down, when a power failure occurs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Start a charging transaction
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain setup messages
    for (let _d = 0; _d < 10; _d++) {
      if ((await ctx.server.waitForMessageOrNull('StatusNotification', 500)) == null) break;
    }
    await ctx.server.waitForMessageOrNull('Authorize', 500);
    await ctx.server.waitForMessageOrNull('StartTransaction', 5000);

    // Trigger power failure: stops tx (sends StopTransaction), then disconnects + reconnects
    await ctx.station.simulatePowerCycle('PowerLoss');

    // Step 1: StopTransaction with reason PowerLoss (sent before disconnect)
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    steps.push({
      step: 1,
      description: 'StopTransaction reason PowerLoss',
      status: (stopTx['reason'] as string) === 'PowerLoss' ? 'passed' : 'failed',
      expected: 'reason = PowerLoss',
      actual: `reason = ${String(stopTx['reason'])}`,
    });

    // Step 3: StatusNotification Finishing (sent before going down)
    const finishing = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 3,
      description: 'StatusNotification Finishing before going down',
      status: (finishing['status'] as string) === 'Finishing' ? 'passed' : 'failed',
      expected: 'status = Finishing',
      actual: `status = ${String(finishing['status'])}`,
    });

    // Step 5: BootNotification after power restore (the reboot reconnects at once)
    const boot = await ctx.server.waitForMessage('BootNotification', 10_000);
    steps.push({
      step: 5,
      description: 'BootNotification after power restore',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    // Step 7: StatusNotification per connector and connectorId 0
    const statuses = await collectConnectorStatuses(ctx.server, [0, 1], 10_000);
    const txConnector = statuses.get(1);
    const chargePoint = statuses.get(0);
    steps.push({
      step: 7,
      description:
        'StatusNotification: connector 1 Finishing or Preparing, connectorId 0 Available',
      status:
        (txConnector === 'Finishing' || txConnector === 'Preparing') && chargePoint === 'Available'
          ? 'passed'
          : 'failed',
      expected: 'connector 1 = Finishing or Preparing, connector 0 = Available',
      actual: `connector 1 = ${txConnector ?? 'not received'}, connector 0 = ${chargePoint ?? 'not received'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_032_2_CS: CsTestCase = {
  id: 'TC_032_2_CS',
  name: 'Power failure - stop transaction(s) after going down',
  module: '14-power-failure-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to stop all transactions after going down, when a power failure occurred.',
  purpose: 'To test if the Charge Point first stops all transactions after going down.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Start a charging transaction
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain setup messages
    for (let _d = 0; _d < 10; _d++) {
      if ((await ctx.server.waitForMessageOrNull('StatusNotification', 500)) == null) break;
    }
    await ctx.server.waitForMessageOrNull('Authorize', 500);
    await ctx.server.waitForMessageOrNull('StartTransaction', 5000);

    await drainMessages(ctx.server, 'StatusNotification', 300);

    // Manual Action: disconnect and reconnect the power. Without back-up power
    // the Charge Point cannot stop its transaction before going down.
    await ctx.station.simulatePowerCyclePreserveTransactions();

    // Step 1: BootNotification after power restore
    const boot = await ctx.server.waitForMessage('BootNotification', 10_000);
    steps.push({
      step: 1,
      description: 'BootNotification after power restore',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    // Step 3: StatusNotification per connector and connectorId 0
    const statuses = await collectConnectorStatuses(ctx.server, [0, 1], 10_000);
    const txConnector = statuses.get(1);
    const chargePoint = statuses.get(0);
    steps.push({
      step: 3,
      description:
        'StatusNotification: connector 1 Preparing, Finishing or Charging, connectorId 0 Available',
      status:
        (txConnector === 'Preparing' ||
          txConnector === 'Finishing' ||
          txConnector === 'Charging' ||
          txConnector === 'Unavailable' ||
          txConnector === 'Available') &&
        chargePoint === 'Available'
          ? 'passed'
          : 'failed',
      expected:
        'connector 1 = Preparing, Finishing or Charging (Unavailable/Available allowed in between), connector 0 = Available',
      actual: `connector 1 = ${txConnector ?? 'not received'}, connector 0 = ${chargePoint ?? 'not received'}`,
    });

    // Step 5: StopTransaction after the reboot
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    const validReason = reason === 'PowerLoss' || reason === 'Local' || reason === undefined;
    steps.push({
      step: 5,
      description: 'StopTransaction with valid reason',
      status: validReason ? 'passed' : 'failed',
      expected: 'reason = PowerLoss or Local or omitted',
      actual: `reason = ${String(reason)}`,
    });

    // Step 7: StatusNotification Preparing or Finishing, unless step 3 already reported Finishing
    if (txConnector !== 'Finishing') {
      const after = await waitForMatchingMessage(
        ctx.server,
        'StatusNotification',
        (sn) => sn['connectorId'] === 1,
        10_000,
      );
      const afterStatus = after?.['status'] as string | undefined;
      steps.push({
        step: 7,
        description: 'StatusNotification Preparing or Finishing',
        status: afterStatus === 'Preparing' || afterStatus === 'Finishing' ? 'passed' : 'failed',
        expected: 'status = Preparing or Finishing',
        actual: `status = ${afterStatus ?? 'not received'}`,
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_034_CS: CsTestCase = {
  id: 'TC_034_CS',
  name: 'Power Failure with Unavailable Status',
  module: '14-power-failure-non-happy',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to persist the status of the connectors, when a power failure occurs.',
  purpose:
    'To test if the Charge Point persists the status of the connectors, when a power failure occurs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Set connector to Inoperative
    const caResp = await ctx.server.sendCommand('ChangeAvailability', {
      connectorId: 0,
      type: 'Inoperative',
    });
    steps.push({
      step: 2,
      description: 'ChangeAvailability Inoperative Accepted',
      status: (caResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(caResp['status'])}`,
    });

    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    steps.push({
      step: 3,
      description: 'StatusNotification Unavailable',
      status: (sn1['status'] as string) === 'Unavailable' ? 'passed' : 'failed',
      expected: 'status = Unavailable',
      actual: `status = ${String(sn1['status'])}`,
    });

    // The other connector's Unavailable notification belongs to step 3 as well
    await drainMessages(ctx.server, 'StatusNotification', 300);

    // Manual Action: disconnect and reconnect the power
    await ctx.station.simulatePowerCycle();

    // BootNotification after power cycle
    const boot = await ctx.server.waitForMessage('BootNotification', 10_000);
    steps.push({
      step: 5,
      description: 'BootNotification after power cycle',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });

    // Step 7: per connector and connectorId 0, still Unavailable
    const statuses = await collectConnectorStatuses(ctx.server, [0, 1], 10_000);
    steps.push({
      step: 7,
      description: 'StatusNotification Unavailable for connector 1 and connectorId 0',
      status:
        statuses.get(0) === 'Unavailable' && statuses.get(1) === 'Unavailable'
          ? 'passed'
          : 'failed',
      expected: 'connector 0 = Unavailable, connector 1 = Unavailable',
      actual: `connector 0 = ${statuses.get(0) ?? 'not received'}, connector 1 = ${statuses.get(1) ?? 'not received'}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
