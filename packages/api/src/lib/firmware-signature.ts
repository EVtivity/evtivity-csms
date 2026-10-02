// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import {
  FIRMWARE_SIGNATURE_MAX_LENGTH,
  FIRMWARE_SIGNING_CERTIFICATE_MAX_LENGTH,
  ValidationError,
  validateFirmwareSignature,
} from '@evtivity/lib';
import type { FirmwareSignatureError } from '@evtivity/lib';

/** Request body field: the Firmware Signing certificate of a secure firmware update. */
export const firmwareSigningCertificateField = z
  .string()
  .max(FIRMWARE_SIGNING_CERTIFICATE_MAX_LENGTH)
  .describe(
    'PEM encoded X.509 Firmware Signing certificate the firmware was signed with (OCPP 2.1 L01.FR.11). Set together with signature.',
  );

/** Request body field: the firmware signature of a secure firmware update. */
export const firmwareSignatureField = z
  .string()
  .max(FIRMWARE_SIGNATURE_MAX_LENGTH)
  .describe(
    'Base64 encoded firmware signature the station verifies with the signing certificate. Set together with signingCertificate.',
  );

const MESSAGES: Record<FirmwareSignatureError, string> = {
  incomplete: 'signingCertificate and signature must be set together',
  invalidCertificate: 'signingCertificate is not a PEM encoded X.509 certificate',
  certificateTooLong: `signingCertificate exceeds ${String(FIRMWARE_SIGNING_CERTIFICATE_MAX_LENGTH)} characters`,
  invalidSignature: 'signature is not base64 encoded',
  signatureTooLong: `signature exceeds ${String(FIRMWARE_SIGNATURE_MAX_LENGTH)} characters`,
};

/**
 * Validates the signing fields of a firmware update: both or neither, a PEM
 * certificate that parses as X.509, and a base64 signature. Throws a 400
 * VALIDATION_ERROR naming the failing field.
 */
export function assertFirmwareSignature(
  signingCertificate: string | null | undefined,
  signature: string | null | undefined,
): void {
  let error = validateFirmwareSignature(signingCertificate, signature);
  if (error == null && signingCertificate != null && signingCertificate !== '') {
    try {
      new X509Certificate(signingCertificate);
    } catch {
      error = 'invalidCertificate';
    }
  }
  if (error != null) throw new ValidationError(MESSAGES[error]);
}
