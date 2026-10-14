// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  isPnc16MessageId,
  PNC16_VENDOR_ID,
  unwrapPnc16Answer,
  unwrapPnc16Data,
  wrapPnc16,
} from '../iso15118-pnc16.js';

describe('ISO 15118 Plug and Charge DataTransfer for OCPP 1.6', () => {
  it('wraps a message with the fixed vendorId and the message as JSON (note 2.2)', () => {
    expect(PNC16_VENDOR_ID).toBe('org.openchargealliance.iso15118pnc');
    expect(wrapPnc16('SignCertificate', { csr: 'PEM' })).toEqual({
      vendorId: 'org.openchargealliance.iso15118pnc',
      messageId: 'SignCertificate',
      data: '{"csr":"PEM"}',
    });
  });

  it('knows the nine messageIds of the note', () => {
    for (const id of [
      'Authorize',
      'CertificateSigned',
      'DeleteCertificate',
      'Get15118EVCertificate',
      'GetCertificateStatus',
      'GetInstalledCertificateIds',
      'InstallCertificate',
      'SignCertificate',
      'TriggerMessage',
    ]) {
      expect(isPnc16MessageId(id)).toBe(true);
    }
    expect(isPnc16MessageId('Heartbeat')).toBe(false);
    expect(isPnc16MessageId(undefined)).toBe(false);
  });

  it('unwraps only a JSON object and only from an accepted answer', () => {
    expect(unwrapPnc16Data('{"status":"Accepted"}')).toEqual({ status: 'Accepted' });
    expect(unwrapPnc16Data('[1]')).toBeNull();
    expect(unwrapPnc16Data('nope')).toBeNull();
    expect(unwrapPnc16Data(undefined)).toBeNull();
    expect(unwrapPnc16Answer({ status: 'Accepted', data: '{"status":"Rejected"}' })).toEqual({
      status: 'Rejected',
    });
    expect(
      unwrapPnc16Answer({ status: 'UnknownVendorId', data: '{"status":"Accepted"}' }),
    ).toBeNull();
  });
});
