// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiProposalDtoSchema } from '@evtivity/lib/ai-proposals';

const inserted: unknown[] = [];
let returning: unknown[] = [];
const audits: unknown[] = [];
const publishes: unknown[] = [];

/** What the target lookups return: the station by OCPP id, then the session. */
let stationRows: unknown[] = [];
let sessionRows: unknown[] = [];

vi.mock('@evtivity/database', () => ({
  db: {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => Promise.resolve('siteId' in fields ? stationRows : sessionRows),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        inserted.push(values);
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve(returning) }),
        };
      },
    }),
  },
  aiProposals: { dedupKey: 'dedup_key', status: 'status' },
  aiProposalAuditLog: {},
  chargingSessions: { stationId: 'station_id' },
  chargingStations: { id: 'id', siteId: 'site_id', stationId: 'station_id' },
  writeAudit: (_config: unknown, args: unknown) => {
    audits.push(args);
    return Promise.resolve();
  },
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: (channel: string, payload: string) => {
      publishes.push({ channel, payload: JSON.parse(payload) as unknown });
      return Promise.resolve();
    },
  }),
}));

const { createAiProposal, toAiProposalDto, AiProposalInputError } =
  await import('../ai-proposal.service.js');
type Input = Parameters<typeof createAiProposal>[0];

function input(overrides: Partial<Input> = {}): Input {
  return {
    source: 'worker',
    job: 'stuck_sessions',
    siteId: 'sit_000000000001',
    stationId: 'sta_000000000001',
    sessionId: 'ses_000000000001',
    operationId: 'ocppv21_RequestStopTransaction',
    method: 'POST',
    path: '/v1/ocpp/commands/v21/RequestStopTransaction',
    args: { stationId: 'CS-1', transactionId: 'tx-1' },
    expiresAt: new Date(Date.now() + 3_600_000),
    actor: { actor: 'system', actorLabel: 'ai-stuck-sessions' },
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'apr_000000000001',
    source: 'worker',
    job: 'stuck_sessions',
    insightId: null,
    workerRunId: null,
    requestedByUserId: null,
    apiKeyId: null,
    siteId: 'sit_000000000001',
    stationId: 'sta_000000000001',
    sessionId: 'ses_000000000001',
    operationId: 'ocppv21_RequestStopTransaction',
    method: 'POST',
    path: '/v1/ocpp/commands/v21/RequestStopTransaction',
    args: { stationId: 'CS-1', transactionId: 'tx-1' },
    argsHash: 'h',
    summary: {},
    rationaleText: null,
    rationaleLanguage: null,
    precondition: { kind: 'session_active', params: { sessionId: 'ses_000000000001' } },
    dedupKey: null,
    status: 'pending',
    expiresAt: new Date('2026-10-10T12:00:00Z'),
    decidedBy: null,
    decidedAt: null,
    executedAt: null,
    result: null,
    createdAt: new Date('2026-10-10T10:00:00Z'),
    updatedAt: new Date('2026-10-10T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  inserted.length = 0;
  audits.length = 0;
  publishes.length = 0;
  returning = [];
  stationRows = [{ id: 'sta_000000000001', siteId: 'sit_000000000001' }];
  sessionRows = [{ stationId: 'sta_000000000001' }];
});

describe('createAiProposal', () => {
  it('stores the args hash, audits and publishes with the site', async () => {
    returning = [row()];
    const created = await createAiProposal(input());
    expect(created?.id).toBe('apr_000000000001');
    expect(inserted[0]).toMatchObject({ argsHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(audits).toEqual([expect.objectContaining({ action: 'created', actor: 'system' })]);
    expect(publishes).toEqual([
      {
        channel: 'csms_events',
        payload: expect.objectContaining({
          eventType: 'ai.proposal.updated',
          siteId: 'sit_000000000001',
        }),
      },
    ]);
  });

  it('returns null without side effects when a pending proposal has the same dedup key', async () => {
    returning = [];
    expect(await createAiProposal(input({ dedupKey: 'stuck_sessions:ses_1' }))).toBeNull();
    expect(audits).toHaveLength(0);
    expect(publishes).toHaveLength(0);
  });

  it('TC-AI-WK-05: refuses a worker proposal outside the closed action set', async () => {
    for (const bad of [
      input({ operationId: 'updateTariff', path: '/v1/tariffs/{id}', method: 'PATCH' }),
      input({
        operationId: 'ocppv21_Reset',
        path: '/v1/ocpp/commands/v21/Reset',
        args: { stationId: 'CS-1', type: 'Immediate' },
      }),
      input({ job: null }),
      input({ requestedByUserId: 'usr_000000000001' }),
    ]) {
      await expect(createAiProposal(bad)).rejects.toBeInstanceOf(AiProposalInputError);
    }
    expect(inserted).toHaveLength(0);
  });

  it('requires a requester on an MCP proposal and an expiry in the future', async () => {
    await expect(createAiProposal(input({ source: 'mcp', job: null }))).rejects.toBeInstanceOf(
      AiProposalInputError,
    );
    await expect(
      createAiProposal(input({ expiresAt: new Date(Date.now() - 1) })),
    ).rejects.toBeInstanceOf(AiProposalInputError);
  });

  it('publishes no station or session for an MCP proposal', async () => {
    returning = [row({ source: 'mcp', job: null, requestedByUserId: 'usr_000000000001' })];
    await createAiProposal(
      input({ source: 'mcp', job: null, requestedByUserId: 'usr_000000000001' }),
    );
    expect(publishes[0]).toEqual({
      channel: 'csms_events',
      payload: { eventType: 'ai.proposal.updated', siteId: 'sit_000000000001' },
    });
  });
});

describe('the proposal target comes from the station in the arguments (P11)', () => {
  it('stores the station and site of the named station', async () => {
    returning = [row()];
    await createAiProposal(input());
    expect(inserted[0]).toMatchObject({
      siteId: 'sit_000000000001',
      stationId: 'sta_000000000001',
      sessionId: 'ses_000000000001',
    });
  });

  it('refuses a site, station or session that does not match the named station', async () => {
    for (const bad of [
      input({ siteId: 'sit_000000000002' }),
      input({ siteId: null }),
      input({ stationId: 'sta_000000000002' }),
    ]) {
      await expect(createAiProposal(bad)).rejects.toBeInstanceOf(AiProposalInputError);
    }
    sessionRows = [{ stationId: 'sta_000000000002' }];
    await expect(createAiProposal(input())).rejects.toBeInstanceOf(AiProposalInputError);
    stationRows = [];
    await expect(createAiProposal(input())).rejects.toBeInstanceOf(AiProposalInputError);
    expect(inserted).toHaveLength(0);
  });
});

describe('toAiProposalDto', () => {
  it('matches the shared DTO contract', () => {
    const dto = toAiProposalDto(row() as never, new Map());
    expect(aiProposalDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.expiresAt).toBe('2026-10-10T12:00:00.000Z');
  });

  it('names the API key of an MCP proposal, and none for a revoked key or a worker', () => {
    expect(
      toAiProposalDto(row({ apiKeyId: 7 }) as never, new Map([[7, 'Ops key']])).apiKeyName,
    ).toBe('Ops key');
    expect(
      toAiProposalDto(row({ apiKeyId: 8 }) as never, new Map([[7, 'Ops key']])).apiKeyName,
    ).toBeNull();
    expect(toAiProposalDto(row({ apiKeyId: null }) as never, new Map()).apiKeyName).toBeNull();
  });

  it('drops a stored precondition or result that no longer parses', () => {
    const dto = toAiProposalDto(
      row({ precondition: { kind: 'other' }, result: 'x' }) as never,
      new Map(),
    );
    expect(dto.precondition).toBeNull();
    expect(dto.result).toBeNull();
  });
});
