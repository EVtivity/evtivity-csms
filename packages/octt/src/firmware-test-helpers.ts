// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestContext } from './types.js';
import { FIRMWARE_SIGNATURE, FIRMWARE_SIGNING_CERTIFICATE } from './firmware-fixtures.js';
import { waitForOnline } from './security-test-helpers.js';

/** <Configured firmware_location> of the secure firmware update tests. */
export const FIRMWARE_LOCATION = 'https://example.com/fw.bin';

export interface SecureFirmwareUpdateOptions {
  requestId?: number;
  location?: string;
  retrieveDateTime?: string;
  installDateTime?: string;
}

/**
 * Performs the OCTT manual action of the secure firmware update tests (L01):
 * the operator updates the station's firmware through the CSMS route
 * (POST /v1/ocpp/commands/v21/UpdateFirmware) with the configured signing
 * certificate and signature, so the test exercises what the CSMS sends.
 * Throws when the CSMS did not send the request; a station rejection
 * (HTTP 502) means the request reached the station.
 */
export async function sendSecureFirmwareUpdate(
  ctx: TestContext,
  options: SecureFirmwareUpdateOptions = {},
): Promise<void> {
  if (ctx.callApi == null) throw new Error('API client not available');
  if (!(await waitForOnline(ctx, 10_000))) throw new Error('Station not online in the CSMS');
  const res = await ctx.callApi('POST', '/ocpp/commands/v21/UpdateFirmware', {
    stationId: ctx.stationId,
    requestId: options.requestId ?? 1,
    firmware: {
      location: options.location ?? FIRMWARE_LOCATION,
      retrieveDateTime: options.retrieveDateTime ?? new Date().toISOString(),
      ...(options.installDateTime != null ? { installDateTime: options.installDateTime } : {}),
      signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
      signature: FIRMWARE_SIGNATURE,
    },
  });
  if (res.status !== 200 && res.status !== 202 && res.status !== 502) {
    const code = typeof res.body['code'] === 'string' ? ` ${res.body['code']}` : '';
    throw new Error(`UpdateFirmware route returned HTTP ${String(res.status)}${code}`);
  }
}

/**
 * Doc validation of the UpdateFirmwareRequest of a secure firmware update:
 * firmware.signingCertificate and firmware.signature are the configured ones.
 */
export function signedFirmwareStep(
  step: number,
  payload: Record<string, unknown> | null,
): StepResult {
  const firmware = payload?.['firmware'] as Record<string, unknown> | undefined;
  const certificateOk = firmware?.['signingCertificate'] === FIRMWARE_SIGNING_CERTIFICATE;
  const signatureOk = firmware?.['signature'] === FIRMWARE_SIGNATURE;
  return {
    step,
    description: 'UpdateFirmwareRequest carries the configured signingCertificate and signature',
    status: certificateOk && signatureOk ? 'passed' : 'failed',
    expected: 'firmware.signingCertificate <Configured>, firmware.signature <Configured>',
    actual: `signingCertificate ${certificateOk ? 'matches' : 'does not match'}, signature ${signatureOk ? 'matches' : 'does not match'}`,
  };
}

/** Doc validation: a firmware dateTime field of the UpdateFirmwareRequest is in the future. */
export function futureFirmwareDateStep(
  step: number,
  payload: Record<string, unknown> | null,
  field: 'installDateTime' | 'retrieveDateTime',
  sentAt: number,
): StepResult {
  const firmware = payload?.['firmware'] as Record<string, unknown> | undefined;
  const value = firmware?.[field];
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return {
    step,
    description: `UpdateFirmwareRequest firmware.${field} is a dateTime in the future`,
    status: Number.isFinite(time) && time > sentAt ? 'passed' : 'failed',
    expected: `firmware.${field} <A dateTime in the future>`,
    actual: `firmware.${field} = ${String(value)}`,
  };
}
