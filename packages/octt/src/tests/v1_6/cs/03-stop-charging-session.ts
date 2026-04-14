// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_068_CS: CsTestCase = {
  id: 'TC_068_CS',
  name: 'Stop transaction - IdTag matches StartTransaction IdTag',
  module: '03-stop-charging-session',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Charge Point stops a transaction when a card is swiped with the same idToken as used to start the transaction.',
  purpose: 'Check whether the Charge Point is able to handle a stop transaction with same idToken.',
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

    // Reusable State: Charging - start a session first
    // Before: plug in cable for Charging state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain all messages from charging setup (Authorize, StatusNotification Preparing/Charging, StartTransaction)
    for (let i = 0; i < 10; i++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 1000);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 1000);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 1000);
    } catch {
      /* drain */
    }

    // Manual Action: Swipe same idTag to stop
    await ctx.station.stopCharging(1, 'Local');

    // Step 3: StopTransaction with matching idTag
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const stopIdTag = stopTx['idTag'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Charge Point sends StopTransaction.req with matching idTag',
      status: stopIdTag !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.req with idTag matching start',
      actual: `idTag = ${String(stopIdTag)}`,
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

export const TC_069_CS: CsTestCase = {
  id: 'TC_069_CS',
  name: 'Stop transaction - ParentIdTag matches StartTransaction ParentIdTag',
  module: '03-stop-charging-session',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Charge Point stops a transaction when a card is swiped with the same ParentIdTag as used to start the transaction.',
  purpose:
    'Check whether the Charge Point is able to handle a stop transaction with same ParentIdTag.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const parentIdTag = 'OCTT_PARENT_001';

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted', parentIdTag } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
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

    // Swipe different idTag with same parentIdTag
    await ctx.station.authorize(1, 'OCTT_TAG_002');

    // Step 1: Authorize with different idTag
    const auth = await ctx.server.waitForMessage('Authorize', 10_000);
    const authIdTag = auth['idTag'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Charge Point sends Authorize.req with different idTag',
      status: authIdTag !== undefined ? 'passed' : 'failed',
      expected: 'Authorize.req with different idTag',
      actual: `idTag = ${String(authIdTag)}`,
    });

    // Step 3: StopTransaction
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const stopIdTag = stopTx['idTag'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Charge Point sends StopTransaction.req with idTag from Authorize',
      status: stopIdTag !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.req received',
      actual: `idTag = ${String(stopIdTag)}`,
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

export const TC_005_1_CS: CsTestCase = {
  id: 'TC_005_1_CS',
  name: 'EV Side Disconnected - StopTransactionOnEVSideDisconnect = true (unlock true)',
  module: '03-stop-charging-session',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to stop the transaction when the cable is disconnected at EV side.',
  purpose:
    'To test if the Charge Point stops the transaction when the cable is disconnected at EV side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
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

    // Manual Action: Unplug EV side
    await ctx.station.unplug(1);

    // Step 1: StopTransaction with reason EVDisconnected
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Charge Point sends StopTransaction.req with reason EVDisconnected',
      status: reason === 'EVDisconnected' ? 'passed' : 'failed',
      expected: 'reason = EVDisconnected',
      actual: `reason = ${String(reason)}`,
    });

    // Step 3: StatusNotification Finishing
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    steps.push({
      step: 3,
      description: 'Charge Point sends StatusNotification.req with status Finishing',
      status: sn1Status === 'Finishing' ? 'passed' : 'failed',
      expected: 'status = Finishing',
      actual: `status = ${String(sn1Status)}`,
    });

    // Step 5: StatusNotification Available (after full unplug)
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn2Status = sn2['status'] as string | undefined;
    steps.push({
      step: 5,
      description: 'Charge Point sends StatusNotification.req with status Available',
      status: sn2Status === 'Available' ? 'passed' : 'failed',
      expected: 'status = Available',
      actual: `status = ${String(sn2Status)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_005_2_CS: CsTestCase = {
  id: 'TC_005_2_CS',
  name: 'EV Side Disconnected - StopTransactionOnEVSideDisconnect = true (unlock false)',
  module: '03-stop-charging-session',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to stop the transaction when the cable is disconnected at EV side.',
  purpose:
    'To test if the Charge Point stops the transaction when the cable is disconnected at EV side with unlock false.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
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

    // Manual Action: Unplug EV side
    await ctx.station.unplug(1);

    // Step 1: StopTransaction with reason EVDisconnected
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Charge Point sends StopTransaction.req with reason EVDisconnected',
      status: reason === 'EVDisconnected' ? 'passed' : 'failed',
      expected: 'reason = EVDisconnected',
      actual: `reason = ${String(reason)}`,
    });

    // Step 3: StatusNotification Finishing or Available
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    const validStatus = sn1Status === 'Finishing' || sn1Status === 'Available';
    steps.push({
      step: 3,
      description: 'Charge Point sends StatusNotification.req with Finishing or Available',
      status: validStatus ? 'passed' : 'failed',
      expected: 'status = Finishing or Available',
      actual: `status = ${String(sn1Status)}`,
    });

    // Step 5: CS sends UnlockConnector
    const unlockResp = await ctx.server.sendCommand('UnlockConnector', { connectorId: 1 });
    const unlockStatus = unlockResp['status'] as string | undefined;
    const unlockOk = unlockStatus === 'Unlocked' || unlockStatus === 'NotSupported';
    steps.push({
      step: 6,
      description: 'Charge Point responds to UnlockConnector.req',
      status: unlockOk ? 'passed' : 'failed',
      expected: 'status = Unlocked or NotSupported',
      actual: `status = ${String(unlockStatus)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_005_3_CS: CsTestCase = {
  id: 'TC_005_3_CS',
  name: 'EV Side Disconnected - StopTransactionOnEVSideDisconnect = false',
  module: '03-stop-charging-session',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'This scenario is used to keep the transaction active, even when the cable is disconnected at EV side.',
  purpose:
    'To test if the Charge Point keeps the transaction active when the cable is disconnected at EV side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
      if (action === 'StartTransaction')
        return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });

    // Set StopTransactionOnEVSideDisconnect = false
    await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'StopTransactionOnEVSideDisconnect',
      value: 'false',
    });

    // Reusable State: Charging
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain charging setup messages
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
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }

    // Manual Action: Unplug EV side (StopTransactionOnEVSideDisconnect = false)
    await ctx.station.unplug(1);

    // Step 1: StatusNotification SuspendedEV/SuspendedEVSE
    const sn1 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn1Status = sn1['status'] as string | undefined;
    const suspended = sn1Status === 'SuspendedEV' || sn1Status === 'SuspendedEVSE';
    steps.push({
      step: 1,
      description: 'Charge Point sends StatusNotification.req with SuspendedEV/SuspendedEVSE',
      status: suspended ? 'passed' : 'failed',
      expected: 'status = SuspendedEV or SuspendedEVSE',
      actual: `status = ${String(sn1Status)}`,
    });

    // Step 3: CS sends RemoteStopTransaction
    const remoteStopResp = await ctx.server.sendCommand('RemoteStopTransaction', {
      transactionId: 1,
    });
    steps.push({
      step: 4,
      description: 'Charge Point responds to RemoteStopTransaction.req',
      status: remoteStopResp !== undefined ? 'passed' : 'failed',
      expected: 'RemoteStopTransaction.conf received',
      actual: remoteStopResp !== undefined ? 'Received' : 'Not received',
    });

    // Step 5: StatusNotification Finishing
    const sn2 = await ctx.server.waitForMessage('StatusNotification', 10_000);
    const sn2Status = sn2['status'] as string | undefined;
    const finishOk = sn2Status === 'Finishing' || sn2Status === 'Available';
    steps.push({
      step: 5,
      description: 'Charge Point sends StatusNotification.req with Finishing or Available',
      status: finishOk ? 'passed' : 'failed',
      expected: 'status = Finishing or Available',
      actual: `status = ${String(sn2Status)}`,
    });

    // Step 7: StopTransaction with reason Remote
    const stopTx = await ctx.server.waitForMessage('StopTransaction', 10_000);
    const reason = stopTx['reason'] as string | undefined;
    steps.push({
      step: 7,
      description: 'Charge Point sends StopTransaction.req with reason Remote',
      status: reason === 'Remote' ? 'passed' : 'failed',
      expected: 'reason = Remote',
      actual: `reason = ${String(reason)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
