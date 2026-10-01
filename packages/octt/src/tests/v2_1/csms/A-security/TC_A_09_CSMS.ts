// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import {
  isPasswordString,
  newTestPassword,
  reconnectWith,
  tryConnect,
  waitForOnline,
} from '../../../../security-test-helpers.js';

const INITIAL_PASSWORD = newTestPassword(24);

export const TC_A_09_CSMS: TestCase = {
  id: 'TC_A_09_CSMS',
  name: 'Update Charging Station Password for HTTP Basic Authentication - Accepted',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS sets a new BasicAuthPassword; the Charging Station reconnects with it.',
  purpose:
    'To verify if the CSMS is able to successfully set the new BasicAuthPassword and only accepts the new password afterwards.',
  provision: { securityProfile: 1, password: INITIAL_PASSWORD },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    if (ctx.callApi == null || ctx.stationDbId == null) {
      steps.push({
        step: 1,
        description: 'Operator changes the password through the CSMS API',
        status: 'failed',
        expected: 'API available',
        actual: 'API client not available',
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let received: { component: string; variable: string; value: string } | null = null;
    ctx.client.setIncomingCallHandler((_messageId, action, payload) => {
      if (action === 'SetVariables') {
        const data = (payload['setVariableData'] as Record<string, unknown>[] | undefined)?.[0];
        const component = data?.['component'] as { name?: string } | undefined;
        const variable = data?.['variable'] as { name?: string } | undefined;
        // Ignore the configuration the CSMS pushes after boot.
        const isPassword = variable?.name === 'BasicAuthPassword';
        if (isPassword) {
          received = {
            component: component?.name ?? '',
            variable: variable?.name ?? '',
            value: String(data?.['attributeValue'] ?? ''),
          };
        }
        return Promise.resolve({
          setVariableResult: [
            {
              attributeStatus: 'Accepted',
              component: data?.['component'] ?? {},
              variable: data?.['variable'] ?? {},
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    // Manual action: update the Basic Auth password on the CSMS.
    const newPassword = newTestPassword(32);
    await waitForOnline(ctx);
    const api = await ctx.callApi('POST', `/stations/${ctx.stationDbId}/credentials`, {
      password: newPassword,
    });

    // Step 1 validations: SecurityCtrlr.BasicAuthPassword, a passwordString of
    // 16-40 characters (A00.FR.205).
    const sent = received as { component: string; variable: string; value: string } | null;
    const valid =
      sent?.component === 'SecurityCtrlr' &&
      sent.variable === 'BasicAuthPassword' &&
      sent.value === newPassword &&
      sent.value.length >= 16 &&
      sent.value.length <= 40 &&
      isPasswordString(sent.value);
    steps.push({
      step: 1,
      description: 'CSMS sends SetVariablesRequest for SecurityCtrlr.BasicAuthPassword',
      status: valid ? 'passed' : 'failed',
      expected: 'SecurityCtrlr.BasicAuthPassword = new passwordString of 16-40 characters',
      actual:
        sent == null
          ? 'No SetVariablesRequest received'
          : `${sent.component}.${sent.variable}, length ${String(sent.value.length)}`,
    });

    steps.push({
      step: 2,
      description: 'The CSMS switches to the new password after Accepted (A01.FR.03)',
      status: api.status === 200 && api.body['appliedTo'] === 'station' ? 'passed' : 'failed',
      expected: '200 appliedTo=station',
      actual: `${String(api.status)} ${JSON.stringify(api.body)}`,
    });

    // Steps 3-6: reconnect with the new password; the CSMS upgrades the connection.
    const reconnected = await reconnectWith(ctx, { password: newPassword, securityProfile: 1 });
    steps.push({
      step: 3,
      description: 'The Test System reconnects with the new BasicAuthPassword',
      status: reconnected ? 'passed' : 'failed',
      expected: 'Connection accepted',
      actual: reconnected ? 'Connected' : 'Not connected',
    });
    if (reconnected) {
      const boot = await ctx.client.sendCall('BootNotification', {
        chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
        reason: 'PowerUp',
      });
      steps.push({
        step: 4,
        description: 'BootNotificationResponse after reconnecting',
        status: boot['status'] === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status ${String(boot['status'])}`,
      });
    }

    const oldStatus = await tryConnect(ctx, {
      serverUrl: ctx.config.serverUrl,
      password: INITIAL_PASSWORD,
    });
    steps.push({
      step: 5,
      description: 'The previous password is no longer accepted (A01.FR.03)',
      status: oldStatus === 401 ? 'passed' : 'failed',
      expected: 'HTTP 401',
      actual: `HTTP ${String(oldStatus)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
