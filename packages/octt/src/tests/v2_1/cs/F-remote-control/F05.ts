// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

const defaultHandler = async (action: string): Promise<Record<string, unknown>> => {
  if (action === 'BootNotification')
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  if (action === 'StatusNotification') return {};
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  if (action === 'NotifyEvent') return {};
  if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
  if (action === 'TransactionEvent') return {};
  return {};
};

export const TC_F_05_CS: CsTestCase = {
  id: 'TC_F_05_CS',
  name: 'Remote unlock Connector - With ongoing transaction',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the CSMS can be requested to send an UnlockConnectorRequest to the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to respond to the UnlockConnectorRequest with an ongoing transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;
    const idToken = 'OCTT-TOKEN-001';

    ctx.server.setMessageHandler(defaultHandler);

    // Before: State is EnergyTransferStarted (ongoing transaction)
    await ctx.station.plugIn(evseId);
    await ctx.station.startCharging(evseId, idToken);
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1-2: Send UnlockConnectorRequest
    const unlockRes = await ctx.server.sendCommand('UnlockConnector', {
      evseId,
      connectorId,
    });
    const unlockStatus = unlockRes['status'] as string;
    steps.push({
      step: 2,
      description: 'UnlockConnectorResponse - status must be OngoingAuthorizedTransaction',
      status: unlockStatus === 'OngoingAuthorizedTransaction' ? 'passed' : 'failed',
      expected: 'status = OngoingAuthorizedTransaction',
      actual: `status = ${unlockStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_06_CS: CsTestCase = {
  id: 'TC_F_06_CS',
  name: 'Remote unlock Connector - Without ongoing transaction - Accepted',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the CSMS can be requested to send an UnlockConnectorRequest to the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to successfully unlock a connector without ongoing transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;

    ctx.server.setMessageHandler(defaultHandler);

    // Before: EVConnectedPreSession (cable plugged in, no transaction)
    await ctx.station.plugIn(evseId);
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* may already be consumed */
    }

    // Step 1-2: Send UnlockConnectorRequest
    const unlockRes = await ctx.server.sendCommand('UnlockConnector', {
      evseId,
      connectorId,
    });
    const unlockStatus = unlockRes['status'] as string;
    steps.push({
      step: 2,
      description: 'UnlockConnectorResponse - status must be Unlocked',
      status: unlockStatus === 'Unlocked' ? 'passed' : 'failed',
      expected: 'status = Unlocked',
      actual: `status = ${unlockStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_07_CS: CsTestCase = {
  id: 'TC_F_07_CS',
  name: 'Remote unlock Connector - Without ongoing transaction - No cable connected',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the CSMS can be requested to send an UnlockConnectorRequest to the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to perform the remote unlock connector mechanism and report the correct status when no cable is connected.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;

    ctx.server.setMessageHandler(defaultHandler);

    // No cable connected - station is in Available state (no setup needed)

    // Step 1-2: Send UnlockConnectorRequest
    const unlockRes = await ctx.server.sendCommand('UnlockConnector', {
      evseId,
      connectorId,
    });
    const unlockStatus = unlockRes['status'] as string;
    steps.push({
      step: 2,
      description: 'UnlockConnectorResponse - status must be Unlocked',
      status: unlockStatus === 'Unlocked' ? 'passed' : 'failed',
      expected: 'status = Unlocked',
      actual: `status = ${unlockStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_10_CS: CsTestCase = {
  id: 'TC_F_10_CS',
  name: 'Remote unlock Connector - Without ongoing transaction - UnknownConnector',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case describes how the CSMS can be requested to send an UnlockConnectorRequest to the Charging Station.',
  purpose:
    'To verify if the Charging Station is able to respond with a UnlockConnectorResponse with status UnknownConnector.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const unknownConnectorId = 999;

    ctx.server.setMessageHandler(defaultHandler);

    // No setup needed - send unlock with unknown connector

    // Step 1-2: Send UnlockConnectorRequest with unknown connectorId
    const unlockRes = await ctx.server.sendCommand('UnlockConnector', {
      evseId,
      connectorId: unknownConnectorId,
    });
    const unlockStatus = unlockRes['status'] as string;
    steps.push({
      step: 2,
      description: 'UnlockConnectorResponse - status must be UnknownConnector',
      status: unlockStatus === 'UnknownConnector' ? 'passed' : 'failed',
      expected: 'status = UnknownConnector',
      actual: `status = ${unlockStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
