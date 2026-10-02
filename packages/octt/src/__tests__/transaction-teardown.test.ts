// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

const { activeRows, freshClient, createTestClient } = vi.hoisted(() => {
  const freshClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    sendCall: vi.fn().mockResolvedValue({}),
    setConnectedHandler: vi.fn(),
    setDisconnectedHandler: vi.fn(),
  };
  return {
    activeRows: [] as unknown[][],
    freshClient,
    createTestClient: vi.fn(() => freshClient),
  };
});

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where']) chain[m] = vi.fn(() => chain);
  chain['limit'] = vi.fn(() => Promise.resolve(activeRows.shift() ?? []));
  return {
    db: { select: vi.fn(() => chain) },
    chargingSessions: { id: 'id', stationId: 'station_id', status: 'status' },
  };
});

vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }));

vi.mock('../client.js', () => ({ createTestClient }));

import { stopOpenTransactions } from '../transaction-teardown.js';
import type { OpenTransaction, TestOcppClient } from '../client.js';

const logger = pino({ level: 'silent' });

function makeClient(open: OpenTransaction[], connected = true) {
  return {
    isConnected: connected,
    connection: { serverUrl: 'ws://csms', password: 'pw', securityProfile: 1 },
    transactions: { open },
    disconnect: vi.fn(),
    sendCall: vi.fn().mockResolvedValue({}),
  };
}

describe('stopOpenTransactions', () => {
  beforeEach(() => {
    activeRows.length = 0;
    vi.clearAllMocks();
  });

  it('does nothing when no transaction is open', async () => {
    const client = makeClient([]);
    await stopOpenTransactions({
      client: client as unknown as TestOcppClient,
      stationId: 'OCTT-1',
      stationDbId: 'sta_1',
      version: 'ocpp2.1',
      logger,
    });
    expect(client.sendCall).not.toHaveBeenCalled();
  });

  it('sends StopTransaction (Other) for an open 1.6 transaction', async () => {
    const client = makeClient([
      { version: 'ocpp1.6', transactionId: 9, connectorId: 1, meterStart: 50, idTag: 'T' },
    ]);
    await stopOpenTransactions({
      client: client as unknown as TestOcppClient,
      stationId: 'OCTT-1',
      stationDbId: 'sta_1',
      version: 'ocpp1.6',
      logger,
    });
    expect(client.sendCall).toHaveBeenCalledWith(
      'StopTransaction',
      expect.objectContaining({ transactionId: 9, meterStop: 50, reason: 'Other' }),
    );
  });

  it('sends TransactionEvent Ended with the next seqNo and polls until no session is active', async () => {
    activeRows.push([{ id: 'ses_1' }], []);
    const evse = { id: 1, connectorId: 1 };
    const client = makeClient([{ version: 'ocpp2.1', transactionId: 'TX1', seqNo: 2, evse }]);
    await stopOpenTransactions({
      client: client as unknown as TestOcppClient,
      stationId: 'OCTT-1',
      stationDbId: 'sta_1',
      version: 'ocpp2.1',
      logger,
    });
    expect(client.sendCall).toHaveBeenCalledWith(
      'TransactionEvent',
      expect.objectContaining({
        eventType: 'Ended',
        seqNo: 3,
        evse,
        transactionInfo: { transactionId: 'TX1', stoppedReason: 'Other' },
      }),
    );
    expect(activeRows).toHaveLength(0);
  });

  it('reconnects with the current connection settings when the test dropped the socket', async () => {
    const client = makeClient(
      [{ version: 'ocpp2.1', transactionId: 'TX2', seqNo: 0, evse: undefined }],
      false,
    );
    await stopOpenTransactions({
      client: client as unknown as TestOcppClient,
      stationId: 'OCTT-1',
      stationDbId: null,
      version: 'ocpp2.1',
      logger,
    });
    expect(client.disconnect).toHaveBeenCalled();
    expect(createTestClient).toHaveBeenCalledWith({
      serverUrl: 'ws://csms',
      stationId: 'OCTT-1',
      version: 'ocpp2.1',
      password: 'pw',
      securityProfile: 1,
    });
    expect(freshClient.sendCall).toHaveBeenCalledWith(
      'TransactionEvent',
      expect.objectContaining({ seqNo: 1 }),
    );
    expect(freshClient.disconnect).toHaveBeenCalled();
  });
});
