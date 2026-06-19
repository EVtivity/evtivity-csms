// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

// Colocated so the relative module mocks (../config.js, ./challenge.js, ...)
// resolve against this directory, matching how index.ts imports them.
const h = vi.hoisted(() => ({
  getAttestationConfig: vi.fn(),
  consumeChallenge: vi.fn(),
  verifyAssertion: vi.fn(),
  verifyRegistration: vi.fn(),
  verifyPlayIntegrity: vi.fn(),
  decryptString: vi.fn(),
  deviceIdFromRequest: vi.fn(),
  updateWhere: vi.fn(),
  selectRows: [] as unknown[],
}));

vi.mock('@evtivity/database', () => ({
  getAttestationConfig: h.getAttestationConfig,
  mobileAttestKeys: { deviceId: {} },
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(h.selectRows) }) }),
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => {
          h.updateWhere(...args);
          return Promise.resolve(undefined);
        },
      }),
    }),
  },
}));
vi.mock('@evtivity/lib', () => ({ decryptString: h.decryptString }));
vi.mock('../config.js', () => ({ config: { SETTINGS_ENCRYPTION_KEY: 'k' } }));
vi.mock('../driver-session.js', () => ({ deviceIdFromRequest: h.deviceIdFromRequest }));
vi.mock('./challenge.js', () => ({
  consumeChallenge: h.consumeChallenge,
  issueChallenge: vi.fn(),
}));
vi.mock('./app-attest.js', () => ({
  verifyAssertion: h.verifyAssertion,
  verifyRegistration: h.verifyRegistration,
}));
vi.mock('./play-integrity.js', () => ({ verifyPlayIntegrity: h.verifyPlayIntegrity }));

import { verifyDeviceAttestation } from './index.js';

const ENABLED = {
  enabled: true,
  ios: { teamId: 'TEAM', bundleId: 'com.evtivity.driver', environment: 'development' as const },
  android: {
    cloudProjectNumber: '123',
    packageName: 'com.evtivity.driver',
    serviceAccountEnc: 'enc-blob',
  },
};

function req(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const androidHeaders = {
  'x-attest-platform': 'android',
  'x-attest-challenge': 'nonce-1',
  'x-device-attestation': 'play-token',
};
const iosHeaders = {
  'x-attest-platform': 'ios',
  'x-attest-challenge': 'nonce-1',
  'x-device-attestation': 'assertion',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.selectRows = [];
});

describe('verifyDeviceAttestation', () => {
  it('returns true and consumes nothing when attestation is disabled', async () => {
    h.getAttestationConfig.mockResolvedValue({ ...ENABLED, enabled: false });
    const ok = await verifyDeviceAttestation(req(androidHeaders));
    expect(ok).toBe(true);
    expect(h.consumeChallenge).not.toHaveBeenCalled();
  });

  it('returns false when the challenge header is missing', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    const ok = await verifyDeviceAttestation(req({ 'x-attest-platform': 'android' }));
    expect(ok).toBe(false);
    expect(h.consumeChallenge).not.toHaveBeenCalled();
  });

  it('returns false when the challenge is stale or replayed', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    h.consumeChallenge.mockResolvedValue(false);
    const ok = await verifyDeviceAttestation(req(androidHeaders));
    expect(ok).toBe(false);
    expect(h.verifyPlayIntegrity).not.toHaveBeenCalled();
  });

  it('returns false for android when the service account is not configured', async () => {
    h.getAttestationConfig.mockResolvedValue({
      ...ENABLED,
      android: { ...ENABLED.android, serviceAccountEnc: '' },
    });
    h.consumeChallenge.mockResolvedValue(true);
    const ok = await verifyDeviceAttestation(req(androidHeaders));
    expect(ok).toBe(false);
  });

  it('verifies a valid android Play Integrity token', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    h.consumeChallenge.mockResolvedValue(true);
    h.decryptString.mockReturnValue('{"type":"service_account"}');
    h.verifyPlayIntegrity.mockResolvedValue({ ok: true });
    const ok = await verifyDeviceAttestation(req(androidHeaders));
    expect(ok).toBe(true);
    expect(h.verifyPlayIntegrity).toHaveBeenCalledWith('play-token', 'nonce-1', expect.anything());
  });

  it('returns false when the android verdict is rejected', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    h.consumeChallenge.mockResolvedValue(true);
    h.decryptString.mockReturnValue('{"type":"service_account"}');
    h.verifyPlayIntegrity.mockResolvedValue({ ok: false });
    const ok = await verifyDeviceAttestation(req(androidHeaders));
    expect(ok).toBe(false);
  });

  it('returns false for ios when no device id is present', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    h.consumeChallenge.mockResolvedValue(true);
    h.deviceIdFromRequest.mockReturnValue(undefined);
    const ok = await verifyDeviceAttestation(req(iosHeaders));
    expect(ok).toBe(false);
  });

  it('returns false for ios when the device has no registered key', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    h.consumeChallenge.mockResolvedValue(true);
    h.deviceIdFromRequest.mockReturnValue('device-1');
    h.selectRows = [];
    const ok = await verifyDeviceAttestation(req(iosHeaders));
    expect(ok).toBe(false);
  });

  it('verifies a valid ios assertion and advances the signature counter', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    h.consumeChallenge.mockResolvedValue(true);
    h.deviceIdFromRequest.mockReturnValue('device-1');
    h.selectRows = [{ publicKey: 'pem', signCount: 2 }];
    h.verifyAssertion.mockReturnValue({ ok: true, newSignCount: 5 });
    const ok = await verifyDeviceAttestation(req(iosHeaders));
    expect(ok).toBe(true);
    expect(h.verifyAssertion).toHaveBeenCalledWith(
      'assertion',
      'nonce-1',
      'pem',
      2,
      expect.anything(),
    );
    expect(h.updateWhere).toHaveBeenCalledTimes(1);
  });

  it('returns false and does not advance the counter when the ios assertion fails', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    h.consumeChallenge.mockResolvedValue(true);
    h.deviceIdFromRequest.mockReturnValue('device-1');
    h.selectRows = [{ publicKey: 'pem', signCount: 2 }];
    h.verifyAssertion.mockReturnValue({ ok: false });
    const ok = await verifyDeviceAttestation(req(iosHeaders));
    expect(ok).toBe(false);
    expect(h.updateWhere).not.toHaveBeenCalled();
  });

  it('returns false for an unknown platform', async () => {
    h.getAttestationConfig.mockResolvedValue(ENABLED);
    h.consumeChallenge.mockResolvedValue(true);
    const ok = await verifyDeviceAttestation(
      req({ ...androidHeaders, 'x-attest-platform': 'windows' }),
    );
    expect(ok).toBe(false);
  });
});
