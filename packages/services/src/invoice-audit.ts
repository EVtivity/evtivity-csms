// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import { db, invoiceAuditLog, writeAudit } from '@evtivity/database';
import type { WriteAuditArgs } from '@evtivity/database';
import type { NotificationDelivery } from '@evtivity/lib';

/** Who an invoice audit row names: the request's actor, or `system` with a label. */
export type InvoiceAuditActor = Pick<
  WriteAuditArgs,
  'actor' | 'actorUserId' | 'actorDriverId' | 'actorApiKeyId' | 'actorLabel'
>;

/** Where a failed audit read or write is logged (fail-open, P9). */
export interface InvoiceAuditLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/** The audit actor of an automatic send by a process, such as a worker job. */
export function systemInvoiceAuditActor(label: string): InvoiceAuditActor {
  return { actor: 'system', actorLabel: label };
}

/**
 * True when an earlier send of the invoice was audited (`invoice_sent`), so
 * the next send is a resend. Fail-open (P9): a failed read is logged and
 * answers false, the send goes on.
 */
export async function wasInvoiceSent(
  invoiceId: string,
  log?: InvoiceAuditLogger,
): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: invoiceAuditLog.id })
      .from(invoiceAuditLog)
      .where(
        and(eq(invoiceAuditLog.invoiceId, invoiceId), eq(invoiceAuditLog.action, 'invoice_sent')),
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    log?.warn({ err, invoiceId }, 'Invoice send history read failed; recorded as a first send');
    return false;
  }
}

export interface InvoiceSentAudit {
  invoiceId: string;
  invoiceNumber: string;
  /** The notification event that carried it, such as invoice.Sent or invoice.FleetOverdue. */
  eventType: string;
  /** The messages the email and SMS providers accepted. */
  delivered: NotificationDelivery[];
  /** The invoice was sent before. */
  resend: boolean;
  actor: InvoiceAuditActor;
}

/**
 * Writes `invoice_sent` for a send that at least one provider accepted. A send
 * nothing accepted (no address, no provider, every attempt failed) writes
 * nothing; each attempt is in the notification history. `after` holds the
 * channels, the email addresses, the event and whether it was a resend.
 * Fail-open (P9) through writeAudit.
 */
export async function writeInvoiceSentAudit(
  args: InvoiceSentAudit,
  log?: InvoiceAuditLogger,
): Promise<void> {
  if (args.delivered.length === 0) return;
  const channels = [...new Set(args.delivered.map((d) => d.channel))];
  const recipientEmails = [
    ...new Set(args.delivered.filter((d) => d.channel === 'email').map((d) => d.recipient)),
  ];
  await writeAudit(
    { table: invoiceAuditLog, idColumn: 'invoice_id' },
    {
      entityId: args.invoiceId,
      entityIdSnapshot: args.invoiceId,
      action: 'invoice_sent',
      ...args.actor,
      before: null,
      after: {
        invoiceNumber: args.invoiceNumber,
        eventType: args.eventType,
        channels,
        recipientEmails,
        resend: args.resend,
      },
    },
    db,
    log,
  );
}
