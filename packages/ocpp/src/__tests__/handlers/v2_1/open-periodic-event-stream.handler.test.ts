// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

const logger = pino({ level: 'silent' });

function makeCtx(payload: Record<string, unknown>): {
  ctx: HandlerContext;
  publishMock: ReturnType<typeof vi.fn>;
} {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const ctx: HandlerContext = {
    stationId: 'CS-001',
    stationDbId: 'sta_db_1',
    session: {
      stationId: 'CS-001',
      stationDbId: 'sta_db_1',
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action: 'OpenPeriodicEventStream',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2_1 OpenPeriodicEventStream handler', () => {
  it('publishes ocpp.OpenPeriodicEventStream and returns Accepted', async () => {
    const { handleOpenPeriodicEventStream } =
      await import('../../../handlers/v2_1/open-periodic-event-stream.handler.js');
    const constantStreamData = {
      id: 5,
      variableMonitoringId: 9,
      params: { interval: 60, values: 10 },
    };
    const { ctx, publishMock } = makeCtx({ constantStreamData });
    const response = await handleOpenPeriodicEventStream(ctx);

    expect(response).toEqual({ status: 'Accepted' });
    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.OpenPeriodicEventStream',
      aggregateType: 'ChargingStation',
      aggregateId: 'CS-001',
      payload: {
        stationId: 'CS-001',
        stationDbId: 'sta_db_1',
        constantStreamData,
      },
    });
  });
});
