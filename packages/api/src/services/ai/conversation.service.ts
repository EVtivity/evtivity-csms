// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The only writer of the AI conversation tables (`ai_conversations`,
 * `ai_messages`, `ai_tool_calls`, `ai_pending_actions`) and of
 * `ai_conversation_audit_log` (design principle P3). Every read is scoped to
 * the conversation's owner: another user's conversation does not exist.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, ilike, isNull, lt, or, sql, count } from 'drizzle-orm';
import {
  db,
  aiConversations,
  aiMessages,
  aiToolCalls,
  aiPendingActions,
  aiConversationAuditLog,
  writeAudit,
} from '@evtivity/database';
import type { AuditActor } from '@evtivity/database';
import { generateId } from '@evtivity/lib';
import type {
  AiMessage,
  AiPart,
  AiProviderState,
  AiToolResultPart,
  AiUsage,
} from './core/types.js';
import type { AiSurface } from './tools/policy.js';
import type { RedactionCounts } from './tools/redact.js';

export interface AuditActorFields {
  actor: AuditActor;
  actorUserId?: string | null;
  actorDriverId?: string | null;
  actorApiKeyId?: string | null;
  actorLabel?: string | null;
}

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export type AiConversationRow = typeof aiConversations.$inferSelect;
export type AiMessageRow = typeof aiMessages.$inferSelect;
export type AiPendingActionRow = typeof aiPendingActions.$inferSelect;

/** A turn holds its conversation for at most this long (the 120 s turn clock plus margin). */
const TURN_LEASE_MS = 180_000;

/** A pending action can be confirmed for this long. */
export const PENDING_ACTION_TTL_MS = 5 * 60_000;

export const MAX_TITLE_LENGTH = 200;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON with sorted object keys, so equal arguments hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

export function argsHash(args: unknown): string {
  return sha256(canonicalJson(args));
}

async function audit(
  conversationId: string,
  action: string,
  actor: AuditActorFields,
  fields: {
    before?: unknown;
    after?: unknown;
    notes?: string | null;
    viaAi?: { conversationId: string; toolCallId: string };
  },
  logger?: Logger,
): Promise<void> {
  await writeAudit(
    { table: aiConversationAuditLog, idColumn: 'ai_conversation_id' },
    {
      entityId: conversationId,
      entityIdSnapshot: conversationId,
      action,
      ...actor,
      before: fields.before ?? null,
      after: fields.after ?? null,
      notes: fields.notes ?? null,
      viaAi: fields.viaAi ?? null,
    },
    db,
    logger,
  );
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function createConversation(
  input: {
    userId: string;
    surface: AiSurface;
    supportCaseId?: string | null;
    provider: string;
    model: string;
    title?: string;
  },
  actor: AuditActorFields,
  logger?: Logger,
): Promise<AiConversationRow> {
  const [row] = await db
    .insert(aiConversations)
    .values({
      id: generateId('aiConversation'),
      userId: input.userId,
      surface: input.surface,
      supportCaseId: input.supportCaseId ?? null,
      provider: input.provider,
      model: input.model,
      title: (input.title ?? '').slice(0, MAX_TITLE_LENGTH),
    })
    .returning();
  if (row === undefined) throw new Error('ai_conversations insert returned no row');
  await audit(
    row.id,
    'created',
    actor,
    { after: { surface: row.surface, supportCaseId: row.supportCaseId, title: row.title } },
    logger,
  );
  return row;
}

/** The user's live conversation on `surface`, or null (another user's is not found). */
export async function getConversation(
  userId: string,
  conversationId: string,
  surface: AiSurface,
): Promise<AiConversationRow | null> {
  const [row] = await db
    .select()
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.id, conversationId),
        eq(aiConversations.userId, userId),
        eq(aiConversations.surface, surface),
        isNull(aiConversations.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listConversations(
  userId: string,
  options: { page: number; limit: number; search?: string | undefined },
): Promise<{ data: AiConversationRow[]; total: number }> {
  const conditions = [
    eq(aiConversations.userId, userId),
    eq(aiConversations.surface, 'chatbot'),
    isNull(aiConversations.deletedAt),
  ];
  if (options.search != null && options.search.trim() !== '') {
    const escaped = options.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    conditions.push(ilike(aiConversations.title, `%${escaped}%`));
  }
  const where = and(...conditions);
  const [data, totals] = await Promise.all([
    db
      .select()
      .from(aiConversations)
      .where(where)
      .orderBy(desc(aiConversations.updatedAt), desc(aiConversations.id))
      .limit(options.limit)
      .offset((options.page - 1) * options.limit),
    db.select({ total: count() }).from(aiConversations).where(where),
  ]);
  return { data, total: totals[0]?.total ?? 0 };
}

export async function renameConversation(
  conversation: AiConversationRow,
  title: string,
  actor: AuditActorFields,
  logger?: Logger,
): Promise<AiConversationRow> {
  const [row] = await db
    .update(aiConversations)
    .set({ title: title.slice(0, MAX_TITLE_LENGTH), updatedAt: new Date() })
    .where(eq(aiConversations.id, conversation.id))
    .returning();
  const updated = row ?? conversation;
  await audit(
    conversation.id,
    'renamed',
    actor,
    { before: { title: conversation.title }, after: { title: updated.title } },
    logger,
  );
  return updated;
}

/** Hides the conversation; the retention cron deletes it and its rows. */
export async function deleteConversation(
  conversation: AiConversationRow,
  actor: AuditActorFields,
  logger?: Logger,
): Promise<void> {
  await db
    .update(aiConversations)
    .set({ deletedAt: new Date() })
    .where(and(eq(aiConversations.id, conversation.id), isNull(aiConversations.deletedAt)));
  await audit(conversation.id, 'deleted', actor, { before: { title: conversation.title } }, logger);
}

/**
 * Takes the conversation's turn lease. False when another turn holds it
 * (a lease older than `TURN_LEASE_MS` is taken over: its pod died).
 */
export async function claimTurn(conversationId: string, now = new Date()): Promise<boolean> {
  const stale = new Date(now.getTime() - TURN_LEASE_MS);
  const rows = await db
    .update(aiConversations)
    .set({ turnStartedAt: now })
    .where(
      and(
        eq(aiConversations.id, conversationId),
        or(isNull(aiConversations.turnStartedAt), lt(aiConversations.turnStartedAt, stale)),
      ),
    )
    .returning({ id: aiConversations.id });
  return rows.length > 0;
}

/** Ends the turn: frees the lease and records the provider and model it ran on. */
export async function releaseTurn(
  conversationId: string,
  ran: { provider: string; model: string } | null,
): Promise<void> {
  await db
    .update(aiConversations)
    .set({ turnStartedAt: null, updatedAt: new Date(), ...(ran ?? {}) })
    .where(eq(aiConversations.id, conversationId));
}

export async function setTitleIfEmpty(conversationId: string, title: string): Promise<void> {
  await db
    .update(aiConversations)
    .set({ title: title.slice(0, MAX_TITLE_LENGTH) })
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.title, '')));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** What a tool result produced under another access reads as. */
export const HIDDEN_TOOL_RESULT =
  '{"status":"hidden","note":"Result hidden after an access change. Run the tool again if it is still needed."}';

/**
 * The rows with the tool results of every message produced under another
 * access fingerprint (sites plus effective permissions, `requestAccessScope`)
 * replaced by HIDDEN_TOOL_RESULT, so a stored result never outlives a site,
 * permission or API key scope change. A row without a fingerprint (written
 * before it was stored) counts as another access.
 */
export function hideStaleToolResults(
  rows: readonly AiMessageRow[],
  accessScope: string,
): AiMessageRow[] {
  return rows.map((row) => {
    if (row.accessScope === accessScope) return row;
    const parts = row.parts as AiPart[];
    if (!parts.some((part) => part.type === 'tool_result')) return row;
    return {
      ...row,
      parts: parts.map((part) =>
        part.type === 'tool_result'
          ? ({ ...part, content: HIDDEN_TOOL_RESULT, isError: false } satisfies AiToolResultPart)
          : part,
      ),
    };
  });
}

/**
 * The conversation's messages as the caller with this access fingerprint may
 * see them (read and replay): tool results of another access are hidden.
 */
export async function listMessages(
  conversationId: string,
  accessScope: string,
): Promise<AiMessageRow[]> {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id));
  return hideStaleToolResults(rows, accessScope);
}

/** The conversation history as the engine sends it to a model. */
export function toAiMessages(rows: readonly AiMessageRow[]): AiMessage[] {
  return rows.map((row) => {
    const message: AiMessage = {
      role: row.role as AiMessage['role'],
      parts: row.parts as AiPart[],
    };
    if (row.providerState != null) message.providerState = row.providerState as AiProviderState;
    return message;
  });
}

export async function appendMessage(input: {
  id?: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  parts: AiPart[];
  providerState?: AiProviderState | undefined;
  usage?: AiUsage | undefined;
  costMicros?: number | null | undefined;
  finishReason?: string | undefined;
  /** The caller's access fingerprint; required on tool messages. */
  accessScope?: string | undefined;
}): Promise<string> {
  const id = input.id ?? generateId('aiMessage');
  // A clock tie would make the order ambiguous; the id breaks it, but a
  // strictly later timestamp keeps the history readable as well.
  await db.insert(aiMessages).values({
    id,
    conversationId: input.conversationId,
    role: input.role,
    parts: input.parts,
    providerState: input.providerState ?? null,
    usage: input.usage ?? null,
    costMicros: input.costMicros ?? null,
    finishReason: input.finishReason ?? null,
    accessScope: input.accessScope ?? null,
    createdAt: sql`clock_timestamp()`,
  });
  return id;
}

/**
 * Replaces one tool result part of a tool message (a confirmed, rejected or
 * expired action) and stamps the message with the access fingerprint of the
 * request that produced the new result, so reads under another access hide
 * it (`hideStaleToolResults`). When that fingerprint differs from the stored
 * one, the message's other tool results were produced under another access:
 * they become HIDDEN_TOOL_RESULT, so the new stamp never reveals them.
 */
export async function replaceToolResult(
  toolMessageId: string,
  toolCallId: string,
  content: string,
  isError: boolean,
  accessScope: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ parts: aiMessages.parts, accessScope: aiMessages.accessScope })
      .from(aiMessages)
      .where(eq(aiMessages.id, toolMessageId))
      .for('update');
    if (row === undefined) return;
    const sameAccess = row.accessScope === accessScope;
    const parts = (row.parts as AiPart[]).map((part) => {
      if (part.type !== 'tool_result') return part;
      if (part.toolCallId === toolCallId) {
        return { ...part, content, isError } satisfies AiToolResultPart;
      }
      return sameAccess
        ? part
        : ({ ...part, content: HIDDEN_TOOL_RESULT, isError: false } satisfies AiToolResultPart);
    });
    await tx.update(aiMessages).set({ parts, accessScope }).where(eq(aiMessages.id, toolMessageId));
  });
}

/** Total tokens (input and output) the user's conversations used since `since`. */
export async function tokensUsedSince(userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(COALESCE((${aiMessages.usage}->>'inputTokens')::bigint, 0) + COALESCE((${aiMessages.usage}->>'outputTokens')::bigint, 0)), 0)`,
    })
    .from(aiMessages)
    .innerJoin(aiConversations, eq(aiConversations.id, aiMessages.conversationId))
    .where(
      and(
        eq(aiConversations.userId, userId),
        sql`${aiMessages.createdAt} >= ${since.toISOString()}::timestamptz`,
        sql`${aiMessages.usage} IS NOT NULL`,
      ),
    );
  return Number(row?.total ?? 0);
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export type ToolCallStatus =
  | 'ok'
  | 'refused'
  | 'error'
  | 'pending_confirmation'
  | 'confirmed'
  | 'rejected';

export async function recordToolCall(
  input: {
    conversationId: string;
    messageId: string;
    toolCallId: string;
    name: string;
    operationId: string | null;
    method: string | null;
    path: string | null;
    /** Redacted. */
    args: unknown;
    status: ToolCallStatus;
  },
  actor: AuditActorFields,
  logger?: Logger,
): Promise<string> {
  const id = generateId('aiToolCall');
  await db.insert(aiToolCalls).values({ id, ...input });
  await audit(
    input.conversationId,
    'tool_called',
    actor,
    {
      after: {
        name: input.name,
        operationId: input.operationId,
        method: input.method,
        path: input.path,
        args: input.args,
        status: input.status,
      },
      viaAi: { conversationId: input.conversationId, toolCallId: id },
    },
    logger,
  );
  return id;
}

export async function completeToolCall(
  rowId: string,
  result: {
    status: ToolCallStatus;
    httpStatus?: number | null;
    latencyMs?: number | null;
    redactionCounts?: RedactionCounts | null;
  },
): Promise<void> {
  await db
    .update(aiToolCalls)
    .set({
      status: result.status,
      httpStatus: result.httpStatus ?? null,
      latencyMs: result.latencyMs ?? null,
      redactionCounts: result.redactionCounts ?? null,
    })
    .where(eq(aiToolCalls.id, rowId));
}

// ---------------------------------------------------------------------------
// Pending actions
// ---------------------------------------------------------------------------

export async function createPendingAction(input: {
  conversationId: string;
  toolCallRowId: string;
  toolMessageId: string;
  toolCallId: string;
  operationId: string;
  args: Record<string, unknown>;
  now?: Date;
}): Promise<{ actionId: string; nonce: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const nonce = randomBytes(24).toString('base64url');
  const actionId = generateId('aiPendingAction');
  const expiresAt = new Date(now.getTime() + PENDING_ACTION_TTL_MS);
  await db.insert(aiPendingActions).values({
    id: actionId,
    conversationId: input.conversationId,
    toolCallRowId: input.toolCallRowId,
    toolMessageId: input.toolMessageId,
    toolCallId: input.toolCallId,
    operationId: input.operationId,
    args: input.args,
    argsHash: argsHash(input.args),
    nonceHash: sha256(nonce),
    expiresAt,
  });
  return { actionId, nonce, expiresAt };
}

export type PendingDecision = 'confirmed' | 'rejected';

export type DecideOutcome =
  | { kind: 'decided'; action: AiPendingActionRow }
  /** The same decision was already taken: nothing runs again (idempotent). */
  | { kind: 'already'; action: AiPendingActionRow }
  | { kind: 'not_found' }
  | { kind: 'expired'; action: AiPendingActionRow }
  | { kind: 'invalid' };

function nonceMatches(nonce: string, nonceHash: string): boolean {
  const a = Buffer.from(sha256(nonce), 'hex');
  const b = Buffer.from(nonceHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Records the user's decision on a pending action: a compare-and-set from
 * `pending`, so a write runs at most once. Unknown action, another user's
 * action and a wrong nonce are all `not_found` (no existence leak).
 */
export async function decidePendingAction(input: {
  conversationId: string;
  actionId: string;
  nonce: string;
  decision: PendingDecision;
  now?: Date;
}): Promise<DecideOutcome> {
  const now = input.now ?? new Date();
  const [action] = await db
    .select()
    .from(aiPendingActions)
    .where(
      and(
        eq(aiPendingActions.id, input.actionId),
        eq(aiPendingActions.conversationId, input.conversationId),
      ),
    )
    .limit(1);
  if (action === undefined || !nonceMatches(input.nonce, action.nonceHash)) {
    return { kind: 'not_found' };
  }
  if (action.status === input.decision) return { kind: 'already', action };
  if (action.status === 'expired') return { kind: 'expired', action };
  if (action.status !== 'pending') return { kind: 'invalid' };
  if (action.expiresAt.getTime() <= now.getTime()) {
    await db
      .update(aiPendingActions)
      .set({ status: 'expired', decidedAt: now })
      .where(and(eq(aiPendingActions.id, action.id), eq(aiPendingActions.status, 'pending')));
    return { kind: 'expired', action };
  }
  if (argsHash(action.args) !== action.argsHash) return { kind: 'invalid' };
  const [decided] = await db
    .update(aiPendingActions)
    .set({ status: input.decision, decidedAt: now })
    .where(and(eq(aiPendingActions.id, action.id), eq(aiPendingActions.status, 'pending')))
    .returning();
  if (decided === undefined) {
    // Another request decided first.
    const [current] = await db
      .select()
      .from(aiPendingActions)
      .where(eq(aiPendingActions.id, action.id))
      .limit(1);
    if (current?.status === input.decision) return { kind: 'already', action: current };
    return { kind: 'invalid' };
  }
  return { kind: 'decided', action: decided };
}

/**
 * Marks the conversation's open actions as superseded (the user sent a new
 * message instead of deciding). Returns them, so their placeholder results
 * can be filled in.
 */
export async function supersedePendingActions(
  conversationId: string,
): Promise<AiPendingActionRow[]> {
  return db
    .update(aiPendingActions)
    .set({ status: 'superseded', decidedAt: new Date() })
    .where(
      and(
        eq(aiPendingActions.conversationId, conversationId),
        eq(aiPendingActions.status, 'pending'),
      ),
    )
    .returning();
}

/** Audits the user's decision on an action. */
export async function auditDecision(
  action: AiPendingActionRow,
  decision: PendingDecision,
  actor: AuditActorFields,
  logger?: Logger,
): Promise<void> {
  await audit(
    action.conversationId,
    decision === 'confirmed' ? 'action_confirmed' : 'action_rejected',
    actor,
    {
      after: { actionId: action.id, operationId: action.operationId },
      viaAi: { conversationId: action.conversationId, toolCallId: action.toolCallRowId },
    },
    logger,
  );
}

/** Audits the attachments a user message used (one row per attachment). */
export async function auditAttachmentsAdded(
  conversationId: string,
  attachments: readonly { id: string; fileName: string; contentType: string }[],
  actor: AuditActorFields,
  logger?: Logger,
): Promise<void> {
  for (const a of attachments) {
    await audit(
      conversationId,
      'attachment_added',
      actor,
      { after: { attachmentId: a.id, fileName: a.fileName, contentType: a.contentType } },
      logger,
    );
  }
}
