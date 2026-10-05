// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { PubSubClient } from '@evtivity/lib';
import { issueCert, type TestCert } from './ocsp-fixtures.js';

const { getPkiProviderMock, executeMock, insertedRows, existingRows } = vi.hoisted(() => ({
  getPkiProviderMock: vi.fn(),
  executeMock: vi.fn(async () => []),
  insertedRows: [] as Array<Record<string, unknown>>,
  existingRows: [] as Array<{ certificate: string }>,
}));

vi.mock('../../../services/pki/provider-factory.js', () => ({
  getPkiProvider: getPkiProviderMock,
}));

vi.mock('@evtivity/database', () => {
  const tx = {
    execute: executeMock,
    select: () => ({
      from: () => ({
        where: async () => existingRows,
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        insertedRows.push(row);
      },
    }),
  };
  return {
    db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    pkiCaCertificates: { certificate: 'certificate', certificateType: 'certificate_type' },
  };
});

import { HubjectProvider } from '../../../services/pki/hubject-provider.js';
import {
  refreshRootCertificates,
  subscribePncCommands,
} from '../../../services/pki/root-certificate-refresh.js';

let root: TestCert;
let otherRoot: TestCert;
let intermediate: TestCert;

function hubjectProvider(pems: string[]): HubjectProvider {
  const provider = Object.create(HubjectProvider.prototype) as HubjectProvider;
  Object.assign(provider, { getRootCertificates: vi.fn(async () => pems) });
  return provider;
}

beforeAll(async () => {
  root = await issueCert('CN=V2G Root CA', null, { ca: true });
  otherRoot = await issueCert('CN=Second V2G Root CA', null, { ca: true });
  intermediate = await issueCert('CN=CPO Sub-CA 1', root, { ca: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.length = 0;
  existingRows.length = 0;
});

describe('refreshRootCertificates', () => {
  it('stores the new self-signed roots from Hubject and skips intermediates, bad PEM and duplicates', async () => {
    existingRows.push({ certificate: otherRoot.pem });
    const provider = hubjectProvider([
      root.pem,
      intermediate.pem,
      'not a certificate',
      otherRoot.pem,
      root.pem,
    ]);
    getPkiProviderMock.mockResolvedValue(provider);

    const result = await refreshRootCertificates();

    expect(provider.getRootCertificates).toHaveBeenCalledWith('V2GRootCertificate');
    expect(result).toEqual({ fetched: 5, added: 1 });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      certificateType: 'V2GRootCertificate',
      certificate: root.pem,
      source: 'hubject',
      serialNumber: expect.any(String),
      subject: expect.stringContaining('V2G Root CA'),
      validFrom: expect.any(Date),
      validTo: expect.any(Date),
    });
  });

  it('adds nothing for the manual provider, whose roots are already stored', async () => {
    existingRows.push({ certificate: root.pem });
    getPkiProviderMock.mockResolvedValue({
      getRootCertificates: vi.fn(async () => [root.pem]),
    });

    await expect(refreshRootCertificates()).resolves.toEqual({ fetched: 1, added: 0 });
    expect(insertedRows).toHaveLength(0);
  });

  it('marks roots from a non-Hubject provider as manual uploads', async () => {
    getPkiProviderMock.mockResolvedValue({
      getRootCertificates: vi.fn(async () => [otherRoot.pem]),
    });

    await expect(refreshRootCertificates()).resolves.toEqual({ fetched: 1, added: 1 });
    expect(insertedRows[0]).toMatchObject({ source: 'manual_upload' });
  });

  it('propagates a provider failure without touching the table', async () => {
    getPkiProviderMock.mockResolvedValue({
      getRootCertificates: vi.fn(async () => {
        throw new Error('Hubject root cert fetch failed: 503');
      }),
    });

    await expect(refreshRootCertificates()).rejects.toThrow('Hubject root cert fetch failed');
    expect(executeMock).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });
});

describe('subscribePncCommands', () => {
  async function setup(): Promise<{
    deliver: (raw: string) => Promise<void>;
    publish: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  }> {
    const publish = vi.fn(async () => {});
    const ref: { handler: ((raw: string) => void) | null } = { handler: null };
    const subscribe = vi.fn(async (_channel: string, handler: (raw: string) => void) => {
      ref.handler = handler;
      return { unsubscribe: vi.fn(async () => {}) };
    });
    const pubsub = { publish, subscribe, close: vi.fn() } as unknown as PubSubClient;
    await subscribePncCommands(pubsub);
    return {
      publish,
      subscribe,
      // The handler runs asynchronously; let it settle before asserting.
      deliver: async (raw) => {
        ref.handler?.(raw);
        await new Promise((resolve) => setImmediate(resolve));
      },
    };
  }

  it('subscribes to pnc_commands and replies with the refresh result', async () => {
    getPkiProviderMock.mockResolvedValue(hubjectProvider([root.pem]));
    const h = await setup();

    expect(h.subscribe).toHaveBeenCalledWith('pnc_commands', expect.any(Function));
    await h.deliver(JSON.stringify({ commandId: 'cmd-1', action: 'refreshRootCertificates' }));

    await vi.waitFor(() => {
      expect(h.publish).toHaveBeenCalledWith(
        'pnc_command_results',
        JSON.stringify({ commandId: 'cmd-1', fetched: 1, added: 1 }),
      );
    });
  });

  it('replies with the error when the refresh fails', async () => {
    getPkiProviderMock.mockRejectedValue(new Error('settings unavailable'));
    const h = await setup();

    await h.deliver(JSON.stringify({ commandId: 'cmd-2', action: 'refreshRootCertificates' }));

    await vi.waitFor(() => {
      expect(h.publish).toHaveBeenCalledWith(
        'pnc_command_results',
        JSON.stringify({ commandId: 'cmd-2', error: 'settings unavailable' }),
      );
    });
  });

  it('replies with an error for an unknown action', async () => {
    const h = await setup();

    await h.deliver(JSON.stringify({ commandId: 'cmd-3', action: 'somethingElse' }));

    await vi.waitFor(() => {
      expect(h.publish).toHaveBeenCalledWith(
        'pnc_command_results',
        JSON.stringify({ commandId: 'cmd-3', error: 'Unknown PnC action: somethingElse' }),
      );
    });
    expect(getPkiProviderMock).not.toHaveBeenCalled();
  });

  it('ignores bad JSON and commands without a commandId', async () => {
    const h = await setup();

    await h.deliver('not json');
    await h.deliver(JSON.stringify({ action: 'refreshRootCertificates' }));

    expect(h.publish).not.toHaveBeenCalled();
    expect(getPkiProviderMock).not.toHaveBeenCalled();
  });
});
