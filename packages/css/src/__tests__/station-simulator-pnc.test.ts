// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { liveHarness, silenceConsole, type Harness } from './sim-harness.js';

const contract = {
  emaid: 'NLEVSC12345678',
  certificate: Buffer.from('leaf'),
  subCertificates: [],
  privateKey: {} as never,
};
const hashData = [
  {
    hashAlgorithm: 'SHA256',
    issuerNameHash: 'aa',
    issuerKeyHash: 'bb',
    serialNumber: '1F',
    responderURL: '',
  },
];
const checks = vi.hoisted(() => ({
  iso2: vi.fn(),
  iso20: vi.fn(),
}));

vi.mock('../lib/iso15118-test-ev.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/iso15118-test-ev.js')>();
  return {
    ...actual,
    checkIso2Response: checks.iso2,
    checkIso20Response: checks.iso20,
    contractCertificateHashData: vi.fn(() => hashData),
  };
});

function txEvents(h: Harness, type: string): Array<Record<string, unknown>> {
  return h.sent('TransactionEvent').filter((e) => e['eventType'] === type);
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
  checks.iso2.mockReturnValue({ ok: true, contract, remaining: null });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Plug and Charge actions', () => {
  it('creates an EV with a PCID and the OEM root PEM', async () => {
    const h = await liveHarness('ocpp2.1');
    const ev = await h.sim.createPncEv(1);
    expect(ev.pcid).toMatch(/^EVSIM[0-9A-Z]{13}$/);
    expect(ev.oemRootCertificate).toContain('BEGIN CERTIFICATE');
    expect(ev.edition).toBe(2);
  });

  it('installs a contract through Get15118EVCertificate and starts with the eMAID', async () => {
    const h = await liveHarness('ocpp2.1', (action) =>
      action === 'Get15118EVCertificate' ? { status: 'Accepted', exiResponse: 'EXI' } : undefined,
    );
    await h.sim.createPncEv(1);
    expect(await h.sim.installPncContract(1)).toEqual({
      emaid: contract.emaid,
      remainingContracts: null,
    });
    const request = h.sent('Get15118EVCertificate')[0];
    expect(request).toMatchObject({
      action: 'Install',
      iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef',
    });
    expect(typeof request?.['exiRequest']).toBe('string');

    await h.sim.plugIn(1);
    const txId = await h.sim.startPncCharging(1);
    expect(h.sent('Authorize').at(-1)).toEqual({
      idToken: { idToken: contract.emaid, type: 'eMAID' },
      iso15118CertificateHashData: hashData,
    });
    const started = txEvents(h, 'Started')[0];
    expect(started?.['idToken']).toEqual({ idToken: contract.emaid, type: 'eMAID' });
    expect(await h.sim.startPncCharging(1)).toBe(txId);
  });

  it('refuses a rejected installation, a refused contract and a rejected authorization', async () => {
    let installStatus = 'Failed';
    const h = await liveHarness('ocpp2.1', (action) => {
      if (action === 'Get15118EVCertificate') return { status: installStatus, exiResponse: 'EXI' };
      if (action === 'Authorize') return { idTokenInfo: { status: 'Invalid' } };
      return undefined;
    });
    await expect(h.sim.installPncContract(1)).rejects.toThrow(/create one first/);
    await h.sim.createPncEv(1);
    await expect(h.sim.installPncContract(1)).rejects.toThrow(/not accepted/);
    installStatus = 'Accepted';
    checks.iso2.mockReturnValueOnce({ ok: false, reason: 'CPS signature invalid' });
    await expect(h.sim.installPncContract(1)).rejects.toThrow(/CPS signature/);
    await expect(h.sim.startPncCharging(1)).rejects.toThrow(/install one first/);
    await h.sim.installPncContract(1);
    await expect(h.sim.startPncCharging(1)).rejects.toThrow(/cable/);
    await h.sim.plugIn(1);
    await expect(h.sim.startPncCharging(1)).rejects.toThrow(/Invalid/);
    expect(txEvents(h, 'Started')).toHaveLength(0);
  });

  it('is OCPP 2.1 only', async () => {
    const h = await liveHarness('ocpp1.6');
    await expect(h.sim.createPncEv(1)).rejects.toThrow(/2\.1/);
  });
});
