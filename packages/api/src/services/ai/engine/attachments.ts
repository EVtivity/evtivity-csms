// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Chat attachments in a turn: the message parts that reference them, the
 * check against the model's capabilities (from the stored kind, type, size
 * and page count) before anything is sent, and the bytes for the adapter.
 */

import { findUnsupportedParts } from '../core/messages.js';
import type {
  AiAttachmentResolver,
  AiPart,
  DocumentMime,
  ImageMime,
  ModelCapabilities,
} from '../core/types.js';
import { readChatAttachmentBytes } from '../attachments/chat-attachments.service.js';
import type { ChatAttachment } from '../attachments/chat-attachments.service.js';

/** The parts a user message gets for its attachments (images, PDFs, text files). */
export function attachmentParts(attachments: readonly ChatAttachment[]): AiPart[] {
  return attachments.map((a): AiPart => {
    if (a.kind === 'image') {
      return { type: 'image', attachmentId: a.id, mime: a.contentType as ImageMime };
    }
    return {
      type: 'document',
      attachmentId: a.id,
      mime: a.contentType as DocumentMime,
      name: a.fileName,
    };
  });
}

export type AttachmentProblem = 'AI_ATTACHMENT_UNSUPPORTED' | 'AI_ATTACHMENT_TOO_LARGE';

/**
 * Whether the model can take these attachments: the kind and format
 * (vision, PDF support), the number of images, and the size and page limits.
 * Null when it can.
 */
export function attachmentProblem(
  attachments: readonly ChatAttachment[],
  caps: ModelCapabilities,
): AttachmentProblem | null {
  const parts = attachmentParts(attachments);
  if (findUnsupportedParts({ messages: [{ role: 'user', parts }] }, caps).length > 0) {
    return 'AI_ATTACHMENT_UNSUPPORTED';
  }
  for (const a of attachments) {
    if (a.kind === 'image' && caps.vision !== false && a.sizeBytes > caps.vision.maxBytes) {
      return 'AI_ATTACHMENT_TOO_LARGE';
    }
    if (a.kind === 'pdf' && caps.documents.pdf !== false) {
      const pdf = caps.documents.pdf;
      if (a.sizeBytes > pdf.maxBytes || (a.pageCount ?? 0) > pdf.maxPages) {
        return 'AI_ATTACHMENT_TOO_LARGE';
      }
    }
  }
  return null;
}

/** The adapter's attachment reader for a user's turn: only their own ready attachments. */
export function attachmentResolverFor(userId: string): AiAttachmentResolver {
  return async (attachmentId) => {
    const { bytes, attachment } = await readChatAttachmentBytes(userId, attachmentId);
    return {
      mime: attachment.contentType,
      data: new Uint8Array(bytes),
      name: attachment.fileName,
    };
  };
}
