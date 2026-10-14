// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeAuditMock, deleted, returningMock } = vi.hoisted(() => {
  const deleted = { rows: [] as unknown[] };
  return {
    writeAuditMock: vi.fn(),
    deleted,
    returningMock: vi.fn(async () => deleted.rows),
  };
});

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: returningMock })) })),
    },
    writeAudit: writeAuditMock,
  };
});

import { supportCaseAuditLog } from '@evtivity/database';
import { deleteSupportCaseAttachment } from '../support-case.service.js';

const ACTOR = { actor: 'operator' as const, actorUserId: 'usr_1' };

describe('deleteSupportCaseAttachment', () => {
  beforeEach(() => {
    writeAuditMock.mockClear();
    deleted.rows = [];
  });

  it('audits attachment_deleted on the case with the deleted file', async () => {
    deleted.rows = [{ fileName: 'photo.jpg', fileSize: 1200, contentType: 'image/jpeg' }];
    await deleteSupportCaseAttachment({
      caseId: 'cas_1',
      messageId: 7,
      attachmentId: 9,
      actor: ACTOR,
    });
    expect(writeAuditMock).toHaveBeenCalledWith(
      { table: supportCaseAuditLog, idColumn: 'support_case_id' },
      {
        entityId: 'cas_1',
        entityIdSnapshot: 'cas_1',
        action: 'attachment_deleted',
        ...ACTOR,
        before: {
          messageId: 7,
          attachmentId: 9,
          fileName: 'photo.jpg',
          fileSize: 1200,
          contentType: 'image/jpeg',
        },
      },
      expect.anything(),
      undefined,
    );
  });

  it('writes no audit row when no attachment was deleted', async () => {
    await deleteSupportCaseAttachment({
      caseId: 'cas_1',
      messageId: 7,
      attachmentId: 9,
      actor: ACTOR,
    });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});
