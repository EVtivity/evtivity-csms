// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import {
  newTestPassword,
  reconnectWith,
  tryConnect,
  waitForOnline,
} from '../../../../security-test-helpers.js';
import { defaultReply } from '../../../../default-replies.js';

const PASSWORD = newTestPassword(24);
const MESSAGE_TIMEOUT = 30;
const OCPP_INTERFACE = 'Wired0';

export const TC_A_19_CSMS: TestCase = {
  id: 'TC_A_19_CSMS',
  name: 'Upgrade Charging Station Security Profile - Accepted',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS updates the connection details on the Charging Station to increase the security profile level.',
  purpose:
    'To verify if the CSMS is able to set a new network connection profile at a higher security profile level on the Charging Station.',
  provision: { securityProfile: 1, password: PASSWORD },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    if (ctx.callApi == null || ctx.stationDbId == null) {
      steps.push({
        step: 1,
        description: 'Operator requests the upgrade through the CSMS API',
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

    // The Test System's configured network connection (slot 1).
    const deviceModel: Record<string, string> = {
      NetworkConfigurationPriority: '1',
      OcppCsmsUrl: ctx.config.serverUrl,
      OcppInterface: OCPP_INTERFACE,
      MessageTimeout: String(MESSAGE_TIMEOUT),
    };
    let networkProfile: Record<string, unknown> | null = null;
    let priority: string | null = null;
    let resetReceived = false;
    ctx.client.setIncomingCallHandler((_messageId, action, payload) => {
      if (action === 'GetVariables') {
        const items = (payload['getVariableData'] ?? []) as {
          component: Record<string, unknown>;
          variable: { name: string };
        }[];
        return Promise.resolve({
          getVariableResult: items.map((item) => ({
            attributeStatus: item.variable.name in deviceModel ? 'Accepted' : 'UnknownVariable',
            attributeValue: deviceModel[item.variable.name],
            component: item.component,
            variable: item.variable,
          })),
        });
      }
      if (action === 'SetNetworkProfile') {
        networkProfile = payload;
        return Promise.resolve({ status: 'Accepted' });
      }
      if (action === 'SetVariables') {
        const data = (payload['setVariableData'] as Record<string, unknown>[] | undefined)?.[0];
        if (
          (data?.['variable'] as { name?: string } | undefined)?.name ===
          'NetworkConfigurationPriority'
        ) {
          priority = String(data?.['attributeValue'] ?? '');
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
      if (action === 'Reset') {
        resetReceived = true;
        return Promise.resolve({ status: 'Accepted' });
      }
      return defaultReply('ocpp2.1', action, payload);
    });

    // Manual actions: new NetworkConnectionProfile one level higher, priority, reboot.
    await waitForOnline(ctx);
    const api = await ctx.callApi('PATCH', `/stations/${ctx.stationDbId}`, { securityProfile: 2 });

    const profile = networkProfile as Record<string, unknown> | null;
    const connectionData = (profile?.['connectionData'] ?? {}) as Record<string, unknown>;
    const slot = profile?.['configurationSlot'];
    const step1Ok =
      profile != null &&
      connectionData['messageTimeout'] === MESSAGE_TIMEOUT &&
      connectionData['ocppInterface'] === OCPP_INTERFACE &&
      connectionData['ocppTransport'] === 'JSON' &&
      connectionData['ocppVersion'] === 'OCPP20' &&
      connectionData['securityProfile'] === 2;
    steps.push({
      step: 1,
      description: 'CSMS sends SetNetworkProfileRequest for security profile 2',
      status: step1Ok ? 'passed' : 'failed',
      expected:
        'messageTimeout 30, ocppInterface Wired0, ocppTransport JSON, ocppVersion OCPP20, securityProfile 2',
      actual: profile == null ? 'No SetNetworkProfileRequest received' : JSON.stringify(profile),
    });

    const priorityValue = priority as string | null;
    const slots = (priorityValue ?? '').split(',').map((s) => s.trim());
    steps.push({
      step: 3,
      description: 'CSMS sets NetworkConfigurationPriority containing the new slot',
      status: slot != null && slots.includes(String(slot)) ? 'passed' : 'failed',
      expected: `OCPPCommCtrlr.NetworkConfigurationPriority contains slot ${String(slot)}`,
      actual: priorityValue ?? 'No SetVariablesRequest for NetworkConfigurationPriority',
    });
    steps.push({
      step: 5,
      description: 'CSMS sends ResetRequest',
      status: resetReceived ? 'passed' : 'failed',
      expected: 'ResetRequest received',
      actual: resetReceived ? 'Received' : 'Not received',
    });
    steps.push({
      step: 6,
      description: 'The upgrade is pending until the station connects with the new profile',
      status: api.status === 200 && api.body['pendingSecurityProfile'] === 2 ? 'passed' : 'failed',
      expected: '200 pendingSecurityProfile=2',
      actual: `${String(api.status)} ${JSON.stringify(api.body).slice(0, 200)}`,
    });

    // Steps 7-14 reconnect over TLS, which needs the CSMS TLS endpoint.
    const tlsUrl = ctx.config.tlsServerUrl;
    if (tlsUrl == null) {
      for (const [step, description] of [
        [7, 'Reconnect with security profile 2 is accepted'],
        [10, 'Reconnect with the original security profile 1 is rejected'],
      ] as const) {
        steps.push({
          step,
          description,
          status: 'skipped',
          expected: 'Run with --tls-server <wss url>',
          actual: 'No TLS endpoint configured',
        });
      }
    } else {
      const upgraded = await reconnectWith(ctx, { serverUrl: tlsUrl, securityProfile: 2 });
      steps.push({
        step: 7,
        description: 'Reconnect with security profile 2 is accepted',
        status: upgraded ? 'passed' : 'failed',
        expected: 'Connection accepted',
        actual: upgraded ? 'Connected' : 'Not connected',
      });
      // Profile 1 is Basic Auth over plain ws://. Through a wss:// --server the
      // same credentials make a valid profile 2 connection, which the CSMS
      // rightly accepts, so the step needs a plain ws:// endpoint.
      if (!ctx.config.serverUrl.startsWith('ws://')) {
        steps.push({
          step: 10,
          description: 'Reconnect with the original security profile 1 is rejected (A05.FR.07)',
          status: 'skipped',
          expected: 'Run with --server <plain ws:// url>',
          actual: `--server ${ctx.config.serverUrl} is not a plain ws:// endpoint`,
        });
      } else {
        const lower = await tryConnect(ctx, {
          serverUrl: ctx.config.serverUrl,
          password: PASSWORD,
        });
        steps.push({
          step: 10,
          description: 'Reconnect with the original security profile 1 is rejected (A05.FR.07)',
          status: lower === 401 ? 'passed' : 'failed',
          expected: 'HTTP 401',
          actual: `HTTP ${String(lower)}`,
        });
      }
    }

    const passed = steps.every((s) => s.status !== 'failed');
    return { status: passed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
