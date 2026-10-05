// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHmac } from 'node:crypto';
import type { StepResult, TestContext, TestResult } from './types.js';
import { CSMS_STATE_TIMEOUT_MS, waitForEvse, waitForOnline } from './security-test-helpers.js';
import { defaultReply } from './default-replies.js';

/**
 * The station side of OCPP 2.1 C25 dynamic QR codes for the CSMS tests
 * TC_C_131 to TC_C_133: answer the CSMS's SetVariables WebPaymentsCtrlr, keep
 * the values (the shared secret is write-only on a real station), and build the
 * QR code URL from URLTemplate with a TOTP computed as a station does.
 */

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface WebPaymentsCapture {
  /** WebPaymentsCtrlr variable values the CSMS set. */
  values: Record<string, string>;
  /**
   * Answers a SetVariables call (Accepted per item, echoing component and
   * variable) and records WebPaymentsCtrlr values. Returns null for other actions.
   */
  handle: (action: string, payload: Record<string, unknown>) => Record<string, unknown> | null;
}

export function captureWebPayments(): WebPaymentsCapture {
  const values: Record<string, string> = {};
  return {
    values,
    handle(action, payload) {
      if (action !== 'SetVariables') return null;
      const items = Array.isArray(payload['setVariableData'])
        ? (payload['setVariableData'] as Record<string, unknown>[])
        : [];
      return {
        setVariableResult: items.map((item) => {
          const component = item['component'] as { name?: string } | undefined;
          const variable = item['variable'] as { name?: string } | undefined;
          if (component?.name === 'WebPaymentsCtrlr' && variable?.name != null) {
            values[variable.name] = String(item['attributeValue']);
          }
          return { attributeStatus: 'Accepted', component, variable };
        }),
      };
    },
  };
}

/** "TOTP algorithm, version 1" (OCPP 2.1 C25), as the station computes it. */
export function stationTotp(values: Record<string, string>, atMs: number = Date.now()): string {
  const validity = Number(values['ValidityTime']);
  const length = Number(values['Length']);
  const interval = BigInt(Math.floor(atMs / 1000 / validity));
  const timeBytes = Buffer.alloc(8);
  timeBytes.writeBigUInt64BE(interval);
  const hash = createHmac('sha256', Buffer.from(values['SharedSecret'] ?? '', 'utf8'))
    .update(timeBytes)
    .digest();
  const offset = (hash[hash.length - 1] ?? 0) & 0x0f;
  let totp = '';
  for (let i = 0; i < length; i++) {
    totp += BASE62.charAt((hash[(offset + i) % hash.length] ?? 0) % BASE62.length);
  }
  return totp;
}

export interface QrUrlParts {
  /** Omit to leave the {chargingstationid} placeholder out of the URL. */
  chargingStationId?: string;
  evseId: number;
  totp: string;
  version: string;
  query?: string;
}

/** Fills WebPaymentsCtrlr.URLTemplate. An omitted part removes its path segment. */
export function buildQrUrl(template: string, parts: QrUrlParts): string {
  const url = template
    .replace(
      parts.chargingStationId != null ? '{chargingstationid}' : '{chargingstationid}/',
      parts.chargingStationId != null ? encodeURIComponent(parts.chargingStationId) : '',
    )
    .replace('{evse}', String(parts.evseId))
    .replace('{totp}', encodeURIComponent(parts.totp))
    .replace('{version}', encodeURIComponent(parts.version));
  return parts.query != null ? `${url}?${parts.query}` : url;
}

/**
 * Has the CSMS configure dynamic QR codes on the test station (the operator
 * action behind "CSMS configured for central cost calculation" with a QR base
 * URL). The test's incoming call handler must pass SetVariables to
 * `capture.handle`. Returns an error description, or null on success.
 */
export async function enableDynamicQr(
  ctx: TestContext,
  capture: WebPaymentsCapture,
  settings: { validitySeconds: number; totpLength: number } = {
    validitySeconds: 60,
    totpLength: 8,
  },
): Promise<string | null> {
  if (ctx.callApi == null || ctx.stationDbId == null) return 'API client not available';
  if (!(await waitForOnline(ctx))) {
    return `Station not online in the CSMS within ${String(CSMS_STATE_TIMEOUT_MS / 1000)} s`;
  }
  const res = await ctx.callApi('PUT', `/stations/${ctx.stationDbId}/web-payments`, settings);
  if (res.status !== 200) {
    const code = typeof res.body['code'] === 'string' ? res.body['code'] : '';
    return `HTTP ${String(res.status)} ${code}`;
  }
  if (capture.values['SharedSecret'] == null || capture.values['URLTemplate'] == null) {
    return 'WebPaymentsCtrlr SharedSecret or URLTemplate not set';
  }
  return null;
}

/**
 * The EV driver opens the QR code URL: the portal asks the CSMS to decode it and
 * check its one-time password (C25.FR.07-09).
 */
export async function visitQrUrl(
  ctx: TestContext,
  url: string,
): Promise<{ valid: boolean; reason?: string; stationId?: string; evseId?: number } | string> {
  if (ctx.callApi == null) return 'API client not available';
  const res = await ctx.callApi('POST', '/portal/guest/qr/validate', { url });
  if (res.status !== 200) return `HTTP ${String(res.status)}`;
  return res.body as { valid: boolean; reason?: string; stationId?: string; evseId?: number };
}

/**
 * TC_C_132 / TC_C_133: the CSMS configures dynamic QR codes, the EV driver
 * opens an invalid QR code URL, and the CSMS must refuse it (no payment page)
 * and send no RequestStartTransaction.
 */
export async function runInvalidQrTest(
  ctx: TestContext,
  description: string,
  parts: (values: Record<string, string>) => QrUrlParts,
): Promise<TestResult> {
  const steps: StepResult[] = [];

  const bootRes = await ctx.client.sendCall('BootNotification', {
    chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
    reason: 'PowerUp',
  });
  steps.push({
    step: 1,
    description: 'Boot station',
    status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
    expected: 'status = Accepted',
    actual: `status = ${String(bootRes['status'])}`,
  });
  await ctx.client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Available',
    evseId: 1,
    connectorId: 1,
  });

  const seen = { requestStart: false };
  const capture = captureWebPayments();
  ctx.client.setIncomingCallHandler((_messageId, action, payload) => {
    const setVariables = capture.handle(action, payload);
    if (setVariables != null) return Promise.resolve(setVariables);
    if (action === 'RequestStartTransaction') {
      seen.requestStart = true;
      return Promise.resolve({ status: 'Accepted' });
    }
    return defaultReply('ocpp2.1', action, payload);
  });

  // Prerequisite: the CSMS configured the station's dynamic QR code.
  const configError = await enableDynamicQr(ctx, capture);
  steps.push({
    step: 2,
    description: 'CSMS configures WebPaymentsCtrlr (URLTemplate, TOTP, SharedSecret)',
    status: configError == null ? 'passed' : 'failed',
    expected: 'SetVariables WebPaymentsCtrlr accepted',
    actual: configError ?? `URLTemplate = ${String(capture.values['URLTemplate'])}`,
  });
  if (configError != null) return { status: 'failed', durationMs: 0, steps };

  // The QR code names EVSE 1: the CSMS must know it, or every URL is refused
  // as unknown_evse and the check below would pass for the wrong reason.
  const evseError = await waitForEvse(ctx, 1);
  if (evseError != null) {
    steps.push({
      step: 3,
      description: `CSMS refuses the ${description} and shows no payment page`,
      status: 'failed',
      expected: 'EVSE 1 known to the CSMS',
      actual: evseError,
    });
    return { status: 'failed', durationMs: 0, steps };
  }

  // Manual Action: the EV driver opens the invalid QR code URL.
  const url = buildQrUrl(capture.values['URLTemplate'] ?? '', parts(capture.values));
  const visit = await visitQrUrl(ctx, url);
  steps.push({
    step: 3,
    description: `CSMS refuses the ${description} and shows no payment page`,
    status: typeof visit !== 'string' && !visit.valid ? 'passed' : 'failed',
    expected: 'QR code not valid',
    actual: typeof visit === 'string' ? visit : `${url}: ${JSON.stringify(visit)}`,
  });

  // Step 1 of the scenario: the CSMS does NOT send RequestStartTransaction.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  steps.push({
    step: 4,
    description: 'CSMS does not send RequestStartTransaction',
    status: !seen.requestStart ? 'passed' : 'failed',
    expected: 'No RequestStartTransaction received',
    actual: seen.requestStart
      ? 'RequestStartTransaction received'
      : 'No RequestStartTransaction received',
  });

  const allPassed = steps.every((s) => s.status === 'passed');
  return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
}
