// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * executeConfirmedToolCall: the helper that runs a confirmed AI proposal as
 * the confirming user (TTL, args hash, policy, closed action set,
 * precondition, OCPP version re-mapped at confirm, schema, via_ai).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { currentAuditViaAi } from '@evtivity/database';
import { aiArgsHash } from '@evtivity/lib';
import { findAiWorkerAction, workerActionArgsAllowed } from '@evtivity/lib/ai-proposals';
import {
  executeConfirmedToolCall,
  registerAiToolCallContext,
} from '../services/ai/tools/execute.js';
import type { ConfirmedToolCall, ConfirmingCaller } from '../services/ai/tools/execute.js';
import type { CommandStation } from '../lib/command-station.js';

const STOP_21 = '/v1/ocpp/commands/v21/RequestStopTransaction';
const STOP_16 = '/v1/ocpp/commands/v16/RemoteStopTransaction';

let app: FastifyInstance;
const seen: { url: string; body: unknown; auth: unknown; via: unknown }[] = [];
let answer = 200;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerAiToolCallContext(app);
  for (const url of [STOP_21, STOP_16]) {
    app.post(url, async (request, reply) => {
      seen.push({
        url,
        body: request.body,
        auth: request.headers.authorization,
        via: currentAuditViaAi(),
      });
      return reply.status(answer).send({ status: 'Accepted', apiKeyEnc: 'cipher' });
    });
  }
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  seen.length = 0;
  answer = 200;
});

const caller = (perms: string[] = ['stations:read']): ConfirmingCaller => ({
  userId: 'usr_confirmer01',
  authorization: 'Bearer confirmer-token',
  hasPermission: (p) => Promise.resolve(perms.includes(p)),
});

function call(overrides: Partial<ConfirmedToolCall> = {}): ConfirmedToolCall {
  const args = overrides.args ?? { stationId: 'CS-1', transactionId: 'tx-42' };
  return {
    operationId: 'ocppv21_RequestStopTransaction',
    args,
    argsHash: aiArgsHash(args),
    expiresAt: new Date(Date.now() + 60_000),
    via: { channel: 'proposal', proposalId: 'apr_000000000001', confirmedBy: 'usr_confirmer01' },
    ...overrides,
  };
}

const station = (ocppProtocol: string | null) => () =>
  Promise.resolve<CommandStation | null>({ id: 'sta_000000000001', ocppProtocol });

const workerAllowed = (operationId: string, args: Readonly<Record<string, unknown>>) => {
  const action = findAiWorkerAction(operationId);
  return action !== undefined && workerActionArgsAllowed(action, args);
};

describe('executeConfirmedToolCall', () => {
  it('runs as the confirming user and records via_ai for the proposal (TC-AI-WK-07)', async () => {
    const result = await executeConfirmedToolCall(app, caller(), call(), {
      findStation: station('ocpp2.1'),
    });
    expect(result).toMatchObject({
      kind: 'ran',
      operationId: 'ocppv21_RequestStopTransaction',
      httpStatus: 200,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: STOP_21,
      auth: 'Bearer confirmer-token',
      via: { channel: 'proposal', proposalId: 'apr_000000000001', confirmedBy: 'usr_confirmer01' },
    });
    // The stored excerpt is redacted.
    expect(JSON.stringify(result)).not.toContain('cipher');
  });

  it('refuses after the expiry without running (TC-AI-WK-09)', async () => {
    const result = await executeConfirmedToolCall(
      app,
      caller(),
      call({ expiresAt: new Date(Date.now() - 1) }),
      { findStation: station('ocpp2.1') },
    );
    expect(result).toEqual({ kind: 'expired' });
    expect(seen).toHaveLength(0);
  });

  it('ends stale when the precondition no longer holds (TC-AI-WK-08)', async () => {
    const result = await executeConfirmedToolCall(
      app,
      caller(),
      call({ precondition: () => Promise.resolve(false) }),
      { findStation: station('ocpp2.1') },
    );
    expect(result).toEqual({ kind: 'stale' });
    expect(seen).toHaveLength(0);
  });

  it('refuses arguments that no longer match the stored hash', async () => {
    const result = await executeConfirmedToolCall(app, caller(), call({ argsHash: 'tampered' }));
    expect(result).toEqual({ kind: 'refused', reason: 'args_mismatch' });
    expect(seen).toHaveLength(0);
  });

  it('refuses an operation the policy does not let the assistant write (TC-AI-WK-05)', async () => {
    const args = { id: 'sta_000000000001', priceCents: 1 };
    const result = await executeConfirmedToolCall(
      app,
      caller(),
      call({ operationId: 'updateTariff', args, argsHash: aiArgsHash(args) }),
    );
    expect(result).toEqual({ kind: 'refused', reason: 'no_longer_available' });
    expect(seen).toHaveLength(0);
  });

  it('refuses a write outside the closed worker action set', async () => {
    const args = { stationId: 'CS-1', type: 'Immediate' };
    const result = await executeConfirmedToolCall(
      app,
      caller(),
      call({
        operationId: 'ocppv21_Reset',
        args,
        argsHash: aiArgsHash(args),
        allowAction: workerAllowed,
      }),
    );
    expect(result).toEqual({ kind: 'refused', reason: 'no_longer_available' });
  });

  it('maps the command to the station version at confirm time (TC-AI-WK-04)', async () => {
    const result = await executeConfirmedToolCall(
      app,
      caller(),
      call({ args: { stationId: 'CS-1', transactionId: '42' }, allowAction: workerAllowed }),
      { findStation: station('ocpp1.6') },
    );
    expect(result).toMatchObject({ kind: 'ran', operationId: 'ocppv16_RemoteStopTransaction' });
    expect(seen[0]).toMatchObject({
      url: STOP_16,
      body: { stationId: 'CS-1', transactionId: 42 },
    });
  });

  it('refuses when the station version has no equivalent', async () => {
    const result = await executeConfirmedToolCall(
      app,
      caller(),
      call({ args: { stationId: 'CS-1', transactionId: 'not-a-number' } }),
      { findStation: station('ocpp1.6') },
    );
    expect(result).toEqual({ kind: 'refused', reason: 'ocpp_version_mismatch' });
    expect(seen).toHaveLength(0);
  });

  it('runs unchanged and records the route answer when the user cannot read stations', async () => {
    answer = 403;
    const result = await executeConfirmedToolCall(app, caller([]), call(), {
      findStation: () => Promise.reject(new Error('not called')),
    });
    expect(result).toMatchObject({ kind: 'ran', httpStatus: 403 });
  });

  it('refuses arguments that do not match the operation schema', async () => {
    const args = { stationId: 'CS-1' };
    const result = await executeConfirmedToolCall(
      app,
      caller(),
      call({ args, argsHash: aiArgsHash(args) }),
      { findStation: station('ocpp2.1') },
    );
    expect(result).toEqual({ kind: 'refused', reason: 'invalid_arguments' });
  });
});
