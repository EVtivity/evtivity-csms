// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The `ocpi-cdrs` BullMQ queue, owned by the OCPI server (producer and
// consumer), so no other process imports OCPI code:
//
// - `cdr` (jobId `cdr-<sessionId>`): issue the CDR of a completed CPO session
//   and POST it to the partner. Added by the push listener after it pushes a
//   completed session (every OCPI replica adds the same jobId, so one job
//   runs) and by the sweep.
// - `cdr-sweep` (job scheduler, every 5 minutes): adds `cdr` jobs for
//   completed sessions of the last 24 hours without a CDR (a lost pub/sub
//   message, an OCPI restart), `cdr-push` jobs for credit CDRs of the last 24
//   hours not pushed yet (the API's operator credit stores them pending), and
//   `legacy-evse-removal` jobs. It also prunes `ocpi_removed_evses` past the
//   retention period, and runs one step of the one-time CDR backfill
//   (`runCdrBackfillStep`).
// - `cdr-push` (jobId `cdr-push-<ocpiCdrId>`): POST a stored CDR.
// - `legacy-evse-removal` (jobId `legacy-evse-removal-<partnerId>`): sends
//   REMOVED once per partner for the EVSE uids published before v0.1.32.

import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import { and, asc, eq, gt, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  isRoamingEnabled,
  ocpiCdrBackfill,
  ocpiCdrs,
  pruneRemovedOcpiEvses,
  ocpiPartnerEndpoints,
  ocpiPartners,
  ocpiRoamingSessions,
} from '@evtivity/database';
import { createBullMQConnection, createLogger, logBullMQErrors } from '@evtivity/lib';
import { issueSessionCdr, pushCdr } from './cdr.service.js';
import { pushLegacyEvseRemoval } from './push.service.js';

const logger = createLogger('ocpi-cdr-jobs');

export const OCPI_CDR_QUEUE = 'ocpi-cdrs';

/** A CDR is issued a minute after the session push, so late cost updates land first. */
export const CDR_DELAY_MS = 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;
/** The sweep covers sessions that ended between 2 minutes and 24 hours ago. */
const SWEEP_MIN_AGE_MS = 2 * 60_000;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60_000;
const SWEEP_BATCH = 500;
/** The one-time backfill covers sessions that ended this long before its cutoff. */
export const BACKFILL_WINDOW_DAYS = 30;
/** Backfill sessions scheduled per sweep tick (every 5 minutes), at most 600 an hour. */
const BACKFILL_BATCH = 50;
/** Spacing of the backfill jobs of one tick, so partners get one CDR every few seconds. */
const BACKFILL_SPACING_MS = 5_000;

export function cdrJobId(sessionId: string): string {
  return `cdr-${sessionId}`;
}

export function cdrPushJobId(ocpiCdrId: string): string {
  return `cdr-push-${ocpiCdrId}`;
}

export function legacyRemovalJobId(partnerId: string): string {
  return `legacy-evse-removal-${partnerId}`;
}

export function createOcpiCdrQueue(connection: ConnectionOptions): Queue {
  return new Queue(OCPI_CDR_QUEUE, {
    connection,
    defaultJobOptions: {
      // Completed jobs are kept longer than the sweep window, so their jobId
      // still dedups a re-add from the sweep or a later session push.
      removeOnComplete: { age: 2 * 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });
}

/** Schedules the CDR of a session (idempotent per session, P7). */
export async function scheduleSessionCdr(
  queue: Queue,
  sessionId: string,
  delayMs = CDR_DELAY_MS,
): Promise<void> {
  await queue.add(
    'cdr',
    { sessionId },
    {
      jobId: cdrJobId(sessionId),
      delay: delayMs,
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

/**
 * Issues the session's CDR and POSTs it to the partner. A failed POST throws
 * so BullMQ retries; the stored CDR is reused, so a retry sends the same CDR.
 */
export async function runCdrJob(sessionId: string): Promise<void> {
  const issued = await issueSessionCdr(sessionId);
  if (issued.status !== 'created' && issued.status !== 'existing') {
    logger.debug({ sessionId, status: issued.status }, 'No CDR for session');
    return;
  }
  const pushed = await pushCdr(issued.cdrId);
  if (pushed === 'failed') {
    throw new Error(`CDR ${issued.cdrId} push failed`);
  }
}

/** POSTs a stored CDR (a credit CDR); a failed POST throws so BullMQ retries. */
export async function runCdrPushJob(ocpiCdrId: string): Promise<void> {
  if ((await pushCdr(ocpiCdrId)) === 'failed') {
    throw new Error(`CDR ${ocpiCdrId} push failed`);
  }
}

/**
 * Sends REMOVED for the partner's pre-v0.1.32 EVSE uids, then marks the
 * partner done. Nothing is marked when the partner has no locations receiver
 * or token yet.
 */
export async function runLegacyEvseRemovalJob(partnerId: string): Promise<void> {
  const sent = await pushLegacyEvseRemoval(partnerId);
  if (sent == null) return;
  await db
    .update(ocpiPartners)
    .set({ legacyEvseUidsRemovedAt: new Date() })
    .where(and(eq(ocpiPartners.id, partnerId), isNull(ocpiPartners.legacyEvseUidsRemovedAt)));
  logger.info({ partnerId, sent }, 'Legacy EVSE uids removed at partner');
}

/**
 * One step of the one-time CDR backfill (owner decision for v0.1.38):
 * completed roaming sessions that ended in the BACKFILL_WINDOW_DAYS before
 * the cutoff (the time migration 0141 ran) get their CDR through the same
 * `cdr-<sessionId>` jobs, so a session the sweep already scheduled is not
 * scheduled twice, and `issueSessionCdr` never issues a second CDR. Each step
 * takes the next BACKFILL_BATCH sessions after the cursor (ended_at, id),
 * schedules them BACKFILL_SPACING_MS apart, then advances the cursor; a
 * crash re-schedules at most one batch, which the jobIds dedup. An empty
 * step marks the backfill completed, and it never runs again. Recipient and
 * P5 rules are the job's (session's eMSP only, completed sessions only).
 */
export async function runCdrBackfillStep(queue: Queue): Promise<void> {
  const [state] = await db.select().from(ocpiCdrBackfill).where(eq(ocpiCdrBackfill.id, 1)).limit(1);
  if (state == null || state.completedAt != null) return;

  const from = new Date(state.cutoffAt.getTime() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60_000);
  const cursor =
    state.cursorEndedAt != null && state.cursorSessionId != null
      ? sql`(${chargingSessions.endedAt}, ${chargingSessions.id}) > (${state.cursorEndedAt}, ${state.cursorSessionId})`
      : sql`true`;
  const sessions = await db
    .select({ sessionId: chargingSessions.id, endedAt: chargingSessions.endedAt })
    .from(ocpiRoamingSessions)
    .innerJoin(chargingSessions, eq(chargingSessions.id, ocpiRoamingSessions.chargingSessionId))
    .where(
      and(
        eq(chargingSessions.status, 'completed'),
        gte(chargingSessions.endedAt, from),
        lt(chargingSessions.endedAt, state.cutoffAt),
        cursor,
        sql`NOT EXISTS (
          SELECT 1 FROM ocpi_cdrs c
          WHERE c.charging_session_id = ${chargingSessions.id} AND c.is_credit = false
        )`,
      ),
    )
    .orderBy(asc(chargingSessions.endedAt), asc(chargingSessions.id))
    .limit(BACKFILL_BATCH);

  const last = sessions[sessions.length - 1];
  if (last?.endedAt == null) {
    await db
      .update(ocpiCdrBackfill)
      .set({ completedAt: new Date() })
      .where(and(eq(ocpiCdrBackfill.id, 1), isNull(ocpiCdrBackfill.completedAt)));
    logger.info('One-time CDR backfill completed');
    return;
  }
  for (const [i, { sessionId }] of sessions.entries()) {
    await scheduleSessionCdr(queue, sessionId, i * BACKFILL_SPACING_MS);
  }
  await db
    .update(ocpiCdrBackfill)
    .set({ cursorEndedAt: last.endedAt, cursorSessionId: last.sessionId })
    .where(eq(ocpiCdrBackfill.id, 1));
  logger.info({ sessions: sessions.length }, 'CDR backfill scheduled a batch');
}

/** Adds the jobs the sweep finds missing. Does nothing while roaming is off. */
export async function runCdrSweep(queue: Queue, now: Date = new Date()): Promise<void> {
  if (!(await isRoamingEnabled())) return;

  // Removed EVSEs past their retention period (served as REMOVED until then).
  await pruneRemovedOcpiEvses(now);
  await runCdrBackfillStep(queue);

  const sessions = await db
    .select({ sessionId: chargingSessions.id })
    .from(ocpiRoamingSessions)
    .innerJoin(chargingSessions, eq(chargingSessions.id, ocpiRoamingSessions.chargingSessionId))
    .where(
      and(
        eq(chargingSessions.status, 'completed'),
        lt(chargingSessions.endedAt, new Date(now.getTime() - SWEEP_MIN_AGE_MS)),
        gt(chargingSessions.endedAt, new Date(now.getTime() - SWEEP_MAX_AGE_MS)),
        sql`NOT EXISTS (
          SELECT 1 FROM ocpi_cdrs c
          WHERE c.charging_session_id = ${chargingSessions.id} AND c.is_credit = false
        )`,
      ),
    )
    .limit(SWEEP_BATCH);
  for (const { sessionId } of sessions) {
    await scheduleSessionCdr(queue, sessionId, 0);
  }

  const credits = await db
    .select({ ocpiCdrId: ocpiCdrs.ocpiCdrId })
    .from(ocpiCdrs)
    .where(
      and(
        eq(ocpiCdrs.isCredit, true),
        isNotNull(ocpiCdrs.chargingSessionId),
        eq(ocpiCdrs.pushStatus, 'pending'),
        gt(ocpiCdrs.createdAt, new Date(now.getTime() - SWEEP_MAX_AGE_MS)),
      ),
    )
    .limit(SWEEP_BATCH);
  for (const { ocpiCdrId } of credits) {
    await queue.add(
      'cdr-push',
      { cdrId: ocpiCdrId },
      {
        jobId: cdrPushJobId(ocpiCdrId),
        attempts: 8,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
  }

  const partners = await db
    .selectDistinct({ id: ocpiPartners.id })
    .from(ocpiPartners)
    .innerJoin(
      ocpiPartnerEndpoints,
      and(
        eq(ocpiPartnerEndpoints.partnerId, ocpiPartners.id),
        eq(ocpiPartnerEndpoints.module, 'locations'),
        eq(ocpiPartnerEndpoints.interfaceRole, 'RECEIVER'),
      ),
    )
    .where(and(eq(ocpiPartners.status, 'connected'), isNull(ocpiPartners.legacyEvseUidsRemovedAt)));
  for (const { id } of partners) {
    await queue.add(
      'legacy-evse-removal',
      { partnerId: id },
      {
        jobId: legacyRemovalJobId(id),
        attempts: 5,
        backoff: { type: 'exponential', delay: 60_000 },
      },
    );
  }

  if (sessions.length > 0 || credits.length > 0 || partners.length > 0) {
    logger.info(
      { cdrs: sessions.length, creditCdrs: credits.length, legacyRemovals: partners.length },
      'OCPI sweep scheduled jobs',
    );
  }
}

export async function processOcpiCdrJob(job: Job, queue: Queue): Promise<void> {
  const data = job.data as { sessionId?: string; partnerId?: string; cdrId?: string };
  switch (job.name) {
    case 'cdr':
      if (data.sessionId != null) await runCdrJob(data.sessionId);
      return;
    case 'cdr-push':
      if (data.cdrId != null) await runCdrPushJob(data.cdrId);
      return;
    case 'legacy-evse-removal':
      if (data.partnerId != null) await runLegacyEvseRemovalJob(data.partnerId);
      return;
    case 'cdr-sweep':
      await runCdrSweep(queue);
      return;
    default:
      logger.warn({ name: job.name }, 'Unknown OCPI job');
  }
}

export interface OcpiCdrJobs {
  queue: Queue;
  /** For the push listener: schedule the CDR of a completed session. */
  scheduleSessionCdr: (sessionId: string) => Promise<void>;
  stop: () => Promise<void>;
}

/** Creates the queue, its sweep scheduler, and its worker (one Redis connection each). */
export async function startOcpiCdrJobs(redisUrl: string): Promise<OcpiCdrJobs> {
  const queue = logBullMQErrors(
    createOcpiCdrQueue(createBullMQConnection(redisUrl)),
    OCPI_CDR_QUEUE,
  );
  await queue.upsertJobScheduler(
    'ocpi-cdr-sweep',
    { every: SWEEP_EVERY_MS },
    { name: 'cdr-sweep' },
  );

  const worker = new Worker(OCPI_CDR_QUEUE, (job) => processOcpiCdrJob(job, queue), {
    connection: createBullMQConnection(redisUrl),
    concurrency: 5,
  });
  // BullMQ re-emits connection errors on each Queue and Worker.
  logBullMQErrors(worker, OCPI_CDR_QUEUE);
  worker.on('failed', (job, err) => {
    logger.error(
      { jobName: job?.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err },
      'OCPI job failed',
    );
  });

  return {
    queue,
    scheduleSessionCdr: (sessionId) => scheduleSessionCdr(queue, sessionId),
    stop: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
