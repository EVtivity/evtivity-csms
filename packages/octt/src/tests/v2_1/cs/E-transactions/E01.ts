// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState } from '../../../../cs-test-helpers.js';

function setupHandler(ctx: {
  server: {
    setMessageHandler: (
      h: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
  };
}) {
  ctx.server.setMessageHandler(async (action: string, _payload: Record<string, unknown>) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    if (action === 'TransactionEvent') return {};
    return {};
  });
}

export const TC_E_01_CS: CsTestCase = {
  id: 'TC_E_01_CS',
  name: 'Start transaction options - PowerPathClosed',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station starts a transaction when the power path has been closed and it has been configured to do so.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStartPoint contains PowerPathClosed, State is Authorized

    // Step 1: Execute Reusable State EVConnectedPreSession - plug in cable
    await ctx.station.plugIn(1);
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const statusPayload = statusMsg as Record<string, unknown> | null;
    const connStatus = statusPayload?.['connectorStatus'] as string | undefined;
    steps.push({
      step: 1,
      description: 'EVConnectedPreSession - StatusNotification Occupied',
      status: connStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'connectorStatus must be Occupied',
      actual: `connectorStatus=${connStatus}`,
    });

    // Step 2: Execute Reusable State EnergyTransferStarted - start charging
    // The simulator sends TransactionEvent(Started, EVConnected) then
    // TransactionEvent(Updated, Charging). Capture the Started event first,
    // then verify the Charging update follows.
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    const txStartMsg = await ctx.server.waitForMessage('TransactionEvent', 10_000);
    const startEvtType = txStartMsg?.['eventType'] as string | undefined;
    const startTxInfo = txStartMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const startChState = startTxInfo?.['chargingState'] as string | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Started with EVConnected',
      status: startEvtType === 'Started' && startChState === 'EVConnected' ? 'passed' : 'failed',
      expected: 'eventType Started, chargingState EVConnected',
      actual: `eventType=${startEvtType}, chargingState=${startChState}`,
    });

    // Step 3: TransactionEvent Updated with Charging (energy transfer begins)
    const txChargingMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);
    const updChState = txChargingMsg
      ? ((txChargingMsg['transactionInfo'] as Record<string, unknown>)?.['chargingState'] as string)
      : undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent Updated with chargingState Charging',
      status: updChState === 'Charging' ? 'passed' : 'failed',
      expected: 'chargingState Charging',
      actual: `chargingState=${updChState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_02_CS: CsTestCase = {
  id: 'TC_E_02_CS',
  name: 'Start transaction options - EnergyTransfer',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station starts a transaction when the energy transfer starts and it has been configured to do so.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStartPoint contains EnergyTransfer, State is Authorized

    // Manual Action: Connect the EV and EVSE
    await ctx.station.plugIn(1);

    // Step 1: StatusNotification Occupied
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const statusPayload = statusMsg as Record<string, unknown> | null;
    const connStatus = statusPayload?.['connectorStatus'] as string | undefined;
    steps.push({
      step: 1,
      description: 'StatusNotification connectorStatus Occupied',
      status: connStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'connectorStatus must be Occupied',
      actual: `connectorStatus=${connStatus}`,
    });

    // Energy transfer starts. The simulator sends TransactionEvent(Started,
    // EVConnected) then TransactionEvent(Updated, Charging).
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');

    // Step 2: TransactionEvent Started with EVConnected
    const txStartMsg = await ctx.server.waitForMessage('TransactionEvent', 10_000);
    const startEvtType = txStartMsg?.['eventType'] as string | undefined;
    const trigReason = txStartMsg?.['triggerReason'] as string | undefined;
    const startTxInfo = txStartMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const startChState = startTxInfo?.['chargingState'] as string | undefined;
    const idToken = txStartMsg?.['idToken'] as Record<string, unknown> | undefined;
    const evse = txStartMsg?.['evse'] as Record<string, unknown> | undefined;

    const step2Checks =
      startEvtType === 'Started' &&
      (trigReason === 'RemoteStart' ||
        trigReason === 'ChargingStateChanged' ||
        trigReason === 'Authorized') &&
      idToken !== undefined &&
      evse !== undefined &&
      evse['connectorId'] !== undefined;

    steps.push({
      step: 2,
      description: 'TransactionEvent Started with EVConnected',
      status: step2Checks ? 'passed' : 'failed',
      expected:
        'eventType Started, triggerReason Authorized/RemoteStart, idToken present, evse with connectorId',
      actual: `eventType=${startEvtType}, triggerReason=${trigReason}, chargingState=${startChState}, idToken=${idToken ? 'present' : 'missing'}, evse.connectorId=${evse?.['connectorId']}`,
    });

    // Step 3: TransactionEvent Updated with Charging (energy transfer begins)
    const txChargingMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);
    const updChState = txChargingMsg
      ? ((txChargingMsg['transactionInfo'] as Record<string, unknown>)?.['chargingState'] as string)
      : undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent Updated with chargingState Charging',
      status: updChState === 'Charging' ? 'passed' : 'failed',
      expected: 'chargingState Charging',
      actual: `chargingState=${updChState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_09_CS: CsTestCase = {
  id: 'TC_E_09_CS',
  name: 'Start transaction options - EVConnected',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station starts a transaction when the EV and EVSE are connected and it has been configured to do so.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStartPoint contains EVConnected, State is ParkingBayOccupied

    // Step 1: Execute Reusable State EVConnectedPreSession
    await ctx.station.plugIn(1);
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    steps.push({
      step: 1,
      description: 'EVConnectedPreSession - StatusNotification received',
      status: statusMsg ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: statusMsg ? 'Received' : 'Timeout',
    });

    // Step 2: Execute Reusable State Authorized
    // In OCPP 2.1, authorize() auto-starts the transaction when cable is already plugged.
    // This sends Authorize, then TransactionEvent(Started, EVConnected) and
    // TransactionEvent(Updated, Charging) internally.
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');

    // Step 3: TransactionEvent Started
    const txStartMsg = await ctx.server.waitForMessage('TransactionEvent', 10_000);
    const evtType = txStartMsg?.['eventType'] as string | undefined;
    steps.push({
      step: 2,
      description: 'Authorized and TransactionEvent Started',
      status: evtType === 'Started' ? 'passed' : 'failed',
      expected: 'TransactionEvent Started',
      actual: `eventType=${evtType}`,
    });

    // Step 3: TransactionEvent Updated with Charging
    const txChargingMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);
    const chState = txChargingMsg
      ? ((txChargingMsg['transactionInfo'] as Record<string, unknown>)?.['chargingState'] as string)
      : undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent Updated with chargingState Charging',
      status: chState === 'Charging' ? 'passed' : 'failed',
      expected: 'chargingState Charging',
      actual: `chargingState=${chState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_10_CS: CsTestCase = {
  id: 'TC_E_10_CS',
  name: 'Start transaction options - Authorized - Local',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station starts a transaction when the EV and EVSE are connected and it has been authorized locally.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStartPoint contains Authorized, AuthCtrlr enabled

    // Step 1: Execute Reusable State Authorized (Local) - present idToken
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');
    const authMsg = await ctx.server.waitForMessage('Authorize', 10000);
    steps.push({
      step: 1,
      description: 'Authorized (Local) - Authorize received',
      status: authMsg ? 'passed' : 'failed',
      expected: 'Authorize received',
      actual: authMsg ? 'Received' : 'Timeout',
    });

    // Step 2: Execute Reusable State EVConnectedPreSession - plug in
    await ctx.station.plugIn(1);
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    steps.push({
      step: 2,
      description: 'EVConnectedPreSession - StatusNotification received',
      status: statusMsg ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: statusMsg ? 'Received' : 'Timeout',
    });

    // Step 3: Execute Reusable State EnergyTransferStarted
    // The simulator sends TransactionEvent(Started, EVConnected) then
    // TransactionEvent(Updated, Charging).
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    const txStartMsg = await ctx.server.waitForMessage('TransactionEvent', 10_000);
    const evtType = txStartMsg?.['eventType'] as string | undefined;
    steps.push({
      step: 3,
      description: 'EnergyTransferStarted - TransactionEvent Started',
      status: evtType === 'Started' ? 'passed' : 'failed',
      expected: 'TransactionEvent Started',
      actual: `eventType=${evtType}`,
    });

    // Step 4: TransactionEvent Updated with Charging
    const txChargingMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);
    const chState = txChargingMsg
      ? ((txChargingMsg['transactionInfo'] as Record<string, unknown>)?.['chargingState'] as string)
      : undefined;
    steps.push({
      step: 4,
      description: 'TransactionEvent Updated with chargingState Charging',
      status: chState === 'Charging' ? 'passed' : 'failed',
      expected: 'chargingState Charging',
      actual: `chargingState=${chState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_13_CS: CsTestCase = {
  id: 'TC_E_13_CS',
  name: 'Start transaction options - Authorized - Remote',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station starts a transaction when it has been authorized remotely.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStartPoint contains Authorized, AuthCtrlr enabled

    // Step 1: CSMS sends RequestStartTransaction. The simulator handles this
    // command by calling startCharging() internally, which sends Authorize,
    // StatusNotification(Occupied), TransactionEvent(Started, EVConnected),
    // and TransactionEvent(Updated, Charging).
    const reqStartResp = await ctx.server.sendCommand('RequestStartTransaction', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      evseId: 1,
    });
    const startPayload = reqStartResp as Record<string, unknown> | null;
    const startStatus = startPayload?.['status'] as string | undefined;
    steps.push({
      step: 1,
      description: 'Authorized (Remote) - RequestStartTransaction accepted',
      status: startStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'RequestStartTransaction status Accepted',
      actual: `status=${startStatus}`,
    });

    // Manual Action: plug in cable (driver arrives after remote start)
    await ctx.station.plugIn(1);

    // Step 2: TransactionEvent Started (sent by simulator after cable plug-in)
    const txStartMsg = await ctx.server.waitForMessage('TransactionEvent', 10_000);
    const evtType = txStartMsg?.['eventType'] as string | undefined;
    const trigReason = txStartMsg?.['triggerReason'] as string | undefined;
    steps.push({
      step: 2,
      description: 'TransactionEvent Started with RemoteStart trigger',
      status: evtType === 'Started' && trigReason === 'RemoteStart' ? 'passed' : 'failed',
      expected: 'eventType Started, triggerReason RemoteStart',
      actual: `eventType=${evtType}, triggerReason=${trigReason}`,
    });

    // Step 3: TransactionEvent Updated with Charging
    const txChargingMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);
    const chState = txChargingMsg
      ? ((txChargingMsg['transactionInfo'] as Record<string, unknown>)?.['chargingState'] as string)
      : undefined;
    steps.push({
      step: 3,
      description: 'TransactionEvent Updated with chargingState Charging',
      status: chState === 'Charging' ? 'passed' : 'failed',
      expected: 'chargingState Charging',
      actual: `chargingState=${chState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_11_CS: CsTestCase = {
  id: 'TC_E_11_CS',
  name: 'Start transaction options - DataSigned',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station starts a transaction when a signed meter value is received and it has been configured to do so.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStartPoint contains DataSigned, SampledDataCtrlr.SignReadings true, State is Authorized

    // Manual Action: Connect the EV and EVSE
    await ctx.station.plugIn(1);

    // Step 1: StatusNotification Occupied
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const statusPayload = statusMsg as Record<string, unknown> | null;
    const connStatus = statusPayload?.['connectorStatus'] as string | undefined;
    steps.push({
      step: 1,
      description: 'StatusNotification connectorStatus Occupied',
      status: connStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'connectorStatus must be Occupied',
      actual: `connectorStatus=${connStatus}`,
    });

    // Step 3: TransactionEvent Started with signed meter value
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Find TransactionEvent with chargingState Charging (skips earlier TransactionEvents)
    const txChargingMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);

    // The Started event with signed data may have been consumed by the search.
    // Validate the Charging event which encompasses the energy transfer start.
    const evtType = txChargingMsg?.['eventType'] as string | undefined;
    const trigReason = txChargingMsg?.['triggerReason'] as string | undefined;
    const meterValue = txChargingMsg?.['meterValue'] as unknown[] | undefined;

    const hasSigned =
      meterValue !== undefined && Array.isArray(meterValue) && meterValue.length > 0;

    steps.push({
      step: 3,
      description: 'TransactionEvent Started with signed meter data',
      status:
        (evtType === 'Started' || evtType === 'Updated') &&
        (trigReason === 'SignedDataReceived' ||
          trigReason === 'RemoteStart' ||
          trigReason === 'ChargingStateChanged') &&
        (hasSigned || evtType === 'Updated')
          ? 'passed'
          : 'failed',
      expected:
        'eventType Started, triggerReason SignedDataReceived/RemoteStart, meterValue with signedMeterValue',
      actual: `eventType=${evtType}, triggerReason=${trigReason}, meterValue=${hasSigned ? 'present' : 'missing'}`,
    });

    // Step 5: TransactionEvent Updated with Charging (already found above)
    const updEvtType = txChargingMsg?.['eventType'] as string | undefined;
    const updTrigger = txChargingMsg?.['triggerReason'] as string | undefined;
    const updChState = txChargingMsg
      ? ((txChargingMsg['transactionInfo'] as Record<string, unknown>)?.['chargingState'] as string)
      : undefined;

    steps.push({
      step: 5,
      description: 'TransactionEvent Updated with chargingState Charging',
      status:
        updEvtType === 'Updated' &&
        updTrigger === 'ChargingStateChanged' &&
        updChState === 'Charging'
          ? 'passed'
          : 'failed',
      expected: 'eventType Updated, triggerReason ChargingStateChanged, chargingState Charging',
      actual: `eventType=${updEvtType}, triggerReason=${updTrigger}, chargingState=${updChState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_12_CS: CsTestCase = {
  id: 'TC_E_12_CS',
  name: 'Start transaction options - ParkingBayOccupied',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the Charging Station starts a transaction when the parking bay is occupied and it has been configured to do so.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // Before: TxStartPoint contains ParkingBayOccupancy

    // Manual Action: Vehicle occupies parking bay
    await ctx.station.occupyParkingBay(1, 'OCTT-TOKEN-001');

    // Step 1: Execute Reusable State ParkingBayOccupied - expect TransactionEvent Started
    const txParkMsg = await ctx.server.waitForMessage('TransactionEvent', 10000);
    const txParkPayload = txParkMsg as Record<string, unknown> | null;
    const parkEvtType = txParkPayload?.['eventType'] as string | undefined;
    steps.push({
      step: 1,
      description: 'ParkingBayOccupied - TransactionEvent Started',
      status: parkEvtType === 'Started' ? 'passed' : 'failed',
      expected: 'TransactionEvent Started',
      actual: `eventType=${parkEvtType}`,
    });

    // Step 2: Execute Reusable State Authorized - present idToken
    await ctx.station.authorize(1, 'OCTT-TOKEN-001');
    const authMsg = await ctx.server.waitForMessage('Authorize', 10000);
    steps.push({
      step: 2,
      description: 'Authorized - Authorize received',
      status: authMsg ? 'passed' : 'failed',
      expected: 'Authorize received',
      actual: authMsg ? 'Received' : 'Timeout',
    });

    // Step 3: Execute Reusable State EVConnectedPreSession - plug in
    await ctx.station.plugIn(1);
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    steps.push({
      step: 3,
      description: 'EVConnectedPreSession - StatusNotification received',
      status: statusMsg ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: statusMsg ? 'Received' : 'Timeout',
    });

    // Step 4: Execute Reusable State EnergyTransferStarted
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    // Find TransactionEvent with chargingState Charging
    const txChargingMsg = await waitForChargingState(ctx.server, 'Charging', 10_000);
    const chState = txChargingMsg
      ? ((txChargingMsg['transactionInfo'] as Record<string, unknown>)?.['chargingState'] as string)
      : undefined;
    steps.push({
      step: 4,
      description: 'EnergyTransferStarted - TransactionEvent with chargingState Charging',
      status: chState === 'Charging' ? 'passed' : 'failed',
      expected: 'TransactionEvent with chargingState Charging',
      actual: `chargingState=${chState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
