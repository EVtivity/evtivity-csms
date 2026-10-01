// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import {
  isPasswordString,
  newTestPassword,
  tryConnect,
  waitForOnline,
} from '../../../../security-test-helpers.js';

const INITIAL_PASSWORD = newTestPassword(24);

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
              attributeStatus: isPassword ? 'Rejected' : 'Accepted',
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
      description: 'The CSMS reports that the station rejected the password',
      status:
        api.status === 502 && api.body['code'] === 'STATION_SECURITY_CHANGE_REJECTED'
          ? 'passed'
          : 'failed',
      expected: '502 STATION_SECURITY_CHANGE_REJECTED',
      actual: `${String(api.status)} ${JSON.stringify(api.body)}`,
    });

    // Steps 3-4: the CSMS keeps accepting the old credentials.
    const oldStatus = await tryConnect(ctx, {
      serverUrl: ctx.config.serverUrl,
      password: INITIAL_PASSWORD,
    });
    steps.push({
      step: 3,
      description: 'The CSMS still accepts the old credentials',
      status: oldStatus === 101 ? 'passed' : 'failed',
      expected: 'Connection accepted',
      actual: `HTTP ${String(oldStatus)}`,
    });
    const newStatus = await tryConnect(ctx, {
      serverUrl: ctx.config.serverUrl,
      password: newPassword,
    });
    steps.push({
      step: 4,
      description: 'The rejected password is not accepted',
      status: newStatus === 401 ? 'passed' : 'failed',
      expected: 'HTTP 401',
      actual: `HTTP ${String(newStatus)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
