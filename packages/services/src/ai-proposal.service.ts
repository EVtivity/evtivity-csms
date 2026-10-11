// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI proposals: writes a background worker or an MCP client asks for. This
 * service is the only writer of `ai_proposals` and `ai_proposal_audit_log`
 * (P3). The worker creates proposals; the API creates MCP proposals and
 * claims, finishes and rejects them. Nothing here runs a proposal: the API
 * runs a confirmed one through `executeConfirmedToolCall`, as the confirming
 * operator.
 *
 * Status moves once, from `pending` to a terminal status, by compare-and-set
 * (P5). A confirm first claims the row (`decided_by`, `decided_at`, status
 * still `pending`) so concurrent confirms run it once (P7), and a reject or
 * the expiry sweep never takes a claimed row.
 */

import { and, desc, eq, ilike, inArray, isNull, lte, lt, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  db,
  aiProposals,
  aiProposalAuditLog,
  chargingSessions,
  chargingStations,
  refreshTokens,
  sites,
  writeAudit,
} from '@evtivity/database';
import type { AuditActor } from '@evtivity/database';
import { aiArgsHash, createLogger } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  AI_PROPOSAL_SOURCES,
  AI_PROPOSAL_STATUSES,
  AI_WORKER_JOBS,
  aiProposalPreconditionSchema,
  aiProposalResultSchema,
  findAiWorkerAction,
  workerActionArgsAllowed,
} from '@evtivity/lib/ai-proposals';
import type {
  AiProposalDto,
  AiProposalPrecondition,
  AiProposalResult,
  AiProposalSource,
  AiProposalStatus,
  AiWorkerJob,
} from '@evtivity/lib/ai-proposals';

const moduleLogger = createLogger('ai-proposals');

export type AiProposalRow = typeof aiProposals.$inferSelect;

/** Who changed a proposal, for its audit row. */
export interface AiProposalActor {
  actor: AuditActor;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  actorLabel?: string | null;
}

/** A confirm holds its claim this long; a claim older than this is a crashed run. */
export const AI_PROPOSAL_CLAIM_TIMEOUT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Side effects (fail-open, P9)
// ---------------------------------------------------------------------------

async function audit(
  row: Pick<AiProposalRow, 'id'>,
  action: 'created' | 'confirmed' | 'executed' | 'failed' | 'rejected' | 'expired' | 'stale',
  actor: AiProposalActor,
  fields: { before?: unknown; after?: unknown; notes?: string | null },
  log: ServiceLogger,
): Promise<void> {
  await writeAudit(
    { table: aiProposalAuditLog, idColumn: 'ai_proposal_id' },
    {
      entityId: row.id,
      entityIdSnapshot: row.id,
      action,
      actor: actor.actor,
      actorUserId: actor.actorUserId ?? null,
      actorApiKeyId: actor.actorApiKeyId ?? null,
      actorLabel: actor.actorLabel ?? null,
      before: fields.before ?? null,
      after: fields.after ?? null,
      notes: fields.notes ?? null,
      viaAi: null,
    },
    db,
    log,
  );
}

/**
 * `ai.proposal.updated` on `csms_events`, filtered by site in the SSE stream.
 * An MCP proposal names no station or session: only its requester may see it.
 */
async function publishUpdated(row: AiProposalRow, log: ServiceLogger): Promise<void> {
  const event: Record<string, unknown> = {
    eventType: 'ai.proposal.updated',
    siteId: row.siteId,
  };
  if (row.source === 'worker') {
    event['proposalId'] = row.id;
    event['status'] = row.status;
    event['stationId'] = row.stationId;
    event['sessionId'] = row.sessionId;
  }
  try {
    await getPubSub().publish('csms_events', JSON.stringify(event));
  } catch (err) {
    log.warn({ err, proposalId: row.id }, 'AI proposal event publish failed');
  }
}

/** Every decision starts from a pending row. */
const PENDING = { status: 'pending' } as const;

/** The state a proposal row has, for an audit `after`. */
function auditState(row: AiProposalRow): Record<string, unknown> {
  return { status: row.status, decidedBy: row.decidedBy, operationId: row.operationId };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateAiProposalInput {
  source: AiProposalSource;
  job?: AiWorkerJob | null;
  insightId?: string | null;
  workerRunId?: number | null;
  /** MCP: the API key's user, the only user who may approve it. */
  requestedByUserId?: string | null;
  apiKeyId?: number | null;
  siteId: string | null;
  stationId?: string | null;
  sessionId?: string | null;
  operationId: string;
  method: string;
  path: string;
  args: Record<string, unknown>;
  summary?: Record<string, unknown>;
  rationaleText?: string | null;
  rationaleLanguage?: string | null;
  precondition?: AiProposalPrecondition | null;
  /** One pending proposal per key: a second create with the same key returns null. */
  dedupKey?: string | null;
  expiresAt: Date;
  actor: AiProposalActor;
}

export class AiProposalInputError extends Error {}

function checkCreateInput(input: CreateAiProposalInput, now: Date): void {
  if (!AI_PROPOSAL_SOURCES.includes(input.source)) {
    throw new AiProposalInputError(`Unknown proposal source: ${input.source}`);
  }
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new AiProposalInputError('A proposal must expire in the future');
  }
  if (input.precondition != null) aiProposalPreconditionSchema.parse(input.precondition);
  if (input.source === 'worker') {
    // The worker may propose only the closed action set (TC-AI-WK-05).
    if (input.job == null || !AI_WORKER_JOBS.includes(input.job)) {
      throw new AiProposalInputError('A worker proposal names its job');
    }
    const action = findAiWorkerAction(input.operationId);
    if (
      action === undefined ||
      action.method !== input.method ||
      action.path !== input.path ||
      !workerActionArgsAllowed(action, input.args)
    ) {
      throw new AiProposalInputError(`Not a worker action: ${input.operationId}`);
    }
    if (input.requestedByUserId != null || input.apiKeyId != null) {
      throw new AiProposalInputError('A worker proposal has no requester');
    }
  } else if (input.requestedByUserId == null) {
    throw new AiProposalInputError('An MCP proposal names the requesting user');
  }
}

interface ProposalTarget {
  siteId: string | null;
  stationId: string | null;
  sessionId: string | null;
}

/**
 * The station, site and session a proposal targets, from the station its
 * arguments name (the OCPP identity the route acts on), never from the
 * caller alone: the read scope trusts `site_id` (P11). A given `siteId`,
 * `stationId` or `sessionId` that does not match that station is refused.
 * A proposal whose arguments name no station keeps the given site.
 */
async function resolveTarget(input: CreateAiProposalInput): Promise<ProposalTarget> {
  const ocppStationId = input.args['stationId'];
  if (typeof ocppStationId !== 'string') {
    if (input.stationId != null || input.sessionId != null) {
      throw new AiProposalInputError('A proposal for a station names it in its arguments');
    }
    return { siteId: input.siteId, stationId: null, sessionId: null };
  }
  const [station] = await db
    .select({ id: chargingStations.id, siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, ocppStationId));
  if (station === undefined) throw new AiProposalInputError('Unknown station');
  if (
    (input.stationId != null && input.stationId !== station.id) ||
    input.siteId !== station.siteId
  ) {
    throw new AiProposalInputError('The station, site and arguments do not match');
  }
  if (input.sessionId != null) {
    const [session] = await db
      .select({ stationId: chargingSessions.stationId })
      .from(chargingSessions)
      .where(eq(chargingSessions.id, input.sessionId));
    if (session?.stationId !== station.id) {
      throw new AiProposalInputError('The session is not at the station');
    }
  }
  return { siteId: station.siteId, stationId: station.id, sessionId: input.sessionId ?? null };
}

/**
 * Creates a pending proposal, audits it and publishes `ai.proposal.updated`.
 * Returns null when a pending proposal with the same `dedupKey` exists.
 */
export async function createAiProposal(
  input: CreateAiProposalInput,
  log: ServiceLogger = moduleLogger,
): Promise<AiProposalRow | null> {
  checkCreateInput(input, new Date());
  const target = await resolveTarget(input);
  const [row] = await db
    .insert(aiProposals)
    .values({
      source: input.source,
      job: input.job ?? null,
      insightId: input.insightId ?? null,
      workerRunId: input.workerRunId ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
      apiKeyId: input.apiKeyId ?? null,
      siteId: target.siteId,
      stationId: target.stationId,
      sessionId: target.sessionId,
      operationId: input.operationId,
      method: input.method,
      path: input.path,
      args: input.args,
      argsHash: aiArgsHash(input.args),
      summary: input.summary ?? {},
      rationaleText: input.rationaleText ?? null,
      rationaleLanguage: input.rationaleLanguage ?? null,
      precondition: input.precondition ?? null,
      dedupKey: input.dedupKey ?? null,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({
      target: aiProposals.dedupKey,
      where: sql`${aiProposals.status} = 'pending' AND ${aiProposals.dedupKey} IS NOT NULL`,
    })
    .returning();
  if (row === undefined) return null;
  await audit(
    row,
    'created',
    input.actor,
    { after: { ...auditState(row), source: row.source, job: row.job, args: row.args } },
    log,
  );
  await publishUpdated(row, log);
  return row;
}

// ---------------------------------------------------------------------------
// Read (site scope)
// ---------------------------------------------------------------------------

/** The caller of a read: their user id and sites (null: all sites). */
export interface AiProposalScope {
  userId: string;
  siteIds: string[] | null;
}

/**
 * What a user may see: a worker proposal in their sites (an unsited or
 * company-level one only with all-site access), and an MCP proposal only
 * when they requested it (another user's answers 404, the phishing rule).
 */
export function aiProposalScopeCondition(scope: AiProposalScope): SQL {
  const siteCondition =
    scope.siteIds === null
      ? sql`true`
      : scope.siteIds.length === 0
        ? sql`false`
        : inArray(aiProposals.siteId, scope.siteIds);
  return and(
    siteCondition,
    or(
      eq(aiProposals.source, 'worker'),
      and(eq(aiProposals.source, 'mcp'), eq(aiProposals.requestedByUserId, scope.userId)),
    ),
  ) as SQL;
}

export interface ListAiProposalsFilter {
  status?: AiProposalStatus;
  source?: AiProposalSource;
  job?: AiWorkerJob;
  siteId?: string;
  stationId?: string;
  sessionId?: string;
  /** Matches the station's OCPP identity, the site name, the operation or the proposal id. */
  search?: string;
  limit: number;
  offset: number;
}

export async function listAiProposals(
  scope: AiProposalScope,
  filter: ListAiProposalsFilter,
): Promise<{ data: AiProposalRow[]; total: number }> {
  const conditions: SQL[] = [aiProposalScopeCondition(scope)];
  if (filter.status !== undefined) conditions.push(eq(aiProposals.status, filter.status));
  if (filter.source !== undefined) conditions.push(eq(aiProposals.source, filter.source));
  if (filter.job !== undefined) conditions.push(eq(aiProposals.job, filter.job));
  if (filter.siteId !== undefined) conditions.push(eq(aiProposals.siteId, filter.siteId));
  if (filter.stationId !== undefined) conditions.push(eq(aiProposals.stationId, filter.stationId));
  if (filter.sessionId !== undefined) conditions.push(eq(aiProposals.sessionId, filter.sessionId));
  if (filter.search !== undefined && filter.search !== '') {
    const pattern = `%${filter.search.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(
      or(
        ilike(aiProposals.id, pattern),
        ilike(aiProposals.operationId, pattern),
        sql`EXISTS (SELECT 1 FROM ${chargingStations} WHERE ${chargingStations.id} = ${aiProposals.stationId} AND ${chargingStations.stationId} ILIKE ${pattern})`,
        sql`EXISTS (SELECT 1 FROM ${sites} WHERE ${sites.id} = ${aiProposals.siteId} AND ${sites.name} ILIKE ${pattern})`,
      ) as SQL,
    );
  }
  const where = and(...conditions);
  const [data, [count]] = await Promise.all([
    db
      .select()
      .from(aiProposals)
      .where(where)
      .orderBy(desc(aiProposals.createdAt), desc(aiProposals.id))
      .limit(filter.limit)
      .offset(filter.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(aiProposals)
      .where(where),
  ]);
  return { data, total: count?.total ?? 0 };
}

/** The proposal, or null when it does not exist or the user may not see it. */
export async function getAiProposal(
  scope: AiProposalScope,
  id: string,
): Promise<AiProposalRow | null> {
  const [row] = await db
    .select()
    .from(aiProposals)
    .where(and(eq(aiProposals.id, id), aiProposalScopeCondition(scope)));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

export type AiProposalClaim =
  | { kind: 'claimed'; row: AiProposalRow }
  /** Past its expiry: the row is now `expired`. */
  | { kind: 'expired'; row: AiProposalRow }
  /** Decided before (or claimed by a concurrent confirm). */
  | { kind: 'decided'; row: AiProposalRow }
  | { kind: 'not_found' };

/**
 * Claims a pending, unexpired, unclaimed proposal for a confirm. One of
 * several concurrent confirms wins; the others get `decided`. Audits
 * `confirmed`.
 */
export async function claimAiProposal(
  id: string,
  actor: AiProposalActor & { actorUserId: string },
  log: ServiceLogger = moduleLogger,
): Promise<AiProposalClaim> {
  const [claimed] = await db
    .update(aiProposals)
    .set({ decidedBy: actor.actorUserId, decidedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(aiProposals.id, id),
        eq(aiProposals.status, 'pending'),
        isNull(aiProposals.decidedAt),
        sql`${aiProposals.expiresAt} > now()`,
      ),
    )
    .returning();
  if (claimed !== undefined) {
    await audit(claimed, 'confirmed', actor, { before: PENDING, after: auditState(claimed) }, log);
    return { kind: 'claimed', row: claimed };
  }
  const [row] = await db.select().from(aiProposals).where(eq(aiProposals.id, id));
  if (row === undefined) return { kind: 'not_found' };
  if (row.status === 'pending' && row.decidedAt === null) {
    const expired = await expireOne(row.id, log);
    if (expired !== null) return { kind: 'expired', row: expired };
  }
  const [current] = await db.select().from(aiProposals).where(eq(aiProposals.id, id));
  if (current === undefined) return { kind: 'not_found' };
  return current.status === 'expired'
    ? { kind: 'expired', row: current }
    : { kind: 'decided', row: current };
}

export type AiProposalOutcome =
  | { status: 'executed'; result: AiProposalResult }
  | { status: 'failed'; result: AiProposalResult }
  | { status: 'stale' }
  | { status: 'expired' };

/**
 * Ends a proposal the caller claimed: `executed` or `failed` with the
 * route's answer, `stale` when its precondition no longer held, `expired`
 * when the confirm came too late. Only the claiming user's pending row
 * changes; returns null when it was not theirs or already ended.
 */
export async function finishAiProposal(
  id: string,
  actor: AiProposalActor & { actorUserId: string },
  outcome: AiProposalOutcome,
  log: ServiceLogger = moduleLogger,
): Promise<AiProposalRow | null> {
  const result =
    outcome.status === 'executed' || outcome.status === 'failed'
      ? aiProposalResultSchema.parse(outcome.result)
      : null;
  const [row] = await db
    .update(aiProposals)
    .set({
      status: outcome.status,
      result,
      ...(outcome.status === 'executed' ? { executedAt: sql`now()` } : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(aiProposals.id, id),
        eq(aiProposals.status, 'pending'),
        eq(aiProposals.decidedBy, actor.actorUserId),
      ),
    )
    .returning();
  if (row === undefined) return null;
  await audit(
    row,
    outcome.status,
    actor,
    { before: { ...PENDING, decidedBy: row.decidedBy }, after: { status: row.status, result } },
    log,
  );
  await publishUpdated(row, log);
  return row;
}

export type AiProposalRejection =
  | { kind: 'rejected'; row: AiProposalRow }
  /** Past its expiry: the row is now `expired`, not rejected. */
  | { kind: 'expired'; row: AiProposalRow }
  /** Decided before, or claimed by a confirm that is running. */
  | { kind: 'decided'; row: AiProposalRow }
  | { kind: 'not_found' };

/** Rejects a pending, unclaimed, unexpired proposal. Audits `rejected`. */
export async function rejectAiProposal(
  id: string,
  actor: AiProposalActor & { actorUserId: string },
  log: ServiceLogger = moduleLogger,
): Promise<AiProposalRejection> {
  const [row] = await db
    .update(aiProposals)
    .set({
      status: 'rejected',
      decidedBy: actor.actorUserId,
      decidedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(aiProposals.id, id),
        eq(aiProposals.status, 'pending'),
        isNull(aiProposals.decidedAt),
        sql`${aiProposals.expiresAt} > now()`,
      ),
    )
    .returning();
  if (row !== undefined) {
    await audit(row, 'rejected', actor, { before: PENDING, after: { status: row.status } }, log);
    await publishUpdated(row, log);
    return { kind: 'rejected', row };
  }
  const expired = await expireOne(id, log);
  if (expired !== null) return { kind: 'expired', row: expired };
  const [current] = await db.select().from(aiProposals).where(eq(aiProposals.id, id));
  if (current === undefined) return { kind: 'not_found' };
  return current.status === 'expired'
    ? { kind: 'expired', row: current }
    : { kind: 'decided', row: current };
}

const SWEEP_ACTOR: AiProposalActor = { actor: 'system', actorLabel: 'ai-proposal-sweep' };

async function expireOne(id: string, log: ServiceLogger): Promise<AiProposalRow | null> {
  const [row] = await db
    .update(aiProposals)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(
      and(
        eq(aiProposals.id, id),
        eq(aiProposals.status, 'pending'),
        isNull(aiProposals.decidedAt),
        lte(aiProposals.expiresAt, sql`now()`),
      ),
    )
    .returning();
  if (row === undefined) return null;
  await audit(row, 'expired', SWEEP_ACTOR, { before: PENDING, after: { status: row.status } }, log);
  await publishUpdated(row, log);
  return row;
}

/**
 * The sweep (cron `ai-proposal-sweep`): expires unclaimed pending proposals
 * past their expiry, and fails claims older than the claim timeout (a confirm
 * whose process died; whether the route ran is unknown, so it is never
 * retried). Returns the counts.
 */
export async function sweepAiProposals(
  log: ServiceLogger = moduleLogger,
): Promise<{ expired: number; interrupted: number }> {
  const expired = await db
    .update(aiProposals)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(
      and(
        eq(aiProposals.status, 'pending'),
        isNull(aiProposals.decidedAt),
        lte(aiProposals.expiresAt, sql`now()`),
      ),
    )
    .returning();
  for (const row of expired) {
    await audit(
      row,
      'expired',
      SWEEP_ACTOR,
      { before: PENDING, after: { status: row.status } },
      log,
    );
    await publishUpdated(row, log);
  }
  const cutoff = new Date(Date.now() - AI_PROPOSAL_CLAIM_TIMEOUT_MS);
  const interrupted = await db
    .update(aiProposals)
    .set({
      status: 'failed',
      result: { httpStatus: 0, body: { error: 'interrupted' } },
      updatedAt: sql`now()`,
    })
    .where(and(eq(aiProposals.status, 'pending'), lt(aiProposals.decidedAt, cutoff)))
    .returning();
  for (const row of interrupted) {
    await audit(
      row,
      'failed',
      SWEEP_ACTOR,
      {
        before: { ...PENDING, decidedBy: row.decidedBy },
        after: { status: row.status },
        notes: 'The confirm did not finish',
      },
      log,
    );
    await publishUpdated(row, log);
  }
  return { expired: expired.length, interrupted: interrupted.length };
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

function param(precondition: AiProposalPrecondition, name: string): string | null {
  const value = precondition.params[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Whether the state a proposal was made for still holds. Checked at confirm
 * time; false ends the proposal `stale`.
 * - `session_active` `{ sessionId, transactionId? }`: the session is still active (same transaction).
 * - `station_faulted` `{ stationId }`: the station's availability is still `faulted`.
 * - `station_availability` `{ stationId, availability }`: the station's availability is unchanged.
 */
export async function aiProposalPreconditionHolds(
  precondition: AiProposalPrecondition,
): Promise<boolean> {
  switch (precondition.kind) {
    case 'session_active': {
      const sessionId = param(precondition, 'sessionId');
      if (sessionId === null) return false;
      const [session] = await db
        .select({ status: chargingSessions.status, transactionId: chargingSessions.transactionId })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, sessionId));
      const transactionId = param(precondition, 'transactionId');
      return (
        session !== undefined &&
        session.status === 'active' &&
        (transactionId === null || session.transactionId === transactionId)
      );
    }
    case 'station_faulted':
    case 'station_availability': {
      const stationId = param(precondition, 'stationId');
      if (stationId === null) return false;
      const [station] = await db
        .select({ availability: chargingStations.availability })
        .from(chargingStations)
        .where(eq(chargingStations.id, stationId));
      if (station === undefined) return false;
      const expected =
        precondition.kind === 'station_faulted' ? 'faulted' : param(precondition, 'availability');
      return station.availability === expected;
    }
  }
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Names of the API keys that asked for MCP proposals, by key id. A revoked
 * (deleted) key has no name: its proposals show none.
 */
export async function aiProposalApiKeyNames(
  rows: readonly AiProposalRow[],
): Promise<Map<number, string>> {
  const ids = [...new Set(rows.map((r) => r.apiKeyId).filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const keys = await db
    .select({ id: refreshTokens.id, name: refreshTokens.name })
    .from(refreshTokens)
    .where(
      and(
        inArray(refreshTokens.id, ids),
        eq(refreshTokens.type, 'api_key'),
        isNull(refreshTokens.revokedAt),
      ),
    );
  return new Map(
    keys
      .filter((k): k is { id: number; name: string } => k.name != null)
      .map((k) => [k.id, k.name]),
  );
}

/** The DTO of a proposal; `apiKeyNames` from `aiProposalApiKeyNames`. */
export function toAiProposalDto(
  row: AiProposalRow,
  apiKeyNames: ReadonlyMap<number, string>,
): AiProposalDto {
  const precondition = aiProposalPreconditionSchema.safeParse(row.precondition);
  const result = aiProposalResultSchema.safeParse(row.result);
  return {
    id: row.id,
    source: row.source as AiProposalSource,
    job: (AI_WORKER_JOBS as readonly string[]).includes(row.job ?? '')
      ? (row.job as AiWorkerJob)
      : null,
    insightId: row.insightId,
    requestedByUserId: row.requestedByUserId,
    apiKeyName: row.apiKeyId != null ? (apiKeyNames.get(row.apiKeyId) ?? null) : null,
    siteId: row.siteId,
    stationId: row.stationId,
    sessionId: row.sessionId,
    operationId: row.operationId,
    method: row.method,
    path: row.path,
    args: row.args as Record<string, unknown>,
    argsHash: row.argsHash,
    summary: row.summary as Record<string, unknown>,
    rationaleText: row.rationaleText,
    rationaleLanguage: row.rationaleLanguage,
    precondition: row.precondition == null || !precondition.success ? null : precondition.data,
    status: (AI_PROPOSAL_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as AiProposalStatus)
      : 'failed',
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    executedAt: iso(row.executedAt),
    result: row.result == null || !result.success ? null : result.data,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Deletes proposals in a final status last changed more than `retentionDays`
 * ago (cron `ai-retention-prune`). Pending proposals are never deleted; their
 * audit rows stay under the audit retention.
 */
export async function pruneAiProposals(retentionDays: number): Promise<number> {
  const rows = await db
    .delete(aiProposals)
    .where(
      and(
        ne(aiProposals.status, 'pending'),
        lt(aiProposals.updatedAt, sql`now() - ${retentionDays} * interval '1 day'`),
      ),
    )
    .returning({ id: aiProposals.id });
  return rows.length;
}
