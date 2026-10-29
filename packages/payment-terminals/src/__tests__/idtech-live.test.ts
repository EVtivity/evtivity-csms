// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Opt-in run of the ID TECH adapter against the real PSG sandbox. Skipped
// unless IDTECH_LIVE_API_KEY, IDTECH_LIVE_API_SECRET, IDTECH_LIVE_MERCHANT_ID
// and IDTECH_LIVE_DEVICE_ID are set. It makes the read-only calls (merchant,
// devices, device) and one test pre-auth that it voids, and prints states,
// counts and error kinds only, never a credential, a device or transaction id
// or a card value. IDTECH_LIVE_BASE_URL replaces the sandbox URL of
// contract.ts (a proxy or a renamed host).
//
// Required before IDTECH_LIVE_VERIFIED may become true (owner decision
// 2026-10-29): every assumption of contract.ts this run touches must hold.

import { describe, expect, it } from 'vitest';
import { IdtechTerminalProvider } from '../idtech/adapter.js';
import { IDTECH_BASE_URLS } from '../idtech/contract.js';
import { TerminalProviderError } from '../types.js';

const apiKey = process.env['IDTECH_LIVE_API_KEY'] ?? '';
const apiSecret = process.env['IDTECH_LIVE_API_SECRET'] ?? '';
const merchantId = process.env['IDTECH_LIVE_MERCHANT_ID'] ?? '';
const deviceId = process.env['IDTECH_LIVE_DEVICE_ID'] ?? '';
const baseUrl = process.env['IDTECH_LIVE_BASE_URL'] ?? IDTECH_BASE_URLS.sandbox;
const live = apiKey !== '' && apiSecret !== '' && merchantId !== '' && deviceId !== '';
const TIMEOUT_MS = 60_000;

function report(message: string): void {
  // States, counts and error kinds only.
  console.info(`[idtech-live] ${message}`);
}

function provider(secret = apiSecret): IdtechTerminalProvider {
  return new IdtechTerminalProvider({
    baseUrl,
    merchantId,
    apiKey,
    apiSecret: secret,
    // The live run has no webhook endpoint; verifyWebhook is not exercised.
    webhookSecret: 'unused',
    fetch: globalThis.fetch,
    timeoutMs: 15_000,
  });
}

describe.skipIf(!live)('ID TECH PSG sandbox (live)', () => {
  it(
    'accepts the credentials and refuses a wrong secret as auth',
    async () => {
      expect(await provider().testConnection()).toEqual({ ok: true });
      const wrong = await provider(`${apiSecret}x`).testConnection();
      expect(wrong).toEqual({ ok: false, reason: 'auth' });
    },
    TIMEOUT_MS,
  );

  it(
    'lists the devices with the assumed fields and reads the test device',
    async () => {
      const { devices } = await provider().listDevices();
      report(`devices: ${String(devices.length)}`);
      const device = devices.find((d) => d.providerDeviceId === deviceId);
      expect(device).toBeDefined();
      report(
        `test device: model ${device?.model ?? 'none'}, online ${String(device?.online)}, iccid ${device?.iccid != null ? 'present' : 'absent'}`,
      );
      expect(device?.online).not.toBeNull();
      const one = await provider().getDevice(deviceId);
      expect(one?.providerDeviceId).toBe(deviceId);
      expect(await provider().getDevice('psg_device_does_not_exist')).toBeNull();
    },
    TIMEOUT_MS,
  );

  it(
    'starts one test pre-auth, repeats it with the same key, reads and voids it',
    async () => {
      const p = provider();
      const reference = `live_${String(Date.now())}`;
      const input = {
        providerDeviceId: deviceId,
        amountCents: 100,
        currency: 'USD',
        reference,
        timeoutSeconds: 30,
        evseChoices: [],
        idempotencyKey: `${reference}:start`,
      };
      let ref: string | null = null;
      try {
        const started = await p.startPayment(input);
        ref = started.providerTxnRef;
        report(`pre-auth state: ${started.state}`);
        expect(['presenting', 'authorized', 'declined']).toContain(started.state);
        const repeat = await p.startPayment(input);
        expect(repeat.providerTxnRef).toBe(ref);
        const read = await p.getTransaction(ref);
        expect(read?.providerTxnRef).toBe(ref);
        if (read?.state === 'presenting' || read?.state === 'authorized') {
          const voided = await p.void(ref, `${reference}:void`);
          report(`void state: ${voided.state}`);
          expect(voided.state).toBe('voided');
        }
        ref = null;
      } finally {
        if (ref != null) {
          // A hold this run could not void must be released by hand.
          await p.void(ref, `${reference}:void-final`).catch((err: unknown) => {
            report(
              `final void failed: ${err instanceof TerminalProviderError ? err.kind : 'unknown error'}`,
            );
          });
        }
      }
    },
    TIMEOUT_MS,
  );
});
