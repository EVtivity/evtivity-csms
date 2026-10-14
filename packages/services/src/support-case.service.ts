// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The single writer of support cases (design principle P3, plan v0.1.45
 * section 2.13): `support_cases`, `support_case_messages`,
 * `support_case_sessions`, `support_case_reads`, `support_case_attachments`
 * rows and `support_case_audit_log`. Operator routes, portal routes and the
 * worker (driver AI analysis and sweeper) call it; a guard test
 * (`support-case-writer-guard.test.ts`, TC-AI-DR-21) fails on a write anywhere
 * else.
 *
 * Driver AI states (`ai_state`) move only forward, by compare-and-set from
 * the state the caller read (P5): `queued -> analyzing -> awaiting_feedback`,
 * then one of the terminal states `resolved_by_ai`, `escalated`, `failed`,
 * `skipped`. A case leaves `ai_assist` for `open` whenever the AI step ends
 * without the driver saying the answer solved the issue, so a person always
 * gets it.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  client,
  db,
  supportCaseAttachments,
  supportCaseAuditLog,
  supportCaseMessages,
  supportCaseReads,
  supportCaseSessions,
  supportCases,
  redactAuditPayload,
  writeAudit,
} from '@evtivity/database';
import type { AuditActor } from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  DRIVER_AI_ANSWERED_EVENT,
  DRIVER_AI_OPEN_STATES,
  DRIVER_AI_REQUESTS_CHANNEL,
  SUPPORT_CASE_AI_ASSIST_STATUS,
  SUPPORT_CASE_ASSISTANT_SENDER,
} from '@evtivity/lib/driver-ai';
import type {
  DriverActionCode,
  DriverAiConsentDecision,
  DriverAiOpenState,
  DriverAiState,
  DriverAiStateReason,
  SupportCaseCategory,
} from '@evtivity/lib/driver-ai';
import { dispatchOperatorNotification, notifySupportCaseEvent } from './support-case-notify.js';
import { ALL_TEMPLATES_DIRS } from './template-dirs.js';

export type SupportCaseRow = typeof supportCases.$inferSelect;
export type SupportCaseMessageRow = typeof supportCaseMessages.$inferSelect;
export type SupportCaseAttachmentRow = typeof supportCaseAttachments.$inferSelect;
export type SupportCasePriority = SupportCaseRow['priority'];
export type SupportCaseStatus = SupportCaseRow['status'];

/** Who made a change, as the audit log records it (`getAuditActor` in the API). */
export interface SupportCaseActor {
  actor: AuditActor;
  actorUserId?: string | null;
  actorDriverId?: string | null;
  actorApiKeyId?: string | null;
  actorLabel?: string | null;
}

interface WarnLogger {
  warn: (obj: unknown, msg?: string) => void;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const AUDIT = { table: supportCaseAuditLog, idColumn: 'support_case_id' } as const;

/** The system actor of the worker's driver AI steps. */
export const DRIVER_AI_SYSTEM_ACTOR: SupportCaseActor = {
  actor: 'system',
  actorLabel: 'driver-ai',
};

async function audit(
  caseId: string,
  action: string,
  actor: SupportCaseActor,
  fields: { before?: unknown; after?: unknown },
  executor: Tx | typeof db = db,
  log?: WarnLogger,
): Promise<void> {
  await writeAudit(
    AUDIT,
    { entityId: caseId, entityIdSnapshot: caseId, action, ...actor, ...fields },
    executor,
    log,
  );
}

/**
 * Inserts an audit row in the caller's transaction and throws on failure.
 * `writeAudit` is fail-open, but a failed insert inside a transaction aborts
 * it (Postgres 25P02) and the commit then rolls the change back silently. So
 * audits that are part of the change itself (the consent, P11 layer 2) use
 * this; every other audit runs after the commit through `audit()`.
 */
async function auditInTransaction(
  tx: Tx,
  caseId: string,
  action: string,
  actor: SupportCaseActor,
  fields: { before?: unknown; after?: unknown },
): Promise<void> {
  await tx.insert(supportCaseAuditLog).values({
    supportCaseId: caseId,
    supportCaseIdSnapshot: caseId,
    action: action as (typeof supportCaseAuditLog.$inferInsert)['action'],
    actor: actor.actor,
    actorUserId: actor.actorUserId ?? null,
    actorDriverId: actor.actorDriverId ?? null,
    actorApiKeyId: actor.actorApiKeyId ?? null,
    actorLabel: actor.actorLabel ?? null,
    before: fields.before == null ? null : redactAuditPayload(fields.before),
    after: fields.after == null ? null : redactAuditPayload(fields.after),
  });
}

async function nextCaseNumber(executor: Tx | typeof db): Promise<string> {
  const result = await executor.execute(sql`SELECT nextval('support_case_number_seq') as val`);
  const seq = Number((result as unknown as Array<{ val: string }>)[0]?.val ?? 1);
  return `CASE-${String(seq).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** The consent the driver gave with a new case (`aiConsent` of the portal create). */
export interface SupportCaseAiConsent {
  decision: DriverAiConsentDecision;
  noticeVersion: number;
  language: string;
}

export interface CreateSupportCaseInput {
  subject: string;
  description: string;
  category: SupportCaseCategory;
  priority: SupportCasePriority;
  driverId: string | null;
  stationId: string | null;
  assignedTo: string | null;
  sessionIds: string[];
  /** Who opened the case: the driver (portal) or an operator. */
  openedBy: { type: 'driver'; driverId: string } | { type: 'operator'; userId: string };
  actor: SupportCaseActor;
  /**
   * The driver's choice, checked by the route (the feature is on, the notice
   * is current). Null: the driver was not asked (feature off, old app build,
   * operator case).
   */
  aiConsent?: SupportCaseAiConsent | null;
  /**
   * With granted consent: why the AI step cannot run (the per-minute limit),
   * so the case goes to operators at once as `skipped`. Null: queued.
   */
  aiSkipReason?: DriverAiStateReason | null;
  log?: WarnLogger;
}

/**
 * Creates a case with its first message (the description) and linked
 * sessions, in one transaction with its audit rows. Then notifies: a driver
 * case reaches operators unless the AI handles it first (`ai_assist`, E4); an
 * operator case notifies its driver. A granted, queued case is not published
 * here: the route calls `requestDriverAiAnalysis` after this returns (P4: the
 * row exists before the request).
 */
export async function createSupportCase(input: CreateSupportCaseInput): Promise<SupportCaseRow> {
  const consent = input.aiConsent ?? null;
  const granted = consent?.decision === 'granted';
  const aiQueued = granted && input.aiSkipReason == null;
  const now = new Date();

  const created = await db.transaction(async (tx) => {
    const caseNumber = await nextCaseNumber(tx);
    const [row] = await tx
      .insert(supportCases)
      .values({
        caseNumber,
        subject: input.subject,
        description: input.description,
        category: input.category,
        priority: input.priority,
        driverId: input.driverId,
        stationId: input.stationId,
        assignedTo: input.assignedTo,
        createdByDriver: input.openedBy.type === 'driver',
        status: aiQueued ? SUPPORT_CASE_AI_ASSIST_STATUS : 'open',
        ...(consent != null
          ? {
              aiConsent: consent.decision,
              aiConsentAt: now,
              aiConsentLanguage: consent.language,
              aiConsentNoticeVersion: consent.noticeVersion,
            }
          : {}),
        ...(granted
          ? {
              aiState: aiQueued ? 'queued' : 'skipped',
              aiStateReason: aiQueued ? null : (input.aiSkipReason ?? null),
            }
          : {}),
      })
      .returning();
    if (row == null) throw new Error('Failed to create support case');

    if (input.sessionIds.length > 0) {
      await tx
        .insert(supportCaseSessions)
        .values(input.sessionIds.map((sessionId) => ({ caseId: row.id, sessionId })));
    }

    await tx.insert(supportCaseMessages).values({
      caseId: row.id,
      senderType: input.openedBy.type,
      senderId: input.openedBy.type === 'driver' ? input.openedBy.driverId : input.openedBy.userId,
      body: input.description,
      isInternal: false,
    });

    if (consent != null) {
      // A case with a consent commits with its creation and consent audit rows
      // or not at all (P11 layer 2): fail-closed inserts.
      await auditInTransaction(tx, row.id, 'created', input.actor, { after: row });
      await auditInTransaction(
        tx,
        row.id,
        granted ? 'ai_consent_granted' : 'ai_consent_declined',
        input.actor,
        {
          after: {
            decision: consent.decision,
            noticeVersion: consent.noticeVersion,
            language: consent.language,
            at: now.toISOString(),
          },
        },
      );
    }
    return row;
  });

  if (consent == null) {
    await audit(created.id, 'created', input.actor, { after: created }, db, input.log);
  }
  if (input.sessionIds.length > 0) {
    await audit(
      created.id,
      'sessions_linked',
      input.actor,
      { after: { sessionIds: input.sessionIds } },
      db,
      input.log,
    );
  }
  if (granted && !aiQueued) {
    await audit(
      created.id,
      'escalated_from_ai',
      DRIVER_AI_SYSTEM_ACTOR,
      { after: { aiState: 'skipped', reason: input.aiSkipReason ?? null } },
      db,
      input.log,
    );
  }

  if (input.openedBy.type === 'driver') {
    if (!aiQueued) {
      void dispatchOperatorNotification(
        'new_case',
        created.id,
        created.caseNumber,
        created.subject,
        created.assignedTo,
      );
    }
    void notifySupportCaseEvent('supportCase.created', created.id, input.driverId, {
      toOperators: !aiQueued,
    });
  } else {
    if (input.driverId != null) {
      void dispatchDriverNotification(
        client,
        'supportCase.Created',
        input.driverId,
        { caseNumber: created.caseNumber, subject: created.subject, category: created.category },
        ALL_TEMPLATES_DIRS,
        getPubSub(),
      );
    }
    void notifySupportCaseEvent('supportCase.created', created.id, input.driverId);
  }
  return created;
}

/**
 * Asks the worker for the analysis of a queued case. Fail-open (P9): a lost
 * request is queued again by the `driver-ai-sweep` cron, with the same job id.
 */
export async function requestDriverAiAnalysis(
  caseId: string,
  log?: WarnLogger,
  pubsub: PubSubClient = getPubSub(),
): Promise<void> {
  try {
    await pubsub.publish(DRIVER_AI_REQUESTS_CHANNEL, JSON.stringify({ caseId }));
  } catch (err) {
    log?.warn({ err, caseId }, 'Driver AI request not published; the sweeper queues it');
  }
}

// ---------------------------------------------------------------------------
// Operator changes
// ---------------------------------------------------------------------------

export interface UpdateSupportCaseInput {
  existing: SupportCaseRow;
  /** Operator-settable statuses only (never `ai_assist`). */
  status?: Exclude<SupportCaseStatus, 'ai_assist'> | undefined;
  priority?: SupportCasePriority | undefined;
  category?: SupportCaseCategory | undefined;
  /** Undefined: unchanged; null: unassign. */
  assignedTo?: string | null | undefined;
  /** The new assignee's name for the system message (checked by the route). */
  assigneeName?: string | null | undefined;
  addSessionIds?: string[] | undefined;
  removeSessionIds?: string[] | undefined;
  userId: string;
  actor: SupportCaseActor;
  log?: WarnLogger;
}

/**
 * The operator PATCH: field changes with one system message and one audit row
 * each, session link changes, the driver notice on resolve. An operator who
 * changes the status of a case the AI still handles ends the AI step as
 * escalated (the person took it over).
 */
export async function updateSupportCase(
  input: UpdateSupportCaseInput,
): Promise<SupportCaseRow | undefined> {
  const { existing } = input;
  const id = existing.id;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const systemMessages: string[] = [];
  const statusChanged = input.status != null && input.status !== existing.status;

  if (statusChanged && input.status != null) {
    updates['status'] = input.status;
    systemMessages.push(`Status changed from ${existing.status} to ${input.status}`);
    if (input.status === 'resolved') {
      updates['resolvedAt'] = new Date();
      updates['resolutionSource'] = 'operator';
    }
    if (input.status === 'closed') {
      updates['closedAt'] = new Date();
    }
    if (input.status !== 'resolved' && input.status !== 'closed') {
      updates['resolutionSource'] = null;
    }
    // An open AI step ends as escalated: the person took the case over. The
    // CASE keeps a terminal state another path wrote meanwhile (P5).
    updates['aiState'] =
      sql`CASE WHEN ${supportCases.aiState} IN ('queued', 'analyzing', 'awaiting_feedback') THEN 'escalated' ELSE ${supportCases.aiState} END`;
  }

  if (input.priority != null && input.priority !== existing.priority) {
    updates['priority'] = input.priority;
    systemMessages.push(`Priority changed from ${existing.priority} to ${input.priority}`);
  }

  if (input.category != null && input.category !== existing.category) {
    updates['category'] = input.category;
    systemMessages.push(`Category changed from ${existing.category} to ${input.category}`);
  }

  if (input.assignedTo !== undefined && input.assignedTo !== existing.assignedTo) {
    updates['assignedTo'] = input.assignedTo;
    if (input.assignedTo != null) {
      systemMessages.push(`Assigned to ${input.assigneeName ?? ''}`.trimEnd());
    } else {
      systemMessages.push('Assignment removed');
    }
  }

  if (input.addSessionIds != null && input.addSessionIds.length > 0) {
    await db
      .insert(supportCaseSessions)
      .values(input.addSessionIds.map((sid) => ({ caseId: id, sessionId: sid })))
      .onConflictDoNothing();
  }
  if (input.removeSessionIds != null && input.removeSessionIds.length > 0) {
    await db
      .delete(supportCaseSessions)
      .where(
        and(
          eq(supportCaseSessions.caseId, id),
          inArray(supportCaseSessions.sessionId, input.removeSessionIds),
        ),
      );
  }

  const [updated] = await db
    .update(supportCases)
    .set(updates)
    .where(eq(supportCases.id, id))
    .returning();

  // One round-trip for up to four field changes in one PATCH.
  if (systemMessages.length > 0) {
    await db.insert(supportCaseMessages).values(
      systemMessages.map((msg) => ({
        caseId: id,
        senderType: 'system' as const,
        senderId: input.userId,
        body: msg,
        isInternal: false,
      })),
    );
  }

  if (input.status === 'resolved' && existing.driverId != null) {
    void dispatchDriverNotification(
      client,
      'supportCase.Resolved',
      existing.driverId,
      {
        caseNumber: existing.caseNumber,
        subject: existing.subject,
        category: existing.category,
      },
      ALL_TEMPLATES_DIRS,
      getPubSub(),
    );
  }

  void notifySupportCaseEvent('supportCase.updated', id, existing.driverId);

  const { actor, log } = input;
  if (statusChanged && isOpenAiState(existing.aiState) && updated?.aiState === 'escalated') {
    await audit(
      id,
      'escalated_from_ai',
      actor,
      {
        before: { status: existing.status, aiState: existing.aiState },
        after: { status: input.status, aiState: 'escalated', reason: null },
      },
      db,
      log,
    );
  }
  if (statusChanged) {
    await audit(
      id,
      'status_changed',
      actor,
      { before: { status: existing.status }, after: { status: input.status } },
      db,
      log,
    );
  }
  if (input.priority != null && input.priority !== existing.priority) {
    await audit(
      id,
      'priority_changed',
      actor,
      { before: { priority: existing.priority }, after: { priority: input.priority } },
      db,
      log,
    );
  }
  if (input.category != null && input.category !== existing.category) {
    await audit(
      id,
      'category_changed',
      actor,
      { before: { category: existing.category }, after: { category: input.category } },
      db,
      log,
    );
  }
  if (input.assignedTo !== undefined && input.assignedTo !== existing.assignedTo) {
    await audit(
      id,
      'assigned',
      actor,
      { before: { assignedTo: existing.assignedTo }, after: { assignedTo: input.assignedTo } },
      db,
      log,
    );
  }
  if (input.addSessionIds != null && input.addSessionIds.length > 0) {
    await audit(
      id,
      'sessions_linked',
      actor,
      { after: { sessionIds: input.addSessionIds } },
      db,
      log,
    );
  }
  if (input.removeSessionIds != null && input.removeSessionIds.length > 0) {
    await audit(
      id,
      'sessions_unlinked',
      actor,
      { before: { sessionIds: input.removeSessionIds } },
      db,
      log,
    );
  }
  return updated;
}

/** An operator reply or internal note. Notifies the driver of a public reply. */
export async function addOperatorMessage(input: {
  supportCase: SupportCaseRow;
  userId: string;
  body: string;
  isInternal: boolean;
  actor: SupportCaseActor;
  log?: WarnLogger;
}): Promise<SupportCaseMessageRow | undefined> {
  const { supportCase } = input;
  const [message] = await db
    .insert(supportCaseMessages)
    .values({
      caseId: supportCase.id,
      senderType: 'operator',
      senderId: input.userId,
      body: input.body,
      isInternal: input.isInternal,
    })
    .returning();

  if (!input.isInternal && supportCase.driverId != null) {
    void dispatchDriverNotification(
      client,
      'supportCase.OperatorReply',
      supportCase.driverId,
      {
        caseNumber: supportCase.caseNumber,
        subject: supportCase.subject,
        category: supportCase.category,
      },
      ALL_TEMPLATES_DIRS,
      getPubSub(),
    );
  }

  // Internal notes stay operator-only. Driver only sees public replies.
  void notifySupportCaseEvent(
    'supportCase.newMessage',
    supportCase.id,
    input.isInternal ? null : supportCase.driverId,
  );

  await audit(
    supportCase.id,
    'message_added',
    input.actor,
    { after: { messageId: message?.id, isInternal: input.isInternal } },
    db,
    input.log,
  );
  return message;
}

/** Marks the case read by the operator (unread badge). */
export async function markSupportCaseRead(userId: string, caseId: string): Promise<void> {
  await db
    .insert(supportCaseReads)
    .values({ userId, caseId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [supportCaseReads.userId, supportCaseReads.caseId],
      set: { lastReadAt: new Date() },
    });
}

/**
 * Records an issued refund on the case: a system message (best effort: the
 * refund already cleared the provider) and the `refund_issued` audit row.
 */
export async function recordSupportCaseRefund(input: {
  supportCase: Pick<SupportCaseRow, 'id' | 'driverId'>;
  userId: string;
  message: string;
  audit: { sessionId: string; amountCents: number; currency: string };
  actor: SupportCaseActor;
  log: WarnLogger;
}): Promise<void> {
  const id = input.supportCase.id;
  try {
    await db.insert(supportCaseMessages).values({
      caseId: id,
      senderType: 'system',
      senderId: input.userId,
      body: input.message,
      isInternal: false,
    });
  } catch (err) {
    input.log.warn({ err, caseId: id }, 'Failed to write refund system message');
  }
  void notifySupportCaseEvent('supportCase.updated', id, input.supportCase.driverId);
  await audit(id, 'refund_issued', input.actor, { after: input.audit }, db, input.log);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Stores an attachment row for a confirmed upload. Returns the row and
 * whether it was new (a retried confirm of the same key returns the existing
 * row).
 */
export async function insertSupportCaseAttachment(
  values: typeof supportCaseAttachments.$inferInsert,
): Promise<SupportCaseAttachmentRow | undefined> {
  const [row] = await db.insert(supportCaseAttachments).values(values).returning();
  return row;
}

/** Audits a new attachment (`attachment_added`). */
export async function recordSupportCaseAttachmentAdded(input: {
  caseId: string;
  messageId: number;
  attachment: Pick<SupportCaseAttachmentRow, 'fileName' | 'fileSize' | 'contentType'>;
  actor: SupportCaseActor;
  log?: WarnLogger;
}): Promise<void> {
  await audit(
    input.caseId,
    'attachment_added',
    input.actor,
    {
      after: {
        messageId: input.messageId,
        fileName: input.attachment.fileName,
        fileSize: input.attachment.fileSize,
        contentType: input.attachment.contentType,
      },
    },
    db,
    input.log,
  );
}

/**
 * Deletes an attachment row (the S3 object is removed by the caller) and
 * audits it (`attachment_deleted`) when a row was deleted.
 */
export async function deleteSupportCaseAttachment(input: {
  caseId: string;
  messageId: number;
  attachmentId: number;
  actor: SupportCaseActor;
  log?: WarnLogger;
}): Promise<void> {
  const [deleted] = await db
    .delete(supportCaseAttachments)
    .where(eq(supportCaseAttachments.id, input.attachmentId))
    .returning({
      fileName: supportCaseAttachments.fileName,
      fileSize: supportCaseAttachments.fileSize,
      contentType: supportCaseAttachments.contentType,
    });
  if (deleted == null) return;
  await audit(
    input.caseId,
    'attachment_deleted',
    input.actor,
    {
      before: {
        messageId: input.messageId,
        attachmentId: input.attachmentId,
        fileName: deleted.fileName,
        fileSize: deleted.fileSize,
        contentType: deleted.contentType,
      },
    },
    db,
    input.log,
  );
}

// ---------------------------------------------------------------------------
// Driver messages
// ---------------------------------------------------------------------------

function isOpenAiState(state: string | null): state is DriverAiOpenState {
  return state != null && (DRIVER_AI_OPEN_STATES as readonly string[]).includes(state);
}

/**
 * A driver reply. Audited with the driver as actor. A reply on a case the AI
 * still handles escalates it to operators (`driver_replied`, plan 2.2 step 6),
 * so a driver who keeps writing reaches a person; the operator notice is then
 * the new case notice, else the driver reply notice.
 */
export async function addDriverMessage(input: {
  supportCase: SupportCaseRow;
  driverId: string;
  body: string;
  log?: WarnLogger;
}): Promise<SupportCaseMessageRow | undefined> {
  const { supportCase, driverId } = input;
  const actor: SupportCaseActor = { actor: 'driver', actorDriverId: driverId };
  const [message] = await db
    .insert(supportCaseMessages)
    .values({
      caseId: supportCase.id,
      senderType: 'driver',
      senderId: driverId,
      body: input.body,
      isInternal: false,
    })
    .returning();

  await audit(
    supportCase.id,
    'message_added',
    actor,
    { after: { messageId: message?.id, isInternal: false } },
    db,
    input.log,
  );

  // A case the automatic answer resolved reopens when the driver writes
  // ("You can reopen it by writing to us", plan 2.11), by compare-and-set so
  // an operator's later status change is never overwritten (P5).
  if (supportCase.status === 'resolved' && supportCase.resolutionSource === 'ai') {
    const reopened = await db
      .update(supportCases)
      .set({ status: 'open', resolvedAt: null, resolutionSource: null, updatedAt: new Date() })
      .where(
        and(
          eq(supportCases.id, supportCase.id),
          eq(supportCases.status, 'resolved'),
          eq(supportCases.resolutionSource, 'ai'),
        ),
      )
      .returning({ id: supportCases.id });
    if (reopened.length > 0) {
      await audit(
        supportCase.id,
        'status_changed',
        actor,
        {
          before: { status: 'resolved', resolutionSource: 'ai' },
          after: { status: 'open', resolutionSource: null, reason: 'driver_replied' },
        },
        db,
        input.log,
      );
    }
  }

  let escalated = false;
  if (isOpenAiState(supportCase.aiState)) {
    escalated = await escalateFromAi({
      caseId: supportCase.id,
      from: DRIVER_AI_OPEN_STATES,
      state: 'escalated',
      reason: 'driver_replied',
      actor,
      ...(input.log != null ? { log: input.log } : {}),
    });
  }
  if (!escalated) {
    void dispatchOperatorNotification(
      'driver_reply',
      supportCase.id,
      supportCase.caseNumber,
      supportCase.subject,
      supportCase.assignedTo,
    );
  }
  // Operators get the event unless the case is still with the AI. A lost
  // escalation race (another path escalated first) still left it open.
  const stillWithAi =
    supportCase.status === SUPPORT_CASE_AI_ASSIST_STATUS &&
    !escalated &&
    (await getSupportCaseRow(supportCase.id))?.status === SUPPORT_CASE_AI_ASSIST_STATUS;
  void notifySupportCaseEvent('supportCase.newMessage', supportCase.id, driverId, {
    toOperators: !stillWithAi,
  });
  return message;
}

// ---------------------------------------------------------------------------
// Driver AI steps
// ---------------------------------------------------------------------------

/** Reads a case row (the worker re-reads it before every step). */
export async function getSupportCaseRow(caseId: string): Promise<SupportCaseRow | undefined> {
  const [row] = await db.select().from(supportCases).where(eq(supportCases.id, caseId));
  return row;
}

/**
 * Claims a queued case for analysis (`queued -> analyzing`). False when
 * another worker or step already moved it: the job then does nothing (P7).
 */
export async function claimDriverAiAnalysis(caseId: string): Promise<boolean> {
  const rows = await db
    .update(supportCases)
    .set({ aiState: 'analyzing', updatedAt: new Date() })
    .where(
      and(
        eq(supportCases.id, caseId),
        eq(supportCases.aiState, 'queued'),
        eq(supportCases.status, SUPPORT_CASE_AI_ASSIST_STATUS),
      ),
    )
    .returning({ id: supportCases.id });
  return rows.length > 0;
}

/**
 * Puts a case stuck in `analyzing` (a worker crashed mid-call) back to
 * `queued`, so the sweeper can queue it again. Compare-and-set on the time it
 * was last changed.
 */
export async function requeueStuckDriverAiAnalysis(caseId: string, before: Date): Promise<boolean> {
  const rows = await db
    .update(supportCases)
    .set({ aiState: 'queued', updatedAt: new Date() })
    .where(
      and(
        eq(supportCases.id, caseId),
        eq(supportCases.aiState, 'analyzing'),
        sql`${supportCases.updatedAt} < ${before}`,
      ),
    )
    .returning({ id: supportCases.id });
  return rows.length > 0;
}

/**
 * Stores the validated answer as an `assistant` message and asks the driver
 * the feedback question (`analyzing -> awaiting_feedback`), in one
 * transaction. False when the case left `analyzing` meanwhile (the driver
 * replied): nothing is stored. Then the SSE event and the driver push.
 */
export async function storeDriverAiAnswer(input: {
  caseId: string;
  answer: string;
  driverActions: DriverActionCode[];
  needsOperator: boolean;
  provider: string;
  model: string;
  log?: WarnLogger;
}): Promise<boolean> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(supportCases)
      .set({
        aiState: 'awaiting_feedback',
        aiStateReason: null,
        aiAnsweredAt: now,
        aiDriverActions: input.driverActions,
        aiNeedsOperator: input.needsOperator,
        updatedAt: now,
      })
      .where(
        and(
          eq(supportCases.id, input.caseId),
          eq(supportCases.aiState, 'analyzing'),
          eq(supportCases.status, SUPPORT_CASE_AI_ASSIST_STATUS),
        ),
      )
      .returning();
    if (row == null) return null;
    const [message] = await tx
      .insert(supportCaseMessages)
      .values({
        caseId: row.id,
        senderType: SUPPORT_CASE_ASSISTANT_SENDER,
        senderId: null,
        body: input.answer,
        isInternal: false,
      })
      .returning({ id: supportCaseMessages.id });
    return { row, messageId: message?.id };
  });
  if (result == null) return false;
  const stored = result.row;
  await audit(
    stored.id,
    'ai_answered',
    DRIVER_AI_SYSTEM_ACTOR,
    {
      after: {
        messageId: result.messageId,
        driverActions: input.driverActions,
        needsOperator: input.needsOperator,
        provider: input.provider,
        model: input.model,
      },
    },
    db,
    input.log,
  );
  if (stored.driverId != null) {
    void dispatchDriverNotification(
      client,
      DRIVER_AI_ANSWERED_EVENT,
      stored.driverId,
      { caseNumber: stored.caseNumber, subject: stored.subject, category: stored.category },
      ALL_TEMPLATES_DIRS,
      getPubSub(),
    );
  }
  void notifySupportCaseEvent('supportCase.updated', stored.id, stored.driverId, {
    toOperators: false,
  });
  return true;
}

export interface EscalateFromAiInput {
  caseId: string;
  /** The AI states the case may be in; anything else leaves it unchanged (P5). */
  from: readonly DriverAiOpenState[];
  /** `escalated`: handed to operators; `failed`: the analysis broke; `skipped`: it never ran. */
  state: Extract<DriverAiState, 'escalated' | 'failed' | 'skipped'>;
  reason: DriverAiStateReason | null;
  /** Only the case of this driver (a driver action). */
  driverId?: string;
  actor?: SupportCaseActor;
  log?: WarnLogger;
}

/**
 * Ends the AI step without a resolution and opens the case to operators
 * (`ai_assist -> open`), by compare-and-set from `from`. Audits
 * `escalated_from_ai` (`ai_failed` for a failure), notifies operators through
 * the new case path and sends SSE to both sides. False when the case was not
 * in one of `from`: a rerun changes nothing.
 */
export async function escalateFromAi(input: EscalateFromAiInput): Promise<boolean> {
  const now = new Date();
  const actor = input.actor ?? DRIVER_AI_SYSTEM_ACTOR;
  const result = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ aiState: supportCases.aiState })
      .from(supportCases)
      .where(eq(supportCases.id, input.caseId))
      .for('update');
    const [updated] = await tx
      .update(supportCases)
      .set({
        status: 'open',
        aiState: input.state,
        aiStateReason: input.reason,
        ...(input.reason === 'driver_declined_answer' ? { aiFeedbackAt: now } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(supportCases.id, input.caseId),
          inArray(supportCases.aiState, [...input.from]),
          eq(supportCases.status, SUPPORT_CASE_AI_ASSIST_STATUS),
          input.driverId != null ? eq(supportCases.driverId, input.driverId) : undefined,
        ),
      )
      .returning();
    if (updated == null) return null;
    return { updated, beforeState: before?.aiState ?? null };
  });
  if (result == null) return false;
  const row = result.updated;
  await audit(
    row.id,
    input.state === 'failed' ? 'ai_failed' : 'escalated_from_ai',
    actor,
    {
      before: { status: SUPPORT_CASE_AI_ASSIST_STATUS, aiState: result.beforeState },
      after: { status: 'open', aiState: input.state, reason: input.reason },
    },
    db,
    input.log,
  );
  void dispatchOperatorNotification(
    'new_case',
    row.id,
    row.caseNumber,
    row.subject,
    row.assignedTo,
  );
  void notifySupportCaseEvent('supportCase.updated', row.id, row.driverId);
  return true;
}

/** Outcome of the driver's answer to "Did this solve your issue?". */
export type DriverAiFeedbackOutcome = 'resolved' | 'escalated' | 'not_awaiting';

/**
 * The feedback, asked once. Yes resolves the case as resolved by AI; No opens
 * it to operators with the transcript. Compare-and-set from
 * `awaiting_feedback` on the driver's own case: a second call returns
 * `not_awaiting` (409 `SUPPORT_CASE_AI_NOT_AWAITING_FEEDBACK`, threat T7).
 */
export async function recordDriverAiFeedback(input: {
  caseId: string;
  driverId: string;
  satisfied: boolean;
  log?: WarnLogger;
}): Promise<DriverAiFeedbackOutcome> {
  const actor: SupportCaseActor = { actor: 'driver', actorDriverId: input.driverId };
  if (!input.satisfied) {
    const escalated = await escalateFromAi({
      caseId: input.caseId,
      from: ['awaiting_feedback'],
      state: 'escalated',
      reason: 'driver_declined_answer',
      driverId: input.driverId,
      actor,
      ...(input.log != null ? { log: input.log } : {}),
    });
    return escalated ? 'escalated' : 'not_awaiting';
  }
  const now = new Date();
  const [row] = await db
    .update(supportCases)
    .set({
      status: 'resolved',
      resolvedAt: now,
      resolutionSource: 'ai',
      aiState: 'resolved_by_ai',
      aiStateReason: null,
      aiFeedbackAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(supportCases.id, input.caseId),
        eq(supportCases.driverId, input.driverId),
        eq(supportCases.aiState, 'awaiting_feedback'),
        eq(supportCases.status, SUPPORT_CASE_AI_ASSIST_STATUS),
      ),
    )
    .returning();
  if (row == null) return 'not_awaiting';
  await audit(
    row.id,
    'resolved_by_ai',
    actor,
    {
      before: { status: SUPPORT_CASE_AI_ASSIST_STATUS, aiState: 'awaiting_feedback' },
      after: { status: 'resolved', aiState: 'resolved_by_ai', resolutionSource: 'ai' },
    },
    db,
    input.log,
  );
  // Resolved by AI cases stay visible to operators (T12) without a notice.
  void notifySupportCaseEvent('supportCase.updated', row.id, row.driverId);
  return 'resolved';
}
