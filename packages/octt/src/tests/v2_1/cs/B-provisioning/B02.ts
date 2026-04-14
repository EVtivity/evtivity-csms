// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_02_CS: CsTestCase = {
  id: 'TC_B_02_CS',
  name: 'Cold Boot Charging Station - Pending',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The booting mechanism allows a Charging Station to provide some general information about the Charging Station.',
  purpose:
    'To verify whether the Charging Station is able to correctly handle the pending state of the boot mechanism.',
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    // Use short interval so boot retry happens quickly in test
    const heartbeatInterval = 2;

    // Set handler: first BootNotification gets Pending, second gets Accepted
    let bootCount = 0;
    ctx.server.setMessageHandler(async (action, _payload) => {
      if (action === 'BootNotification') {
        bootCount++;
        if (bootCount === 1) {
          return {
            currentTime: new Date().toISOString(),
            interval: heartbeatInterval,
            status: 'Pending',
          };
        }
        return {
          currentTime: new Date().toISOString(),
          interval: heartbeatInterval,
          status: 'Accepted',
        };
      }
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      if (action === 'NotifyReport') return {};
      if (action === 'NotifyEvent') return {};
      if (action === 'SecurityEventNotification') return {};
      return {};
    });

    // Station boots autonomously - sends BootNotification, gets Pending
    await ctx.station.start();
    await ctx.server.waitForConnection(5000);

    // Step 1: Validate first BootNotification got Pending
    const bootPayload = await ctx.server.waitForMessage('BootNotification', 10000);
    steps.push({
      step: 1,
      description: 'BootNotification sent, expect Pending response',
      status: bootCount >= 1 ? 'passed' : 'failed',
      expected: 'BootNotification received by server',
      actual: `bootCount = ${String(bootCount)}, payload received = ${bootPayload != null}`,
    });

    // Step 3: CSMS sends SetVariables (OfflineThreshold)
    const setVarRes = await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
          attributeValue: '300',
        },
      ],
    });
    const setVarStatus = (
      (setVarRes['setVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
        string,
        unknown
      >
    )?.['attributeStatus'] as string;
    steps.push({
      step: 4,
      description: 'SetVariablesResponse: attributeStatus = Accepted',
      status: setVarStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'setVariableResult[0].attributeStatus = Accepted',
      actual: `setVariableResult[0].attributeStatus = ${setVarStatus}`,
    });

    // Step 5: CSMS sends GetVariables (OfflineThreshold)
    const getVarRes = await ctx.server.sendCommand('GetVariables', {
      getVariableData: [
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'OfflineThreshold' },
        },
      ],
    });
    const getVarStatus = (
      (getVarRes['getVariableResult'] as Array<Record<string, unknown>>)?.[0] as Record<
        string,
        unknown
      >
    )?.['attributeStatus'] as string;
    steps.push({
      step: 6,
      description: 'GetVariablesResponse: attributeStatus = Accepted',
      status: getVarStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'getVariableResult[0].attributeStatus = Accepted',
      actual: `getVariableResult[0].attributeStatus = ${getVarStatus}`,
    });

    // Step 7: CSMS sends GetBaseReport (FullInventory)
    const requestId = Math.floor(Math.random() * 1000000);
    const baseReportRes = await ctx.server.sendCommand('GetBaseReport', {
      requestId,
      reportBase: 'FullInventory',
    });
    const baseReportStatus = baseReportRes['status'] as string;
    steps.push({
      step: 8,
      description: 'GetBaseReportResponse: status = Accepted',
      status: baseReportStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${baseReportStatus}`,
    });

    // Wait for NotifyReport messages
    try {
      await ctx.server.waitForMessage('NotifyReport', 10000);
    } catch {
      // NotifyReport may or may not arrive in test context
    }

    // Step 11: CSMS sends RequestStartTransaction (should be rejected during Pending)
    const startTxRes = await ctx.server.sendCommand('RequestStartTransaction', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      evseId: 1,
    });
    const startTxStatus = startTxRes['status'] as string;
    steps.push({
      step: 12,
      description: 'RequestStartTransactionResponse: status = Rejected',
      status: startTxStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${startTxStatus}`,
    });

    // Step 13: CSMS sends TriggerMessage for BootNotification
    const triggerRes = await ctx.server.sendCommand('TriggerMessage', {
      requestedMessage: 'BootNotification',
    });
    const triggerStatus = triggerRes['status'] as string;
    const triggerOk = triggerStatus === 'Accepted' || triggerStatus === 'NotImplemented';
    steps.push({
      step: 14,
      description: 'TriggerMessageResponse: status = Accepted or NotImplemented',
      status: triggerOk ? 'passed' : 'failed',
      expected: 'status = Accepted or NotImplemented',
      actual: `status = ${triggerStatus}`,
    });

    // Step 15: Wait for BootNotification with reason Triggered
    if (triggerStatus === 'Accepted') {
      try {
        const triggeredBoot = await ctx.server.waitForMessage('BootNotification', 15000);
        const reason = triggeredBoot['reason'] as string;
        steps.push({
          step: 15,
          description: 'BootNotificationRequest with reason = Triggered',
          status: reason === 'Triggered' ? 'passed' : 'failed',
          expected: 'reason = Triggered',
          actual: `reason = ${reason}`,
        });
      } catch {
        steps.push({
          step: 15,
          description: 'BootNotificationRequest with reason = Triggered',
          status: 'failed',
          expected: 'reason = Triggered',
          actual: 'Timed out waiting for BootNotification',
        });
      }
    }

    // Step 17: Wait for StatusNotification with connectorStatus = Available
    try {
      const statusPayload = await ctx.server.waitForMessage('StatusNotification', 10000);
      const connectorStatus = statusPayload['connectorStatus'] as string;
      steps.push({
        step: 17,
        description: 'StatusNotificationRequest: connectorStatus = Available',
        status: connectorStatus === 'Available' ? 'passed' : 'failed',
        expected: 'connectorStatus = Available',
        actual: `connectorStatus = ${connectorStatus}`,
      });
    } catch {
      steps.push({
        step: 17,
        description: 'StatusNotificationRequest: connectorStatus = Available',
        status: 'failed',
        expected: 'connectorStatus = Available',
        actual: 'Timed out waiting for StatusNotification',
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
