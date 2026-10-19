// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi } from 'vitest';
import pino from 'pino';
import type { TestContext } from '../../types.js';

type IncomingHandler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

type Forward = (payload: Record<string, unknown>) => Record<string, unknown> | null;

/**
 * A CSMS for the K17 renegotiation cases (TC_K_114, TC_K_115): it forwards the
 * triggered SetChargingProfile to the station as `forward` shapes it (null: it
 * sends nothing) and answers NotifyEVChargingNeeds and NotifyEVChargingSchedule
 * with the given statuses (default Accepted).
 */
export function makeRenegotiationContext(
  testId: string,
  forward: Forward,
  statuses: { needsStatus?: string; scheduleStatus?: string } = {},
) {
  let handler: IncomingHandler | null = null;
  const sendCall = vi.fn((action: string, _payload: Record<string, unknown>) => {
    if (action === 'BootNotification') {
      return Promise.resolve({ status: 'Accepted', currentTime: '', interval: 300 });
    }
    if (action === 'NotifyEVChargingNeeds') {
      return Promise.resolve({ status: statuses.needsStatus ?? 'Accepted' });
    }
    if (action === 'NotifyEVChargingSchedule') {
      return Promise.resolve({ status: statuses.scheduleStatus ?? 'Accepted' });
    }
    return Promise.resolve({});
  });
  const triggerCommand = vi.fn(
    async (_version: string, _action: string, payload: Record<string, unknown>) => {
      if (handler == null) throw new Error('no incoming handler');
      const request = { ...payload };
      delete request['stationId'];
      const sent = forward(request);
      if (sent == null) return {};
      return handler('m1', 'SetChargingProfile', sent);
    },
  );
  const ctx: TestContext = {
    client: {
      sendCall,
      setIncomingCallHandler: vi.fn((h: IncomingHandler) => {
        handler = h;
      }),
    } as unknown as TestContext['client'],
    version: 'ocpp2.1',
    stationId: `OCTT-K-smart-charging-${testId}-test`,
    tokens: { valid: 'OCTTVALID0000001' } as TestContext['tokens'],
    stationDbId: 'sta_test',
    logger: pino({ level: 'silent' }),
    config: { serverUrl: 'ws://localhost:7103' },
    triggerCommand,
  };
  return { ctx, sendCall, triggerCommand };
}

export function startedTransactionId(sendCall: ReturnType<typeof vi.fn>): string {
  const call = sendCall.mock.calls.find(([action]) => action === 'TransactionEvent');
  const payload = call?.[1] as { transactionInfo: { transactionId: string } };
  return payload.transactionInfo.transactionId;
}
