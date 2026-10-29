// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  cardBin,
  cardLast4,
  looksLikePan,
  PaymentTerminalRegistry,
  redactPanRuns,
  type TerminalProviderSettings,
} from '../index.js';

const IDTECH: TerminalProviderSettings['idtech'] = {
  enabled: true,
  environment: 'sandbox',
  merchantId: 'm',
  apiKey: 'k',
  apiSecret: 's',
  webhookSecret: 'w',
};

function registry(
  idtech: TerminalProviderSettings['idtech'],
  opts: { allowSimulated?: boolean; allowUnverified?: boolean } = {},
): PaymentTerminalRegistry {
  return new PaymentTerminalRegistry({
    readSettings: () => Promise.resolve({ idtech }),
    encryptionKey: 'x'.repeat(32),
    allowSimulated: opts.allowSimulated ?? false,
    allowUnverified: opts.allowUnverified ?? false,
  });
}

describe('PaymentTerminalRegistry', () => {
  it('builds the simulated provider only where it is allowed', async () => {
    expect(await registry(IDTECH).getProvider('simulated')).toBeNull();
    expect((await registry(IDTECH, { allowSimulated: true }).getProvider('simulated'))?.id).toBe(
      'simulated',
    );
  });

  it('never builds ID TECH outside development and test while the contract is unverified', async () => {
    expect(await registry(IDTECH).getProvider('idtech')).toBeNull();
    expect((await registry(IDTECH, { allowUnverified: true }).getProvider('idtech'))?.id).toBe(
      'idtech',
    );
  });

  it('needs every credential and the switch', async () => {
    for (const missing of ['merchantId', 'apiKey', 'apiSecret', 'webhookSecret'] as const) {
      expect(
        await registry({ ...IDTECH, [missing]: '' }, { allowUnverified: true }).getProvider(
          'idtech',
        ),
      ).toBeNull();
    }
    expect(
      await registry({ ...IDTECH, enabled: false }, { allowUnverified: true }).getProvider(
        'idtech',
      ),
    ).toBeNull();
    await expect(
      registry({ ...IDTECH, enabled: false }).requireProvider('idtech'),
    ).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });

  it('rebuilds the adapter when the settings change', async () => {
    let settings = IDTECH;
    const reg = new PaymentTerminalRegistry({
      readSettings: () => Promise.resolve({ idtech: settings }),
      encryptionKey: 'x'.repeat(32),
      allowSimulated: true,
      allowUnverified: true,
    });
    const first = await reg.getProvider('idtech');
    expect(await reg.getProvider('idtech')).toBe(first);
    settings = { ...IDTECH, apiKey: 'rotated' };
    expect(await reg.getProvider('idtech')).not.toBe(first);
    expect(await reg.availableProviders()).toEqual(['simulated', 'idtech']);
  });
});

describe('card fields', () => {
  it('keeps exactly 4 and 6 digits and spots PAN-shaped runs', () => {
    expect(cardLast4('4242')).toBe('4242');
    expect(cardLast4('42424')).toBeNull();
    expect(cardBin('424242')).toBe('424242');
    expect(cardBin(424242)).toBeNull();
    expect(looksLikePan('4242 4242 4242 4242')).toBe(true);
    expect(looksLikePan('ref 12345')).toBe(false);
    expect(redactPanRuns('pan=4242-4242-4242-4242 ok')).toBe('pan=[redacted] ok');
  });
});
