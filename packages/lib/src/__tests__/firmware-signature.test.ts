// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  FIRMWARE_SIGNATURE_MAX_LENGTH,
  isBase64,
  isPemCertificate,
  validateFirmwareSignature,
} from '../firmware-signature.js';

const PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBszCCAVmgAwIBAgIUQ2Vy',
  'dGlmaWNhdGVib2R5PT0=',
  '-----END CERTIFICATE-----',
].join('\n');

describe('isBase64', () => {
  it('accepts padded base64', () => {
    expect(isBase64('c2lnbmF0dXJl')).toBe(true);
    expect(isBase64('c2lnbg==')).toBe(true);
    expect(isBase64('c2lnbmE=')).toBe(true);
  });

  it('rejects empty, unpadded, and non-base64 values', () => {
    expect(isBase64('')).toBe(false);
    expect(isBase64('c2lnb')).toBe(false);
    expect(isBase64('not base64!')).toBe(false);
  });
});

describe('isPemCertificate', () => {
  it('accepts one PEM certificate, with LF or CRLF line ends', () => {
    expect(isPemCertificate(PEM)).toBe(true);
    expect(isPemCertificate(PEM.replace(/\n/g, '\r\n'))).toBe(true);
    expect(isPemCertificate(`\n${PEM}\n`)).toBe(true);
  });

  it('rejects other PEM types and malformed bodies', () => {
    expect(isPemCertificate(PEM.replace(/CERTIFICATE/g, 'PRIVATE KEY'))).toBe(false);
    expect(isPemCertificate(PEM.replace('MIIBszCC', 'MIIB!zCC'))).toBe(false);
    expect(isPemCertificate('MIIBszCCAVmgAwIBAgIU')).toBe(false);
    expect(isPemCertificate('-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----')).toBe(false);
  });
});

describe('validateFirmwareSignature', () => {
  it('accepts an unsigned update and a complete signed one', () => {
    expect(validateFirmwareSignature(undefined, undefined)).toBeNull();
    expect(validateFirmwareSignature('', null)).toBeNull();
    expect(validateFirmwareSignature(PEM, 'c2lnbmF0dXJl')).toBeNull();
  });

  it('requires both fields together', () => {
    expect(validateFirmwareSignature(PEM, '')).toBe('incomplete');
    expect(validateFirmwareSignature(null, 'c2lnbmF0dXJl')).toBe('incomplete');
  });

  it('reports the invalid field', () => {
    expect(validateFirmwareSignature('not a certificate', 'c2lnbmF0dXJl')).toBe(
      'invalidCertificate',
    );
    expect(validateFirmwareSignature(PEM, 'not base64!')).toBe('invalidSignature');
    expect(validateFirmwareSignature(PEM, 'A'.repeat(FIRMWARE_SIGNATURE_MAX_LENGTH + 4))).toBe(
      'signatureTooLong',
    );
    expect(validateFirmwareSignature(`${PEM}${' '.repeat(5500)}`, 'c2lnbmF0dXJl')).toBe(
      'certificateTooLong',
    );
  });
});
