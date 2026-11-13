// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

// The module reads the signed-in user's permissions; the auth store reads the theme.
vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
import {
  TERMINAL_TXN_STATES,
  terminalName,
  terminalPairingLabel,
  terminalProviderName,
  txnStateLabel,
  txnStateVariant,
  type PaymentTerminal,
} from '../payment-terminal-types';

// Echoes the key and its options, so the test sees which text was asked for.
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts == null ? key : `${key}:${JSON.stringify(opts)}`) as unknown as TFunction;

function terminal(over: Partial<PaymentTerminal> = {}): PaymentTerminal {
  return {
    id: 'trm_1',
    label: null,
    provider: 'idtech',
    integrationMode: 'cloud',
    providerDeviceId: null,
    vendor: null,
    model: null,
    serialNumber: null,
    firmwareVersion: null,
    siteId: null,
    siteName: null,
    stationId: null,
    stationOcppId: null,
    evseId: null,
    evseNumber: null,
    status: 'active',
    online: null,
    lastSeenAt: null,
    statusFetchedAt: null,
    offlineSince: null,
    hasDisplay: true,
    simAttached: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('terminalProviderName', () => {
  it('names the simulated provider in the viewer language, ID TECH as is, others by their id', () => {
    expect(terminalProviderName(t, 'simulated')).toBe('paymentTerminals.providers.simulated');
    expect(terminalProviderName(t, 'idtech')).toBe('ID TECH');
    expect(terminalProviderName(t, 'acme')).toBe('acme');
  });
});

describe('terminalName', () => {
  it('takes the label, else the serial number, else the device ID, else Unnamed', () => {
    expect(
      terminalName(terminal({ label: 'Bay 1', serialNumber: 'S1', providerDeviceId: 'd' }), t),
    ).toBe('Bay 1');
    expect(terminalName(terminal({ serialNumber: 'S1', providerDeviceId: 'd' }), t)).toBe('S1');
    expect(terminalName(terminal({ providerDeviceId: 'dev_9' }), t)).toBe('dev_9');
    expect(terminalName(terminal(), t)).toBe('common.unnamedTerminal');
  });
});

describe('terminalPairingLabel', () => {
  it('names the station and its connector, or the whole station, and nothing unpaired', () => {
    expect(terminalPairingLabel(t, terminal())).toBeNull();
    expect(
      terminalPairingLabel(
        t,
        terminal({ stationId: 'sta_1', stationOcppId: 'CS-001', evseNumber: 2 }),
      ),
    ).toBe('CS-001, paymentTerminals.connector:{"number":2}');
    expect(terminalPairingLabel(t, terminal({ stationId: 'sta_1' }))).toBe(
      'sta_1, paymentTerminals.wholeStation',
    );
  });
});

describe('transaction states', () => {
  it('colors captured green, open holds blue, waits amber, failures red and ends gray', () => {
    expect(txnStateVariant('captured')).toBe('success');
    expect(txnStateVariant('authorized')).toBe('info');
    expect(txnStateVariant('capture_requested')).toBe('info');
    for (const s of ['requested', 'presenting', 'void_requested', 'refund_pending']) {
      expect(txnStateVariant(s)).toBe('warning');
    }
    expect(txnStateVariant('declined')).toBe('destructive');
    expect(txnStateVariant('failed')).toBe('destructive');
    for (const s of ['refunded', 'partially_refunded', 'voided', 'expired']) {
      expect(txnStateVariant(s)).toBe('secondary');
    }
    expect(txnStateVariant('something_new')).toBe('outline');
  });

  it('gives every known state a color other than the unknown outline', () => {
    for (const s of TERMINAL_TXN_STATES) expect(txnStateVariant(s)).not.toBe('outline');
  });

  it('labels a known state in the viewer language and shows an unknown one as sent', () => {
    expect(txnStateLabel(t, 'captured')).toBe('paymentTerminals.txnStates.captured');
    expect(txnStateLabel(t, 'something_new')).toBe('something_new');
  });
});
