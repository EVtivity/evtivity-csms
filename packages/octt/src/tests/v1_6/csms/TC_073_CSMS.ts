// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';
import {
  isPasswordString,
  newTestPassword,
  reconnectWith,
  tryConnect,
  waitForOnline,
} from '../../../security-test-helpers.js';
import { defaultReply } from '../../../default-replies.js';

const INITIAL_PASSWORD = newTestPassword(18);

export const TC_073_CSMS: TestCase = {
  id: 'TC_073_CSMS',
  name: 'Update Charge Point Password for HTTP Basic Authentication (1.6)',
  module: 'security',
  version: 'ocpp1.6',
  sut: 'csms',
  description:
    'The Central System configures a new password for HTTP Basic Authentication; the Charge Point reconnects with it.',
  purpose: 'To check if the Central System is able to change the Basic Authentication password.',
  provision: { securityProfile: 1, password: INITIAL_PASSWORD },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const fail = (step: number, description: string, actual: string): void => {
      steps.push({ step, description, status: 'failed', expected: 'API available', actual });
    };
    if (ctx.callApi == null || ctx.stationDbId == null) {
      fail(1, 'Operator changes the password through the CSMS API', 'API client not available');
      return { status: 'failed', durationMs: 0, steps };
    }

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received: { key: string; value: string } | null = null;
    ctx.client.setIncomingCallHandler((_messageId, action, payload) => {
      if (action === 'ChangeConfiguration') {
        // The CSMS also pushes its boot configuration (meter value keys); keep the password change.
        const key = String(payload['key'] ?? '');
        if (key === 'AuthorizationKey' || received == null) {
          received = { key, value: String(payload['value'] ?? '') };
        }
        return Promise.resolve({ status: 'Accepted' });
      }
      return defaultReply('ocpp1.6', action, payload);
    });

    // Manual action: update the Basic Auth password on the Central System.
    const newPassword = newTestPassword(20);
    await waitForOnline(ctx);
    const api = await ctx.callApi('POST', `/stations/${ctx.stationDbId}/credentials`, {
      password: newPassword,
    });

    // Step 1 validations (OCTT TC_073_CSMS): key AuthorizationKey, value the hex of
    // the password, at most 40 hex characters, password 16-20 bytes.
    const change = received as { key: string; value: string } | null;
    const hex = change?.value ?? '';
    const decoded = /^(?:[0-9A-Fa-f]{2})+$/.test(hex) ? Buffer.from(hex, 'hex') : null;
    const valid =
      change?.key === 'AuthorizationKey' &&
      hex.length <= 40 &&
      decoded != null &&
      decoded.length >= 16 &&
      decoded.length <= 20 &&
      isPasswordString(decoded.toString('latin1'));
    steps.push({
      step: 1,
      description: 'Central System sends ChangeConfiguration(AuthorizationKey) with a hex password',
      status: valid ? 'passed' : 'failed',
      expected: 'key AuthorizationKey, hex value of at most 40 characters, 16-20 byte password',
      actual:
        change == null
          ? 'No ChangeConfiguration received'
          : `key=${change.key}, hex length=${String(hex.length)}, bytes=${String(decoded?.length ?? 0)}`,
    });
    steps.push({
      step: 2,
      description: 'The Central System applies the password only after Accepted',
      status: api.status === 200 && api.body['appliedTo'] === 'station' ? 'passed' : 'failed',
      expected: '200 appliedTo=station',
      actual: `${String(api.status)} ${JSON.stringify(api.body)}`,
    });

    // Step 3: the Charge Point reconnects using the new password.
    const reconnected =
      decoded != null &&
      (await reconnectWith(ctx, { password: decoded.toString('latin1'), securityProfile: 1 }));
    steps.push({
      step: 3,
      description: 'The Charge Point reconnects with the new password',
      status: reconnected ? 'passed' : 'failed',
      expected: 'Connection accepted',
      actual: reconnected ? 'Connected' : 'Not connected',
    });

    const oldStatus = await tryConnect(ctx, {
      serverUrl: ctx.config.serverUrl,
      password: INITIAL_PASSWORD,
    });
    steps.push({
      step: 4,
      description: 'The previous password is no longer accepted',
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
