// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { assertFirmwareSignature } from '../lib/firmware-signature.js';

// Real self-signed test PEM so the X509Certificate check accepts it.
const FIRMWARE_SIGNING_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDYTCCAkmgAwIBAgIUTRwcMo/cq2a8TDMda6I+GpAzyJQwDQYJKoZIhvcNAQEL
BQAwQDELMAkGA1UEBhMCVVMxFjAUBgNVBAoMDUVWdGl2aXR5IFRlc3QxGTAXBgNV
BAMMEEVWdGl2aXR5IFRlc3QgQ0EwHhcNMjYwMjIxMTgxNjEzWhcNMzYwMjE5MTgx
NjEzWjBAMQswCQYDVQQGEwJVUzEWMBQGA1UECgwNRVZ0aXZpdHkgVGVzdDEZMBcG
A1UEAwwQRVZ0aXZpdHkgVGVzdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBANsDGoiIRlgTFls3z+pPNTFTG9lxQlXwBhlw9i/wV3yQJPdqSgxFDgp7
PHCev7IHSgP0nBBfHQ560gFjtgMP+8Pgmeqtt8RGknxZPeSMePxwuzvkf1+XYfta
Bg6QAgoChDJkdFbXlqANzE6BB685h+OKI6wDbvOqxFGReQHodBX2ENGk/c0p2BXn
I/9IydpRL5FC918ex++GE9DAf9gZHO35J12WWp5QDmmZHBGrowFLv0nTuISZ0bQw
U/vDGOVR8s/KJ4r0jyb9MuSQFJkg1VBM6j36Ge8vMrQmWoi2yZLGYYaKp+R1zN+V
8DwkbXeQRy4jiqyBYApET5txG2uGuLECAwEAAaNTMFEwHQYDVR0OBBYEFH1zUD3V
8/aR7jGSi5ptHCmMWIUDMB8GA1UdIwQYMBaAFH1zUD3V8/aR7jGSi5ptHCmMWIUD
MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBADQ2+W8418Zkytha
LIilVOLJdK+AKpWrZWRNYkb/JnEu/husUfZXaxxOUQB+/gEhh4EeFcTSWkEh2GiU
XZbZ9zXDVqKLNBgubMKRjJh7XA4uASdP2dKt7u/aerYdBGPd2Uuku6IBLVNWxHap
GYQS+sRDqF0Qhk6ZnPUUuqpEFcP7/Ib3/Bna1XC/6nitqfoF5jMPZcahQY9eOVR2
2t30h0+FJcLlHC2Sit+scgqcNsIH7dLrn/DGBqRGuNDbLr0en7Gwr1AXUOSpc8/W
43o8KYRCfMwahBKbuSBXvueAXJNpWYEPGxEcZc+sH/IqssqdzsqB8ZGZghiLh6uI
qf/5BbM=
-----END CERTIFICATE-----`;
const FIRMWARE_SIGNATURE = 'c2lnbmF0dXJlLWJ5dGVz';

describe('assertFirmwareSignature', () => {
  it('accepts a real signing certificate and a base64 signature', () => {
    expect(() => {
      assertFirmwareSignature(FIRMWARE_SIGNING_CERTIFICATE, FIRMWARE_SIGNATURE);
    }).not.toThrow();
  });

  it('accepts an unsigned update', () => {
    expect(() => {
      assertFirmwareSignature(undefined, undefined);
    }).not.toThrow();
  });

  it('rejects a PEM block that does not parse as X.509', () => {
    expect(() => {
      assertFirmwareSignature(
        '-----BEGIN CERTIFICATE-----\nTUlJQg==\n-----END CERTIFICATE-----',
        FIRMWARE_SIGNATURE,
      );
    }).toThrow('signingCertificate is not a PEM encoded X.509 certificate');
  });

  it('rejects one field without the other', () => {
    expect(() => {
      assertFirmwareSignature(FIRMWARE_SIGNING_CERTIFICATE, undefined);
    }).toThrow('signingCertificate and signature must be set together');
  });
});
