// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse } from '../lib/response-schemas.js';
import { handleAssistantChat } from '../services/ai/assistant.service.js';
import { authorize } from '../middleware/rbac.js';

const chatBody = z.object({
  message: z.string().min(1).max(2000).describe('The user message to send to the AI assistant'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .max(50)
    .default([])
    .describe('Previous conversation messages for context'),
});

const chatResponse = z
  .object({
    reply: z.string(),
    apiCallsMade: z.number(),
  })
  .passthrough();

export function assistantRoutes(app: FastifyInstance): void {
  app.post(
    '/assistant/chat',
    {
      onRequest: [authorize('settings.ai:write')],
      schema: {
        tags: ['AI Assistant'],
        summary: 'Chat with the AI assistant',
        operationId: 'chatWithAssistant',
        security: [{ bearerAuth: [] }],
        body: zodSchema(chatBody),
        response: {
          200: zodSchema(chatResponse),
          400: errorResponse,
          500: errorResponse,
        },
      },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (request) => {
            const userId = (request.user as unknown as Record<string, unknown> | undefined)?.[
              'userId'
            ];
            return typeof userId === 'string' ? userId : request.ip;
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string; roleId: string };
      const body = request.body as z.infer<typeof chatBody>;
      let authHeader = request.headers.authorization ?? '';
      if (authHeader === '') {
        const rawCsmsToken = request.cookies['csms_token'] ?? '';
        if (rawCsmsToken !== '') {
          const unsigned = request.unsignCookie(rawCsmsToken);
          authHeader = `Bearer ${unsigned.valid ? unsigned.value : rawCsmsToken}`;
        }
      }

      try {
        const result = await handleAssistantChat(
          app,
          userId,
          body.message,
          body.history,
          authHeader,
        );
        return result;
      } catch (err) {
        const error = err as Error & { code?: string };
        if (error.code === 'AI_NOT_CONFIGURED') {
          return reply.status(400).send({ error: error.message, code: 'AI_NOT_CONFIGURED' });
        }
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to process AI request', code: 'AI_ERROR' });
      }
    },
  );
}
