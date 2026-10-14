// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeAuditMock, state } = vi.hoisted(() => ({
  writeAuditMock: vi.fn(),
  state: { row: null as Record<string, unknown> | null },
}));

function chain(result: () => unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'set', 'limit']) c[m] = vi.fn(() => c);
  c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return c;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => chain(() => (state.row == null ? [] : [state.row]))),
    update: vi.fn(() => chain(() => [])),
    delete: vi.fn(() => chain(() => [])),
  },
  aiAttachments: { id: 'a.id', userId: 'a.userId', deletedAt: 'a.deletedAt' },
  aiConversationAuditLog: { table: 'ai_conversation_audit_log' },
  writeAudit: writeAuditMock,
}));

vi.mock('../services/s3.service.js', () => ({
  getS3Config: vi.fn(async () => ({ bucket: 'b' })),
  deleteObject: vi.fn(async () => undefined),
  generateDownloadUrl: vi.fn(),
  generateUploadPost: vi.fn(),
  QUARANTINE_PREFIX: 'quarantine/',
  readObject: vi.fn(),
  sanitizeFileName: vi.fn((name: string) => name),
  UPLOAD_URL_EXPIRES_SECONDS: 300,
}));

import { deleteChatAttachment } from '../services/ai/attachments/chat-attachments.service.js';

const ACTOR = {
  actor: 'operator' as const,
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};
const log = { warn: vi.fn() } as never;

function attachment(conversationId: string | null): Record<string, unknown> {
  return {
    id: 'att_1',
    userId: 'usr_1',
    conversationId,
    fileName: 'meter.png',
    contentType: 'image/png',
    s3Bucket: 'b',
    s3Key: 'k',
    quarantineKey: 'q',
    status: 'ready',
  };
}

describe('deleteChatAttachment audit', () => {
  beforeEach(() => {
    writeAuditMock.mockClear();
  });

  it('audits attachment_deleted on the conversation the attachment belongs to', async () => {
    state.row = attachment('cnv_1');
    await deleteChatAttachment('usr_1', 'att_1', log, ACTOR);
    expect(writeAuditMock).toHaveBeenCalledWith(
      { table: { table: 'ai_conversation_audit_log' }, idColumn: 'ai_conversation_id' },
      {
        entityId: 'cnv_1',
        entityIdSnapshot: 'cnv_1',
        action: 'attachment_deleted',
        ...ACTOR,
        before: { attachmentId: 'att_1', fileName: 'meter.png', contentType: 'image/png' },
      },
      expect.anything(),
      log,
    );
  });

  it('writes no audit row for an upload no conversation used', async () => {
    state.row = attachment(null);
    await deleteChatAttachment('usr_1', 'att_1', log, ACTOR);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});
