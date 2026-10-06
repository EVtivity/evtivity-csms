// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PubSubClient } from '@evtivity/lib';

const { initiateRegistration } = vi.hoisted(() => ({ initiateRegistration: vi.fn() }));
vi.mock('../services/credentials.service.js', () => ({ initiateRegistration }));

const { OcpiRegisterListener } = await import('../services/register-listener.service.js');

type Handler = (payload: string) => void;

async function deliver(payloads: string[]): Promise<void> {
  let handler: Handler | null = null;
  const pubsub = {
    publish: vi.fn(),
    subscribe: vi.fn((channel: string, h: Handler) => {
      expect(channel).toBe('ocpi_register');
      handler = h;
      return Promise.resolve({ unsubscribe: vi.fn(() => Promise.resolve()) });
    }),
    close: vi.fn(),
  } as unknown as PubSubClient;
  const listener = new OcpiRegisterListener(pubsub);
  await listener.start();
  for (const p of payloads) (handler as Handler | null)?.(p);
  // stop() waits for the in-flight registrations.
  await listener.stop();
}

beforeEach(() => {
  initiateRegistration.mockReset();
  initiateRegistration.mockResolvedValue(undefined);
});

describe('OcpiRegisterListener', () => {
  it('starts the registration with the requested version', async () => {
    await deliver([JSON.stringify({ partnerId: 'opr_1', preferredVersion: '2.3.0' })]);
    expect(initiateRegistration).toHaveBeenCalledWith('opr_1', '2.3.0');
  });

  it('defaults to OCPI 2.2.1 when no version is requested', async () => {
    await deliver([JSON.stringify({ partnerId: 'opr_1' })]);
    expect(initiateRegistration).toHaveBeenCalledWith('opr_1', '2.2.1');
  });

  it('ignores invalid JSON and notifications without a partner id', async () => {
    await deliver(['{', JSON.stringify(null), JSON.stringify({ partnerId: 42 }), '"text"']);
    expect(initiateRegistration).not.toHaveBeenCalled();
  });

  it('keeps listening after a registration fails', async () => {
    initiateRegistration.mockRejectedValueOnce(new Error('partner unreachable'));
    await deliver([JSON.stringify({ partnerId: 'opr_1' }), JSON.stringify({ partnerId: 'opr_2' })]);
    expect(initiateRegistration).toHaveBeenCalledTimes(2);
    expect(initiateRegistration).toHaveBeenLastCalledWith('opr_2', '2.2.1');
  });

  it('stop() without start() resolves', async () => {
    const listener = new OcpiRegisterListener({} as PubSubClient);
    await expect(listener.stop()).resolves.toBeUndefined();
  });
});
