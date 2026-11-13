// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@evtivity/lib';

const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  updates: [] as unknown[][],
  updateSets: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  deletes: 0,
  txUpdates: [] as unknown[][],
  storage: null as Record<string, unknown> | null,
  limits: { maxBytes: 1000, maxPerMessage: 2 },
  finalize: vi.fn(),
}));

function chain(result: () => unknown, onSet?: (v: Record<string, unknown>) => void): unknown {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'returning']) c[m] = vi.fn(() => c);
  c['set'] = vi.fn((v: Record<string, unknown>) => {
    onSet?.(v);
    return c;
  });
  c['values'] = vi.fn((v: Record<string, unknown>) => {
    h.inserts.push(v);
    return c;
  });
  c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return c;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => chain(() => h.selects.shift() ?? [])),
    insert: vi.fn(() => chain(() => [])),
    update: vi.fn(() =>
      chain(
        () => h.updates.shift() ?? [],
        (v) => h.updateSets.push(v),
      ),
    ),
    delete: vi.fn(() =>
      chain(() => {
        h.deletes++;
        return [];
      }),
    ),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ update: vi.fn(() => chain(() => h.txUpdates.shift() ?? [])) }),
    ),
  },
  aiAttachments: {
    id: 'a.id',
    userId: 'a.userId',
    deletedAt: 'a.deletedAt',
    status: 'a.status',
    conversationId: 'a.conversationId',
  },
  aiConversationAuditLog: {},
  writeAudit: vi.fn(),
}));

vi.mock('../services/storage.service.js', () => ({
  getObjectStorage: vi.fn(async () => h.storage),
  QUARANTINE_PREFIX: 'quarantine/',
  sanitizeFileName: vi.fn((name: string) => name.replace(/\//g, '_')),
  UPLOAD_URL_EXPIRES_SECONDS: 300,
}));

vi.mock('../services/ai/attachments/upload-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai/attachments/upload-flow.js')>();
  return {
    ...actual,
    attachmentLimits: vi.fn(async () => h.limits),
    finalizeUpload: h.finalize,
  };
});

import {
  claimChatAttachments,
  confirmChatAttachment,
  deleteChatAttachment,
  getChatAttachment,
  getChatAttachmentDownloadUrl,
  markConversationAttachmentsDeleted,
  readChatAttachmentBytes,
  requestChatAttachmentUpload,
} from '../services/ai/attachments/chat-attachments.service.js';

const log = { warn: vi.fn() } as never;
const ACTOR = {
  actor: 'operator' as const,
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'att_1',
    userId: 'usr_1',
    status: 'ready',
    fileName: 'meter.png',
    declaredType: 'image/png',
    contentType: 'image/png',
    kind: 'image',
    sizeBytes: 500,
    width: 10,
    height: 20,
    pageCount: null,
    conversationId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    s3Bucket: 'b',
    s3Key: 'clean',
    quarantineKey: 'q',
    ...over,
  };
}

function storage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bucket: 'b',
    createUpload: vi.fn(async () => ({ method: 'POST', url: 'https://s3/up', fields: { a: '1' } })),
    getDownloadUrl: vi.fn(async () => 'https://s3/dl'),
    deleteObject: vi.fn(async () => undefined),
    readObject: vi.fn(async () => ({ status: 'ok', bytes: Buffer.from('abc') })),
    ...over,
  };
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

beforeEach(() => {
  h.selects = [];
  h.updates = [];
  h.updateSets = [];
  h.inserts = [];
  h.deletes = 0;
  h.txUpdates = [];
  h.storage = storage();
  h.limits = { maxBytes: 1000, maxPerMessage: 2 };
});

describe('requestChatAttachmentUpload', () => {
  it('records a pending attachment under the user quarantine prefix', async () => {
    const ticket = await requestChatAttachmentUpload('usr/1', {
      fileName: 'photo.png',
      contentType: 'image/png',
      fileSize: 200,
    });
    expect(ticket.uploadMethod).toBe('POST');
    expect(ticket.uploadUrl).toBe('https://s3/up');
    expect(ticket.fields).toEqual({ a: '1' });
    expect(ticket.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const inserted = h.inserts[0];
    expect(inserted).toMatchObject({
      id: ticket.attachmentId,
      userId: 'usr/1',
      status: 'pending',
      fileName: 'photo.png',
      declaredType: 'image/png',
      declaredSize: 200,
      s3Bucket: 'b',
    });
    expect(inserted?.['quarantineKey']).toBe(
      `quarantine/chat/usr_1/${ticket.attachmentId}/photo.png`,
    );
    const create = h.storage?.['createUpload'] as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledWith(inserted?.['quarantineKey'], 'image/png', {
      size: 200,
      maxBytes: 1000,
    });
  });

  it('refuses an oversized file before any storage call', async () => {
    expect(
      await code(
        requestChatAttachmentUpload('u', {
          fileName: 'a.png',
          contentType: 'image/png',
          fileSize: 5000,
        }),
      ),
    ).toBe('AI_ATTACHMENT_TOO_LARGE');
    expect(h.inserts).toHaveLength(0);
  });

  it('answers STORAGE_NOT_CONFIGURED without storage', async () => {
    h.storage = null;
    expect(
      await code(
        requestChatAttachmentUpload('u', {
          fileName: 'a.png',
          contentType: 'image/png',
          fileSize: 10,
        }),
      ),
    ).toBe('STORAGE_NOT_CONFIGURED');
  });
});

describe('confirmChatAttachment', () => {
  it('returns a ready attachment again without processing', async () => {
    h.selects = [[row()]];
    const a = await confirmChatAttachment('usr_1', 'att_1', log);
    expect(a).toMatchObject({ id: 'att_1', kind: 'image', sizeBytes: 500 });
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown attachment', async () => {
    expect(await code(confirmChatAttachment('usr_1', 'x', log))).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('answers 404 for a pending upload of a disallowed declared type', async () => {
    h.selects = [[row({ status: 'pending', declaredType: 'application/zip' })]];
    expect(await code(confirmChatAttachment('usr_1', 'att_1', log))).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('refuses when the storage bucket changed since the upload', async () => {
    h.selects = [[row({ status: 'pending', s3Bucket: 'old' })]];
    expect(await code(confirmChatAttachment('usr_1', 'att_1', log))).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('marks a refused upload deleted and rethrows', async () => {
    h.selects = [[row({ status: 'pending' })]];
    h.finalize.mockRejectedValueOnce(new AppError('bad', 400, 'AI_ATTACHMENT_REJECTED'));
    expect(await code(confirmChatAttachment('usr_1', 'att_1', log))).toBe('AI_ATTACHMENT_REJECTED');
    expect(h.updateSets[0]).toHaveProperty('deletedAt');
  });

  it('does not mark the upload deleted on a server error', async () => {
    h.selects = [[row({ status: 'pending' })]];
    h.finalize.mockRejectedValueOnce(new Error('s3 down'));
    expect(await code(confirmChatAttachment('usr_1', 'att_1', log))).toBe('Error: s3 down');
    expect(h.updateSets).toHaveLength(0);
  });

  it('stores the processed result under the clean key', async () => {
    h.selects = [[row({ status: 'pending', fileName: 'photo.webp', declaredType: 'image/webp' })]];
    h.finalize.mockResolvedValueOnce({
      contentType: 'image/png',
      kind: 'image',
      bytes: Buffer.alloc(42),
      width: 3,
      height: 4,
    });
    h.updates = [[row({ fileName: 'photo.png', sizeBytes: 42 })]];
    const a = await confirmChatAttachment('usr_1', 'att_1', log);
    expect(a.fileName).toBe('photo.png');
    expect(h.finalize).toHaveBeenCalledWith(
      {
        storage: h.storage,
        quarantineKey: 'q',
        cleanKey: 'ai-uploads/chat/usr_1/att_1-photo.webp',
        declaredType: 'image/webp',
        maxBytes: 1000,
      },
      log,
    );
    expect(h.updateSets[0]).toMatchObject({
      status: 'ready',
      fileName: 'photo.png',
      contentType: 'image/png',
      kind: 'image',
      sizeBytes: 42,
      width: 3,
      height: 4,
      pageCount: null,
      s3Key: 'ai-uploads/chat/usr_1/att_1-photo.webp',
    });
  });

  it('returns the concurrent confirm result when its own update matched nothing', async () => {
    h.selects = [[row({ status: 'pending' })], [row({ sizeBytes: 77 })]];
    h.finalize.mockResolvedValueOnce({
      contentType: 'application/pdf',
      kind: 'pdf',
      bytes: Buffer.alloc(1),
      pageCount: 2,
    });
    h.updates = [[]];
    const a = await confirmChatAttachment('usr_1', 'att_1', log);
    expect(a.sizeBytes).toBe(77);
    expect(h.updateSets[0]).toMatchObject({ width: null, height: null, pageCount: 2 });
  });
});

describe('getChatAttachment', () => {
  it('maps a ready row', async () => {
    h.selects = [[row({ sizeBytes: null })]];
    expect(await getChatAttachment('usr_1', 'att_1')).toEqual({
      id: 'att_1',
      fileName: 'meter.png',
      contentType: 'image/png',
      kind: 'image',
      sizeBytes: 0,
      width: 10,
      height: 20,
      pageCount: null,
      conversationId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('answers 404 for a row that is not ready, has no kind or a bad type', async () => {
    h.selects = [[row({ status: 'pending' })]];
    expect(await code(getChatAttachment('usr_1', 'att_1'))).toBe('ATTACHMENT_NOT_FOUND');
    h.selects = [[row({ kind: null })]];
    expect(await code(getChatAttachment('usr_1', 'att_1'))).toBe('ATTACHMENT_NOT_FOUND');
    h.selects = [[row({ contentType: null })]];
    expect(await code(getChatAttachment('usr_1', 'att_1'))).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('getChatAttachmentDownloadUrl', () => {
  it('presigns the clean object with the file name and sniffed type', async () => {
    h.selects = [[row()]];
    expect(await getChatAttachmentDownloadUrl('usr_1', 'att_1')).toBe('https://s3/dl');
    expect(h.storage?.['getDownloadUrl']).toHaveBeenCalledWith('b', 'clean', {
      fileName: 'meter.png',
      contentType: 'image/png',
    });
  });

  it('answers 404 without a clean key', async () => {
    h.selects = [[row({ s3Key: null })]];
    expect(await code(getChatAttachmentDownloadUrl('usr_1', 'att_1'))).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('deleteChatAttachment', () => {
  it('deletes both objects and the row', async () => {
    h.selects = [[row()]];
    await deleteChatAttachment('usr_1', 'att_1', log, ACTOR);
    const del = h.storage?.['deleteObject'] as ReturnType<typeof vi.fn>;
    expect(del.mock.calls).toEqual([
      ['b', 'q'],
      ['b', 'clean'],
    ]);
    expect(h.deletes).toBe(1);
  });

  it('deletes only the quarantine object without a clean key', async () => {
    h.selects = [[row({ s3Key: null })]];
    await deleteChatAttachment('usr_1', 'att_1', log, ACTOR);
    expect(h.storage?.['deleteObject']).toHaveBeenCalledTimes(1);
  });

  it('keeps the row marked deleted when storage is not configured', async () => {
    h.selects = [[row()]];
    h.storage = null;
    const warn = vi.fn();
    await deleteChatAttachment('usr_1', 'att_1', { warn } as never, ACTOR);
    expect(h.updateSets[0]).toHaveProperty('deletedAt');
    expect(h.deletes).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 'att_1' }),
      'chat attachment S3 delete failed; the retention cron retries',
    );
  });
});

describe('claimChatAttachments', () => {
  it('returns nothing for no ids', async () => {
    expect(await claimChatAttachments('u', 'c', [])).toEqual([]);
  });

  it('refuses more ids than the per-message limit, duplicates counted once', async () => {
    h.txUpdates = [[row(), row({ id: 'att_2' })]];
    const ok = await claimChatAttachments('usr_1', 'cnv', ['att_1', 'att_2', 'att_1']);
    expect(ok.map((a) => a.id)).toEqual(['att_1', 'att_2']);
    expect(await code(claimChatAttachments('usr_1', 'cnv', ['a', 'b', 'c']))).toBe(
      'AI_ATTACHMENT_TOO_LARGE',
    );
  });

  it('answers 404 when an id is not claimable', async () => {
    h.txUpdates = [[row()]];
    expect(await code(claimChatAttachments('usr_1', 'cnv', ['att_1', 'att_2']))).toBe(
      'ATTACHMENT_NOT_FOUND',
    );
  });
});

describe('markConversationAttachmentsDeleted', () => {
  it('returns the number of rows marked', async () => {
    h.updates = [[{ id: 'a' }, { id: 'b' }]];
    expect(await markConversationAttachmentsDeleted('cnv')).toBe(2);
  });
});

describe('readChatAttachmentBytes', () => {
  it('reads the clean object up to the larger of the limit and its size', async () => {
    h.selects = [[row({ sizeBytes: 5000 })]];
    const out = await readChatAttachmentBytes('usr_1', 'att_1');
    expect(out.bytes.toString()).toBe('abc');
    expect(out.attachment.id).toBe('att_1');
    expect(h.storage?.['readObject']).toHaveBeenCalledWith('b', 'clean', 5000);
  });

  it('answers 404 without a clean key or when the object read fails', async () => {
    h.selects = [[row({ s3Key: null })]];
    expect(await code(readChatAttachmentBytes('usr_1', 'att_1'))).toBe('ATTACHMENT_NOT_FOUND');
    h.selects = [[row()]];
    h.storage = storage({ readObject: vi.fn(async () => ({ status: 'missing' })) });
    expect(await code(readChatAttachmentBytes('usr_1', 'att_1'))).toBe('ATTACHMENT_NOT_FOUND');
  });
});
