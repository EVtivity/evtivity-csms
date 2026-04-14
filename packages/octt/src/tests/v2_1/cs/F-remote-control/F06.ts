// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { waitForChargingState, waitForTriggerReason } from '../../../../cs-test-helpers.js';

const defaultHandler = async (action: string): Promise<Record<string, unknown>> => {
  if (action === 'BootNotification')
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  if (action === 'StatusNotification') return {};
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  if (action === 'NotifyEvent') return {};
  if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
  if (action === 'TransactionEvent') return {};
  if (action === 'MeterValues') return {};
  if (action === 'LogStatusNotification') return {};
  if (action === 'FirmwareStatusNotification') return {};
  if (action === 'SecurityEventNotification') return {};
  return {};
};

export const TC_F_11_CS: CsTestCase = {
  id: 'TC_F_11_CS',
  name: 'Trigger message - MeterValues - Specific EVSE',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a MeterValuesRequest message for a specific EVSE, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1-2: Send TriggerMessageRequest for MeterValues
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'MeterValues',
      evse: { id: evseId },
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 3: Wait for MeterValuesRequest
    const meterMsg = await ctx.server.waitForMessage('MeterValues', 10000);
    const meterEvseId = meterMsg['evseId'] as number;
    const meterValue = meterMsg['meterValue'] as Record<string, unknown>[];
    const sampledValue = (meterValue?.[0] as Record<string, unknown>)?.['sampledValue'] as Record<
      string,
      unknown
    >[];
    const context = sampledValue?.[0]?.['context'] as string;
    steps.push({
      step: 3,
      description:
        'MeterValuesRequest - evseId must match, sampledValue[0].context must be Trigger',
      status: meterEvseId === evseId && context === 'Trigger' ? 'passed' : 'failed',
      expected: `evseId = ${String(evseId)}, context = Trigger`,
      actual: `evseId = ${String(meterEvseId)}, context = ${context}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_12_CS: CsTestCase = {
  id: 'TC_F_12_CS',
  name: 'Trigger message - MeterValues - All EVSE',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a MeterValuesRequest message for all EVSE, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1-2: Send TriggerMessageRequest for MeterValues without evse
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'MeterValues',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 3: Wait for MeterValuesRequest
    const meterMsg = await ctx.server.waitForMessage('MeterValues', 10000);
    const meterValue = meterMsg['meterValue'] as Record<string, unknown>[];
    const sampledValue = (meterValue?.[0] as Record<string, unknown>)?.['sampledValue'] as Record<
      string,
      unknown
    >[];
    const context = sampledValue?.[0]?.['context'] as string;
    steps.push({
      step: 3,
      description: 'MeterValuesRequest - sampledValue[0].context must be Trigger',
      status: context === 'Trigger' ? 'passed' : 'failed',
      expected: 'context = Trigger',
      actual: `context = ${context}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_13_CS: CsTestCase = {
  id: 'TC_F_13_CS',
  name: 'Trigger message - TransactionEvent - Specific EVSE',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a TransactionEventRequest message for a specific EVSE, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';

    ctx.server.setMessageHandler(defaultHandler);

    // Before: State is EnergyTransferStarted
    await ctx.station.plugIn(evseId);
    await ctx.station.startCharging(evseId, idToken);
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1-2: Send TriggerMessageRequest for TransactionEvent
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'TransactionEvent',
      evse: { id: evseId },
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 3: Wait for TransactionEventRequest with triggerReason Trigger (skip MeterValuePeriodic)
    const txEvent = await waitForTriggerReason(ctx.server, 'Trigger', 10000);
    const txInfo = txEvent?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chargingState = txInfo?.['chargingState'] as string | undefined;
    const meterValue = txEvent?.['meterValue'] as unknown;
    const evse = txEvent?.['evse'] as Record<string, unknown> | undefined;
    const txEvseId = evse?.['id'] as number | undefined;

    const evseValid = txEvseId == null || txEvseId === evseId;
    const meterPresent = meterValue != null;

    steps.push({
      step: 3,
      description:
        'TransactionEventRequest - triggerReason must be Trigger, chargingState must be Charging, meterValue must be present',
      status:
        txEvent != null && chargingState === 'Charging' && meterPresent && evseValid
          ? 'passed'
          : 'failed',
      expected: 'triggerReason = Trigger, chargingState = Charging, meterValue present',
      actual: `triggerReason = ${txEvent?.['triggerReason'] as string | undefined}, chargingState = ${chargingState}, meterValue = ${String(meterPresent)}, evseId = ${String(txEvseId)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_14_CS: CsTestCase = {
  id: 'TC_F_14_CS',
  name: 'Trigger message - TransactionEvent - All EVSE',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a TransactionEventRequest message for all EVSE, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const idToken = 'OCTT-TOKEN-001';

    ctx.server.setMessageHandler(defaultHandler);

    // Before: State is EnergyTransferStarted for all EVSE
    await ctx.station.plugIn(evseId);
    await ctx.station.startCharging(evseId, idToken);
    // Wait for charging state (drains StatusNotification, Authorize, and intermediate TransactionEvents)
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    // Step 1-2: Send TriggerMessageRequest for TransactionEvent without evse
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'TransactionEvent',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 3: Wait for TransactionEventRequest with triggerReason Trigger (skip MeterValuePeriodic)
    const txEvent14 = await waitForTriggerReason(ctx.server, 'Trigger', 10000);
    const txInfo14 = txEvent14?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chargingState14 = txInfo14?.['chargingState'] as string | undefined;
    const meterValue14 = txEvent14?.['meterValue'] as unknown;
    const meterPresent14 = meterValue14 != null;

    steps.push({
      step: 3,
      description:
        'TransactionEventRequest - triggerReason must be Trigger, chargingState must be Charging, meterValue must be present',
      status:
        txEvent14 != null && chargingState14 === 'Charging' && meterPresent14 ? 'passed' : 'failed',
      expected: 'triggerReason = Trigger, chargingState = Charging, meterValue present',
      actual: `triggerReason = ${txEvent14?.['triggerReason'] as string | undefined}, chargingState = ${chargingState14}, meterValue = ${String(meterPresent14)}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_15_CS: CsTestCase = {
  id: 'TC_F_15_CS',
  name: 'Trigger message - LogStatusNotification - Idle',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a LogStatusNotificationRequest with status Idle, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1-2: Send TriggerMessageRequest for LogStatusNotification
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'LogStatusNotification',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 3: Wait for LogStatusNotificationRequest
    const logMsg = await ctx.server.waitForMessage('LogStatusNotification', 10000);
    const logStatus = logMsg['status'] as string;
    steps.push({
      step: 3,
      description: 'LogStatusNotificationRequest - status must be Idle',
      status: logStatus === 'Idle' ? 'passed' : 'failed',
      expected: 'status = Idle',
      actual: `status = ${logStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_16_CS: CsTestCase = {
  id: 'TC_F_16_CS',
  name: 'Trigger message - LogStatusNotification - Uploading',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a LogStatusNotificationRequest with status Uploading, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1-2: Send GetLogRequest to start log upload
    const getLogRes = await ctx.server.sendCommand('GetLog', {
      logType: 'DiagnosticsLog',
      requestId: 1,
      log: { remoteLocation: 'https://example.com/logs' },
    });
    const getLogStatus = getLogRes['status'] as string;
    steps.push({
      step: 2,
      description: 'GetLogResponse - status must be Accepted',
      status: getLogStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${getLogStatus}`,
    });

    // Step 3: Wait for LogStatusNotificationRequest (Uploading)
    const logMsg1 = await ctx.server.waitForMessage('LogStatusNotification', 10000);
    const logStatus1 = logMsg1['status'] as string;
    steps.push({
      step: 3,
      description: 'LogStatusNotificationRequest - status must be Uploading',
      status: logStatus1 === 'Uploading' ? 'passed' : 'failed',
      expected: 'status = Uploading',
      actual: `status = ${logStatus1}`,
    });

    // Step 5-6: Send TriggerMessageRequest for LogStatusNotification
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'LogStatusNotification',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 6,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 7: Wait for LogStatusNotificationRequest (Uploading)
    const logMsg2 = await ctx.server.waitForMessage('LogStatusNotification', 10000);
    const logStatus2 = logMsg2['status'] as string;
    steps.push({
      step: 7,
      description: 'LogStatusNotificationRequest - status must be Uploading',
      status: logStatus2 === 'Uploading' ? 'passed' : 'failed',
      expected: 'status = Uploading',
      actual: `status = ${logStatus2}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_17_CS: CsTestCase = {
  id: 'TC_F_17_CS',
  name: 'Trigger message - FirmwareStatusNotification - Specific EVSE not relevant',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a FirmwareStatusNotificationRequest, after receiving a TriggerMessageRequest with a specific EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1-2: Send TriggerMessageRequest for FirmwareStatusNotification with evse
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'FirmwareStatusNotification',
      evse: { id: evseId },
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 3: Wait for FirmwareStatusNotificationRequest
    const fwMsg = await ctx.server.waitForMessage('FirmwareStatusNotification', 10000);
    const fwStatus = fwMsg['status'] as string;
    steps.push({
      step: 3,
      description: 'FirmwareStatusNotificationRequest - status must be Idle',
      status: fwStatus === 'Idle' ? 'passed' : 'failed',
      expected: 'status = Idle',
      actual: `status = ${fwStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_18_CS: CsTestCase = {
  id: 'TC_F_18_CS',
  name: 'Trigger message - FirmwareStatusNotification - Idle',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a FirmwareStatusNotificationRequest with status Idle, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'FirmwareStatusNotification',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    const fwMsg = await ctx.server.waitForMessage('FirmwareStatusNotification', 10000);
    const fwStatus = fwMsg['status'] as string;
    steps.push({
      step: 3,
      description: 'FirmwareStatusNotificationRequest - status must be Idle',
      status: fwStatus === 'Idle' ? 'passed' : 'failed',
      expected: 'status = Idle',
      actual: `status = ${fwStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_19_CS: CsTestCase = {
  id: 'TC_F_19_CS',
  name: 'Trigger message - FirmwareStatusNotification - Downloading',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a FirmwareStatusNotificationRequest with status Downloading, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1-2: Send UpdateFirmwareRequest to start firmware download
    const updateRes = await ctx.server.sendCommand('UpdateFirmware', {
      requestId: 1,
      firmware: {
        location: 'https://example.com/firmware.bin',
        retrieveDateTime: new Date(Date.now() - 7_200_000).toISOString(),
        signingCertificate: 'MIIB...',
        signature: 'invalid-signature',
      },
    });
    const updateStatus = updateRes['status'] as string;
    steps.push({
      step: 2,
      description: 'UpdateFirmwareResponse - status must be Accepted',
      status: updateStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${updateStatus}`,
    });

    // Step 3: Wait for FirmwareStatusNotificationRequest (Downloading)
    const fwMsg1 = await ctx.server.waitForMessage('FirmwareStatusNotification', 10000);
    const fwStatus1 = fwMsg1['status'] as string;
    steps.push({
      step: 3,
      description: 'FirmwareStatusNotificationRequest - status must be Downloading',
      status: fwStatus1 === 'Downloading' ? 'passed' : 'failed',
      expected: 'status = Downloading',
      actual: `status = ${fwStatus1}`,
    });

    // Step 5-6: Send TriggerMessageRequest for FirmwareStatusNotification
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'FirmwareStatusNotification',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 6,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 7: Wait for FirmwareStatusNotificationRequest (Downloading)
    const fwMsg2 = await ctx.server.waitForMessage('FirmwareStatusNotification', 10000);
    const fwStatus2 = fwMsg2['status'] as string;
    steps.push({
      step: 7,
      description: 'FirmwareStatusNotificationRequest - status must be Downloading',
      status: fwStatus2 === 'Downloading' ? 'passed' : 'failed',
      expected: 'status = Downloading',
      actual: `status = ${fwStatus2}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_20_CS: CsTestCase = {
  id: 'TC_F_20_CS',
  name: 'Trigger message - Heartbeat',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a HeartbeatRequest, after receiving a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'Heartbeat',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Wait for HeartbeatRequest
    await ctx.server.waitForMessage('Heartbeat', 10000);
    steps.push({
      step: 3,
      description: 'HeartbeatRequest received',
      status: 'passed',
      expected: 'HeartbeatRequest received',
      actual: 'HeartbeatRequest received',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_23_CS: CsTestCase = {
  id: 'TC_F_23_CS',
  name: 'Trigger message - StatusNotification - Specific EVSE - Available',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a StatusNotificationRequest message for a specific EVSE with Available status.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;

    ctx.server.setMessageHandler(defaultHandler);

    // No prerequisite state - station should be Available

    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'StatusNotification',
      evse: { id: evseId, connectorId },
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    // Step 3: Wait for StatusNotificationRequest
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = statusMsg['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Available',
      status: connectorStatus === 'Available' ? 'passed' : 'failed',
      expected: 'connectorStatus = Available',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_24_CS: CsTestCase = {
  id: 'TC_F_24_CS',
  name: 'Trigger message - StatusNotification - Specific EVSE - Occupied',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a StatusNotificationRequest message for a specific EVSE with Occupied status.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const evseId = 1;
    const connectorId = 1;

    ctx.server.setMessageHandler(defaultHandler);

    // Before: State is EVConnectedPreSession (cable plugged in)
    await ctx.station.plugIn(evseId);
    try {
      await ctx.server.waitForMessage('StatusNotification', 5000);
    } catch {
      /* may already be consumed */
    }

    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'StatusNotification',
      evse: { id: evseId, connectorId },
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus}`,
    });

    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const connectorStatus = statusMsg['connectorStatus'] as string;
    steps.push({
      step: 3,
      description: 'StatusNotificationRequest - connectorStatus must be Occupied',
      status: connectorStatus === 'Occupied' ? 'passed' : 'failed',
      expected: 'connectorStatus = Occupied',
      actual: `connectorStatus = ${connectorStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_26_CS: CsTestCase = {
  id: 'TC_F_26_CS',
  name: 'Trigger message - BootNotification - Rejected',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station rejects resending a BootNotificationRequest, when it has already received a successful BootNotificationResponse.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'BootNotification',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be Rejected',
      status: triggerStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${triggerStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_27_CS: CsTestCase = {
  id: 'TC_F_27_CS',
  name: 'Trigger message - NotImplemented',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to report it has not implemented sending a SignCombinedCertificate triggered by a TriggerMessageRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'SignCombinedCertificate',
    });
    const triggerStatus = triggerRes['status'] as string;
    steps.push({
      step: 2,
      description: 'TriggerMessageResponse - status must be NotImplemented',
      status: triggerStatus === 'NotImplemented' ? 'passed' : 'failed',
      expected: 'status = NotImplemented',
      actual: `status = ${triggerStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_F_100_CS: CsTestCase = {
  id: 'TC_F_100_CS',
  name: 'Trigger message - CustomTrigger',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the Charging Station is able to send a message corresponding to a custom trigger it reports to the CSMS.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    ctx.server.setMessageHandler(defaultHandler);

    // Step 1-2: GetVariablesRequest to discover custom triggers
    const getVarsRes = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'CustomizationCtrlr' },
          variable: { name: 'CustomTriggers' },
        },
      ],
    });
    const getVarResult = (getVarsRes['getVariableResult'] as Record<string, unknown>[])?.[0];
    const attributeValue = getVarResult?.['attributeValue'] as string | undefined;
    const componentName = (getVarResult?.['component'] as Record<string, unknown>)?.[
      'name'
    ] as string;
    const variableName = (getVarResult?.['variable'] as Record<string, unknown>)?.[
      'name'
    ] as string;
    steps.push({
      step: 2,
      description:
        'GetVariablesResponse - attributeValue must not be omitted, component.name must be CustomizationCtrlr, variable.name must be CustomTriggers',
      status:
        attributeValue != null &&
        componentName === 'CustomizationCtrlr' &&
        variableName === 'CustomTriggers'
          ? 'passed'
          : 'failed',
      expected: 'attributeValue present, component = CustomizationCtrlr, variable = CustomTriggers',
      actual: `attributeValue = ${String(attributeValue)}, component = ${componentName}, variable = ${variableName}`,
    });

    // Extract first custom trigger name
    const customTrigger = attributeValue?.split(',')[0]?.trim() ?? 'unknown';

    // Step 3-4: Send TriggerMessageRequest with CustomTrigger
    const triggerRes1 = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'CustomTrigger',
      customTrigger,
    });
    const triggerStatus1 = triggerRes1['status'] as string;
    steps.push({
      step: 4,
      description: 'TriggerMessageResponse - status must be Accepted',
      status: triggerStatus1 === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus1}`,
    });

    // Step 5-6: Send TriggerMessageRequest with Heartbeat and same customTrigger
    const triggerRes2 = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'Heartbeat',
      customTrigger,
    });
    const triggerStatus2 = triggerRes2['status'] as string;
    steps.push({
      step: 6,
      description:
        'TriggerMessageResponse (Heartbeat with customTrigger) - status must be Accepted',
      status: triggerStatus2 === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${triggerStatus2}`,
    });

    // Wait for HeartbeatRequest
    await ctx.server.waitForMessage('Heartbeat', 10000);

    // Step 9-10: Send TriggerMessageRequest with unknown custom trigger
    const randomTrigger = `random-trigger-${String(Date.now())}`;
    const triggerRes3 = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'CustomTrigger',
      customTrigger: randomTrigger,
    });
    const triggerStatus3 = triggerRes3['status'] as string;
    steps.push({
      step: 10,
      description: 'TriggerMessageResponse (unknown customTrigger) - status must be NotImplemented',
      status: triggerStatus3 === 'NotImplemented' ? 'passed' : 'failed',
      expected: 'status = NotImplemented',
      actual: `status = ${triggerStatus3}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
