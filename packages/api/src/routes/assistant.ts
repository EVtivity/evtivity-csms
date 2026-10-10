// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestAccessScope } from '../lib/access-scope.js';
import { AI_STREAM_PROTOCOL_VERSION } from '@evtivity/lib/ai-stream';
import { zodSchema } from '../lib/zod-schema.js';
import {
  errorWith,
  itemResponse,
  paginatedResponse,
  successResponse,
} from '../lib/response-schemas.js';
import { ERROR_CODES, ERROR_MESSAGES } from '../lib/error-codes.generated.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import type { JwtPayload } from '../plugins/auth.js';
import {
  auditAttachmentsAdded,
  auditDecision,
  completeToolCall,
  createConversation,
  decidePendingAction,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  releaseTurn,
  renameConversation,
  replaceToolResult,
} from '../services/ai/conversation.service.js';
import type { AiConversationRow, AiMessageRow } from '../services/ai/conversation.service.js';
import { runChatMessageTurn, runDecisionTurn } from '../services/ai/engine/turn.js';
import {
  AI_ASSISTANT_PERMISSION,
  AI_ASSISTANT_READ_PERMISSION,
  callerAuthorization,
  claimTurnOrReply,
  limitsOrReply,
  streamTurn,
  surfaceConfigOrReply,
} from '../services/ai/engine/route-support.js';
import { resolveModelCapabilities, resolveModelId } from '../services/ai/core/model-registry.js';
import { attachmentProblem } from '../services/ai/engine/attachments.js';
import {
  claimChatAttachments,
  markConversationAttachmentsDeleted,
} from '../services/ai/attachments/chat-attachments.service.js';
import { hasAiAdapter } from '../services/ai/engine/providers.js';
import { isSurfaceAvailable } from '../services/ai/surfaces/config.js';
import { getAiSettings, getCompanyCurrency, isChatbotAiEnabled } from '@evtivity/database';
import { aiCostInCompanyCurrencyMicros } from '@evtivity/lib/pricing-engine';

const conversationParams = z.object({
  id: z.string().min(1).max(64).describe('Conversation ID'),
});

const actionParams = conversationParams.extend({
  actionId: z.string().min(1).max(64).describe('Pending action ID (from confirmation_required)'),
});

const listQuery = paginationQuery.extend({
  search: z.string().max(200).optional().describe('Filter by title (case-insensitive substring)'),
});

const createBody = z.object({
  title: z.string().max(200).optional().describe('Title; set from the first message when empty'),
});

const renameBody = z.object({
  title: z.string().min(1).max(200).describe('New title'),
});

const messageBody = z.object({
  text: z.string().min(1).max(8000).describe('The user message'),
  attachmentIds: z
    .array(z.string().uuid())
    .max(20)
    .optional()
    .describe(
      'Ready chat attachments (POST /v1/assistant/attachments) this message uses; at most ai.attachments.maxPerMessage',
    ),
});

const decisionBody = z.object({
  nonce: z
    .string()
    .min(16)
    .max(200)
    .describe('The single-use nonce of the confirmation_required event'),
});

const statusResponse = z
  .object({
    enabled: z.boolean().describe('The caller can chat with the assistant (shows the chat button)'),
    supportAssistEnabled: z.boolean().describe('The caller can draft support replies with AI'),
  })
  .passthrough();

const conversationItem = z
  .object({
    id: z.string().describe('Conversation ID'),
    title: z.string().describe('Title (empty until the first message)'),
    provider: z.string().describe('AI provider of the latest turn'),
    model: z.string().describe('Model of the latest turn'),
    createdAt: z.string().describe('ISO 8601 creation time'),
    updatedAt: z.string().describe('ISO 8601 time of the latest turn or rename'),
  })
  .passthrough();

const messageItem = z
  .object({
    id: z.string().describe('Message ID'),
    role: z.enum(['user', 'assistant', 'tool']).describe('Who produced the message'),
    parts: z
      .array(
        z
          .object({
            type: z.string().describe('Part type: text, tool_call, tool_result, image or document'),
          })
          .passthrough()
          .describe('A message part; tool results are redacted'),
      )
      .describe('Message content'),
    finishReason: z.string().nullable().describe('Why an assistant message ended'),
    usage: z
      .object({
        inputTokens: z.number().describe('Input tokens, cached included'),
        outputTokens: z.number().describe('Output tokens, reasoning included'),
      })
      .passthrough()
      .nullable()
      .describe('Token usage of an assistant message'),
    costMicros: z
      .number()
      .nullable()
      .describe(
        'Cost in micro-units of the company currency; null when the model has no recorded prices or the company currency is not USD, the providers price currency (show tokens only)',
      ),
    createdAt: z.string().describe('ISO 8601 creation time'),
  })
  .passthrough();

const conversationDetail = conversationItem
  .extend({ messages: z.array(messageItem).describe('Messages, oldest first') })
  .passthrough();

const STREAM_DESCRIPTION = `Server-sent events (protocol version ${String(AI_STREAM_PROTOCOL_VERSION)}): message_start, text_delta, tool_step, confirmation_required, citation, usage, error, done. Parse with readAiStream from @evtivity/lib/ai-stream.`;

const streamResponse = {
  description: STREAM_DESCRIPTION,
  content: { 'text/event-stream': { schema: { type: 'string', description: STREAM_DESCRIPTION } } },
};

function toConversationItem(row: AiConversationRow): z.infer<typeof conversationItem> {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessageItem(row: AiMessageRow, companyCurrency: string): z.infer<typeof messageItem> {
  return {
    id: row.id,
    role: row.role as 'user' | 'assistant' | 'tool',
    parts: row.parts as z.infer<typeof messageItem>['parts'],
    finishReason: row.finishReason,
    usage: (row.usage as z.infer<typeof messageItem>['usage']) ?? null,
    costMicros: aiCostInCompanyCurrencyMicros(row.costMicros, companyCurrency),
    createdAt: row.createdAt.toISOString(),
  };
}

const notFound = { error: 'Conversation not found', code: 'AI_CONVERSATION_NOT_FOUND' } as const;

/** Stops a conversation route when the company turned the chatbot off. */
async function chatbotEnabledOrReply(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (await isChatbotAiEnabled()) return;
  await reply
    .status(400)
    .send({ error: ERROR_MESSAGES.AI_NOT_CONFIGURED, code: 'AI_NOT_CONFIGURED' });
}

/** The provider and model a new conversation shows before its first turn. */
async function configuredProviderAndModel(): Promise<{ provider: string; model: string }> {
  const { chatbot } = await getAiSettings();
  if (chatbot.provider === null) return { provider: '', model: '' };
  return { provider: chatbot.provider, model: resolveModelId(chatbot.provider, chatbot.model) };
}

export function assistantRoutes(app: FastifyInstance): void {
  // Writes need aiAssistant:write, reads aiAssistant:read. With chatbotAi.enabled
  // off, every conversation route answers 400 AI_NOT_CONFIGURED: the company
  // switch wins over personal configurations.
  const auth = {
    onRequest: [authorize(AI_ASSISTANT_PERMISSION)],
    preHandler: [chatbotEnabledOrReply],
  };
  const readAuth = {
    onRequest: [authorize(AI_ASSISTANT_READ_PERMISSION)],
    preHandler: [chatbotEnabledOrReply],
  };

  app.get(
    '/assistant/status',
    {
      onRequest: [authorize(AI_ASSISTANT_READ_PERMISSION)],
      schema: {
        tags: ['AI Assistant'],
        summary: 'Whether the AI assistant and support assist are available',
        description:
          "True when the caller's own AI configuration, or the surface settings (enabled, a provider and its key), let a turn run. No provider, model or key detail is returned. Not cached: a personal configuration makes it per user.",
        operationId: 'getAiAssistantStatus',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(statusResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const [enabled, supportAssistEnabled] = await Promise.all([
        isSurfaceAvailable('chatbot', userId, hasAiAdapter),
        isSurfaceAvailable('support', userId, hasAiAdapter),
      ]);
      return { enabled, supportAssistEnabled };
    },
  );

  app.post(
    '/assistant/conversations',
    {
      ...auth,
      schema: {
        tags: ['AI Assistant'],
        summary: 'Start an AI assistant conversation',
        operationId: 'createAiConversation',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createBody),
        response: {
          201: itemResponse(conversationItem),
          400: errorWith('The assistant is off', [ERROR_CODES.AI_NOT_CONFIGURED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { title } = request.body as z.infer<typeof createBody>;
      const shown = await configuredProviderAndModel();
      const row = await createConversation(
        { userId, surface: 'chatbot', ...shown, ...(title !== undefined ? { title } : {}) },
        getAuditActor(request),
        request.log,
      );
      await reply.status(201).send(toConversationItem(row));
    },
  );

  app.get(
    '/assistant/conversations',
    {
      ...readAuth,
      schema: {
        tags: ['AI Assistant'],
        summary: "List the user's AI assistant conversations",
        description: "Newest first. Only the caller's own conversations are listed.",
        operationId: 'listAiConversations',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listQuery),
        response: {
          200: paginatedResponse(conversationItem),
          400: errorWith('The assistant is off', [ERROR_CODES.AI_NOT_CONFIGURED]),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const q = request.query as z.infer<typeof listQuery>;
      const result = await listConversations(userId, {
        page: q.page,
        limit: q.limit,
        search: q.search,
      });
      return {
        data: result.data.map(toConversationItem),
        total: result.total,
      } satisfies PaginatedResponse<z.infer<typeof conversationItem>>;
    },
  );

  app.get(
    '/assistant/conversations/:id',
    {
      ...readAuth,
      schema: {
        tags: ['AI Assistant'],
        summary: 'Get an AI assistant conversation with its messages',
        operationId: 'getAiConversation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(conversationParams),
        response: {
          200: itemResponse(conversationDetail),
          400: errorWith('The assistant is off', [ERROR_CODES.AI_NOT_CONFIGURED]),
          404: errorWith('Conversation not found', [ERROR_CODES.AI_CONVERSATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof conversationParams>;
      const row = await getConversation(userId, id, 'chatbot');
      if (row === null) return reply.status(404).send(notFound);
      // Tool results stored under another access (sites, permissions, API key
      // scope) are hidden, so a result never outlives an access change.
      const [messages, companyCurrency] = await Promise.all([
        listMessages(row.id, await requestAccessScope(request, userId)),
        getCompanyCurrency(),
      ]);
      return {
        ...toConversationItem(row),
        messages: messages.map((m) => toMessageItem(m, companyCurrency)),
      };
    },
  );

  app.patch(
    '/assistant/conversations/:id',
    {
      ...auth,
      schema: {
        tags: ['AI Assistant'],
        summary: 'Rename an AI assistant conversation',
        operationId: 'updateAiConversation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(conversationParams),
        body: zodSchema(renameBody),
        response: {
          200: itemResponse(conversationItem),
          400: errorWith('The assistant is off', [ERROR_CODES.AI_NOT_CONFIGURED]),
          404: errorWith('Conversation not found', [ERROR_CODES.AI_CONVERSATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof conversationParams>;
      const { title } = request.body as z.infer<typeof renameBody>;
      const row = await getConversation(userId, id, 'chatbot');
      if (row === null) return reply.status(404).send(notFound);
      const updated = await renameConversation(row, title, getAuditActor(request), request.log);
      return toConversationItem(updated);
    },
  );

  app.delete(
    '/assistant/conversations/:id',
    {
      ...auth,
      schema: {
        tags: ['AI Assistant'],
        summary: 'Delete an AI assistant conversation',
        operationId: 'deleteAiConversation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(conversationParams),
        response: {
          200: successResponse,
          400: errorWith('The assistant is off', [ERROR_CODES.AI_NOT_CONFIGURED]),
          404: errorWith('Conversation not found', [ERROR_CODES.AI_CONVERSATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof conversationParams>;
      const row = await getConversation(userId, id, 'chatbot');
      if (row === null) return reply.status(404).send(notFound);
      await deleteConversation(row, getAuditActor(request), request.log);
      await markConversationAttachmentsDeleted(row.id);
      return { success: true as const };
    },
  );

  app.post(
    '/assistant/conversations/:id/messages',
    {
      ...auth,
      schema: {
        tags: ['AI Assistant'],
        summary: 'Send a message and stream the answer',
        description:
          'Answers text/event-stream. The server keeps the history. Reads run as the caller (RBAC and site scope apply); a write stops the turn with confirmation_required and runs only after the confirm request. Errors before the stream opens are JSON.',
        operationId: 'sendAiMessage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(conversationParams),
        body: zodSchema(messageBody),
        response: {
          200: streamResponse,
          400: errorWith('AI is not configured, or the model cannot take the attachments', [
            ERROR_CODES.AI_NOT_CONFIGURED,
            ERROR_CODES.AI_BASE_URL_INVALID,
            ERROR_CODES.AI_ATTACHMENT_UNSUPPORTED,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
          ]),
          404: errorWith('Conversation or attachment not found', [
            ERROR_CODES.AI_CONVERSATION_NOT_FOUND,
            ERROR_CODES.ATTACHMENT_NOT_FOUND,
          ]),
          409: errorWith('A turn is running', [ERROR_CODES.AI_CONVERSATION_BUSY]),
          429: errorWith('AI limit reached', [
            ERROR_CODES.AI_RATE_LIMITED,
            ERROR_CODES.AI_BUDGET_EXCEEDED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof conversationParams>;
      const { text, attachmentIds } = request.body as z.infer<typeof messageBody>;
      const conversation = await getConversation(userId, id, 'chatbot');
      if (conversation === null) return reply.status(404).send(notFound);
      const config = await surfaceConfigOrReply('chatbot', userId, reply);
      if (config === null) return reply;
      // Binds the attachments (404 for one that is not the caller's or not
      // ready, 400 AI_ATTACHMENT_TOO_LARGE over the per-message limit), then
      // checks the model can read them before anything is sent.
      const attachments = await claimChatAttachments(userId, conversation.id, attachmentIds ?? []);
      const problem = attachmentProblem(
        attachments,
        resolveModelCapabilities(config.provider, config.model),
      );
      if (problem !== null) {
        return reply.status(400).send({ error: ERROR_MESSAGES[problem], code: problem });
      }
      if (attachments.length > 0) {
        await auditAttachmentsAdded(
          conversation.id,
          attachments,
          getAuditActor(request),
          request.log,
        );
      }
      const limits = await limitsOrReply(userId, null, reply);
      if (limits === null) return reply;
      if (!(await claimTurnOrReply(conversation.id, reply))) return reply;
      const ctx = {
        app,
        userId,
        authorization: callerAuthorization(request),
        accessScope: await requestAccessScope(request, userId),
        hasPermission: (permission: string) => requestHasPermission(request, permission),
        actor: getAuditActor(request),
        log: request.log,
      };
      await streamTurn(request, reply, conversation.id, config, async (stream) => {
        await runChatMessageTurn({
          ctx,
          conversation,
          config,
          stream,
          text,
          attachments,
          maxToolCalls: limits.maxToolCallsPerTurn,
        });
      });
      return reply;
    },
  );

  for (const decision of ['confirmed', 'rejected'] as const) {
    const verb = decision === 'confirmed' ? 'confirm' : 'reject';
    app.post(
      `/assistant/conversations/:id/actions/:actionId/${verb}`,
      {
        ...auth,
        schema: {
          tags: ['AI Assistant'],
          summary:
            decision === 'confirmed'
              ? 'Confirm a proposed action and stream the rest of the answer'
              : 'Reject a proposed action and stream the rest of the answer',
          description:
            decision === 'confirmed'
              ? 'Runs the write the assistant proposed, exactly once, as the caller, then continues the turn. A second confirm of the same action runs nothing. Answers text/event-stream.'
              : 'Records the rejection, tells the model, and continues the turn. Answers text/event-stream.',
          operationId: decision === 'confirmed' ? 'confirmAiAction' : 'rejectAiAction',
          security: [{ bearerAuth: [] }],
          params: zodSchema(actionParams),
          body: zodSchema(decisionBody),
          response: {
            200: streamResponse,
            400: errorWith('AI is not configured', [
              ERROR_CODES.AI_NOT_CONFIGURED,
              ERROR_CODES.AI_BASE_URL_INVALID,
            ]),
            404: errorWith('Action or conversation not found', [
              ERROR_CODES.AI_ACTION_NOT_FOUND,
              ERROR_CODES.AI_CONVERSATION_NOT_FOUND,
            ]),
            409: errorWith('The action cannot be decided', [
              ERROR_CODES.AI_ACTION_EXPIRED,
              ERROR_CODES.AI_ACTION_INVALID,
              ERROR_CODES.AI_CONVERSATION_BUSY,
            ]),
            429: errorWith('AI limit reached', [
              ERROR_CODES.AI_RATE_LIMITED,
              ERROR_CODES.AI_BUDGET_EXCEEDED,
            ]),
          },
        },
      },
      async (request, reply) => {
        const { userId } = request.user as JwtPayload;
        const { id, actionId } = request.params as z.infer<typeof actionParams>;
        const { nonce } = request.body as z.infer<typeof decisionBody>;
        const conversation = await getConversation(userId, id, 'chatbot');
        if (conversation === null) return reply.status(404).send(notFound);
        const config = await surfaceConfigOrReply('chatbot', userId, reply);
        if (config === null) return reply;
        const limits = await limitsOrReply(userId, null, reply);
        if (limits === null) return reply;
        if (!(await claimTurnOrReply(conversation.id, reply))) return reply;

        let outcome: Awaited<ReturnType<typeof decidePendingAction>>;
        try {
          outcome = await decidePendingAction({
            conversationId: conversation.id,
            actionId,
            nonce,
            decision,
          });
        } catch (err) {
          await releaseTurn(conversation.id, null);
          throw err;
        }
        if (outcome.kind !== 'decided' && outcome.kind !== 'already') {
          await releaseTurn(conversation.id, null);
          if (outcome.kind === 'not_found') {
            return reply
              .status(404)
              .send({ error: 'Action not found', code: 'AI_ACTION_NOT_FOUND' });
          }
          if (outcome.kind === 'expired') {
            await replaceToolResult(
              outcome.action.toolMessageId,
              outcome.action.toolCallId,
              '{"status":"expired","note":"The user did not confirm this action in time. It did not run."}',
              true,
              await requestAccessScope(request, userId),
            );
            await completeToolCall(outcome.action.toolCallRowId, { status: 'rejected' });
            return reply.status(409).send({ error: 'Action expired', code: 'AI_ACTION_EXPIRED' });
          }
          return reply
            .status(409)
            .send({ error: 'Action can no longer be decided', code: 'AI_ACTION_INVALID' });
        }

        const ctx = {
          app,
          userId,
          authorization: callerAuthorization(request),
          accessScope: await requestAccessScope(request, userId),
          hasPermission: (permission: string) => requestHasPermission(request, permission),
          actor: getAuditActor(request),
          log: request.log,
        };
        const { action } = outcome;
        await streamTurn(request, reply, conversation.id, config, async (stream) => {
          if (outcome.kind === 'already') {
            // Idempotent: the decision was taken before, nothing runs again.
            stream.send({
              type: 'tool_step',
              toolCallId: action.toolCallRowId,
              name: action.operationId,
              status: decision,
            });
            stream.send({ type: 'done', messageId: action.toolMessageId, finish: 'end' });
            return;
          }
          await auditDecision(action, decision, ctx.actor, request.log);
          await runDecisionTurn({
            ctx,
            conversation,
            config,
            stream,
            action,
            decision,
            maxToolCalls: limits.maxToolCallsPerTurn,
          });
        });
        return reply;
      },
    );
  }
}
