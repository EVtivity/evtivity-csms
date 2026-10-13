// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Insight actions (`ai_proposals`): the write a background worker suggests
 * with an automatic insight. This service is the only writer of
 * `ai_proposals` and `ai_proposal_audit_log` (P3). The worker creates them
 * (each with its insight); the API claims, finishes and rejects them. Nothing
 * here runs an action: the API runs a confirmed one through
 * `executeConfirmedToolCall`, as the confirming operator. The action has no
 * status of its own for readers: `ai-insight.service` keeps the insight's one
 * status, and this service calls it when the action changes state (created:
 * `markInsightActionPending`; ended: `closeActionInsight`).
 *
 * Status moves once, from `pending` to a terminal status, by compare-and-set
 * (P5). A confirm first claims the row (`decided_by`, `decided_at`, status
 * still `pending`) so concurrent confirms run it once (P7), and a reject or
 * the expiry sweep never takes a claimed row.
 */

import { and, eq, inArray, isNull, lte, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  db,
  aiProposals,
  aiProposalAuditLog,
  chargingSessions,
  chargingStations,
  writeAudit,
} from '@evtivity/database';
import type { AuditActor } from '@evtivity/database';
import { aiArgsHash, createLogger } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
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
  AiProposalStatus,
  AiWorkerJob,
} from '@evtivity/lib/ai-proposals';
import {
  AI_INSIGHT_UPDATED_EVENT,
  closeActionInsight,
  markInsightActionPending,
  publishInsightUpdated,
} from './ai-insight.service.js';

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
 * `ai.insight.updated` on `csms_events` (filtered by site in the SSE stream)
 * for the insight that carries the action, so every insight view refreshes.
 */
async function publishUpdated(row: AiProposalRow, log: ServiceLogger): Promise<void> {
  try {
    await getPubSub().publish(
      'csms_events',
      JSON.stringify({
        eventType: AI_INSIGHT_UPDATED_EVENT,
        insightId: row.insightId,
        siteId: row.siteId,
        stationId: row.stationId,
        sessionId: row.sessionId,
      }),
    );
  } catch (err) {
    log.warn({ err, proposalId: row.id }, 'AI insight action event publish failed');
  }
}

/**
 * After an action left `pending`: publishes the update and moves its insight
 * to the status the end leaves (`closeActionInsight`: done, rejected,
 * expired, resolved, or open again after a failure). Fail-open (P9): the
 * action's status is already stored.
 */
async function afterEnd(
  row: AiProposalRow,
  actor: AiProposalActor,
  log: ServiceLogger,
  options: { dismissInsight?: boolean } = {},
): Promise<void> {
  await publishUpdated(row, log);
  if (row.status === 'pending') return;
  try {
    await closeActionInsight(
      row.insightId,
      row.status as Exclude<AiProposalStatus, 'pending'>,
      { actor: actor.actor, actorUserId: actor.actorUserId ?? null },
      getPubSub(),
      { dismiss: options.dismissInsight === true },
    );
  } catch (err) {
    log.warn({ err, proposalId: row.id }, 'Closing the insight of an ended action failed');
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
  job: AiWorkerJob;
  /** The insight that carries the action (`storeWorkerActionInsight`). */
  insightId: string;
  workerRunId?: number | null;
  siteId: string | null;
  stationId?: string | null;
  sessionId?: string | null;
  operationId: string;
  method: string;
  path: string;
  args: Record<string, unknown>;
  summary?: Record<string, unknown>;
  precondition?: AiProposalPrecondition | null;
  /** One pending proposal per key: a second create with the same key returns null. */
  dedupKey?: string | null;
  expiresAt: Date;
  actor: AiProposalActor;
}

export class AiProposalInputError extends Error {}

function checkCreateInput(input: CreateAiProposalInput, now: Date): void {
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new AiProposalInputError('A proposal must expire in the future');
  }
  if (input.precondition != null) aiProposalPreconditionSchema.parse(input.precondition);
  if (input.insightId === '') throw new AiProposalInputError('An action names its insight');
  // A worker may suggest only the closed action set (TC-AI-WK-05).
  if (!AI_WORKER_JOBS.includes(input.job)) {
    throw new AiProposalInputError('An action names its worker job');
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
  // The action and its insight's move to pending commit together: an action
  // whose insight did not move would wait for a decision no one can take.
  // An insight no longer open (resolved or dismissed meanwhile) gets no action.
  const created = await db
    .transaction(async (tx) => {
      const [inserted] = await tx
        .insert(aiProposals)
        .values({
          job: input.job,
          insightId: input.insightId,
          workerRunId: input.workerRunId ?? null,
          siteId: target.siteId,
          stationId: target.stationId,
          sessionId: target.sessionId,
          operationId: input.operationId,
          method: input.method,
          path: input.path,
          args: input.args,
          argsHash: aiArgsHash(input.args),
          summary: input.summary ?? {},
          precondition: input.precondition ?? null,
          dedupKey: input.dedupKey ?? null,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing({
          target: aiProposals.dedupKey,
          where: sql`${aiProposals.status} = 'pending' AND ${aiProposals.dedupKey} IS NOT NULL`,
        })
        .returning();
      if (inserted === undefined) return null;
      const insight = await markInsightActionPending(tx, inserted.insightId);
      if (insight === null) throw new InsightNotOpen();
      return { row: inserted, insight };
    })
    .catch((err: unknown) => {
      if (err instanceof InsightNotOpen) return null;
      throw err;
    });
  if (created === null) return null;
  const { row, insight } = created;
  await audit(
    row,
    'created',
    input.actor,
    { after: { ...auditState(row), job: row.job, insightId: row.insightId, args: row.args } },
    log,
  );
  await publishUpdated(row, log);
  await publishInsightUpdated(getPubSub(), insight);
  return row;
}

/** Rolls back an action insert whose insight is no longer open. */
class InsightNotOpen extends Error {}

// ---------------------------------------------------------------------------
// Read (site scope)
// ---------------------------------------------------------------------------

/** The site condition of a read: null siteIds is every site; unsited actions only for all-site users. */
export function aiProposalSiteCondition(siteIds: readonly string[] | null): SQL {
  if (siteIds === null) return sql`true`;
  if (siteIds.length === 0) return sql`false`;
  return inArray(aiProposals.siteId, [...siteIds]);
}

/** The actions of these insights, by insight id (at most one each). */
export async function insightActionRows(
  insightIds: readonly string[],
): Promise<Map<string, AiProposalRow>> {
  if (insightIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(aiProposals)
    .where(inArray(aiProposals.insightId, [...insightIds]));
  return new Map(rows.map((r) => [r.insightId, r]));
}

/** Whether an action with this dedup key waits for a decision (a suggestion is then not repeated). */
export async function hasPendingAiProposal(dedupKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: aiProposals.id })
    .from(aiProposals)
    .where(and(eq(aiProposals.dedupKey, dedupKey), eq(aiProposals.status, 'pending')))
    .limit(1);
  return row !== undefined;
}

/** The action an insight carries, or null. */
export async function getInsightActionRow(insightId: string): Promise<AiProposalRow | null> {
  const [row] = await db.select().from(aiProposals).where(eq(aiProposals.insightId, insightId));
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
  await afterEnd(row, actor, log);
  return row;
}

export type AiProposalRejection =
  | { kind: 'rejected'; row: AiProposalRow }
  /** Past its expiry: the row is now `expired`, not rejected. */
  | { kind: 'expired'; row: AiProposalRow }
  /** Decided before, or claimed by a confirm that is running. */
  | { kind: 'decided'; row: AiProposalRow }
  | { kind: 'not_found' };

/**
 * Rejects a pending, unclaimed, unexpired proposal. Audits `rejected`.
 * `dismissInsight` (the insight's dismiss route) closes the insight
 * `dismissed` instead of `rejected`.
 */
export async function rejectAiProposal(
  id: string,
  actor: AiProposalActor & { actorUserId: string },
  log: ServiceLogger = moduleLogger,
  options: { dismissInsight?: boolean } = {},
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
    await afterEnd(row, actor, log, options);
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
  await afterEnd(row, SWEEP_ACTOR, log);
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
    await afterEnd(row, SWEEP_ACTOR, log);
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
    await afterEnd(row, SWEEP_ACTOR, log);
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

/** The DTO of an action (`action` of the insight DTO). */
export function toAiProposalDto(row: AiProposalRow): AiProposalDto {
  const precondition = aiProposalPreconditionSchema.safeParse(row.precondition);
  const result = aiProposalResultSchema.safeParse(row.result);
  return {
    id: row.id,
    job: (AI_WORKER_JOBS as readonly string[]).includes(row.job ?? '')
      ? (row.job as AiWorkerJob)
      : null,
    insightId: row.insightId,
    siteId: row.siteId,
    stationId: row.stationId,
    sessionId: row.sessionId,
    operationId: row.operationId,
    method: row.method,
    path: row.path,
    args: row.args as Record<string, unknown>,
    argsHash: row.argsHash,
    summary: row.summary as Record<string, unknown>,
    precondition: row.precondition == null || !precondition.success ? null : precondition.data,
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    executedAt: iso(row.executedAt),
    result: row.result == null || !result.success ? null : result.data,
    createdAt: row.createdAt.toISOString(),
  };
}
