// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { offeredSubprotocols, selectOcppSubprotocol } from '../server/subprotocol.js';

describe('selectOcppSubprotocol', () => {
  it('prefers OCPP 2.1 over 1.6', () => {
    expect(selectOcppSubprotocol(new Set(['ocpp1.6', 'ocpp2.1']))).toBe('ocpp2.1');
  });

  it('selects OCPP 1.6 when 2.1 is not offered', () => {
    expect(selectOcppSubprotocol(new Set(['ocpp1.6']))).toBe('ocpp1.6');
  });

  it('selects nothing for unsupported subprotocols', () => {
    expect(selectOcppSubprotocol(new Set(['ocpp2.0.1']))).toBeNull();
    expect(selectOcppSubprotocol(new Set())).toBeNull();
  });
});

describe('offeredSubprotocols', () => {
  it('splits a comma-separated header and trims each token', () => {
    expect(offeredSubprotocols('ocpp1.6, ocpp2.1 ,')).toEqual(new Set(['ocpp1.6', 'ocpp2.1']));
  });

  it('reads repeated header values', () => {
    expect(offeredSubprotocols(['ocpp1.6', 'ocpp2.1'])).toEqual(new Set(['ocpp1.6', 'ocpp2.1']));
  });

  it('is empty without the header', () => {
    expect(offeredSubprotocols(undefined)).toEqual(new Set());
  });
});
