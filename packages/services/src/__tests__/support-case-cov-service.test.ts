// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The support case writer (`support-case.service.ts`): creation with consent,
// operator changes, messages, attachments, refunds and the driver AI state
// moves (compare-and-set, P5), with their audit rows, notices and events.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import { opArgs, sqlParams } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  audits: [] as Record<string, unknown>[],
  driverNotices: [] as unknown[][],
  operatorNotices: [] as unknown[][],
  events: [] as unknown[][],
  published: [] as { channel: string; message: string }[],
  publishFails: false,
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    redactAuditPayload: (v: unknown) => ({ redacted: v }),
    writeAudit: (_cfg: unknown, args: Record<string, unknown>) => {
      h.audits.push(args);
      return Promise.resolve();
    },
  });
});

vi.mock('@evtivity/lib', () => ({
  dispatchDriverNotification: (...args: unknown[]) => {
    h.driverNotices.push(args);
    return Promise.resolve();
  },
}));

const pubsub = {
  publish: (channel: string, message: string) => {
    if (h.publishFails) return Promise.reject(new Error('redis down'));
    h.published.push({ channel, message });
    return Promise.resolve();
  },
  subscribe: () => Promise.resolve(),
};

vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => pubsub }));

vi.mock('../support-case-notify.js', () => ({
  dispatchOperatorNotification: (...args: unknown[]) => {
    h.operatorNotices.push(args);
    return Promise.resolve();
  },
  notifySupportCaseEvent: (...args: unknown[]) => {
    h.events.push(args);
    return Promise.resolve();
  },
}));

const svc = await import('../support-case.service.js');

type Row = import('../support-case.service.js').SupportCaseRow;

function caseRow(over: Partial<Row> = {}): Row {
  return {
    id: 'cas_1',
    caseNumber: 'CASE-00007',
    subject: 'Charger broken',
    description: 'It does not start',
    category: 'charging_failure',
    priority: 'medium',
    status: 'open',
    driverId: 'drv_1',
    stationId: 'sta_1',
    assignedTo: null,
    createdByDriver: true,
    resolvedAt: null,
    closedAt: null,
    resolutionSource: null,
    aiState: null,
    aiStateReason: null,
    ...over,
  } as unknown as Row;
}

const operator: import('../support-case.service.js').SupportCaseActor = {
  actor: 'operator',
  actorUserId: 'usr_1',
};
const log = { warn: vi.fn() };

beforeEach(() => {
  h.fake.reset();
  h.audits.length = 0;
  h.driverNotices.length = 0;
  h.operatorNotices.length = 0;
  h.events.length = 0;
  h.published.length = 0;
  h.publishFails = false;
  log.warn.mockClear();
});

const baseInput = {
  subject: 'Charger broken',
  description: 'It does not start',
  category: 'charging_failure' as const,
  priority: 'medium' as const,
  driverId: 'drv_1',
  stationId: 'sta_1',
  assignedTo: null,
  sessionIds: [] as string[],
  openedBy: { type: 'driver' as const, driverId: 'drv_1' },
  actor: { actor: 'driver' as const, actorDriverId: 'drv_1' },
};

describe('createSupportCase', () => {
  it('numbers the case, writes its first message and notifies operators', async () => {
    h.fake.queue('execute', [{ val: '7' }]);
    h.fake.queue('insert:support_cases', [caseRow()]);
    const row = await svc.createSupportCase({ ...baseInput, sessionIds: ['ses_1', 'ses_2'] });
    expect(row.id).toBe('cas_1');
    const [inserted] = h.fake.find('insert', 'support_cases');
    expect(inserted!.values).toMatchObject({
      caseNumber: 'CASE-00007',
      status: 'open',
      createdByDriver: true,
    });
    expect(inserted!.values).not.toHaveProperty('aiConsent');
    expect(h.fake.find('insert', 'support_case_sessions')[0]!.values).toEqual([
      { caseId: 'cas_1', sessionId: 'ses_1' },
      { caseId: 'cas_1', sessionId: 'ses_2' },
    ]);
    expect(h.fake.find('insert', 'support_case_messages')[0]!.values).toMatchObject({
      senderType: 'driver',
      senderId: 'drv_1',
      isInternal: false,
    });
    expect(h.audits.map((a) => a['action'])).toEqual(['created', 'sessions_linked']);
    expect(h.operatorNotices[0]).toEqual([
      'new_case',
      'cas_1',
      'CASE-00007',
      'Charger broken',
      null,
    ]);
    expect(h.events[0]).toEqual(['supportCase.created', 'cas_1', 'drv_1', { toOperators: true }]);
  });

  it('defaults the number to 1 when the sequence reads nothing', async () => {
    h.fake.queue('insert:support_cases', [caseRow()]);
    await svc.createSupportCase(baseInput);
    expect(h.fake.find('insert', 'support_cases')[0]!.values).toMatchObject({
      caseNumber: 'CASE-00001',
    });
  });

  it('queues a granted case for the AI, with consent audits in the transaction', async () => {
    h.fake.queue('insert:support_cases', [caseRow({ status: 'ai_assist' })]);
    await svc.createSupportCase({
      ...baseInput,
      aiConsent: { decision: 'granted', noticeVersion: 2, language: 'de' },
    });
    expect(h.fake.find('insert', 'support_cases')[0]!.values).toMatchObject({
      status: 'ai_assist',
      aiConsent: 'granted',
      aiConsentLanguage: 'de',
      aiConsentNoticeVersion: 2,
      aiState: 'queued',
      aiStateReason: null,
    });
    const auditRows = h.fake.find('insert', 'support_case_audit_log');
    expect(auditRows.map((c) => (c.values as { action: string }).action)).toEqual([
      'created',
      'ai_consent_granted',
    ]);
    expect(auditRows.every((c) => c.inTx)).toBe(true);
    expect((auditRows[1]!.values as { after: unknown }).after).toMatchObject({
      redacted: { decision: 'granted', noticeVersion: 2, language: 'de' },
    });
    expect(h.audits).toHaveLength(0);
    // Operators hear nothing until the AI step ends.
    expect(h.operatorNotices).toHaveLength(0);
    expect(h.events[0]).toEqual(['supportCase.created', 'cas_1', 'drv_1', { toOperators: false }]);
  });

  it('skips the AI step with a reason and escalates to operators at once', async () => {
    h.fake.queue('insert:support_cases', [caseRow()]);
    await svc.createSupportCase({
      ...baseInput,
      aiConsent: { decision: 'granted', noticeVersion: 1, language: 'en' },
      aiSkipReason: 'rate_limited',
    });
    expect(h.fake.find('insert', 'support_cases')[0]!.values).toMatchObject({
      status: 'open',
      aiState: 'skipped',
      aiStateReason: 'rate_limited',
    });
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'escalated_from_ai',
        actor: 'system',
        after: { aiState: 'skipped', reason: 'rate_limited' },
      }),
    ]);
    expect(h.operatorNotices).toHaveLength(1);
  });

  it('records a declined consent without an AI state', async () => {
    h.fake.queue('insert:support_cases', [caseRow()]);
    await svc.createSupportCase({
      ...baseInput,
      aiConsent: { decision: 'declined', noticeVersion: 1, language: 'en' },
    });
    const values = h.fake.find('insert', 'support_cases')[0]!.values as Record<string, unknown>;
    expect(values['aiConsent']).toBe('declined');
    expect(values).not.toHaveProperty('aiState');
    expect(
      h.fake
        .find('insert', 'support_case_audit_log')
        .map((c) => (c.values as { action: string }).action),
    ).toEqual(['created', 'ai_consent_declined']);
  });

  it('notifies the driver of an operator case', async () => {
    h.fake.queue('insert:support_cases', [caseRow({ createdByDriver: false })]);
    await svc.createSupportCase({
      ...baseInput,
      openedBy: { type: 'operator', userId: 'usr_1' },
      actor: operator,
    });
    expect(h.fake.find('insert', 'support_case_messages')[0]!.values).toMatchObject({
      senderType: 'operator',
      senderId: 'usr_1',
    });
    expect(h.driverNotices[0]![1]).toBe('supportCase.Created');
    expect(h.driverNotices[0]![2]).toBe('drv_1');
    expect(h.operatorNotices).toHaveLength(0);
    expect(h.events[0]).toEqual(['supportCase.created', 'cas_1', 'drv_1']);
  });

  it('sends no driver notice for an operator case without a driver', async () => {
    h.fake.queue('insert:support_cases', [caseRow({ driverId: null })]);
    await svc.createSupportCase({
      ...baseInput,
      driverId: null,
      openedBy: { type: 'operator', userId: 'usr_1' },
      actor: operator,
    });
    expect(h.driverNotices).toHaveLength(0);
    expect(h.events[0]).toEqual(['supportCase.created', 'cas_1', null]);
  });

  it('throws when the insert returns no row', async () => {
    await expect(svc.createSupportCase(baseInput)).rejects.toThrow('Failed to create support case');
    expect(h.audits).toHaveLength(0);
  });
});

describe('requestDriverAiAnalysis', () => {
  it('publishes the case id, and logs a failed publish', async () => {
    await svc.requestDriverAiAnalysis('cas_1', log, pubsub as never);
    expect(h.published).toEqual([
      { channel: expect.any(String) as string, message: JSON.stringify({ caseId: 'cas_1' }) },
    ]);
    h.publishFails = true;
    await expect(svc.requestDriverAiAnalysis('cas_1', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe('updateSupportCase', () => {
  it('changes every field with one message each, audits and notifies on resolve', async () => {
    h.fake.queue('update:support_cases', [caseRow({ status: 'resolved', aiState: 'escalated' })]);
    const updated = await svc.updateSupportCase({
      existing: caseRow({ status: 'ai_assist', aiState: 'awaiting_feedback', assignedTo: null }),
      status: 'resolved',
      priority: 'high',
      category: 'billing_dispute',
      assignedTo: 'usr_2',
      assigneeName: 'Ann',
      addSessionIds: ['ses_3'],
      removeSessionIds: ['ses_4'],
      userId: 'usr_1',
      actor: operator,
      log,
    });
    expect(updated?.status).toBe('resolved');
    const set = h.fake.find('update', 'support_cases')[0]!.set as Record<string, unknown>;
    expect(set).toMatchObject({
      status: 'resolved',
      resolutionSource: 'operator',
      priority: 'high',
      category: 'billing_dispute',
      assignedTo: 'usr_2',
    });
    expect(set['resolvedAt']).toBeInstanceOf(Date);
    expect(set['aiState']).toBeDefined();
    const msgs = h.fake.find('insert', 'support_case_messages')[0]!.values as { body: string }[];
    expect(msgs.map((m) => m.body)).toEqual([
      'Status changed from ai_assist to resolved',
      'Priority changed from medium to high',
      'Category changed from charging_failure to billing_dispute',
      'Assigned to Ann',
    ]);
    expect(h.fake.find('insert', 'support_case_sessions')).toHaveLength(1);
    expect(
      await sqlParams(opArgs(h.fake.find('delete', 'support_case_sessions')[0], 'where')?.[0]),
    ).toEqual(expect.arrayContaining(['cas_1', 'ses_4']));
    expect(h.audits.map((a) => a['action'])).toEqual([
      'escalated_from_ai',
      'status_changed',
      'priority_changed',
      'category_changed',
      'assigned',
      'sessions_linked',
      'sessions_unlinked',
    ]);
    expect(h.driverNotices[0]![1]).toBe('supportCase.Resolved');
    expect(h.events[0]).toEqual(['supportCase.updated', 'cas_1', 'drv_1']);
  });

  it('sets closedAt on close and clears the resolution on reopen', async () => {
    h.fake.queue('update:support_cases', [caseRow({ status: 'closed' })]);
    await svc.updateSupportCase({
      existing: caseRow(),
      status: 'closed',
      userId: 'usr_1',
      actor: operator,
    });
    const closeSet = h.fake.find('update', 'support_cases')[0]!.set as Record<string, unknown>;
    expect(closeSet['closedAt']).toBeInstanceOf(Date);
    expect(closeSet).not.toHaveProperty('resolutionSource');

    h.fake.queue('update:support_cases', [caseRow({ status: 'in_progress' })]);
    await svc.updateSupportCase({
      existing: caseRow({ status: 'resolved' }),
      status: 'in_progress',
      assignedTo: null,
      userId: 'usr_1',
      actor: operator,
    });
    const reopenSet = h.fake.find('update', 'support_cases')[1]!.set as Record<string, unknown>;
    expect(reopenSet['resolutionSource']).toBeNull();
    // Unchanged assignment (already null) writes no message.
    const bodies = h.fake
      .find('insert', 'support_case_messages')
      .flatMap((c) => (c.values as { body: string }[]).map((m) => m.body));
    expect(bodies).toEqual([
      'Status changed from open to closed',
      'Status changed from resolved to in_progress',
    ]);
    // No AI step was open: no escalation audit.
    expect(h.audits.map((a) => a['action'])).toEqual(['status_changed', 'status_changed']);
    expect(h.driverNotices).toHaveLength(0);
  });

  it('writes no message or audit when nothing changed, and unassigns', async () => {
    await svc.updateSupportCase({
      existing: caseRow(),
      status: 'open',
      priority: 'medium',
      category: 'charging_failure',
      addSessionIds: [],
      removeSessionIds: [],
      userId: 'usr_1',
      actor: operator,
    });
    expect(h.fake.find('insert', 'support_case_messages')).toHaveLength(0);
    expect(h.fake.find('delete')).toHaveLength(0);
    expect(h.audits).toHaveLength(0);

    await svc.updateSupportCase({
      existing: caseRow({ assignedTo: 'usr_2' }),
      assignedTo: null,
      userId: 'usr_1',
      actor: operator,
    });
    expect(
      (h.fake.find('insert', 'support_case_messages')[0]!.values as { body: string }[])[0]!.body,
    ).toBe('Assignment removed');
    expect(h.audits[0]).toMatchObject({
      action: 'assigned',
      before: { assignedTo: 'usr_2' },
      after: { assignedTo: null },
    });
  });

  it('trims the assignee message when the name is unknown', async () => {
    await svc.updateSupportCase({
      existing: caseRow(),
      assignedTo: 'usr_9',
      userId: 'usr_1',
      actor: operator,
    });
    expect(
      (h.fake.find('insert', 'support_case_messages')[0]!.values as { body: string }[])[0]!.body,
    ).toBe('Assigned to');
  });
});

describe('updateSupportCase status guard', () => {
  it('writes the status only while the case still has the status the operator read', async () => {
    h.fake.queue('update:support_cases', [caseRow({ status: 'in_progress' })]);
    await svc.updateSupportCase({
      existing: caseRow({ status: 'open' }),
      status: 'in_progress',
      userId: 'usr_1',
      actor: operator,
    });
    const update = h.fake.find('update', 'support_cases')[0]!;
    expect(await sqlParams(opArgs(update, 'where')?.[0])).toEqual(
      expect.arrayContaining(['cas_1', 'open']),
    );
  });

  it('refuses a status change when the driver closed or reopened the case meanwhile', async () => {
    // No row matches: the stored status is no longer the one the operator read.
    await expect(
      svc.updateSupportCase({
        existing: caseRow({ status: 'open' }),
        status: 'in_progress',
        addSessionIds: ['ses_3'],
        userId: 'usr_1',
        actor: operator,
      }),
    ).rejects.toBeInstanceOf(svc.SupportCaseStatusChangedError);
    expect(h.fake.find('insert', 'support_case_sessions')).toHaveLength(0);
    expect(h.fake.find('insert', 'support_case_messages')).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('does not guard a change that leaves the status alone', async () => {
    await svc.updateSupportCase({
      existing: caseRow({ status: 'open' }),
      priority: 'high',
      userId: 'usr_1',
      actor: operator,
    });
    const update = h.fake.find('update', 'support_cases')[0]!;
    expect(await sqlParams(opArgs(update, 'where')?.[0])).not.toContain('open');
    expect(h.audits.map((a) => a['action'])).toEqual(['priority_changed']);
  });
});

describe('operator messages, reads and refunds', () => {
  it('notifies the driver of a public reply and audits it', async () => {
    h.fake.queue('insert:support_case_messages', [{ id: 41 }]);
    const msg = await svc.addOperatorMessage({
      supportCase: caseRow(),
      userId: 'usr_1',
      body: 'We are on it',
      isInternal: false,
      actor: operator,
    });
    expect(msg).toEqual({ id: 41 });
    expect(h.driverNotices[0]![1]).toBe('supportCase.OperatorReply');
    expect(h.events[0]).toEqual(['supportCase.newMessage', 'cas_1', 'drv_1']);
    expect(h.audits[0]).toMatchObject({
      action: 'message_added',
      after: { messageId: 41, isInternal: false },
    });
  });

  it('keeps an internal note from the driver', async () => {
    await svc.addOperatorMessage({
      supportCase: caseRow(),
      userId: 'usr_1',
      body: 'note',
      isInternal: true,
      actor: operator,
    });
    expect(h.driverNotices).toHaveLength(0);
    expect(h.events[0]).toEqual(['supportCase.newMessage', 'cas_1', null]);
    expect(h.audits[0]).toMatchObject({ after: { messageId: undefined, isInternal: true } });
  });

  it('upserts the read marker', async () => {
    await svc.markSupportCaseRead('usr_1', 'cas_1');
    const [call] = h.fake.find('insert', 'support_case_reads');
    expect(call!.values).toMatchObject({ userId: 'usr_1', caseId: 'cas_1' });
    expect(opArgs(call, 'onConflictDoUpdate')).toBeDefined();
  });

  it('records a refund, and still audits when the message fails', async () => {
    const auditValues = { sessionId: 'ses_1', amountCents: 500, currency: 'USD' };
    await svc.recordSupportCaseRefund({
      supportCase: { id: 'cas_1', driverId: 'drv_1' },
      userId: 'usr_1',
      message: 'Refunded 5.00',
      audit: auditValues,
      actor: operator,
      log,
    });
    expect(h.fake.find('insert', 'support_case_messages')[0]!.values).toMatchObject({
      senderType: 'system',
      body: 'Refunded 5.00',
    });
    expect(h.audits[0]).toMatchObject({ action: 'refund_issued', after: auditValues });

    h.fake.fail('insert:support_case_messages', new Error('db down'));
    await svc.recordSupportCaseRefund({
      supportCase: { id: 'cas_1', driverId: null },
      userId: 'usr_1',
      message: 'Refunded',
      audit: auditValues,
      actor: operator,
      log,
    });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(h.audits).toHaveLength(2);
    expect(h.events[1]).toEqual(['supportCase.updated', 'cas_1', null]);
  });
});

describe('attachments', () => {
  it('inserts a row and returns it', async () => {
    h.fake.queue('insert:support_case_attachments', [{ id: 3 }]);
    expect(await svc.insertSupportCaseAttachment({ fileName: 'a.png' } as never)).toEqual({
      id: 3,
    });
    expect(await svc.insertSupportCaseAttachment({ fileName: 'b.png' } as never)).toBeUndefined();
  });

  it('audits an added attachment with its file facts only', async () => {
    await svc.recordSupportCaseAttachmentAdded({
      caseId: 'cas_1',
      messageId: 9,
      attachment: { fileName: 'a.png', fileSize: 100, contentType: 'image/png' },
      actor: operator,
    });
    expect(h.audits[0]).toMatchObject({
      action: 'attachment_added',
      after: { messageId: 9, fileName: 'a.png', fileSize: 100, contentType: 'image/png' },
    });
  });

  it('audits a deleted attachment only when a row was deleted', async () => {
    const input = { caseId: 'cas_1', messageId: 9, attachmentId: 5, actor: operator };
    await svc.deleteSupportCaseAttachment(input);
    expect(h.audits).toHaveLength(0);
    h.fake.queue('delete:support_case_attachments', [
      { fileName: 'a.png', fileSize: 100, contentType: 'image/png' },
    ]);
    await svc.deleteSupportCaseAttachment(input);
    expect(h.audits[0]).toMatchObject({
      action: 'attachment_deleted',
      before: { messageId: 9, attachmentId: 5, fileName: 'a.png' },
    });
  });
});

describe('addDriverMessage', () => {
  it('notifies operators of a reply on an open case', async () => {
    h.fake.queue('insert:support_case_messages', [{ id: 50 }]);
    const msg = await svc.addDriverMessage({
      supportCase: caseRow(),
      driverId: 'drv_1',
      body: 'Any news?',
    });
    expect(msg).toEqual({ id: 50 });
    expect(h.audits[0]).toMatchObject({
      action: 'message_added',
      actor: 'driver',
      actorDriverId: 'drv_1',
    });
    expect(h.operatorNotices[0]![0]).toBe('driver_reply');
    expect(h.events[0]).toEqual([
      'supportCase.newMessage',
      'cas_1',
      'drv_1',
      { toOperators: true },
    ]);
    expect(h.fake.find('update')).toHaveLength(0);
  });

  it.each([
    ['resolved', 'ai'],
    ['resolved', 'operator'],
    ['resolved', 'driver'],
    ['closed', 'operator'],
  ] as const)(
    'reopens a %s case (resolved by %s) before the reply, by compare-and-set',
    async (status, resolutionSource) => {
      h.fake.queue('select:support_cases', [{ status, resolutionSource }]);
      h.fake.queue('insert:support_case_messages', [{ id: 51 }]);
      h.fake.queue('insert:support_case_messages', [{ id: 52 }]);
      const msg = await svc.addDriverMessage({
        supportCase: caseRow({ status, resolutionSource }),
        driverId: 'drv_1',
        body: 'Still broken',
        log,
      });
      const update = h.fake.find('update', 'support_cases')[0]!;
      expect(update.inTx).toBe(true);
      expect(update.set).toMatchObject({
        status: 'open',
        resolvedAt: null,
        closedAt: null,
        resolutionSource: null,
      });
      // The status is read under the row lock, and the update is conditioned on it.
      const lock = h.fake.find('select', 'support_cases')[0]!;
      expect(lock.inTx).toBe(true);
      expect(opArgs(lock, 'for')?.[0]).toBe('update');
      expect(await sqlParams(opArgs(update, 'where')?.[0])).toEqual(
        expect.arrayContaining(['cas_1', status]),
      );
      // The reopen message comes first, then the reply.
      const messages = h.fake.find('insert', 'support_case_messages');
      expect(messages[0]!.values).toMatchObject({
        senderType: 'system',
        body: 'Reopened by the driver',
        isInternal: false,
      });
      expect(messages[1]!.values).toMatchObject({ senderType: 'driver', body: 'Still broken' });
      expect(msg).toEqual({ id: 52 });
      const reopenAudit = h.fake.find('insert', 'support_case_audit_log')[0]!;
      expect(reopenAudit.inTx).toBe(true);
      expect(reopenAudit.values).toMatchObject({
        action: 'status_changed',
        actor: 'driver',
        actorDriverId: 'drv_1',
        before: { redacted: { status, resolutionSource } },
        after: { redacted: { status: 'open', resolutionSource: null, reason: 'driver_replied' } },
      });
      expect(h.events[0]).toEqual(['supportCase.updated', 'cas_1', 'drv_1']);
      // The operator hears of it through the driver reply notice.
      expect(h.operatorNotices.map((n) => n[0])).toEqual(['driver_reply']);
    },
  );

  it('writes no reopen message or audit when an operator reopened the case meanwhile', async () => {
    h.fake.queue('select:support_cases', [{ status: 'in_progress', resolutionSource: null }]);
    await svc.addDriverMessage({
      supportCase: caseRow({ status: 'resolved', resolutionSource: 'ai' }),
      driverId: 'drv_1',
      body: 'Still broken',
    });
    expect(h.fake.find('update', 'support_cases')).toHaveLength(0);
    expect(h.audits.map((a) => a['action'])).toEqual(['message_added']);
    expect(h.fake.find('insert', 'support_case_audit_log')).toHaveLength(0);
    expect(h.fake.find('insert', 'support_case_messages')).toHaveLength(1);
  });

  it('reopens a case an operator resolved or closed after the reply read it', async () => {
    h.fake.queue('select:support_cases', [{ status: 'closed', resolutionSource: 'operator' }]);
    h.fake.queue('insert:support_case_messages', [{ id: 61 }]);
    h.fake.queue('insert:support_case_messages', [{ id: 62 }]);
    await svc.addDriverMessage({
      supportCase: caseRow({ status: 'open' }),
      driverId: 'drv_1',
      body: 'Still broken',
    });
    const update = h.fake.find('update', 'support_cases')[0]!;
    expect(update.set).toMatchObject({ status: 'open', closedAt: null });
    expect(await sqlParams(opArgs(update, 'where')?.[0])).toEqual(
      expect.arrayContaining(['cas_1', 'closed']),
    );
    expect(h.fake.find('insert', 'support_case_audit_log')[0]!.values).toMatchObject({
      before: { redacted: { status: 'closed', resolutionSource: 'operator' } },
    });
    expect(h.events[0]).toEqual(['supportCase.updated', 'cas_1', 'drv_1']);
  });

  it('escalates a case the AI still handles; operators get the new case notice', async () => {
    h.fake.queue('select:support_cases', [{ status: 'ai_assist', resolutionSource: null }]);
    h.fake.queue('select:support_cases', [{ aiState: 'awaiting_feedback' }]);
    h.fake.queue('update:support_cases', [caseRow({ status: 'open', aiState: 'escalated' })]);
    await svc.addDriverMessage({
      supportCase: caseRow({ status: 'ai_assist', aiState: 'awaiting_feedback' }),
      driverId: 'drv_1',
      body: 'Help',
      log,
    });
    expect(h.audits.map((a) => a['action'])).toEqual(['message_added', 'escalated_from_ai']);
    expect(h.audits[1]).toMatchObject({
      before: { status: 'ai_assist', aiState: 'awaiting_feedback' },
      after: { status: 'open', aiState: 'escalated', reason: 'driver_replied' },
    });
    expect(h.operatorNotices.map((n) => n[0])).toEqual(['new_case']);
    expect(h.events.at(-1)).toEqual([
      'supportCase.newMessage',
      'cas_1',
      'drv_1',
      { toOperators: true },
    ]);
  });

  it('keeps the event from operators while a lost escalation left the case with the AI', async () => {
    // The escalation lost its compare-and-set and the re-read still says ai_assist.
    h.fake.always('select:support_cases', [caseRow({ status: 'ai_assist' })]);
    await svc.addDriverMessage({
      supportCase: caseRow({ status: 'ai_assist', aiState: 'queued' }),
      driverId: 'drv_1',
      body: 'Help',
    });
    expect(h.operatorNotices.map((n) => n[0])).toEqual(['driver_reply']);
    expect(h.events.at(-1)).toEqual([
      'supportCase.newMessage',
      'cas_1',
      'drv_1',
      { toOperators: false },
    ]);
  });
});

describe('driver AI steps', () => {
  it('reads a case row', async () => {
    expect(await svc.getSupportCaseRow('cas_x')).toBeUndefined();
    h.fake.queue('select:support_cases', [caseRow()]);
    expect((await svc.getSupportCaseRow('cas_1'))?.id).toBe('cas_1');
  });

  it('claims a queued case once', async () => {
    h.fake.queue('update:support_cases', [{ id: 'cas_1' }]);
    expect(await svc.claimDriverAiAnalysis('cas_1')).toBe(true);
    expect(await svc.claimDriverAiAnalysis('cas_1')).toBe(false);
    expect(h.fake.calls[0]!.set).toMatchObject({ aiState: 'analyzing' });
    expect(await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0])).toEqual(
      expect.arrayContaining(['cas_1', 'queued', 'ai_assist']),
    );
  });

  it('requeues a stuck analysis only before the given time', async () => {
    const before = new Date('2026-11-12T00:00:00Z');
    h.fake.queue('update:support_cases', [{ id: 'cas_1' }]);
    expect(await svc.requeueStuckDriverAiAnalysis('cas_1', before)).toBe(true);
    expect(await svc.requeueStuckDriverAiAnalysis('cas_1', before)).toBe(false);
    expect(h.fake.calls[0]!.set).toMatchObject({ aiState: 'queued' });
    expect(await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0])).toContain(before);
  });

  it('stores the answer and its message in one transaction, then notifies the driver', async () => {
    h.fake.queue('update:support_cases', [caseRow({ status: 'ai_assist' })]);
    h.fake.queue('insert:support_case_messages', [{ id: 77 }]);
    const ok = await svc.storeDriverAiAnswer({
      caseId: 'cas_1',
      answer: 'Restart the charger',
      driverActions: ['retry_charging'] as never,
      needsOperator: false,
      provider: 'deepseek',
      model: 'm',
    });
    expect(ok).toBe(true);
    const [upd] = h.fake.find('update', 'support_cases');
    expect(upd!.inTx).toBe(true);
    expect(upd!.set).toMatchObject({ aiState: 'awaiting_feedback', aiNeedsOperator: false });
    expect(h.fake.find('insert', 'support_case_messages')[0]!.values).toMatchObject({
      senderId: null,
      body: 'Restart the charger',
    });
    expect(h.audits[0]).toMatchObject({
      action: 'ai_answered',
      actor: 'system',
      after: { messageId: 77, provider: 'deepseek', model: 'm', needsOperator: false },
    });
    expect(h.driverNotices).toHaveLength(1);
    expect(h.events[0]).toEqual(['supportCase.updated', 'cas_1', 'drv_1', { toOperators: false }]);
  });

  it('stores nothing when the case left analyzing, and skips the push without a driver', async () => {
    expect(
      await svc.storeDriverAiAnswer({
        caseId: 'cas_1',
        answer: 'x',
        driverActions: [],
        needsOperator: true,
        provider: 'p',
        model: 'm',
      }),
    ).toBe(false);
    expect(h.fake.find('insert')).toHaveLength(0);
    expect(h.audits).toHaveLength(0);

    h.fake.queue('update:support_cases', [caseRow({ driverId: null })]);
    expect(
      await svc.storeDriverAiAnswer({
        caseId: 'cas_1',
        answer: 'x',
        driverActions: [],
        needsOperator: true,
        provider: 'p',
        model: 'm',
      }),
    ).toBe(true);
    expect(h.driverNotices).toHaveLength(0);
    expect(h.audits[0]).toMatchObject({ after: { messageId: undefined } });
  });

  it('records a failure as ai_failed and reports false for a rerun', async () => {
    h.fake.queue('select:support_cases', []);
    h.fake.queue('update:support_cases', [caseRow()]);
    expect(
      await svc.escalateFromAi({
        caseId: 'cas_1',
        from: ['analyzing'],
        state: 'failed',
        reason: null,
      }),
    ).toBe(true);
    expect(h.audits[0]).toMatchObject({
      action: 'ai_failed',
      actor: 'system',
      before: { status: 'ai_assist', aiState: null },
      after: { status: 'open', aiState: 'failed', reason: null },
    });
    expect(h.operatorNotices).toHaveLength(1);
    expect(
      await svc.escalateFromAi({
        caseId: 'cas_1',
        from: ['analyzing'],
        state: 'failed',
        reason: null,
      }),
    ).toBe(false);
    expect(h.audits).toHaveLength(1);
  });

  it('resolves on a yes, by the driver, once', async () => {
    h.fake.queue('update:support_cases', [caseRow({ status: 'resolved' })]);
    expect(
      await svc.recordDriverAiFeedback({ caseId: 'cas_1', driverId: 'drv_1', satisfied: true }),
    ).toBe('resolved');
    expect(h.fake.calls[0]!.set).toMatchObject({
      status: 'resolved',
      resolutionSource: 'ai',
      aiState: 'resolved_by_ai',
    });
    expect(h.audits[0]).toMatchObject({ action: 'resolved_by_ai', actorDriverId: 'drv_1' });
    expect(h.operatorNotices).toHaveLength(0);
    expect(
      await svc.recordDriverAiFeedback({ caseId: 'cas_1', driverId: 'drv_1', satisfied: true }),
    ).toBe('not_awaiting');
  });

  it('escalates on a no with the feedback time, or reports not awaiting', async () => {
    h.fake.queue('select:support_cases', [{ aiState: 'awaiting_feedback' }]);
    h.fake.queue('update:support_cases', [caseRow({ status: 'open' })]);
    expect(
      await svc.recordDriverAiFeedback({
        caseId: 'cas_1',
        driverId: 'drv_1',
        satisfied: false,
        log,
      }),
    ).toBe('escalated');
    const set = h.fake.find('update', 'support_cases')[0]!.set as Record<string, unknown>;
    expect(set['aiFeedbackAt']).toBeInstanceOf(Date);
    expect(set['aiStateReason']).toBe('driver_declined_answer');
    expect(
      await sqlParams(opArgs(h.fake.find('update', 'support_cases')[0], 'where')?.[0]),
    ).toContain('drv_1');
    expect(
      await svc.recordDriverAiFeedback({ caseId: 'cas_1', driverId: 'drv_1', satisfied: false }),
    ).toBe('not_awaiting');
  });
});

describe('closeSupportCaseByDriver', () => {
  it('resolves the own case with a system message and an audit row in one transaction', async () => {
    h.fake.queue('select:support_cases', [caseRow({ status: 'in_progress', assignedTo: 'usr_2' })]);
    h.fake.queue('update:support_cases', [
      caseRow({ status: 'resolved', resolutionSource: 'driver', assignedTo: 'usr_2' }),
    ]);
    const result = await svc.closeSupportCaseByDriver({ caseId: 'cas_1', driverId: 'drv_1', log });
    expect(result.outcome).toBe('closed');
    const select = h.fake.find('select', 'support_cases')[0]!;
    expect(select.inTx).toBe(true);
    expect(select.ops.map((o) => o.name)).toContain('for');
    // Ownership is part of the locked read.
    expect(await sqlParams(opArgs(select, 'where')?.[0])).toEqual(
      expect.arrayContaining(['cas_1', 'drv_1']),
    );
    const update = h.fake.find('update', 'support_cases')[0]!;
    expect(update.inTx).toBe(true);
    expect(update.set).toMatchObject({ status: 'resolved', resolutionSource: 'driver' });
    expect(update.set).not.toHaveProperty('aiState');
    const message = h.fake.find('insert', 'support_case_messages')[0]!;
    expect(message.inTx).toBe(true);
    expect(message.values).toMatchObject({
      senderType: 'system',
      senderId: 'drv_1',
      body: 'Closed by the driver',
      isInternal: false,
    });
    const audits = h.fake.find('insert', 'support_case_audit_log');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.inTx).toBe(true);
    expect(audits[0]!.values).toMatchObject({
      action: 'status_changed',
      actor: 'driver',
      actorDriverId: 'drv_1',
      before: { redacted: { status: 'in_progress' } },
      after: {
        redacted: { status: 'resolved', resolutionSource: 'driver', reason: 'driver_closed' },
      },
    });
    expect(h.operatorNotices).toEqual([
      ['driver_closed', 'cas_1', 'CASE-00007', 'Charger broken', 'usr_2'],
    ]);
    expect(h.events).toEqual([['supportCase.updated', 'cas_1', 'drv_1']]);
    // No resolved notice to the driver for the own close.
    expect(h.driverNotices).toHaveLength(0);
  });

  it.each(['resolved', 'closed'] as const)('changes nothing on a %s case', async (status) => {
    h.fake.queue('select:support_cases', [caseRow({ status })]);
    const result = await svc.closeSupportCaseByDriver({ caseId: 'cas_1', driverId: 'drv_1' });
    expect(result.outcome).toBe('unchanged');
    expect(h.fake.find('update')).toHaveLength(0);
    expect(h.fake.find('insert')).toHaveLength(0);
    expect(h.operatorNotices).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("answers not_found for another driver's or an unknown case and writes nothing", async () => {
    const result = await svc.closeSupportCaseByDriver({ caseId: 'cas_9', driverId: 'drv_2' });
    expect(result).toEqual({ outcome: 'not_found' });
    expect(h.fake.find('update')).toHaveLength(0);
    expect(h.fake.find('insert')).toHaveLength(0);
    expect(h.operatorNotices).toHaveLength(0);
  });

  it('ends an open AI step as escalated, as an operator status change does', async () => {
    h.fake.queue('select:support_cases', [
      caseRow({ status: 'ai_assist', aiState: 'awaiting_feedback' }),
    ]);
    h.fake.queue('update:support_cases', [caseRow({ status: 'resolved', aiState: 'escalated' })]);
    const result = await svc.closeSupportCaseByDriver({ caseId: 'cas_1', driverId: 'drv_1' });
    expect(result.outcome).toBe('closed');
    expect(h.fake.find('update', 'support_cases')[0]!.set).toMatchObject({
      status: 'resolved',
      resolutionSource: 'driver',
      aiState: 'escalated',
      aiStateReason: null,
    });
    const actions = h.fake
      .find('insert', 'support_case_audit_log')
      .map((c) => (c.values as { action: string }).action);
    expect(actions).toEqual(['escalated_from_ai', 'status_changed']);
  });
});
