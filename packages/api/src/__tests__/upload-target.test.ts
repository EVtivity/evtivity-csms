// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Upload tickets: the declared size reaches createUpload (Cloudflare R2 signs
// exactly that size), and a POST or a PUT target becomes the same response
// fields.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createUploadMock, insertValuesMock } = vi.hoisted(() => ({
  createUploadMock: vi.fn(),
  insertValuesMock: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { insert: vi.fn(() => ({ values: insertValuesMock })) },
  aiAttachments: {},
  aiConversationAuditLog: {},
  supportCaseAttachments: {},
  writeAudit: vi.fn(),
  getAiSettings: vi.fn(async () => ({
    limits: { attachmentsMaxBytes: 5000, attachmentsMaxPerMessage: 3 },
  })),
}));

vi.mock('@evtivity/services/support-case.service', () => ({
  insertSupportCaseAttachment: vi.fn(),
}));

vi.mock('../services/storage.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/storage.service.js')>()),
  getObjectStorage: vi.fn(async () => ({ bucket: 'files', createUpload: createUploadMock })),
}));

import { uploadTargetResponse } from '../lib/upload-target.js';
import { requestChatAttachmentUpload } from '../services/ai/attachments/chat-attachments.service.js';
import { requestSupportAttachmentUpload } from '../services/ai/attachments/support-attachments.js';

const PUT_TARGET = {
  method: 'PUT',
  url: 'https://acct.r2.cloudflarestorage.com/files/k?X-Amz-Signature=s',
  headers: { 'Content-Type': 'application/pdf' },
} as const;

describe('uploadTargetResponse', () => {
  it('passes a POST form through with no headers', () => {
    expect(
      uploadTargetResponse({ method: 'POST', url: 'https://s3/u', fields: { key: 'k' } }),
    ).toEqual({
      uploadUrl: 'https://s3/u',
      uploadMethod: 'POST',
      fields: { key: 'k' },
      uploadHeaders: {},
    });
  });

  it('passes a PUT through with its headers and no form fields', () => {
    expect(uploadTargetResponse(PUT_TARGET)).toEqual({
      uploadUrl: PUT_TARGET.url,
      uploadMethod: 'PUT',
      fields: {},
      uploadHeaders: { 'Content-Type': 'application/pdf' },
    });
  });
});

describe('attachment upload tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createUploadMock.mockResolvedValue(PUT_TARGET);
    insertValuesMock.mockResolvedValue(undefined);
  });

  it('signs a chat attachment for its declared size within ai.attachments.maxBytes', async () => {
    const ticket = await requestChatAttachmentUpload('usr_1', {
      fileName: 'receipt.pdf',
      contentType: 'application/pdf',
      fileSize: 1234,
    });
    expect(createUploadMock).toHaveBeenCalledWith(
      expect.stringMatching(/^ai-uploads\/quarantine\/chat\//),
      'application/pdf',
      { size: 1234, maxBytes: 5000 },
    );
    expect(ticket).toMatchObject({
      uploadUrl: PUT_TARGET.url,
      uploadMethod: 'PUT',
      fields: {},
      uploadHeaders: { 'Content-Type': 'application/pdf' },
    });
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ declaredSize: 1234 }));
  });

  it('signs a support attachment for its declared size within ai.attachments.maxBytes', async () => {
    const ticket = await requestSupportAttachmentUpload('case_1', 5, {
      fileName: 'receipt.pdf',
      contentType: 'application/pdf',
      fileSize: 4321,
    });
    expect(createUploadMock).toHaveBeenCalledWith(
      expect.stringMatching(/^ai-uploads\/quarantine\/support-cases\/case_1\/5\//),
      'application/pdf',
      { size: 4321, maxBytes: 5000 },
    );
    expect(ticket).toMatchObject({ uploadMethod: 'PUT', uploadUrl: PUT_TARGET.url });
  });

  it('refuses a declared size over the limit before anything is signed', async () => {
    await expect(
      requestChatAttachmentUpload('usr_1', {
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        fileSize: 5001,
      }),
    ).rejects.toMatchObject({ code: 'AI_ATTACHMENT_TOO_LARGE' });
    expect(createUploadMock).not.toHaveBeenCalled();
  });
});
