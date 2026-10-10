// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { AiMessage, AiPart, AiRequest, ModelCapabilities, ProviderId } from './types.js';

/**
 * Drops `providerState` that another provider or model produced. Opaque
 * state (thinking signatures, encrypted reasoning) is valid only for the
 * model that made it; replaying it elsewhere returns a 400. The history then
 * goes over as text, tool calls and tool results only.
 */
export function stripForeignProviderState(
  messages: readonly AiMessage[],
  provider: ProviderId,
  model: string,
): AiMessage[] {
  return messages.map((message) => {
    const state = message.providerState;
    if (state === undefined) return message;
    if (state.provider === provider && state.model === model) return message;
    return { role: message.role, parts: message.parts };
  });
}

export interface UnsupportedPart {
  messageIndex: number;
  partIndex: number;
  part: AiPart;
  reason: 'vision' | 'image_format' | 'too_many_images' | 'pdf' | 'tools';
}

/**
 * Lists the request parts the model cannot take. The engine refuses the
 * turn (`AI_ATTACHMENT_UNSUPPORTED`) before calling the provider when this is
 * not empty. Byte and page limits are checked by the upload pipeline, which
 * knows the sizes.
 */
export function findUnsupportedParts(
  req: Pick<AiRequest, 'messages'>,
  caps: ModelCapabilities,
): UnsupportedPart[] {
  const out: UnsupportedPart[] = [];
  let images = 0;
  req.messages.forEach((message, messageIndex) => {
    message.parts.forEach((part, partIndex) => {
      const at = { messageIndex, partIndex, part };
      if (part.type === 'image') {
        images++;
        if (caps.vision === false) out.push({ ...at, reason: 'vision' });
        else if (!caps.vision.formats.includes(part.mime))
          out.push({ ...at, reason: 'image_format' });
        else if (images > caps.vision.maxImages) out.push({ ...at, reason: 'too_many_images' });
      } else if (part.type === 'document' && part.mime === 'application/pdf') {
        if (caps.documents.pdf === false) out.push({ ...at, reason: 'pdf' });
      } else if ((part.type === 'tool_call' || part.type === 'tool_result') && !caps.tools) {
        out.push({ ...at, reason: 'tools' });
      }
    });
  });
  return out;
}
