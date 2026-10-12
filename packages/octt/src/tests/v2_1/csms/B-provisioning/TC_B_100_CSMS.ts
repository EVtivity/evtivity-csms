// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { newTestPassword, waitForOnline } from '../../../../security-test-helpers.js';
import { defaultReply } from '../../../../default-replies.js';

const PASSWORD = newTestPassword(24);
const MESSAGE_TIMEOUT = 30;
const OCPP_INTERFACE = 'Wired0';
const SECURITY_PROFILE = 1;

/**
 * The CSMS sends a network profile with identity and password only through the
 * station security service: an upgrade from profile 0 to profile 1 with a new
 * password (generic OCPP command routes never carry station passwords).
 */
export const TC_B_100_CSMS: TestCase = {
  id: 'TC_B_100_CSMS',
  name: 'Set new NetworkConnectionProfile - Identity and password',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS updates the connection details on the Charging Station including identity and password.',
  purpose:
    'To verify if the CSMS is able to set a new network connection profile that contains basicAuthPassword and identity.',
  provision: { securityProfile: 0 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    if (ctx.callApi == null || ctx.stationDbId == null) {
      steps.push({
        step: 1,
        description: 'Operator requests the network profile through the CSMS API',
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
      if (action === 'Reset') return Promise.resolve({ status: 'Accepted' });
      return defaultReply('ocpp2.1', action, payload);
    });

    // Manual action: a network profile with identity and password.
    await waitForOnline(ctx);
    const api = await ctx.callApi('PATCH', `/stations/${ctx.stationDbId}`, {
      securityProfile: SECURITY_PROFILE,
      password: PASSWORD,
    });

    const profile = networkProfile as Record<string, unknown> | null;
    const connectionData = (profile?.['connectionData'] ?? {}) as Record<string, unknown>;
    const expected: Record<string, unknown> = {
      messageTimeout: MESSAGE_TIMEOUT,
      ocppCsmsUrl: ctx.config.serverUrl,
      ocppInterface: OCPP_INTERFACE,
      ocppTransport: 'JSON',
      ocppVersion: 'OCPP20',
      securityProfile: SECURITY_PROFILE,
      identity: ctx.stationId,
      basicAuthPassword: PASSWORD,
    };
    const mismatches = Object.entries(expected)
      .filter(([field, value]) => connectionData[field] !== value)
      .map(([field]) => field);
    const slot = profile?.['configurationSlot'];
    if (typeof slot !== 'number') mismatches.unshift('configurationSlot');
    steps.push({
      step: 1,
      description: 'CSMS sends SetNetworkProfileRequest with identity and password',
      status: profile != null && mismatches.length === 0 ? 'passed' : 'failed',
      expected: `configurationSlot set, messageTimeout ${String(MESSAGE_TIMEOUT)}, ocppCsmsUrl ${ctx.config.serverUrl}, ocppInterface ${OCPP_INTERFACE}, ocppTransport JSON, ocppVersion OCPP20, securityProfile ${String(SECURITY_PROFILE)}, identity ${ctx.stationId}, basicAuthPassword set`,
      actual:
        profile == null
          ? `No SetNetworkProfileRequest received (API ${String(api.status)} ${JSON.stringify(api.body).slice(0, 200)})`
          : mismatches.length === 0
            ? 'All fields match'
            : `Mismatched: ${mismatches.join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
