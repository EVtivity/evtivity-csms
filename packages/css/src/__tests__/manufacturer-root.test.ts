// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import {
  CSS_MANUFACTURER_ROOT_CA_PEM,
  FIRMWARE_IMAGE_FORMAT,
  parseFirmwareImage,
} from '../lib/manufacturer-root.js';
import { isSelfSigned } from '../lib/station-pki.js';

describe('factory manufacturer root', () => {
  it('is a self-signed CA certificate', () => {
    const cert = new X509Certificate(CSS_MANUFACTURER_ROOT_CA_PEM);
    expect(cert.ca).toBe(true);
    expect(isSelfSigned(cert)).toBe(true);
  });
});

describe('parseFirmwareImage', () => {
  const image = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

  it('accepts a simulator firmware image', () => {
    expect(parseFirmwareImage(image({ format: FIRMWARE_IMAGE_FORMAT, version: '2.0.0' }))).toEqual({
      version: '2.0.0',
    });
  });

  it('rejects a broken build, another format, a missing version, and non-JSON data', () => {
    expect(
      parseFirmwareImage(image({ format: FIRMWARE_IMAGE_FORMAT, version: '2', image: null })),
    ).toBeNull();
    expect(parseFirmwareImage(image({ format: 'other', version: '2' }))).toBeNull();
    expect(parseFirmwareImage(image({ format: FIRMWARE_IMAGE_FORMAT }))).toBeNull();
    expect(parseFirmwareImage(Buffer.from('not json'))).toBeNull();
  });
});
