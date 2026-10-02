// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { db, chargingSessions } from '@evtivity/database';
import { and, eq } from 'drizzle-orm';
import { createTestClient, type OpenTransaction, type TestOcppClient } from './client.js';
import type { OcppVersion } from './types.js';

const SESSION_POLL_INTERVAL_MS = 250;
const SESSION_POLL_TIMEOUT_MS = 10_000;

export interface TeardownOptions {
  client: TestOcppClient;
  stationId: string;
  /** charging_stations.id; when null (no provisioning) the session poll is skipped. */
  stationDbId: string | null;
  version: OcppVersion;
  logger: Logger;
}

/**
 * Stops every transaction the test left running, as OCTT does before each test
 * (test procedure 8.2), then waits until the CSMS has no active session for the
 * station. Reconnects first when the test dropped the connection. Failures are
 * logged and never change the test result.
 */
export async function stopOpenTransactions(opts: TeardownOptions): Promise<void> {
  const open = opts.client.transactions.open;
  if (open.length === 0) return;

  let sender = opts.client;
  let freshClient: TestOcppClient | null = null;
  if (!opts.client.isConnected) {
    // Stop any reconnect loop the test left running before opening a new connection.
    const connection = opts.client.connection;
    opts.client.disconnect();
    freshClient = createTestClient({
      serverUrl: connection.serverUrl,
      stationId: opts.stationId,
      version: opts.version,
      password: connection.password,
      securityProfile: connection.securityProfile,
    });
    freshClient.setConnectedHandler(() => {});
    const fresh = freshClient;
    freshClient.setDisconnectedHandler(() => {
      fresh.disconnect();
    });
    try {
      await freshClient.connect();
    } catch (err) {
      opts.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Teardown reconnect failed, open transactions not stopped',
      );
      freshClient.disconnect();
      return;
    }
    sender = freshClient;
  }

  try {
    for (const tx of open) {
      try {
        await sender.sendCall(...stopCall(tx));
      } catch (err) {
        opts.logger.warn(
          {
            transactionId: tx.transactionId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Teardown stop of open transaction failed',
        );
      }
    }
    if (opts.stationDbId != null) {
      const cleared = await waitForNoActiveSession(opts.stationDbId);
      if (!cleared) {
        opts.logger.warn('Teardown: CSMS still has an active session for the test station');
      }
    }
  } finally {
    freshClient?.disconnect();
  }
}

function stopCall(tx: OpenTransaction): [string, Record<string, unknown>] {
  const timestamp = new Date().toISOString();
  if (tx.version === 'ocpp1.6') {
    return [
      'StopTransaction',
      {
        transactionId: tx.transactionId,
        meterStop: tx.meterStart,
        timestamp,
        reason: 'Other',
      },
    ];
  }
  return [
    'TransactionEvent',
    {
      eventType: 'Ended',
      timestamp,
      triggerReason: 'AbnormalCondition',
      seqNo: tx.seqNo + 1,
      transactionInfo: { transactionId: tx.transactionId, stoppedReason: 'Other' },
      ...(tx.evse != null ? { evse: tx.evse } : {}),
    },
  ];
}

async function waitForNoActiveSession(stationDbId: string): Promise<boolean> {
  const deadline = Date.now() + SESSION_POLL_TIMEOUT_MS;
  for (;;) {
    const active = await db
      .select({ id: chargingSessions.id })
      .from(chargingSessions)
      .where(
        and(eq(chargingSessions.stationId, stationDbId), eq(chargingSessions.status, 'active')),
      )
      .limit(1);
    if (active.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_INTERVAL_MS));
  }
}
