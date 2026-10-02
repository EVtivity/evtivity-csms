// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buildQrUrl, captureWebPayments, stationTotp } from '../qr-test-helpers.js';

const TEMPLATE = 'http://localhost:7101/qr/{chargingstationid}/{evse}/{totp}/{version}';

describe('QR test helpers', () => {
  it('records WebPaymentsCtrlr values and accepts every SetVariables item', () => {
    const capture = captureWebPayments();
    const response = capture.handle('SetVariables', {
      setVariableData: [
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'SharedSecret' },
          attributeValue: 'secret-1',
        },
        { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'X' }, attributeValue: '1' },
      ],
    });
    expect(capture.values).toEqual({ SharedSecret: 'secret-1' });
    expect(response).toEqual({
      setVariableResult: [
        {
          attributeStatus: 'Accepted',
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'SharedSecret' },
        },
        {
          attributeStatus: 'Accepted',
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'X' },
        },
      ],
    });
    expect(capture.handle('Reset', {})).toBeNull();
  });

  it('computes the TOTP v1 of the OCPP 2.1 C25 algorithm', () => {
    const values = { SharedSecret: 'MySharedSecret', ValidityTime: '30', Length: '8' };
    expect(stationTotp(values, 59_000_000 * 30 * 1000)).toBe('5AViTp52');
  });

  it('fills the URL template and drops an omitted charging station identity', () => {
    expect(
      buildQrUrl(TEMPLATE, {
        chargingStationId: 'CS 1',
        evseId: 1,
        totp: 'abc',
        version: 'v1',
        query: 'maxenergy=20000',
      }),
    ).toBe('http://localhost:7101/qr/CS%201/1/abc/v1?maxenergy=20000');
    expect(buildQrUrl(TEMPLATE, { evseId: 1, totp: 'abc', version: 'v1' })).toBe(
      'http://localhost:7101/qr/1/abc/v1',
    );
  });
});
