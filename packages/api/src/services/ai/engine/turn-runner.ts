// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The streaming tool loop of one turn. It calls the model, forwards the text
 * to the client as it streams, runs the reads the model asks for, and stops
 * at the first write with a confirmation request: nothing that changes data
 * runs before the user confirms it (B5).
 *
 * Bounds (B4): every tool call counts, refused and failed ones included, up
 * to `maxToolCalls`; the turn also has a wall clock. Persistence and tool
 * execution are hooks, so the loop is testable without a database.
 */

import { aiCostInCompanyCurrencyMicros, aiUsageCostMicros } from '@evtivity/lib/pricing-engine';
import type { AiStreamEvent as ClientEvent, AiTurnFinishReason } from '@evtivity/lib/ai-stream';
import { AiStreamAccumulator, addUsage, emptyUsage } from '../core/collect.js';
import { isAiProviderError } from '../core/errors.js';
import type { AiProviderErrorCode } from '../core/errors.js';
import { findUnsupportedParts, stripForeignProviderState } from '../core/messages.js';
import type { ModelPrices } from '../core/model-registry.js';
import type {
  AiAdapter,
  AiAttachmentResolver,
  AiFinishReason,
  AiMessage,
  AiPart,
  AiProviderState,
  AiResult,
  AiSystemBlock,
  AiToolCallPart,
  AiToolResultPart,
  AiUsage,
  Effort,
  ProviderId,
} from '../core/types.js';
import { prepareToolCall } from '../tools/execute.js';
import type { AiToolRefusal, Toolset, ToolsetEntry, ToolOutcome } from '../tools/execute.js';
import type { RedactionCounts } from '../tools/redact.js';
import type { ToolCallStatus } from '../conversation.service.js';

/** Reads run in parallel up to this many at once. */
export const MAX_PARALLEL_READS = 4;

/** Wall clock of a turn. */
export const TURN_DEADLINE_MS = 120_000;

/** Placeholder result of a write that waits for the user. */
export const PENDING_RESULT =
  '{"status":"pending_confirmation","note":"Waiting for the user to confirm or reject this action in the UI."}';

/**
 * The outcome of the check a write gets before it is proposed: the call to
 * propose (the same tool, or its equivalent with translated arguments and a
 * note for the model) or a refusal.
 */
export type WriteCheck =
  | { ok: true; entry: ToolsetEntry; args: Record<string, unknown>; note?: string }
  | { ok: false; refusal: AiToolRefusal };

export interface TurnHooks {
  /** Stores an assistant message; returns its id. */
  saveAssistantMessage(input: {
    id: string;
    parts: AiPart[];
    providerState: AiProviderState | undefined;
    usage: AiUsage;
    costMicros: number | null;
    finishReason: string;
  }): Promise<void>;
  /** Stores a tool call row (arguments redacted by the hook); returns the row id. */
  saveToolCall(input: {
    messageId: string;
    call: AiToolCallPart;
    entry: ToolsetEntry | null;
    status: ToolCallStatus;
  }): Promise<string>;
  completeToolCall(
    rowId: string,
    result: {
      status: ToolCallStatus;
      httpStatus?: number;
      latencyMs?: number;
      redactionCounts?: RedactionCounts;
    },
  ): Promise<void>;
  saveToolMessage(parts: AiToolResultPart[]): Promise<string>;
  /** Runs a prepared read as the user. */
  runTool(
    call: { entry: ToolsetEntry; args: Record<string, unknown> },
    toolCallRowId: string,
  ): Promise<ToolOutcome>;
  /**
   * Checks a write before it is proposed (an OCPP command against the
   * station's version). Without it the write is proposed as the model sent it.
   */
  checkWrite?(call: { entry: ToolsetEntry; args: Record<string, unknown> }): Promise<WriteCheck>;
  /** Creates the pending action of a write and returns what the client needs to confirm it. */
  createPendingAction(input: {
    toolCallRowId: string;
    toolMessageId: string;
    call: AiToolCallPart;
    entry: ToolsetEntry;
    args: Record<string, unknown>;
  }): Promise<{
    actionId: string;
    nonce: string;
    expiresAt: Date;
    /** Redacted arguments for the confirmation card. */
    displayArgs: Record<string, unknown>;
    path: string;
  }>;
  newMessageId(): string;
  /** Logs a tool call that threw (the turn goes on). */
  warn(err: unknown, toolName: string): void;
}

export interface TurnRunInput {
  adapter: AiAdapter;
  provider: ProviderId;
  model: string;
  system: AiSystemBlock[];
  /** The conversation so far, ending with the new user message or tool results. */
  history: AiMessage[];
  toolset: Toolset;
  effort: Effort;
  cacheKey?: string;
  maxToolCalls: number;
  /** Epoch ms after which the turn stops. */
  deadline: number;
  signal: AbortSignal;
  prices: ModelPrices | null;
  /** The company currency: the usage event states the cost in it, or tokens only. */
  companyCurrency: string;
  /** Usage spent before the loop (the router call); counted in the first message. */
  priorUsage?: AiUsage;
  /** Id of the first assistant message (sent in `message_start`). */
  firstMessageId: string;
  /** Reads attachment bytes for the adapter. */
  resolveAttachment?: AiAttachmentResolver;
  emit: (event: ClientEvent) => void;
  hooks: TurnHooks;
}

export interface TurnRunResult {
  finish: AiTurnFinishReason;
  /** Id of the last assistant message saved (the first id when none was saved). */
  lastMessageId: string;
  /** Text of the last assistant message (the support draft). */
  text: string;
  usage: AiUsage;
  /** Provider cost in micro-USD (as stored in ai_messages.cost_micros). */
  costMicros: number | null;
  toolCallsUsed: number;
  errorCode?: string;
}

const PROVIDER_ERROR_CODES: Partial<Record<AiProviderErrorCode, string>> = {
  auth: 'AI_PROVIDER_AUTH_FAILED',
  rate_limited: 'AI_PROVIDER_RATE_LIMITED',
  overloaded: 'AI_PROVIDER_UNAVAILABLE',
  unavailable: 'AI_PROVIDER_UNAVAILABLE',
  model_unavailable: 'AI_MODEL_UNAVAILABLE',
};

/** The client error code of a failure thrown out of a turn. */
export function turnErrorCode(err: unknown): string {
  if (isAiProviderError(err)) return PROVIDER_ERROR_CODES[err.code] ?? 'AI_ERROR';
  return 'AI_ERROR';
}

function costOf(usage: AiUsage, prices: ModelPrices | null): number | null {
  return prices === null ? null : aiUsageCostMicros(usage, prices);
}

function turnFinish(reason: AiFinishReason): AiTurnFinishReason {
  return reason === 'tool_use' ? 'end' : reason;
}

function refusedResult(call: AiToolCallPart, message: string): AiToolResultPart {
  return {
    type: 'tool_result',
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify({ error: message }),
    isError: true,
  };
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/** The turn's clock ran out (as opposed to the client stopping it). */
function timedOut(deadline: AbortSignal, client: AbortSignal): boolean {
  return deadline.aborted && !client.aborted;
}

export async function runTurn(input: TurnRunInput): Promise<TurnRunResult> {
  const { hooks, emit } = input;
  const history = [...input.history];
  let usage = emptyUsage();
  let costMicros: number | null = null;
  let toolCallsUsed = 0;
  let messageId = input.firstMessageId;
  let lastSavedId = input.firstMessageId;
  let lastText = '';
  let first = true;
  let limitReached = false;

  const caps = input.adapter.capabilities(input.model);
  const unsupported = findUnsupportedParts({ messages: history }, caps);
  if (unsupported.length > 0) {
    emit({ type: 'error', code: 'AI_ATTACHMENT_UNSUPPORTED' });
    return {
      finish: 'error',
      lastMessageId: lastSavedId,
      text: '',
      usage,
      costMicros,
      toolCallsUsed,
      errorCode: 'AI_ATTACHMENT_UNSUPPORTED',
    };
  }

  const end = (finish: AiTurnFinishReason, errorCode?: string): TurnRunResult => {
    if (errorCode !== undefined) {
      emit({ type: 'error', code: errorCode });
    }
    const shownCost = aiCostInCompanyCurrencyMicros(costMicros, input.companyCurrency);
    emit({
      type: 'usage',
      usage: shownCost === null ? usage : { ...usage, costMicros: shownCost },
    });
    return {
      finish,
      lastMessageId: lastSavedId,
      text: lastText,
      usage,
      costMicros,
      toolCallsUsed,
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  };

  for (;;) {
    if (input.signal.aborted) return end('stopped');
    const remaining = input.deadline - Date.now();
    if (remaining <= 0) return end('error', 'AI_ERROR');

    const deadlineSignal = AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([input.signal, deadlineSignal]);
    const acc = new AiStreamAccumulator();
    let providerError: unknown = null;
    try {
      for await (const event of input.adapter.stream(
        {
          model: input.model,
          system: input.system,
          messages: stripForeignProviderState(history, input.provider, input.model),
          tools: input.toolset.definitions,
          effort: input.effort,
          ...(input.cacheKey !== undefined ? { cacheKey: input.cacheKey } : {}),
          ...(input.resolveAttachment !== undefined
            ? { resolveAttachment: input.resolveAttachment }
            : {}),
        },
        signal,
      )) {
        acc.push(event);
        if (event.type === 'text_delta' && event.text !== '') {
          emit({ type: 'text_delta', text: event.text });
        }
      }
    } catch (err) {
      providerError = err;
    }

    const result: AiResult = acc.result();
    let callUsage = result.usage;
    if (first && input.priorUsage !== undefined) callUsage = addUsage(callUsage, input.priorUsage);
    first = false;
    usage = addUsage(usage, callUsage);
    const callCost = costOf(callUsage, input.prices);
    if (callCost !== null) costMicros = (costMicros ?? 0) + callCost;

    // Model text and tool calls, including calls whose arguments were not JSON.
    const toolCalls: AiToolCallPart[] = [
      ...result.toolCalls,
      ...result.toolCallErrors.map(
        (e): AiToolCallPart => ({ type: 'tool_call', id: e.id, name: e.name, arguments: {} }),
      ),
    ];
    const parts: AiPart[] = [];
    if (result.text !== '') parts.push({ type: 'text', text: result.text });
    parts.push(...toolCalls);

    let finishReason: string = result.finishReason;
    let errorCode: string | undefined;
    if (providerError !== null) {
      if (isAiProviderError(providerError) && providerError.code === 'aborted') {
        finishReason = 'stopped';
      } else if (isAiProviderError(providerError) && providerError.code === 'context_exceeded') {
        finishReason = 'context_exceeded';
      } else if (isAiProviderError(providerError) && providerError.code === 'refusal') {
        finishReason = 'refusal';
      } else {
        finishReason = 'error';
        errorCode = isAiProviderError(providerError)
          ? (PROVIDER_ERROR_CODES[providerError.code] ?? 'AI_ERROR')
          : 'AI_ERROR';
      }
    } else if (timedOut(deadlineSignal, input.signal) && result.finishReason === 'stopped') {
      finishReason = 'error';
      errorCode = 'AI_ERROR';
    }

    // Tool calls are kept only when the loop answers them; a stopped or
    // failed response keeps its text (the partial message, TC-AI-S-03) and
    // drops the provider state, which belongs to the whole response.
    const complete =
      finishReason === 'tool_use' || finishReason === 'end' || finishReason === 'max_tokens';
    // Some providers end a response that has tool calls with `end` (a
    // malformed call reported as a tool_call_error): the calls still get answers.
    const continues =
      errorCode === undefined &&
      toolCalls.length > 0 &&
      (finishReason === 'tool_use' || finishReason === 'end');
    const saved = continues ? parts : parts.filter((p) => p.type === 'text');
    if (saved.length > 0) {
      await hooks.saveAssistantMessage({
        id: messageId,
        parts: saved,
        providerState: complete ? result.providerState : undefined,
        usage: callUsage,
        costMicros: callCost,
        finishReason,
      });
      lastSavedId = messageId;
      lastText = result.text;
    }
    if (errorCode !== undefined) return end('error', errorCode);
    if (!continues) return end(turnFinish(finishReason as AiFinishReason));

    history.push({
      role: 'assistant',
      parts,
      ...(result.providerState !== undefined ? { providerState: result.providerState } : {}),
    });

    // Tool calls: refuse, run (reads) or hold for confirmation (the first write).
    const results = new Map<string, AiToolResultPart>();
    const reads: {
      call: AiToolCallPart;
      entry: ToolsetEntry;
      args: Record<string, unknown>;
      rowId: string;
    }[] = [];
    let pending: {
      call: AiToolCallPart;
      /** The call as proposed: the model's, or its equivalent for the station's OCPP version. */
      proposed: AiToolCallPart;
      entry: ToolsetEntry;
      args: Record<string, unknown>;
      rowId: string;
      note: string | undefined;
    } | null = null;
    const argErrors = new Map(result.toolCallErrors.map((e) => [e.id, e.message]));
    const seen = { unauthorized: false };

    for (const call of toolCalls) {
      toolCallsUsed++;
      const argError = argErrors.get(call.id);
      const prepared =
        argError !== undefined
          ? {
              ok: false as const,
              entry: input.toolset.byName.get(call.name) ?? null,
              refusal: {
                reason: 'invalid_arguments' as const,
                modelText: `Arguments were not valid JSON: ${argError}`,
              },
            }
          : toolCallsUsed > input.maxToolCalls
            ? {
                ok: false as const,
                entry: input.toolset.byName.get(call.name) ?? null,
                refusal: {
                  reason: 'limit_reached' as const,
                  modelText:
                    'Tool call limit reached for this turn. Answer with the information you have.',
                },
              }
            : prepareToolCall(input.toolset, call.name, call.arguments);
      if (!prepared.ok) {
        const rowId = await hooks.saveToolCall({
          messageId,
          call,
          entry: prepared.entry,
          status: 'refused',
        });
        results.set(call.id, refusedResult(call, prepared.refusal.modelText));
        emit({
          type: 'tool_step',
          toolCallId: rowId,
          name: call.name,
          status: 'refused',
          reason: prepared.refusal.reason,
        });
        continue;
      }
      const isRead = prepared.entry.tool.method === 'GET';
      if (!isRead && pending !== null) {
        const message =
          'Only one change can wait for confirmation at a time. Propose it again after the user decides on the first one.';
        const rowId = await hooks.saveToolCall({
          messageId,
          call,
          entry: prepared.entry,
          status: 'refused',
        });
        results.set(call.id, refusedResult(call, message));
        emit({
          type: 'tool_step',
          toolCallId: rowId,
          name: call.name,
          status: 'refused',
          reason: 'one_change_at_a_time',
        });
        continue;
      }
      if (isRead) {
        const rowId = await hooks.saveToolCall({
          messageId,
          call,
          entry: prepared.entry,
          status: 'ok',
        });
        reads.push({ call, entry: prepared.entry, args: prepared.args, rowId });
        continue;
      }
      const checked: WriteCheck =
        hooks.checkWrite !== undefined
          ? await hooks.checkWrite({ entry: prepared.entry, args: prepared.args })
          : { ok: true, entry: prepared.entry, args: prepared.args };
      if (!checked.ok) {
        const rowId = await hooks.saveToolCall({
          messageId,
          call,
          entry: prepared.entry,
          status: 'refused',
        });
        results.set(call.id, refusedResult(call, checked.refusal.modelText));
        emit({
          type: 'tool_step',
          toolCallId: rowId,
          name: call.name,
          status: 'refused',
          reason: checked.refusal.reason,
        });
        continue;
      }
      // The tool row, the pending action and the card carry the call as
      // proposed; the assistant message keeps the model's own call.
      const proposed: AiToolCallPart =
        checked.entry === prepared.entry
          ? call
          : { ...call, name: checked.entry.tool.name, arguments: checked.args };
      const rowId = await hooks.saveToolCall({
        messageId,
        call: proposed,
        entry: checked.entry,
        status: 'pending_confirmation',
      });
      pending = {
        call,
        proposed,
        entry: checked.entry,
        args: checked.args,
        rowId,
        note: checked.note,
      };
    }

    for (const read of reads) {
      emit({ type: 'tool_step', toolCallId: read.rowId, name: read.call.name, status: 'running' });
    }
    await mapLimited(reads, MAX_PARALLEL_READS, async (read) => {
      let outcome: ToolOutcome;
      try {
        outcome = await hooks.runTool({ entry: read.entry, args: read.args }, read.rowId);
      } catch (err) {
        // Recoverable: the model gets an error result and the turn goes on.
        hooks.warn(err, read.call.name);
        await hooks.completeToolCall(read.rowId, { status: 'error' });
        results.set(read.call.id, refusedResult(read.call, 'The tool call failed.'));
        emit({
          type: 'tool_step',
          toolCallId: read.rowId,
          name: read.call.name,
          status: 'error',
        });
        return;
      }
      if (outcome.httpStatus === 401) seen.unauthorized = true;
      await hooks.completeToolCall(read.rowId, {
        status: outcome.status,
        httpStatus: outcome.httpStatus,
        latencyMs: outcome.latencyMs,
        redactionCounts: outcome.redactionCounts,
      });
      results.set(read.call.id, {
        type: 'tool_result',
        toolCallId: read.call.id,
        name: read.call.name,
        content: outcome.content,
        isError: outcome.status === 'error',
      });
      emit({
        type: 'tool_step',
        toolCallId: read.rowId,
        name: read.call.name,
        status: outcome.status,
        summary: outcome.summary,
        durationMs: outcome.latencyMs,
      });
    });
    if (pending !== null) {
      results.set(pending.call.id, {
        type: 'tool_result',
        toolCallId: pending.call.id,
        name: pending.call.name,
        content:
          pending.note !== undefined
            ? JSON.stringify({
                status: 'pending_confirmation',
                note: `${pending.note} Waiting for the user to confirm or reject this action in the UI.`,
              })
            : PENDING_RESULT,
        isError: false,
      });
    }

    const toolParts = toolCalls.map(
      (call) => results.get(call.id) ?? refusedResult(call, 'The tool call did not run.'),
    );
    const toolMessageId = await hooks.saveToolMessage(toolParts);
    history.push({ role: 'tool', parts: toolParts });

    // A tool call that came back 401: the user's token expired mid-turn (TC-AI-S-06).
    if (seen.unauthorized) return end('error', 'UNAUTHORIZED');

    if (pending !== null) {
      const action = await hooks.createPendingAction({
        toolCallRowId: pending.rowId,
        toolMessageId,
        call: pending.proposed,
        entry: pending.entry,
        args: pending.args,
      });
      const method = pending.entry.tool.method;
      emit({
        type: 'tool_step',
        toolCallId: pending.rowId,
        name: pending.proposed.name,
        status: 'pending_confirmation',
      });
      emit({
        type: 'confirmation_required',
        actionId: action.actionId,
        toolCallId: pending.rowId,
        name: pending.proposed.name,
        nonce: action.nonce,
        method: method === 'GET' ? 'POST' : method,
        path: action.path,
        summary: `${method} ${action.path}`.slice(0, 2000),
        arguments: action.displayArgs,
        expiresAt: action.expiresAt.toISOString(),
      });
      return end('confirmation_required');
    }

    if (limitReached) return end('error', 'AI_ERROR');
    if (toolCallsUsed >= input.maxToolCalls) limitReached = true;
    messageId = hooks.newMessageId();
  }
}
