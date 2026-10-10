// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  fail: false,
}));

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where']) chain[m] = vi.fn(() => chain);
  chain['limit'] = vi.fn(() =>
    h.fail ? Promise.reject(new Error('db down')) : Promise.resolve(h.rows),
  );
  return {
    db: { select: vi.fn(() => chain) },
    invoiceAuditLog: { id: 'id', invoiceId: 'invoice_id', action: 'action' },
    writeAudit: vi.fn(() => Promise.resolve()),
  };
});

import { writeAudit } from '@evtivity/database';
import {
  systemInvoiceAuditActor,
  wasInvoiceSent,
  writeInvoiceSentAudit,
} from '../invoice-audit.js';

const log = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.fail = false;
});

describe('writeInvoiceSentAudit', () => {
  const base = {
    invoiceId: 'inv_1',
    invoiceNumber: 'INV-202610-0001',
    eventType: 'invoice.Sent',
    resend: true,
    actor: { actor: 'operator' as const, actorUserId: 'usr_1' },
  };

  it('writes invoice_sent with the channels, email addresses and resend flag', async () => {
    await writeInvoiceSentAudit(
      {
        ...base,
        delivered: [
          { channel: 'email', recipient: 'a@example.test' },
          { channel: 'sms', recipient: '+15550100' },
          { channel: 'email', recipient: 'a@example.test' },
        ],
      },
      log,
    );

    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'invoice_id' }),
      {
        entityId: 'inv_1',
        entityIdSnapshot: 'inv_1',
        action: 'invoice_sent',
        actor: 'operator',
        actorUserId: 'usr_1',
        before: null,
        after: {
          invoiceNumber: 'INV-202610-0001',
          eventType: 'invoice.Sent',
          channels: ['email', 'sms'],
          recipientEmails: ['a@example.test'],
          resend: true,
        },
      },
      expect.anything(),
      log,
    );
  });

  it('writes nothing when no provider accepted the send', async () => {
    await writeInvoiceSentAudit({ ...base, delivered: [] }, log);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('names the system actor with its label for an automatic send', () => {
    expect(systemInvoiceAuditActor('fleet-invoice-run')).toEqual({
      actor: 'system',
      actorLabel: 'fleet-invoice-run',
    });
  });
});

describe('wasInvoiceSent', () => {
  it('is true when an earlier send was audited', async () => {
    h.rows = [{ id: 7 }];
    await expect(wasInvoiceSent('inv_1', log)).resolves.toBe(true);
  });

  it('is false for an invoice never sent', async () => {
    await expect(wasInvoiceSent('inv_1', log)).resolves.toBe(false);
  });

  it('fails open: a failed read is logged and answers false', async () => {
    h.fail = true;
    await expect(wasInvoiceSent('inv_1', log)).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_1' }),
      expect.any(String),
    );
  });
});
