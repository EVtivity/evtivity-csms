// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Signing fields of a secure firmware update (OCPP 2.1 L01, 1.6 Security
 * Whitepaper SignedUpdateFirmware). The CSMS sends the Firmware Signing
 * certificate (L01.FR.11) and the firmware signature with the download URL.
 * Browser-safe, so the CSMS imports it via `@evtivity/lib/firmware-signature`.
 */

/** FirmwareType.signingCertificate maxLength (2.1 and 1.6). */
export const FIRMWARE_SIGNING_CERTIFICATE_MAX_LENGTH = 5500;
/** FirmwareType.signature maxLength (2.1 and 1.6). */
export const FIRMWARE_SIGNATURE_MAX_LENGTH = 800;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PEM_CERTIFICATE_PATTERN =
  /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END CERTIFICATE-----\s*$/;

/** True for a non-empty, padded base64 string. */
export function isBase64(value: string): boolean {
  return value.length > 0 && BASE64_PATTERN.test(value);
}

/** True for one PEM encoded certificate: BEGIN/END CERTIFICATE around a base64 body. */
export function isPemCertificate(value: string): boolean {
  const match = PEM_CERTIFICATE_PATTERN.exec(value.trim());
  const body = match?.[1];
  if (body == null) return false;
  return isBase64(body.replace(/\r?\n/g, ''));
}

export type FirmwareSignatureError =
  | 'incomplete'
  | 'invalidCertificate'
  | 'certificateTooLong'
  | 'invalidSignature'
  | 'signatureTooLong';

/**
 * Checks the signing fields of a firmware update. Both are given or both are
 * empty (an unsigned update). Returns null when valid.
 */
export function validateFirmwareSignature(
  signingCertificate: string | null | undefined,
  signature: string | null | undefined,
): FirmwareSignatureError | null {
  const certificate = signingCertificate ?? '';
  const sig = signature ?? '';
  if (certificate === '' && sig === '') return null;
  if (certificate === '' || sig === '') return 'incomplete';
  if (certificate.length > FIRMWARE_SIGNING_CERTIFICATE_MAX_LENGTH) return 'certificateTooLong';
  if (!isPemCertificate(certificate)) return 'invalidCertificate';
  if (sig.length > FIRMWARE_SIGNATURE_MAX_LENGTH) return 'signatureTooLong';
  if (!isBase64(sig)) return 'invalidSignature';
  return null;
}
