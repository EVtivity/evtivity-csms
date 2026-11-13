// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type { ModelCapabilities } from '@evtivity/ai/core';

const read = vi.hoisted(() => vi.fn());
vi.mock('../services/ai/attachments/chat-attachments.service.js', () => ({
  readChatAttachmentBytes: read,
}));

import {
  attachmentParts,
  attachmentProblem,
  attachmentResolverFor,
} from '../services/ai/engine/attachments.js';
import type { ChatAttachment } from '../services/ai/attachments/chat-attachments.service.js';

function att(over: Partial<ChatAttachment>): ChatAttachment {
  return {
    id: 'att_1',
    fileName: 'f.png',
    contentType: 'image/png',
    kind: 'image',
    sizeBytes: 100,
    width: null,
    height: null,
    pageCount: null,
    conversationId: null,
    createdAt: new Date(0),
    ...over,
  };
}

const PDF: ChatAttachment = att({
  id: 'att_2',
  fileName: 'r.pdf',
  contentType: 'application/pdf',
  kind: 'pdf',
  sizeBytes: 100,
  pageCount: 3,
});

function caps(over: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    streaming: true,
    tools: true,
    parallelToolCalls: true,
    strictTools: false,
    vision: { formats: ['image/png', 'image/jpeg'], maxImages: 2, maxBytes: 1000 },
    documents: { pdf: { maxBytes: 1000, maxPages: 5 }, text: true },
    caching: 'none',
    structuredOutput: false,
    citations: 'prompted',
    effort: [],
    samplingParams: true,
    maxContextTokens: 1000,
    maxOutputTokens: 100,
    ...over,
  } as ModelCapabilities;
}

describe('attachmentParts', () => {
  it('maps images to image parts and the rest to named document parts', () => {
    expect(attachmentParts([att({}), PDF])).toEqual([
      { type: 'image', attachmentId: 'att_1', mime: 'image/png' },
      { type: 'document', attachmentId: 'att_2', mime: 'application/pdf', name: 'r.pdf' },
    ]);
  });
});

describe('attachmentProblem', () => {
  it('is null when the model takes them', () => {
    expect(attachmentProblem([att({}), PDF], caps())).toBeNull();
  });

  it('is unsupported without vision, pdf support, or for too many images', () => {
    expect(attachmentProblem([att({})], caps({ vision: false }))).toBe('AI_ATTACHMENT_UNSUPPORTED');
    expect(attachmentProblem([PDF], caps({ documents: { pdf: false, text: true } }))).toBe(
      'AI_ATTACHMENT_UNSUPPORTED',
    );
    expect(attachmentProblem([att({}), att({}), att({})], caps())).toBe(
      'AI_ATTACHMENT_UNSUPPORTED',
    );
  });

  it('is too large for a big image, a big PDF or too many pages', () => {
    expect(attachmentProblem([att({ sizeBytes: 1001 })], caps())).toBe('AI_ATTACHMENT_TOO_LARGE');
    expect(attachmentProblem([{ ...PDF, sizeBytes: 2000 }], caps())).toBe(
      'AI_ATTACHMENT_TOO_LARGE',
    );
    expect(attachmentProblem([{ ...PDF, pageCount: 6 }], caps())).toBe('AI_ATTACHMENT_TOO_LARGE');
    expect(attachmentProblem([{ ...PDF, pageCount: null }], caps())).toBeNull();
  });

  it('never limits text documents by size', () => {
    const text = att({ kind: 'text', contentType: 'text/plain', sizeBytes: 10_000 });
    expect(attachmentProblem([text], caps({ vision: false }))).toBeNull();
  });
});

describe('attachmentResolverFor', () => {
  it("reads the user's own attachment bytes", async () => {
    read.mockResolvedValueOnce({ bytes: Buffer.from('xy'), attachment: PDF });
    const out = await attachmentResolverFor('usr_1')('att_2');
    expect(read).toHaveBeenCalledWith('usr_1', 'att_2');
    expect(out.mime).toBe('application/pdf');
    expect(out.name).toBe('r.pdf');
    expect(Array.from(out.data)).toEqual([120, 121]);
  });
});
