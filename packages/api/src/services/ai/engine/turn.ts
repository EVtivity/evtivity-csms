// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * One AI turn from a route's point of view: build the prompt and toolset,
 * run the loop with persistence and tool execution wired in, and stream the
 * events. The routes check auth, scope, configuration and limits first and
 * hold the conversation's turn lease around these calls.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, users, getCompanyCurrency } from '@evtivity/database';
import { generateId } from '@evtivity/lib';
import { AI_STREAM_PROTOCOL_VERSION } from '@evtivity/lib/ai-stream';
import type { AiEventStream } from '../core/sse.js';
import { getModelEntry, getProviderEntry } from '../core/model-registry.js';
import type { AiMessage, AiSystemBlock, AiUsage } from '../core/types.js';
import {
  appendMessage,
  completeToolCall,
  createPendingAction,
  listMessages,
  recordToolCall,
  replaceToolResult,
  setTitleIfEmpty,
  supersedePendingActions,
  toAiMessages,
} from '../conversation.service.js';
import type {
  AiConversationRow,
  AiPendingActionRow,
  AuditActorFields,
} from '../conversation.service.js';
import type { AiSurfaceConfig } from '../surfaces/config.js';
import { chatbotToolset, supportToolset } from '../surfaces/toolsets.js';
import type { SupportCaseContext } from '../surfaces/toolsets.js';
import { AI_TOOL_CATALOG, AI_TOOL_CATEGORIES } from '../tools/catalog.js';
import { buildToolRequest, runToolCall } from '../tools/execute.js';
import type { Toolset } from '../tools/execute.js';
import { surfaceOffers, toolPolicy } from '../tools/policy.js';
import { redactToolValue } from '../tools/redact.js';
import { checkOcppCommandVersion } from '../tools/ocpp-command-check.js';
import { createAdapterFor } from './providers.js';
import { buildSystemBlocks } from './prompt.js';
import { attachmentParts, attachmentResolverFor } from './attachments.js';
import type { ChatAttachment } from '../attachments/chat-attachments.service.js';
import { routeCategories } from './router.js';
import { TURN_DEADLINE_MS, runTurn, turnErrorCode } from './turn-runner.js';
import type { TurnHooks, TurnRunResult } from './turn-runner.js';

export interface TurnContext {
  app: FastifyInstance;
  userId: string;
  /** The caller's Authorization header value; tools run with it. */
  authorization: string;
  /**
   * The caller's access fingerprint (`requestAccessScope`): stored on tool
   * messages, and tool results stored under another one are hidden on replay.
   */
  accessScope: string;
  /** Whether the caller holds a permission (API key scope included), as `authorize()` decides. */
  hasPermission: (permission: string) => Promise<boolean>;
  actor: AuditActorFields;
  log: FastifyBaseLogger;
}

const NOT_CONFIRMED_RESULT =
  '{"status":"not_run","note":"The user sent a new message instead of confirming this action. It did not run."}';
const REJECTED_RESULT =
  '{"status":"rejected","note":"The user rejected this action. It did not run. Do not propose it again unless the user asks."}';

async function userPromptContext(
  userId: string,
): Promise<{ userName: string; language: string; currency: string }> {
  const [[user], currency] = await Promise.all([
    db
      .select({ firstName: users.firstName, lastName: users.lastName, language: users.language })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    getCompanyCurrency(),
  ]);
  return {
    userName: user != null ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : '',
    language: user?.language ?? 'en',
    currency,
  };
}

function cacheKeyFor(surface: string, toolset: Toolset): string {
  return createHash('sha256')
    .update(`${surface}:${toolset.definitions.map((d) => d.name).join(',')}`)
    .digest('hex')
    .slice(0, 32);
}

function hooksFor(
  ctx: TurnContext,
  conversation: AiConversationRow,
  config: AiSurfaceConfig,
): TurnHooks {
  return {
    async saveAssistantMessage(input) {
      await appendMessage({
        id: input.id,
        conversationId: conversation.id,
        role: 'assistant',
        parts: input.parts,
        providerState: input.providerState,
        usage: input.usage,
        costMicros: input.costMicros,
        finishReason: input.finishReason,
      });
    },
    saveToolCall({ messageId, call, entry, status }) {
      const request = entry !== null ? buildToolRequest(entry.tool, call.arguments) : null;
      return recordToolCall(
        {
          conversationId: conversation.id,
          messageId,
          toolCallId: call.id,
          name: call.name,
          operationId: entry?.tool.operationId ?? null,
          method: entry?.tool.method ?? null,
          path: request?.url ?? null,
          args: redactToolValue(call.arguments, config.surface).value,
          status,
        },
        ctx.actor,
        ctx.log,
      );
    },
    completeToolCall: (rowId, result) => completeToolCall(rowId, result),
    saveToolMessage: (parts) =>
      appendMessage({
        conversationId: conversation.id,
        role: 'tool',
        parts,
        accessScope: ctx.accessScope,
      }),
    runTool: (call, toolCallRowId) =>
      runToolCall(ctx.app, call, ctx.authorization, {
        conversationId: conversation.id,
        toolCallRowId,
        surface: config.surface,
        userId: ctx.userId,
      }),
    async createPendingAction({ toolCallRowId, toolMessageId, call, entry, args }) {
      const created = await createPendingAction({
        conversationId: conversation.id,
        toolCallRowId,
        toolMessageId,
        toolCallId: call.id,
        operationId: entry.tool.operationId,
        args,
      });
      return {
        ...created,
        displayArgs: redactToolValue(args, config.surface).value as Record<string, unknown>,
        path: buildToolRequest(entry.tool, args).url,
      };
    },
    checkWrite: (call) => checkOcppCommandVersion(ctx, call),
    newMessageId: () => generateId('aiMessage'),
    warn: (err, toolName) => {
      ctx.log.warn({ err, toolName, conversationId: conversation.id }, 'AI tool call failed');
    },
  };
}

interface LoopInput {
  ctx: TurnContext;
  conversation: AiConversationRow;
  config: AiSurfaceConfig;
  stream: AiEventStream;
  system: AiSystemBlock[];
  history: AiMessage[];
  toolset: Toolset;
  maxToolCalls: number;
  priorUsage?: AiUsage;
  firstMessageId: string;
}

async function runLoop(input: LoopInput): Promise<TurnRunResult> {
  const { config, stream } = input;
  const adapter = createAdapterFor(config);
  const result = await runTurn({
    adapter,
    provider: config.provider,
    model: config.model,
    system: input.system,
    history: input.history,
    toolset: input.toolset,
    effort: config.effort,
    cacheKey: cacheKeyFor(config.surface, input.toolset),
    maxToolCalls: input.maxToolCalls,
    deadline: Date.now() + TURN_DEADLINE_MS,
    signal: stream.signal,
    prices: getModelEntry(config.provider, config.model)?.prices ?? null,
    companyCurrency: await getCompanyCurrency(),
    ...(input.priorUsage !== undefined ? { priorUsage: input.priorUsage } : {}),
    firstMessageId: input.firstMessageId,
    resolveAttachment: attachmentResolverFor(input.ctx.userId),
    emit: (event) => {
      stream.send(event);
    },
    hooks: hooksFor(input.ctx, input.conversation, config),
  });
  stream.send({ type: 'done', messageId: result.lastMessageId, finish: result.finish });
  return result;
}

function sendStart(
  stream: AiEventStream,
  conversationId: string,
  messageId: string,
  config: AiSurfaceConfig,
): void {
  stream.send({
    type: 'message_start',
    protocolVersion: AI_STREAM_PROTOCOL_VERSION,
    conversationId,
    messageId,
    provider: config.provider,
    model: config.model,
  });
}

/** Ends a stream that failed before or outside the loop, without leaking the cause. */
export function failStream(stream: AiEventStream, messageId: string, code = 'AI_ERROR'): void {
  stream.send({ type: 'error', code });
  stream.send({ type: 'done', messageId, finish: 'error' });
}

async function routedChatbotToolset(
  config: AiSurfaceConfig,
  history: readonly AiMessage[],
  signal: AbortSignal,
): Promise<{ toolset: Toolset; usage: AiUsage | undefined }> {
  const userTexts = history
    .filter((m) => m.role === 'user')
    .map((m) =>
      m.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join(' ')
        .trim(),
    )
    .filter((t) => t !== '');
  const message = userTexts[userTexts.length - 1] ?? '';
  const routed = await routeCategories({
    adapter: createAdapterFor(config),
    model: getProviderEntry(config.provider).routerModel,
    categories: AI_TOOL_CATEGORIES,
    message,
    recentUserMessages: userTexts.slice(-4, -1),
    signal,
  });
  return { toolset: chatbotToolset(routed.categories), usage: routed.usage };
}

async function chatbotSystem(ctx: TurnContext, config: AiSurfaceConfig): Promise<AiSystemBlock[]> {
  const user = await userPromptContext(ctx.userId);
  return buildSystemBlocks({
    surface: 'chatbot',
    language: user.language,
    operatorPrompt: config.systemPrompt,
    userName: user.userName,
    companyCurrency: user.currency,
    now: new Date(),
  });
}

/** Fills the placeholder results of actions the user did not decide on. */
async function closeOpenActions(conversationId: string, accessScope: string): Promise<void> {
  const superseded = await supersedePendingActions(conversationId);
  for (const action of superseded) {
    await replaceToolResult(
      action.toolMessageId,
      action.toolCallId,
      NOT_CONFIRMED_RESULT,
      true,
      accessScope,
    );
    await completeToolCall(action.toolCallRowId, { status: 'rejected' });
  }
}

/** A chatbot turn for a new user message. */
export async function runChatMessageTurn(input: {
  ctx: TurnContext;
  conversation: AiConversationRow;
  config: AiSurfaceConfig;
  stream: AiEventStream;
  text: string;
  /** Claimed and checked by the route. */
  attachments: readonly ChatAttachment[];
  maxToolCalls: number;
}): Promise<TurnRunResult | null> {
  const { ctx, conversation, config, stream } = input;
  const firstMessageId = generateId('aiMessage');
  sendStart(stream, conversation.id, firstMessageId, config);
  try {
    await closeOpenActions(conversation.id, ctx.accessScope);
    await appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: input.text }, ...attachmentParts(input.attachments)],
    });
    await setTitleIfEmpty(conversation.id, input.text.replace(/\s+/g, ' ').trim().slice(0, 80));
    const history = toAiMessages(await listMessages(conversation.id, ctx.accessScope));
    const [system, routed] = await Promise.all([
      chatbotSystem(ctx, config),
      routedChatbotToolset(config, history, stream.signal),
    ]);
    return await runLoop({
      ctx,
      conversation,
      config,
      stream,
      system,
      history,
      toolset: routed.toolset,
      maxToolCalls: input.maxToolCalls,
      ...(routed.usage !== undefined ? { priorUsage: routed.usage } : {}),
      firstMessageId,
    });
  } catch (err) {
    ctx.log.error({ err, conversationId: conversation.id }, 'AI chat turn failed');
    failStream(stream, firstMessageId, turnErrorCode(err));
    return null;
  }
}

/**
 * Continues a chatbot turn after the user decided on a pending action: a
 * confirmed write runs now (once, as the user), a rejected one is reported
 * to the model, and the loop goes on.
 */
export async function runDecisionTurn(input: {
  ctx: TurnContext;
  conversation: AiConversationRow;
  config: AiSurfaceConfig;
  stream: AiEventStream;
  action: AiPendingActionRow;
  decision: 'confirmed' | 'rejected';
  maxToolCalls: number;
}): Promise<TurnRunResult | null> {
  const { ctx, conversation, config, stream, action } = input;
  const firstMessageId = generateId('aiMessage');
  sendStart(stream, conversation.id, firstMessageId, config);
  try {
    const tool = AI_TOOL_CATALOG.find((t) => t.operationId === action.operationId);
    if (input.decision === 'rejected') {
      await replaceToolResult(
        action.toolMessageId,
        action.toolCallId,
        REJECTED_RESULT,
        false,
        ctx.accessScope,
      );
      await completeToolCall(action.toolCallRowId, { status: 'rejected' });
      stream.send({
        type: 'tool_step',
        toolCallId: action.toolCallRowId,
        name: tool?.name ?? action.operationId,
        status: 'rejected',
      });
    } else if (tool === undefined || !surfaceOffers(toolPolicy(tool.operationId), 'chatbot')) {
      // The policy changed since the action was proposed: it does not run.
      const content = JSON.stringify({ error: 'This action is no longer available.' });
      await replaceToolResult(
        action.toolMessageId,
        action.toolCallId,
        content,
        true,
        ctx.accessScope,
      );
      await completeToolCall(action.toolCallRowId, { status: 'refused' });
      stream.send({
        type: 'tool_step',
        toolCallId: action.toolCallRowId,
        name: tool?.name ?? action.operationId,
        status: 'refused',
        reason: 'no_longer_available',
      });
    } else {
      const policy = toolPolicy(tool.operationId);
      const outcome = await runToolCall(
        ctx.app,
        {
          entry: {
            tool,
            definition: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: tool.strict,
            },
            fixedArgs: {},
            allowedValues: {},
            omitted: policy.omit,
          },
          args: action.args as Record<string, unknown>,
        },
        ctx.authorization,
        {
          conversationId: conversation.id,
          toolCallRowId: action.toolCallRowId,
          surface: 'chatbot',
          userId: ctx.userId,
        },
      );
      await replaceToolResult(
        action.toolMessageId,
        action.toolCallId,
        outcome.content,
        outcome.status === 'error',
        ctx.accessScope,
      );
      await completeToolCall(action.toolCallRowId, {
        status: 'confirmed',
        httpStatus: outcome.httpStatus,
        latencyMs: outcome.latencyMs,
        redactionCounts: outcome.redactionCounts,
      });
      stream.send({
        type: 'tool_step',
        toolCallId: action.toolCallRowId,
        name: tool.name,
        status: outcome.status === 'ok' ? 'confirmed' : 'error',
        summary: outcome.summary,
        durationMs: outcome.latencyMs,
      });
      if (outcome.httpStatus === 401) {
        failStream(stream, firstMessageId, 'UNAUTHORIZED');
        return null;
      }
    }
    const history = toAiMessages(await listMessages(conversation.id, ctx.accessScope));
    const [system, routed] = await Promise.all([
      chatbotSystem(ctx, config),
      routedChatbotToolset(config, history, stream.signal),
    ]);
    return await runLoop({
      ctx,
      conversation,
      config,
      stream,
      system,
      history,
      toolset: routed.toolset,
      maxToolCalls: input.maxToolCalls,
      ...(routed.usage !== undefined ? { priorUsage: routed.usage } : {}),
      firstMessageId,
    });
  } catch (err) {
    ctx.log.error({ err, conversationId: conversation.id }, 'AI decision turn failed');
    failStream(stream, firstMessageId, turnErrorCode(err));
    return null;
  }
}

/** Builds the support assist request message (server-written, trusted). */
function supportRequestText(caseNumber: string, isInternalNote: boolean): string {
  return isInternalNote
    ? `Write an internal note for support case ${caseNumber}. Read the case and its related data with the tools first.`
    : `Write a reply to the customer for support case ${caseNumber}. Read the case and its related data with the tools first.`;
}

/** A support assist turn: one draft for one case, reads pinned to the case. */
export async function runSupportAssistTurn(input: {
  ctx: TurnContext;
  conversation: AiConversationRow;
  config: AiSurfaceConfig;
  stream: AiEventStream;
  caseContext: SupportCaseContext;
  caseNumber: string;
  /** The case driver's language: a customer reply is written in it. */
  driverLanguage: string | null;
  isInternalNote: boolean;
  maxToolCalls: number;
}): Promise<TurnRunResult | null> {
  const { ctx, conversation, config, stream } = input;
  const firstMessageId = generateId('aiMessage');
  sendStart(stream, conversation.id, firstMessageId, config);
  try {
    await appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: supportRequestText(input.caseNumber, input.isInternalNote) }],
    });
    const user = await userPromptContext(ctx.userId);
    const system = buildSystemBlocks({
      surface: 'support',
      language: user.language,
      operatorPrompt: config.systemPrompt,
      userName: user.userName,
      companyCurrency: user.currency,
      now: new Date(),
      tone: config.tone,
      isInternalNote: input.isInternalNote,
      replyLanguage: input.driverLanguage,
    });
    const history = toAiMessages(await listMessages(conversation.id, ctx.accessScope));
    return await runLoop({
      ctx,
      conversation,
      config,
      stream,
      system,
      history,
      toolset: supportToolset(input.caseContext),
      maxToolCalls: input.maxToolCalls,
      firstMessageId,
    });
  } catch (err) {
    ctx.log.error({ err, conversationId: conversation.id }, 'AI support assist turn failed');
    failStream(stream, firstMessageId, turnErrorCode(err));
    return null;
  }
}
