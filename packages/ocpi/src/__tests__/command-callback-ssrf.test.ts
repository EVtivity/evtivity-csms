// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PubSubClient } from '@evtivity/lib';
import type { FakeOcpiCommands } from './helpers/fake-ocpi-commands.js';

const { safeFetchMock, partnerRows, commands } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  partnerRows: [] as { allowPrivateNetwork: boolean }[],
  commands: { fake: null as FakeOcpiCommands | null },
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const { createFakeOcpiCommands } = await import('./helpers/fake-ocpi-commands.js');
  commands.fake = createFakeOcpiCommands();
  const fake = commands.fake;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(partnerRows).then(resolve);
  return {
    ...(await importOriginal<typeof import('@evtivity/database')>()),
    db: {
      select: vi.fn(() => chain),
      insert: vi.fn(() => ({ values: fake.insertValues })),
    },
    client: fake.client,
  };
});
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  safeFetch: safeFetchMock,
}));
vi.mock('../lib/outbound-token.js', () => ({
  getOutboundToken: vi.fn().mockResolvedValue('token-b'),
}));

const { OcpiCommandCallbackService } = await import('../services/command-callback.service.js');

function pubsubWith(handlers: ((payload: string) => void)[]): PubSubClient {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_channel: string, handler: (payload: string) => void) => {
      handlers.push(handler);
      return Promise.resolve({ unsubscribe: vi.fn().mockResolvedValue(undefined) });
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function deliverResult(allowPrivateNetwork: boolean): Promise<void> {
  partnerRows.length = 0;
  commands.fake?.rows.clear();
  partnerRows.push({ allowPrivateNetwork });
  const handlers: ((payload: string) => void)[] = [];
  const service = new OcpiCommandCallbackService(pubsubWith(handlers));
  await service.start();
  await service.registerCommand({
    commandId: 'cmd-1',
    responseUrl: 'https://emsp.example.com/cb/1',
    partnerId: 'opr_1',
    commandType: 'START_SESSION',
  });
  handlers[0]?.(JSON.stringify({ commandId: 'cmd-1', response: { status: 'Accepted' } }));
  await service.stop();
}

describe('OCPI command callback SSRF guard', () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  it('posts the result through safeFetch, public addresses only by default', async () => {
    await deliverResult(false);
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://emsp.example.com/cb/1',
      expect.objectContaining({ method: 'POST', allowPrivateNetworks: false }),
    );
  });

  it('allows private addresses for a partner with the private-network flag', async () => {
    await deliverResult(true);
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://emsp.example.com/cb/1',
      expect.objectContaining({ allowPrivateNetworks: true }),
    );
  });
});
