// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppClient } from '@evtivity/css/ocpp-client';
import type { TestCase, StepResult } from '../../../../types.js';

export const TC_A_10_CSMS: TestCase = {
  id: 'TC_A_10_CSMS',
  name: 'Update Charging Station Password for HTTP Basic Authentication - Rejected',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case verifies the CSMS keeps accepting old credentials when the Charging Station rejects the new BasicAuthPassword.',
  purpose:
    'To verify if the CSMS keeps accepting the old credentials and keeps communication when the new password is rejected.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot the station first
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Step 1: The CSMS sends a SetVariablesRequest to set a new BasicAuthPassword.
    // We respond with Rejected.
    let setVariablesReceived = false;
    let variableName = '';
    let componentName = '';

    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'SetVariables') {
        setVariablesReceived = true;
        const setVariableData = payload['setVariableData'] as
          | Array<Record<string, unknown>>
          | undefined;
        if (setVariableData != null && setVariableData.length > 0) {
          const firstEntry = setVariableData[0];
          if (firstEntry != null) {
            const variable = firstEntry['variable'] as Record<string, unknown> | undefined;
            const component = firstEntry['component'] as Record<string, unknown> | undefined;
            variableName = String(variable?.['name'] ?? '');
            componentName = String(component?.['name'] ?? '');
          }
        }
        return {
          setVariableResult: [
            {
              attributeStatus: 'Rejected',
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'BasicAuthPassword' },
            },
          ],
        };
      }
      return { status: 'NotSupported' };
    });

    // Wait for the CSMS to send SetVariables
    await new Promise((resolve) => setTimeout(resolve, 5000));

    steps.push({
      step: 1,
      description:
        'CSMS sends SetVariablesRequest for BasicAuthPassword with SecurityCtrlr component',
      status: setVariablesReceived ? 'passed' : 'failed',
      expected:
        'SetVariablesRequest with variable.name = BasicAuthPassword, component.name = SecurityCtrlr',
      actual: setVariablesReceived
        ? `Received SetVariables: component=${componentName}, variable=${variableName}`
        : 'No SetVariablesRequest received within timeout',
    });

    // Step 2: Respond with Rejected (handled above)
    steps.push({
      step: 2,
      description: 'Respond with SetVariablesResponse status Rejected',
      status: setVariablesReceived ? 'passed' : 'failed',
      expected: 'SetVariablesResponse sent with status Rejected',
      actual: setVariablesReceived ? 'Response sent' : 'No request to respond to',
    });

    // Step 3: Disconnect the current connection
    ctx.client.disconnect();
    steps.push({
      step: 3,
      description: 'Disconnect current connection after rejecting new password',
      status: !ctx.client.isConnected ? 'passed' : 'failed',
      expected: 'Disconnected',
      actual: ctx.client.isConnected ? 'Still connected' : 'Disconnected',
    });

    // Step 4: Reconnect with the OLD password (since we rejected the new one)
    const oldPassword = ctx.config.password ?? 'password';
    const newClient = new OcppClient({
      serverUrl: ctx.config.serverUrl,
      stationId: ctx.stationId,
      ocppProtocol: 'ocpp2.1',
      password: oldPassword,
      securityProfile: 1,
    });

    let reconnected = false;
    try {
      await newClient.connect();
      reconnected = newClient.isConnected;
    } catch {
      reconnected = false;
    }

    steps.push({
      step: 4,
      description: 'Reconnect with old password (CSMS should still accept old credentials)',
      status: reconnected ? 'passed' : 'failed',
      expected: 'Connected with old password',
      actual: reconnected ? 'Connected with old password' : 'Failed to connect with old password',
    });

    // Step 5: Send BootNotification on the new connection
    if (reconnected) {
      try {
        const bootRes = await newClient.sendCall('BootNotification', {
          chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
          reason: 'PowerUp',
        });
        const status = bootRes['status'] as string;
        steps.push({
          step: 5,
          description:
            'BootNotificationResponse after reconnect with old password has status Accepted',
          status: status === 'Accepted' ? 'passed' : 'failed',
          expected: 'status = Accepted',
          actual: `status = ${status}`,
        });
      } catch {
        steps.push({
          step: 5,
          description:
            'BootNotificationResponse after reconnect with old password has status Accepted',
          status: 'failed',
          expected: 'status = Accepted',
          actual: 'Error sending BootNotification',
        });
      }
      newClient.disconnect();
    } else {
      steps.push({
        step: 5,
        description:
          'BootNotificationResponse after reconnect with old password has status Accepted',
        status: 'failed',
        expected: 'status = Accepted',
        actual: 'Skipped: not connected',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
