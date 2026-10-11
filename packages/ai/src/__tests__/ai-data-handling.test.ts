// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The provider boundary (`redactProviderRequest`) for every usage surface,
 * asserted on the HTTP request body a real adapter sends (rule
 * `features/ai-data-handling.md`). The surface call paths have their own
 * request-body tests in the API and the worker (TC-AI-AD-01 to 08).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { AI_USAGE_SURFACES } from '@evtivity/lib/ai-usage';
import type { AiUsageSurface } from '@evtivity/lib/ai-usage';
import { AI_USAGE_REDACTION_SURFACES, redactProviderRequest, redactToolValue } from '../redact.js';
import type { AiAttachmentContent, AiRequest } from '../core/types.js';
import {
  SEEDED_PAYMENT,
  SEEDED_PERSONAL,
  SEEDED_SECRETS,
  findLeaks,
  seededRecord,
  seededText,
  startRecordingProvider,
} from '../__contract__/data-handling.js';
import type { RecordingProvider } from '../__contract__/data-handling.js';

const encoder = new TextEncoder();

function attachment(mime: AiAttachmentContent['mime'], text: string): AiAttachmentContent {
  return { mime, data: encoder.encode(text), name: 'upload' };
}

const ATTACHMENTS: Record<string, AiAttachmentContent> = {
  att_text: attachment('text/plain', seededText()),
  att_csv: attachment('text/csv', `email,card\n${SEEDED_PERSONAL.email},${SEEDED_PAYMENT.card}\n`),
  att_json: attachment('application/json', JSON.stringify(seededRecord())),
  att_ndjson: attachment(
    'application/x-ndjson',
    `${JSON.stringify(seededRecord())}\nnot json ${seededText()}\n`,
  ),
};

/**
 * A request as the surfaces build it: free text and text attachments raw (the
 * boundary is their only redaction), the tool result already redacted by
 * field at the surface's level, as every producer does (`runToolCall`,
 * `renderEvidencePack`, `explainPromptBlock`, the worker facts).
 */
function seededRequest(model: string, surface: AiUsageSurface): AiRequest {
  const toolResult = redactToolValue(seededRecord(), AI_USAGE_REDACTION_SURFACES[surface]).value;
  return {
    model,
    system: [{ text: 'system', cacheable: true }],
    messages: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: seededText() },
          ...Object.keys(ATTACHMENTS).map((id) => ({
            type: 'document' as const,
            attachmentId: id,
            mime: (ATTACHMENTS[id] as AiAttachmentContent).mime as 'text/plain',
            name: id,
          })),
        ],
      },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'toolu_1', name: 'get_driver', arguments: {} }],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            toolCallId: 'toolu_1',
            name: 'get_driver',
            content: JSON.stringify(toolResult),
            isError: false,
          },
        ],
      },
    ],
    tools: [],
    effort: 'low',
    resolveAttachment: (id) => Promise.resolve(ATTACHMENTS[id] as AiAttachmentContent),
  };
}

let provider: RecordingProvider | null = null;
afterEach(async () => {
  await provider?.close();
  provider = null;
});

async function bodyFor(surface: AiUsageSurface): Promise<string> {
  provider = await startRecordingProvider();
  await provider.adapter.complete(
    redactProviderRequest(seededRequest(provider.model, surface), surface),
    AbortSignal.timeout(10_000),
  );
  const [body] = provider.bodies();
  return body ?? '';
}

describe('AI provider boundary redaction', () => {
  it('maps every usage surface to a redaction level', () => {
    expect(Object.keys(AI_USAGE_REDACTION_SURFACES).sort()).toEqual([...AI_USAGE_SURFACES].sort());
  });

  it('the seeded request leaks every value without the boundary (the fixture is sound)', async () => {
    provider = await startRecordingProvider();
    await provider.adapter.complete(
      seededRequest(provider.model, 'chatbot'),
      AbortSignal.timeout(10_000),
    );
    const body = provider.bodies()[0] ?? '';
    expect(findLeaks(body, 'support')).toEqual(
      expect.arrayContaining(['apiKey', 'stripeKey', 'card', 'iban', 'email', 'phone']),
    );
  });

  it.each(AI_USAGE_SURFACES.filter((s) => s !== 'driver_support'))(
    'the %s request body carries no secret, cards and IBANs masked, personal data at its level',
    async (surface) => {
      const body = await bodyFor(surface);
      const level = AI_USAGE_REDACTION_SURFACES[surface];
      expect(findLeaks(body, level)).toEqual([]);
      expect(body).toContain('****4242');
      if (level === 'chatbot') {
        expect(body).toContain(SEEDED_PERSONAL.email);
      } else {
        expect(body).toContain('j***@example.com');
        expect(body).toMatch(/sha256:[0-9a-f]{12}/);
      }
      // The model's own messages are not rewritten.
      expect(body).toContain('get_driver');
    },
  );

  it('TC-AI-AD-09 driver support: emails and phones masked, token ids cut to the last 4, no secret', async () => {
    const body = await bodyFor('driver_support');
    expect(findLeaks(body, 'driver')).toEqual([]);
    expect(body).toContain('****0042');
    expect(body).toContain('****7788');
    expect(body).toContain('j***@example.com');
    expect(body).not.toMatch(/sha256:[0-9a-f]{12}/);
  });

  it('masks secrets in the system blocks and attachment names, keeping contact data in the prompt', () => {
    const req = redactProviderRequest(
      {
        model: 'm',
        system: [
          {
            text: `Sign as support@example.com. Key ${SEEDED_SECRETS.apiKey}, card ${SEEDED_PAYMENT.card}.`,
            cacheable: true,
          },
        ],
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'document',
                attachmentId: 'att_1',
                mime: 'text/plain',
                name: `keys-${SEEDED_SECRETS.stripeKey}.txt`,
              },
            ],
          },
        ],
        tools: [],
        effort: 'low',
      },
      'support',
    );
    const system = req.system[0]?.text ?? '';
    expect(system).toContain('support@example.com');
    expect(system).not.toContain(SEEDED_SECRETS.apiKey);
    expect(system).not.toContain(SEEDED_PAYMENT.card);
    const part = req.messages[0]?.parts[0];
    expect(part?.type === 'document' ? part.name : '').not.toContain(SEEDED_SECRETS.stripeKey);
  });

  it('passes images and PDFs through unchanged', async () => {
    const pdf: AiAttachmentContent = {
      mime: 'application/pdf',
      data: encoder.encode('%PDF-1.4 sk_live_SEEDSTRIPE0123456789'),
    };
    const req = redactProviderRequest(
      {
        model: 'm',
        system: [],
        messages: [],
        tools: [],
        effort: 'low',
        resolveAttachment: () => Promise.resolve(pdf),
      },
      'chatbot',
    );
    const out = await req.resolveAttachment?.('att_pdf');
    expect(out?.data).toBe(pdf.data);
  });
});
