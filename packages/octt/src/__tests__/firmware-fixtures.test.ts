// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { X509Certificate } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  BROKEN_FIRMWARE_SIGNATURE,
  EXPIRED_FIRMWARE_SIGNING_CERTIFICATE,
  FIRMWARE_SIGNATURE,
  FIRMWARE_SIGNING_CERTIFICATE,
  INVALID_FIRMWARE_SIGNATURE,
} from '../firmware-fixtures.js';

// The secure firmware update tests send the fixtures through the CSMS routes,
// which accept a PEM certificate that parses as X.509 (at most 5500 characters)
// and a padded base64 signature (at most 800 characters).
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

describe('firmware fixtures', () => {
  it('signing certificates are PEM X.509 certificates', () => {
    for (const pem of [FIRMWARE_SIGNING_CERTIFICATE, EXPIRED_FIRMWARE_SIGNING_CERTIFICATE]) {
      expect(pem.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);
      expect(() => new X509Certificate(pem)).not.toThrow();
      expect(pem.length).toBeLessThanOrEqual(5500);
    }
  });

  it('signatures are base64', () => {
    for (const sig of [FIRMWARE_SIGNATURE, BROKEN_FIRMWARE_SIGNATURE, INVALID_FIRMWARE_SIGNATURE]) {
      expect(BASE64.test(sig)).toBe(true);
      expect(sig.length).toBeLessThanOrEqual(800);
    }
  });
});
