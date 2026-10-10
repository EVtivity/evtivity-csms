// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, aiAttachments, aiConversations, getAiSettings } from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import { deleteObject, loadS3Config } from '@evtivity/services/s3-storage';
import { config } from '../lib/config.js';

const BATCH_SIZE = 200;
// Bounds one run; the next hourly tick continues.
const MAX_BATCHES = 25;

/**
 * Attachments to remove: marked deleted (attachment or conversation deleted,
 * or a refused upload), without an owner (user removed), never used in a
 * message within a day of the upload request (abandoned uploads, pending
 * quarantine objects included), or older than `ai.conversationRetentionDays`.
 */
function expiredCondition(retentionDays: number) {
  return or(
    isNotNull(aiAttachments.deletedAt),
    isNull(aiAttachments.userId),
    and(
      isNull(aiAttachments.conversationId),
      lt(aiAttachments.createdAt, sql`now() - interval '24 hours'`),
    ),
    lt(aiAttachments.createdAt, sql`now() - make_interval(days => ${retentionDays})`),
  );
}

/**
 * Conversations to remove: deleted by the user, or without a turn, rename or
 * message for `ai.conversationRetentionDays`.
 */
function expiredConversation(retentionDays: number) {
  return or(
    isNotNull(aiConversations.deletedAt),
    lt(aiConversations.updatedAt, sql`now() - make_interval(days => ${retentionDays})`),
  );
}

/**
 * Deletes expired conversations (their messages, tool calls and pending
 * actions go with them by cascade). Their attachments are marked deleted
 * first, in the same transaction, so the attachment pass below removes the
 * S3 objects. The audit rows stay (audit retention). This cron is the only
 * deleter of conversations besides the API conversation service, which only
 * hides them.
 */
async function pruneConversations(retentionDays: number): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const ids = (
      await db
        .select({ id: aiConversations.id })
        .from(aiConversations)
        .where(expiredConversation(retentionDays))
        .limit(BATCH_SIZE)
    ).map((r) => r.id);
    if (ids.length === 0) break;
    await db.transaction(async (tx) => {
      await tx
        .update(aiAttachments)
        .set({ deletedAt: sql`now()` })
        .where(and(inArray(aiAttachments.conversationId, ids), isNull(aiAttachments.deletedAt)));
      await tx.delete(aiConversations).where(inArray(aiConversations.id, ids));
    });
    deleted += ids.length;
    if (ids.length < BATCH_SIZE) break;
  }
  return deleted;
}

/**
 * Hourly cron `ai-retention-prune` (plan 3.8 step 6): deletes expired AI
 * conversations, then the S3 objects
 * of expired AI chat attachments, then their rows. A row is deleted only after
 * its objects, so a failed S3 call leaves it for the next run (P4). S3 answers
 * success for a key already gone, so a rerun is idempotent (P7). One failed
 * row is logged and the others continue (P9).
 */
export async function aiRetentionPruneHandler(log: Logger): Promise<void> {
  const retentionDays = (await getAiSettings()).limits.conversationRetentionDays;
  const conversations = await pruneConversations(retentionDays);
  if (conversations > 0) {
    log.info({ conversations }, 'ai-retention-prune: expired conversations deleted');
  }
  const [pending] = await db
    .select({ id: aiAttachments.id })
    .from(aiAttachments)
    .where(expiredCondition(retentionDays))
    .limit(1);
  if (pending == null) {
    log.info({ deleted: 0 }, 'ai-retention-prune: completed');
    return;
  }

  const s3 = await loadS3Config(config.SETTINGS_ENCRYPTION_KEY);
  if (s3 == null) {
    log.warn('ai-retention-prune: S3 is not configured; expired attachments are kept');
    return;
  }

  let deleted = 0;
  let failed = 0;
  const failedIds = new Set<string>();
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const rows = await db
      .select({
        id: aiAttachments.id,
        s3Bucket: aiAttachments.s3Bucket,
        quarantineKey: aiAttachments.quarantineKey,
        s3Key: aiAttachments.s3Key,
      })
      .from(aiAttachments)
      .where(expiredCondition(retentionDays))
      .orderBy(asc(aiAttachments.createdAt))
      .limit(BATCH_SIZE + failedIds.size);
    const todo = rows.filter((row) => !failedIds.has(row.id));
    if (todo.length === 0) break;

    for (const row of todo.slice(0, BATCH_SIZE)) {
      try {
        await deleteObject(s3, row.s3Bucket, row.quarantineKey);
        if (row.s3Key != null) await deleteObject(s3, row.s3Bucket, row.s3Key);
        await db.delete(aiAttachments).where(eq(aiAttachments.id, row.id));
        deleted++;
      } catch (err) {
        failed++;
        failedIds.add(row.id);
        log.warn({ err, attachmentId: row.id }, 'ai-retention-prune: attachment delete failed');
      }
    }
    if (todo.length < BATCH_SIZE) break;
  }

  log.info({ deleted, failed }, 'ai-retention-prune: completed');
}
