// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Factory-installed ManufacturerRootCertificate of the simulated charging
 * station (EC P-256, valid 2026-2056). Firmware signing certificates must chain
 * to it (OCPP 2.1 L01 secure firmware update). The CA private key is not kept;
 * the OCTT firmware fixtures hold a signing certificate it issued and
 * firmware images signed with that certificate's key.
 */
export const CSS_MANUFACTURER_ROOT_CA_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIB2TCCAYCgAwIBAgIQAXiMh4U53WORKRM7bnROqjAKBggqhkjOPQQDAjBMMQsw\nCQYDVQQGEwJVUzERMA8GA1UEChMIRVZ0aXZpdHkxKjAoBgNVBAMTIUVWdGl2aXR5\nIENTUyBNYW51ZmFjdHVyZXIgUm9vdCBDQTAgFw0yNjAxMDEwMDAwMDBaGA8yMDU2\nMDEwMTAwMDAwMFowTDELMAkGA1UEBhMCVVMxETAPBgNVBAoTCEVWdGl2aXR5MSow\nKAYDVQQDEyFFVnRpdml0eSBDU1MgTWFudWZhY3R1cmVyIFJvb3QgQ0EwWTATBgcq\nhkjOPQIBBggqhkjOPQMBBwNCAASj1Rzqf2Hyai8vwNhUEfbAE3bDJhjKyfEl3cZZ\nLUxfwV4bqijnZZ/A2O8dxchF5Glnnx0LEnzMgY1of8n7v4wco0IwQDAPBgNVHRMB\nAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUGlCZuRvnr4BoiTqQ\n5kkGAbP6vdswCgYIKoZIzj0EAwIDRwAwRAIgQB76SRJg6afjZVk9aBvVH72a57m5\nHWJ73O4XaHlnPoICIAvBiSqR7SwIZYNlUrusMU/Z2whCG4pFv0WOgu5iLa5l\n-----END CERTIFICATE-----';

/** A simulator firmware image: JSON `{ format: 'evtivity-css-firmware', version, ... }`. */
export interface FirmwareImage {
  version: string;
}

export const FIRMWARE_IMAGE_FORMAT = 'evtivity-css-firmware';

/**
 * Installation verification of a downloaded firmware image (L01). Returns the
 * image when it is a simulator firmware image with a version, or null when it
 * fails verification (InstallVerificationFailed). `image: null` marks a broken
 * build.
 */
export function parseFirmwareImage(data: Buffer): FirmwareImage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const image = parsed as Record<string, unknown>;
  if (image['format'] !== FIRMWARE_IMAGE_FORMAT) return null;
  const version = image['version'];
  if (typeof version !== 'string' || version === '') return null;
  if ('image' in image && image['image'] == null) return null;
  return { version };
}
