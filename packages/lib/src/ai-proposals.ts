// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI insight actions (stored as `ai_proposals`): a write a background worker
 * suggests with an automatic insight. It runs only after an operator confirms
 * it on the insight in the CSMS, with that operator's own authorization.
 * Shared by the worker, the API and the CSMS. Browser-safe
 * (`@evtivity/lib/ai-proposals`).
 */

import { z } from 'zod';

export const AI_WORKER_JOBS = ['network_summary', 'stuck_sessions', 'tariff_anomalies'] as const;
export type AiWorkerJob = (typeof AI_WORKER_JOBS)[number];

export const AI_PROPOSAL_STATUSES = [
  'pending',
  'executed',
  'failed',
  'rejected',
  'expired',
  'stale',
] as const;
export type AiProposalStatus = (typeof AI_PROPOSAL_STATUSES)[number];

/**
 * Why a confirmed proposal was refused before its route ran. Stored as
 * `result.body.refused` of a failed proposal (no English text); the CSMS
 * localizes it as `aiInsights.action.refused.<reason>`.
 */
export const AI_PROPOSAL_REFUSAL_REASONS = [
  'args_mismatch',
  'no_longer_available',
  'invalid_arguments',
  'ocpp_version_mismatch',
] as const;
export type AiProposalRefusalReason = (typeof AI_PROPOSAL_REFUSAL_REASONS)[number];

export function isAiProposalRefusalReason(value: unknown): value is AiProposalRefusalReason {
  return (
    typeof value === 'string' && (AI_PROPOSAL_REFUSAL_REASONS as readonly string[]).includes(value)
  );
}

/** Every status but `pending` is final: a status update only moves a proposal out of `pending`. */
export const AI_PROPOSAL_TERMINAL_STATUSES: readonly AiProposalStatus[] = [
  'executed',
  'failed',
  'rejected',
  'expired',
  'stale',
];

export const AI_WORKER_ACTION_KINDS = [
  'stop_transaction',
  'end_session',
  'soft_reset',
  'change_availability',
] as const;
export type AiWorkerActionKind = (typeof AI_WORKER_ACTION_KINDS)[number];

/**
 * The argument that names what an action acts on, from which the proposal's
 * station, site and session are resolved (never from the caller alone, P11):
 * - `ocpp_station`: `stationId`, the OCPP identity (OCPP command routes);
 * - `station`: `id`, the internal station id;
 * - `session`: `id`, the session id.
 */
export type AiWorkerActionTarget = 'ocpp_station' | 'station' | 'session';

export interface AiWorkerAction {
  kind: AiWorkerActionKind;
  /** The OCPP version of the command route, null for a route that serves both. */
  ocppVersion: '1.6' | '2.1' | null;
  target: AiWorkerActionTarget;
  /** The tool policy `write` operation the action runs. */
  operationId: string;
  method: 'POST';
  path: string;
  /** Arguments that must have exactly this value. */
  fixedArgs: Readonly<Record<string, string>>;
  /** Arguments that must take one of these values. */
  allowedArgs: Readonly<Record<string, readonly string[]>>;
}

/**
 * The closed set of actions a background worker may suggest, each an existing
 * route of policy `write`: station commands, and the end of a stuck session.
 * A session ends through the routes an operator uses: the EVSE stop at an
 * online station (which also ends a session the station no longer knows), and
 * the CSMS end at an offline one. Both end the session with its normal
 * billing, as the station's own stop would. No payment, refund, pricing,
 * re-billing or security operation is in it, and none may be added.
 */
export const AI_WORKER_ACTIONS: readonly AiWorkerAction[] = [
  {
    kind: 'stop_transaction',
    ocppVersion: null,
    target: 'station',
    operationId: 'stopActiveEvseSession',
    method: 'POST',
    path: '/v1/stations/{id}/evses/{evseId}/stop-active-session',
    fixedArgs: {},
    allowedArgs: {},
  },
  {
    kind: 'end_session',
    ocppVersion: null,
    target: 'session',
    operationId: 'endSession',
    method: 'POST',
    path: '/v1/sessions/{id}/end',
    fixedArgs: {},
    allowedArgs: {},
  },
  {
    kind: 'soft_reset',
    ocppVersion: '2.1',
    target: 'ocpp_station',
    operationId: 'ocppv21_Reset',
    method: 'POST',
    path: '/v1/ocpp/commands/v21/Reset',
    fixedArgs: { type: 'OnIdle' },
    allowedArgs: {},
  },
  {
    kind: 'soft_reset',
    ocppVersion: '1.6',
    target: 'ocpp_station',
    operationId: 'ocppv16_Reset',
    method: 'POST',
    path: '/v1/ocpp/commands/v16/Reset',
    fixedArgs: { type: 'Soft' },
    allowedArgs: {},
  },
  {
    kind: 'change_availability',
    ocppVersion: '2.1',
    target: 'ocpp_station',
    operationId: 'ocppv21_ChangeAvailability',
    method: 'POST',
    path: '/v1/ocpp/commands/v21/ChangeAvailability',
    fixedArgs: {},
    allowedArgs: { operationalStatus: ['Inoperative', 'Operative'] },
  },
  {
    kind: 'change_availability',
    ocppVersion: '1.6',
    target: 'ocpp_station',
    operationId: 'ocppv16_ChangeAvailability',
    method: 'POST',
    path: '/v1/ocpp/commands/v16/ChangeAvailability',
    fixedArgs: {},
    allowedArgs: { type: ['Inoperative', 'Operative'] },
  },
];

export function findAiWorkerAction(operationId: string): AiWorkerAction | undefined {
  return AI_WORKER_ACTIONS.find((a) => a.operationId === operationId);
}

/** True when `args` respect the action's fixed and allowed values. */
export function workerActionArgsAllowed(
  action: AiWorkerAction,
  args: Readonly<Record<string, unknown>>,
): boolean {
  for (const [name, value] of Object.entries(action.fixedArgs)) {
    if (args[name] !== value) return false;
  }
  for (const [name, values] of Object.entries(action.allowedArgs)) {
    const value = args[name];
    if (typeof value !== 'string' || !values.includes(value)) return false;
  }
  return true;
}

/** Checked again at confirm time; a proposal whose precondition no longer holds ends `stale`. */
export const AI_PROPOSAL_PRECONDITION_KINDS = [
  'session_active',
  'station_faulted',
  'station_availability',
] as const;
export type AiProposalPreconditionKind = (typeof AI_PROPOSAL_PRECONDITION_KINDS)[number];

export const aiProposalPreconditionSchema = z.object({
  kind: z.enum(AI_PROPOSAL_PRECONDITION_KINDS),
  params: z.record(z.unknown()),
});
export type AiProposalPrecondition = z.infer<typeof aiProposalPreconditionSchema>;

export const aiProposalResultSchema = z.object({
  httpStatus: z.number().int(),
  /** Redacted excerpt of the route's response body. */
  body: z.unknown().optional(),
});
export type AiProposalResult = z.infer<typeof aiProposalResultSchema>;

/**
 * The action an insight carries, as the API returns it (`action` of the
 * insight). It has no status of its own: the insight's status covers it
 * (`INSIGHT_VISIBLE_STATUSES`).
 */
export const aiProposalDtoSchema = z.object({
  id: z.string(),
  job: z.enum(AI_WORKER_JOBS).nullable(),
  insightId: z.string(),
  siteId: z.string().nullable(),
  stationId: z.string().nullable(),
  sessionId: z.string().nullable(),
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  args: z.record(z.unknown()),
  argsHash: z.string(),
  /** Structured fields for the localized confirmation card. */
  summary: z.record(z.unknown()),
  precondition: aiProposalPreconditionSchema.nullable(),
  expiresAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  result: aiProposalResultSchema.nullable(),
  createdAt: z.string(),
});
export type AiProposalDto = z.infer<typeof aiProposalDtoSchema>;

export const aiProposalConfirmBody = z.object({ argsHash: z.string().min(1) });

/** Default time to live of an action: the stuck-session stop (the soft reset uses `aiWorkers.proposalTtlHours`). */
export const AI_PROPOSAL_TTL_MS = {
  stuckSessions: 2 * 60 * 60 * 1000,
} as const;

/** How an audit row written by an AI-run request records where it came from. */
export const AI_VIA_CHANNELS = ['chat', 'mcp', 'proposal'] as const;
export type AiViaChannel = (typeof AI_VIA_CHANNELS)[number];

export const aiAuditViaSchema = z.object({
  channel: z.enum(AI_VIA_CHANNELS),
  conversationId: z.string().optional(),
  toolCallId: z.string().optional(),
  mcpCallId: z.string().optional(),
  proposalId: z.string().optional(),
  confirmedBy: z.string().optional(),
});
export type AiAuditVia = z.infer<typeof aiAuditViaSchema>;

/**
 * Reads a stored `via_ai` value. Rows written before the channel existed hold
 * `{ conversationId, toolCallId }` and are chat rows. Returns null for any
 * other shape.
 */
export function readAiAuditVia(stored: unknown): AiAuditVia | null {
  if (stored == null || typeof stored !== 'object') return null;
  if (!('channel' in stored) && !('conversationId' in stored)) return null;
  const value = 'channel' in stored ? stored : { ...stored, channel: 'chat' };
  const parsed = aiAuditViaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const AI_WORKER_SETTING_KEYS = {
  networkSummaryEnabled: 'aiWorkers.networkSummary.enabled',
  stuckSessionsEnabled: 'aiWorkers.stuckSessions.enabled',
  stuckSessionsIdleMinutes: 'aiWorkers.stuckSessions.idleMinutes',
  stuckSessionsUseModel: 'aiWorkers.stuckSessions.useModel',
  stuckSessionsOfflineEndAfterHours: 'aiWorkers.stuckSessions.offlineEndAfterHours',
  tariffAnomaliesEnabled: 'aiWorkers.tariffAnomalies.enabled',
  proposalTtlHours: 'aiWorkers.proposalTtlHours',
} as const;

/**
 * The MCP toolsets served when a client names none (`?toolsets=`): stations
 * (alerts included), sessions, sites, tokens (with the authorize log) and
 * automatic insights (the main read surface). Shared so the CSMS lists the
 * same set.
 */
export const AI_MCP_DEFAULT_TOOLSETS: readonly string[] = [
  'ai-insights',
  'sessions',
  'sites',
  'stations',
  'tokens',
];

export const AI_MCP_SETTING_KEYS = {
  enabled: 'ai.mcp.enabled',
  rateLimitPerMinute: 'ai.mcp.rateLimitPerMinute',
  dailyCallsPerKey: 'ai.mcp.dailyCallsPerKey',
  allowWrites: 'ai.mcp.allowWrites',
  allowedOrigins: 'ai.mcp.allowedOrigins',
} as const;

/** Error codes of the insight action and MCP routes, with their HTTP status. */
export const AI_PROPOSAL_ERROR_CODES = {
  AI_PROPOSAL_NOT_FOUND: 404,
  AI_PROPOSAL_EXPIRED: 409,
  AI_PROPOSAL_STALE: 409,
  AI_PROPOSAL_ALREADY_DECIDED: 409,
  AI_CONFIRMATION_REQUIRES_SESSION: 403,
  AI_MCP_RATE_LIMITED: 429,
} as const;
export type AiProposalErrorCode = keyof typeof AI_PROPOSAL_ERROR_CODES;
