// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time password of a dynamic QR code (OCPP 2.1 C25, "TOTP
 * algorithm, version 1"), configured in the station's WebPaymentsCtrlr
 * (SharedSecret, ValidityTime, Length, TOTPVersion "v1").
 */

export const TOTP_VERSION_V1 = 'v1';

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface TotpParameters {
  sharedSecret: string;
  /** WebPaymentsCtrlr.ValidityTime in seconds (6 to 3600). */
  validitySeconds: number;
  /** WebPaymentsCtrlr.Length (at least 6). */
  length: number;
}

/** TOTP v1 for one time interval (floor of Unix seconds / ValidityTime). */
export function totpV1ForInterval(params: TotpParameters, interval: bigint): string {
  const timeBytes = Buffer.alloc(8);
  timeBytes.writeBigUInt64BE(interval);
  const hash = createHmac('sha256', Buffer.from(params.sharedSecret, 'utf8'))
    .update(timeBytes)
    .digest();
  const offset = (hash[hash.length - 1] ?? 0) & 0x0f;
  let totp = '';
  for (let i = 0; i < params.length; i++) {
    const byte = hash[(offset + i) % hash.length] ?? 0;
    totp += BASE62.charAt(byte % BASE62.length);
  }
  return totp;
}

function intervalAt(params: TotpParameters, atMs: number): bigint {
  return BigInt(Math.floor(atMs / 1000 / params.validitySeconds));
}

/** TOTP v1 a station shows at the given time. */
export function totpV1(params: TotpParameters, atMs: number = Date.now()): string {
  return totpV1ForInterval(params, intervalAt(params, atMs));
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Validates a TOTP from a QR code URL: it must equal the TOTP of the current,
 * previous, or next time interval, which absorbs processing delay and small
 * clock differences ("Validation of TOTP", C25.FR.07).
 */
export function verifyTotpV1(
  totp: string,
  params: TotpParameters,
  atMs: number = Date.now(),
): boolean {
  const current = intervalAt(params, atMs);
  return [current, current - 1n, current + 1n].some(
    (interval) => interval >= 0n && sameText(totp, totpV1ForInterval(params, interval)),
  );
}
