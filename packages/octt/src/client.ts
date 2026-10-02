// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppClient } from '@evtivity/css/ocpp-client';
import type { OcppVersion } from './types.js';

export interface TestClientOptions {
  serverUrl: string;
  stationId: string;
  version: OcppVersion;
  password?: string | undefined;
  securityProfile?: number | undefined;
  caCert?: string | undefined;
}

/** A transaction the test station started and has not stopped. */
export type OpenTransaction =
  | {
      version: 'ocpp1.6';
      transactionId: number;
      connectorId: number;
      meterStart: number;
      idTag: string;
    }
  | {
      version: 'ocpp2.1';
      transactionId: string;
      /** Highest seqNo the station sent for this transaction. */
      seqNo: number;
      evse?: Record<string, unknown> | undefined;
    };

/**
 * Tracks the transactions a test station opens and closes, so the executor can
 * stop whatever is still running after a test (OCTT test procedure 8.2).
 * 1.6: StartTransaction.conf transactionId opens, StopTransaction.req closes.
 * 2.1: TransactionEvent Started/Updated opens (keeping the last seqNo), Ended closes.
 */
export class TransactionTracker {
  private readonly open16 = new Map<number, OpenTransaction & { version: 'ocpp1.6' }>();
  private readonly open21 = new Map<string, OpenTransaction & { version: 'ocpp2.1' }>();

  onRequest(action: string, payload: Record<string, unknown>): void {
    if (action === 'StopTransaction') {
      const id = payload['transactionId'];
      if (typeof id === 'number') this.open16.delete(id);
      return;
    }
    if (action !== 'TransactionEvent') return;
    const info = payload['transactionInfo'] as Record<string, unknown> | undefined;
    const id = info?.['transactionId'];
    if (typeof id !== 'string') return;
    if (payload['eventType'] === 'Ended') {
      this.open21.delete(id);
      return;
    }
    const seqNo = typeof payload['seqNo'] === 'number' ? payload['seqNo'] : 0;
    const prev = this.open21.get(id);
    const evse = payload['evse'] as Record<string, unknown> | undefined;
    this.open21.set(id, {
      version: 'ocpp2.1',
      transactionId: id,
      seqNo: Math.max(prev?.seqNo ?? seqNo, seqNo),
      evse: evse ?? prev?.evse,
    });
  }

  onResponse(
    action: string,
    payload: Record<string, unknown>,
    response: Record<string, unknown>,
  ): void {
    if (action !== 'StartTransaction') return;
    const id = response['transactionId'];
    if (typeof id !== 'number') return;
    this.open16.set(id, {
      version: 'ocpp1.6',
      transactionId: id,
      connectorId: typeof payload['connectorId'] === 'number' ? payload['connectorId'] : 1,
      meterStart: typeof payload['meterStart'] === 'number' ? payload['meterStart'] : 0,
      idTag: typeof payload['idTag'] === 'string' ? payload['idTag'] : '',
    });
  }

  /** Transactions still open, oldest first. */
  get open(): OpenTransaction[] {
    return [...this.open16.values(), ...this.open21.values()];
  }
}

/** OcppClient that records the transactions the test station opens and closes. */
export class TestOcppClient extends OcppClient {
  readonly transactions = new TransactionTracker();

  override async sendCall(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.transactions.onRequest(action, payload);
    const response = await super.sendCall(action, payload);
    this.transactions.onResponse(action, payload, response);
    return response;
  }
}

export function createTestClient(options: TestClientOptions): TestOcppClient {
  return new TestOcppClient({
    serverUrl: options.serverUrl,
    stationId: options.stationId,
    ocppProtocol: options.version,
    password: options.password,
    securityProfile: options.securityProfile,
    caCert: options.caCert,
  });
}

export function generateStationId(module: string, testId: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `OCTT-${module}-${testId}-${suffix}`;
}
