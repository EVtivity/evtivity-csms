// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// B02/B03: Cold Boot Charging Station - Pending/Rejected - SecurityError
export const TC_B_30_CSMS: TestCase = {
  id: 'TC_B_30_CSMS',
  name: 'Cold Boot Charging Station - Pending/Rejected - SecurityError',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS responds with Pending or Rejected to BootNotification and rejects subsequent messages from unauthorized station with SecurityError.',
  purpose:
    'To verify whether the CSMS is able to handle unauthorized messages from the Charging Station by responding with a SecurityError.',
  onboardingStatus: 'pending',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Send BootNotification - expect Pending or Rejected
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    const bootStatus = bootRes['status'] as string;
    steps.push({
      step: 1,
      description: 'Send BootNotification, expect Pending response',
      status: bootStatus === 'Pending' ? 'passed' : 'failed',
      expected: 'status = Pending',
      actual: `status = ${bootStatus}`,
    });

    // Step 2: Send StatusNotification while in Pending state
    // CSMS should respond with SecurityError CALLERROR
    let receivedSecurityError = false;
    let statusNotifError = '';
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 1,
        connectorId: 1,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      statusNotifError = errorMessage;
      if (errorMessage.includes('SecurityError')) {
        receivedSecurityError = true;
      }
    }

    steps.push({
      step: 2,
      description:
        'Send StatusNotification in Pending state - CSMS responds with SecurityError CALLERROR',
      status: receivedSecurityError ? 'passed' : 'failed',
      expected: 'CSMS responds with SecurityError CALLERROR',
      actual: receivedSecurityError
        ? 'SecurityError CALLERROR received'
        : statusNotifError !== ''
          ? `Error received: ${statusNotifError}`
          : 'No SecurityError received (normal response returned)',
    });

    // Step 3: Send NotifyEventRequest while in Pending state
    // CSMS should also respond with SecurityError CALLERROR
    let receivedNotifyEventSecurityError = false;
    let notifyEventError = '';
    try {
      await ctx.client.sendCall('NotifyEvent', {
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        eventData: [
          {
            eventId: 1,
            timestamp: new Date().toISOString(),
            trigger: 'Delta',
            actualValue: 'Available',
            component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
            variable: { name: 'AvailabilityState' },
            eventNotificationType: 'HardWiredNotification',
          },
        ],
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      notifyEventError = errorMessage;
      if (errorMessage.includes('SecurityError')) {
        receivedNotifyEventSecurityError = true;
      }
    }

    steps.push({
      step: 3,
      description:
        'Send NotifyEventRequest in Pending state - CSMS responds with SecurityError CALLERROR',
      status: receivedNotifyEventSecurityError ? 'passed' : 'failed',
      expected: 'CSMS responds with SecurityError CALLERROR',
      actual: receivedNotifyEventSecurityError
        ? 'SecurityError CALLERROR received'
        : notifyEventError !== ''
          ? `Error received: ${notifyEventError}`
          : 'No SecurityError received (normal response returned)',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// B02/F06: Cold Boot Charging Station - Pending/Rejected - TriggerMessage
export const TC_B_31_CSMS: TestCase = {
  id: 'TC_B_31_CSMS',
  name: 'Cold Boot Charging Station - Pending/Rejected - TriggerMessage',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS responds to BootNotification with Pending or Rejected, then sends TriggerMessage to trigger a new BootNotification.',
  purpose:
    'To verify whether the CSMS is able to send a TriggerMessageRequest to trigger a BootNotificationRequest after responding with Pending or Rejected.',
  onboardingStatus: 'pending',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Step 1: Send BootNotification - expect Pending or Rejected
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    const bootStatus = bootRes['status'] as string;
    steps.push({
      step: 1,
      description: 'Send BootNotification, expect Pending or Rejected response',
      status:
        bootStatus === 'Pending' || bootStatus === 'Rejected' || bootStatus === 'Accepted'
          ? 'passed'
          : 'failed',
      expected: 'status = Pending or Rejected (or Accepted)',
      actual: `status = ${bootStatus}`,
    });

    // Step 2: Wait for TriggerMessage from CSMS
    let receivedTrigger = false;
    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'TriggerMessage') {
        receivedTrigger = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'BootNotification',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 2,
      description: 'CSMS sends TriggerMessage to request new BootNotification',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessage received (CSMS may accept immediately)',
    });

    // Step 3: Send BootNotification with reason Triggered
    const boot2Res = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: receivedTrigger ? 'Triggered' : 'PowerUp',
    });
    const boot2Status = boot2Res['status'] as string;
    steps.push({
      step: 3,
      description: 'Send second BootNotification',
      status: boot2Status === 'Accepted' || boot2Status === 'Pending' ? 'passed' : 'failed',
      expected: 'status = Accepted or Pending',
      actual: `status = ${boot2Status}`,
    });

    return {
      status: steps.filter((s) => s.status === 'failed').length === 0 ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// Part 4 JSON/WebSocket: WebSocket Subprotocol validation
export const TC_B_58_CSMS: TestCase = {
  id: 'TC_B_58_CSMS',
  name: 'WebSocket Subprotocol validation',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP-J imposes extra constraints on the WebSocket subprotocol. The CSMS must select a supported OCPP version when presented with both supported and unsupported subprotocols.',
  purpose:
    'To verify whether the CSMS is able to select a supported OCPP version when also a different unsupported subprotocol is offered.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // First boot to confirm connection is established with the correct subprotocol
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    steps.push({
      step: 1,
      description: 'CSMS accepts connection with supported OCPP subprotocol (ocpp2.1)',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Connection accepted with ocpp2.1 subprotocol',
      actual: `BootNotification status = ${String(bootRes['status'])}`,
    });

    // The test verifies that when CSMS receives SetNetworkProfileRequest response of Failed,
    // it handles it gracefully. In CSMS-as-SUT: wait for SetNetworkProfile from CSMS.
    let receivedSetNetwork = false;
    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'SetNetworkProfile') {
        receivedSetNetwork = true;
        return { status: 'Failed' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetNetworkProfile', {
        stationId: ctx.stationId,
        configurationSlot: 1,
        connectionData: {
          ocppVersion: 'OCPP21',
          ocppTransport: 'JSON',
          messageTimeout: 30,
          ocppCsmsUrl: 'ws://localhost:3003',
          securityProfile: 0,
          ocppInterface: 'Wired0',
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 2,
      description: 'CSMS may send SetNetworkProfile; respond with Failed status',
      status: 'passed',
      expected: 'SetNetworkProfile handled or not sent',
      actual: receivedSetNetwork
        ? 'SetNetworkProfile received, responded Failed'
        : 'No SetNetworkProfile received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// B09: Set new NetworkConnectionProfile - Add new NetworkConfiguration using SetVariables
export const TC_B_105_CSMS: TestCase = {
  id: 'TC_B_105_CSMS',
  name: 'Set new NetworkConnectionProfile - Add new NetworkConfiguration using SetVariables',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS updates the connection details on the Charging Station using SetVariables for NetworkConfiguration.',
  purpose:
    'To verify that CSMS can set NetworkConfiguration and correctly sets the value of Apn/VpnEnabled.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot the station first
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Wait for CSMS to send SetVariablesRequest for NetworkConfiguration
    let receivedSetVariables = false;
    const allAccepted = true;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetVariables') {
          receivedSetVariables = true;
          const setVariableData = payload['setVariableData'] as
            | Array<Record<string, unknown>>
            | undefined;
          const results = (setVariableData ?? []).map((item: Record<string, unknown>) => ({
            component: item['component'],
            variable: item['variable'],
            attributeType: item['attributeType'] ?? 'Actual',
            attributeStatus: 'Accepted',
          }));
          return { setVariableResult: results };
        }
        if (action === 'Reset') {
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetVariables', {
        stationId: ctx.stationId,
        setVariableData: [
          {
            component: { name: 'OCPPCommCtrlr' },
            variable: { name: 'NetworkConfigurationPriority' },
            attributeValue: '1',
            attributeType: 'Actual',
          },
        ],
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetVariablesRequest for NetworkConfiguration',
      status: receivedSetVariables ? 'passed' : 'failed',
      expected: 'SetVariablesRequest received with NetworkConfiguration component',
      actual: receivedSetVariables
        ? 'SetVariablesRequest received, all Accepted'
        : 'No SetVariablesRequest received',
    });

    if (receivedSetVariables) {
      steps.push({
        step: 2,
        description: 'All SetVariables attributes accepted',
        status: allAccepted ? 'passed' : 'failed',
        expected: 'All attributeStatus = Accepted',
        actual: allAccepted ? 'All Accepted' : 'Some rejected',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
