// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  offeredSubprotocols,
  selectOcppSubprotocol,
  subprotocolsForLog,
} from '../server/subprotocol.js';

describe('selectOcppSubprotocol', () => {
  it('prefers OCPP 2.1 over 1.6', () => {
    expect(selectOcppSubprotocol(new Set(['ocpp1.6', 'ocpp2.1']))).toBe('ocpp2.1');
  });

  it('selects OCPP 1.6 when 2.1 is not offered', () => {
    expect(selectOcppSubprotocol(new Set(['ocpp1.6']))).toBe('ocpp1.6');
  });

  it('prefers 2.1, then 2.0.1, then 1.6', () => {
    expect(selectOcppSubprotocol(new Set(['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1']))).toBe('ocpp2.1');
    expect(selectOcppSubprotocol(new Set(['ocpp1.6', 'ocpp2.0.1']))).toBe('ocpp2.0.1');
    expect(selectOcppSubprotocol(new Set(['ocpp2.0.1']))).toBe('ocpp2.0.1');
  });

  it('selects nothing for unsupported subprotocols', () => {
    expect(selectOcppSubprotocol(new Set(['ocpp2.0', 'ocpp1.5']))).toBeNull();
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

describe('subprotocolsForLog', () => {
  it('keeps short offers as they are', () => {
    expect(subprotocolsForLog(new Set(['ocpp2.0', 'mqtt']))).toEqual(['ocpp2.0', 'mqtt']);
  });

  it('logs at most 5 entries of at most 32 characters', () => {
    const long = 'x'.repeat(5000);
    const offered = offeredSubprotocols(
      [long, ...Array.from({ length: 200 }, (_, i) => `proto${String(i)}`)].join(','),
    );

    const logged = subprotocolsForLog(offered);

    expect(logged).toEqual(['x'.repeat(32), 'proto0', 'proto1', 'proto2', 'proto3']);
  });
});
