// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  OCMF_ENCODING,
  OCMF_SIGNING_METHOD,
  OcmfMeterSigner,
  parseMeterPublicKey,
  verifyOcmfSignature,
} from '../signed-meter-values.js';

const identity = {
  vendorName: 'EVtivity',
  model: 'CSS',
  serialNumber: 'SN-1',
  firmwareVersion: '1.0.0',
};

describe('OcmfMeterSigner', () => {
  it('signs a reading as OCMF that verifies with the meter public key', () => {
    const signer = new OcmfMeterSigner(identity);
    const signed = signer.sign(
      { value: 1234, measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
      '2026-10-02T10:00:00.000Z',
      'Transaction.End',
      true,
    );
    expect(signed.encodingMethod).toBe(OCMF_ENCODING);
    expect(signed.signingMethod).toBe(OCMF_SIGNING_METHOD);
    expect(signed.publicKey).toBe(signer.publicKey);
    expect(signer.publicKey.startsWith('oca:base64:asn1:')).toBe(true);
    const ocmf = Buffer.from(signed.signedMeterData, 'base64').toString('utf8');
    expect(ocmf.startsWith('OCMF|')).toBe(true);
    expect(ocmf).toContain('"TX":"E"');
    expect(ocmf).toContain('"RV":1234');
    expect(verifyOcmfSignature(signed.signedMeterData, signer.publicKey)).toBe(true);
  });

  it('sends publicKey "" when the key is not included', () => {
    const signer = new OcmfMeterSigner(identity);
    const signed = signer.sign({ value: 1 }, '2026-10-02T10:00:00.000Z', 'Sample.Periodic', false);
    expect(signed.publicKey).toBe('');
    expect(verifyOcmfSignature(signed.signedMeterData, signer.publicKey)).toBe(true);
  });

  it('rejects data signed by another meter or altered data', () => {
    const a = new OcmfMeterSigner(identity);
    const b = new OcmfMeterSigner(identity);
    const signed = a.sign({ value: 5 }, '2026-10-02T10:00:00.000Z', 'Sample.Clock', false);
    expect(verifyOcmfSignature(signed.signedMeterData, b.publicKey)).toBe(false);
    const altered = Buffer.from(
      Buffer.from(signed.signedMeterData, 'base64').toString('utf8').replace('"RV":5', '"RV":6'),
    ).toString('base64');
    expect(verifyOcmfSignature(altered, a.publicKey)).toBe(false);
  });

  it('parses base16 and bare base64 public keys', () => {
    const signer = new OcmfMeterSigner(identity);
    const b64 = signer.publicKey.split(':')[3] ?? '';
    const hex = Buffer.from(b64, 'base64').toString('hex');
    expect(parseMeterPublicKey(`oca:base16:asn1:${hex}`).asymmetricKeyType).toBe('ec');
    expect(parseMeterPublicKey(b64).asymmetricKeyType).toBe('ec');
  });
});
