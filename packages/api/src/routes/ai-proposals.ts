// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI Inbox: proposals from background AI workers and MCP clients. A proposal
 * runs only when an operator confirms it here, in an interactive session, as
 * that operator (`executeConfirmedToolCall`): the route the proposal names
 * applies its own RBAC and site scope at confirm time. API keys can read
 * proposals but never confirm or reject one (decision D8).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { db, chargingStations, sites, users } from '@evtivity/database';
import {
  AI_PROPOSAL_PRECONDITION_KINDS,
  AI_PROPOSAL_SOURCES,
  AI_PROPOSAL_STATUSES,
  AI_WORKER_JOBS,
  aiProposalConfirmBody,
  aiProposalPreconditionSchema,
  findAiWorkerAction,
  workerActionArgsAllowed,
} from '@evtivity/lib/ai-proposals';
import type { AiProposalDto } from '@evtivity/lib/ai-proposals';
import {
  aiProposalPreconditionHolds,
  claimAiProposal,
  finishAiProposal,
  getAiProposal,
  listAiProposals,
  rejectAiProposal,
  toAiProposalDto,
  aiProposalApiKeyNames,
} from '@evtivity/services/ai-proposal.service';
import type { AiProposalRow, AiProposalScope } from '@evtivity/services/ai-proposal.service';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, paginatedResponse, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES, ERROR_MESSAGES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import { callerAuthorization } from '../services/ai/engine/route-support.js';
import { executeConfirmedToolCall } from '../services/ai/tools/execute.js';
import type { ConfirmedToolCallResult } from '../services/ai/tools/execute.js';

type RouteErrorCode =
  | 'AI_PROPOSAL_NOT_FOUND'
  | 'AI_PROPOSAL_EXPIRED'
  | 'AI_PROPOSAL_STALE'
  | 'AI_PROPOSAL_ALREADY_DECIDED'
  | 'AI_CONFIRMATION_REQUIRES_SESSION'
  | 'VALIDATION_ERROR';

async function sendError(
  reply: FastifyReply,
  status: number,
  code: RouteErrorCode,
): Promise<FastifyReply> {
  return reply.status(status).send({ error: ERROR_MESSAGES[code], code });
}

const proposalItem = z
  .object({
    id: z.string().describe('Proposal ID'),
    source: z
      .enum(AI_PROPOSAL_SOURCES)
      .describe('worker: a background AI worker; mcp: an MCP client'),
    job: z
      .enum(AI_WORKER_JOBS)
      .nullable()
      .describe('The worker job that proposed it, null for MCP'),
    insightId: z.string().nullable().describe('The insight the proposal came with'),
    requestedByUserId: z
      .string()
      .nullable()
      .describe('MCP: the user whose API key asked for it, the only user who may approve it'),
    apiKeyName: z
      .string()
      .nullable()
      .describe('MCP: name of the API key that asked for it; null for workers and a revoked key'),
    siteId: z.string().nullable().describe('Site of the target, null for company-level items'),
    stationId: z.string().nullable().describe('Target station ID'),
    sessionId: z.string().nullable().describe('Target session ID'),
    operationId: z.string().describe('The API operation the proposal runs'),
    method: z.string().describe('HTTP method of the operation'),
    path: z.string().describe('Path of the operation'),
    args: z.record(z.unknown()).describe('The arguments the operation runs with'),
    argsHash: z.string().describe('Hash of the arguments; send it back to confirm'),
    summary: z.record(z.unknown()).describe('Structured fields for the confirmation card'),
    rationaleText: z.string().nullable().describe('Why the worker proposed it, plain text'),
    rationaleLanguage: z.string().nullable().describe('Language of the rationale'),
    precondition: z
      .object({
        kind: z.enum(AI_PROPOSAL_PRECONDITION_KINDS).describe('What must still hold at confirm'),
        params: z.record(z.unknown()).describe('Parameters of the check'),
      })
      .passthrough()
      .nullable()
      .describe('Checked again at confirm; a proposal whose precondition fails ends stale'),
    status: z.enum(AI_PROPOSAL_STATUSES).describe('pending, or the final status'),
    expiresAt: z.string().describe('ISO datetime after which it can no longer be confirmed'),
    decidedBy: z.string().nullable().describe('User who confirmed or rejected it'),
    decidedAt: z.string().nullable().describe('ISO datetime of the decision'),
    executedAt: z.string().nullable().describe('ISO datetime the operation ran'),
    result: z
      .object({
        httpStatus: z.number().int().describe('HTTP status the operation answered'),
        body: z.unknown().optional().describe('Redacted excerpt of the answer'),
      })
      .passthrough()
      .nullable()
      .describe('The operation result, once it ran'),
    createdAt: z.string().describe('ISO datetime'),
    stationName: z
      .string()
      .nullable()
      .describe('OCPP identity of the target station, for display; null without a station'),
    siteName: z.string().nullable().describe('Name of the site, for display; null without a site'),
    requestedByName: z
      .string()
      .nullable()
      .describe('MCP: name of the user whose API key asked for it; null for workers'),
    decidedByName: z
      .string()
      .nullable()
      .describe('Name of the user who confirmed or rejected it; null while undecided'),
  })
  .passthrough();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('Page number (1-based)'),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Items per page (max 100)'),
  status: z.enum(AI_PROPOSAL_STATUSES).optional().describe('Filter by status'),
  source: z.enum(AI_PROPOSAL_SOURCES).optional().describe('Filter by source'),
  job: z.enum(AI_WORKER_JOBS).optional().describe('Filter by worker job'),
  siteId: z.string().optional().describe('Filter by site'),
  stationId: z.string().optional().describe('Filter by station'),
  sessionId: z.string().optional().describe('Filter by session'),
  search: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Matches the station's OCPP identity, the site name, the operation or the proposal ID",
    ),
});

const idParams = z.object({ id: z.string().min(1).max(64).describe('Proposal ID') });

async function scopeOf(request: FastifyRequest): Promise<AiProposalScope> {
  const { userId } = request.user as JwtPayload;
  return { userId, siteIds: await getUserSiteIds(userId) };
}

function isApiKeyRequest(request: FastifyRequest): boolean {
  return (request.user as JwtPayload).isApiKey === true;
}

/** Worker proposals run only the closed action set, also after the OCPP version mapping. */
function workerActionAllowed(operationId: string, args: Readonly<Record<string, unknown>>) {
  const action = findAiWorkerAction(operationId);
  return action !== undefined && workerActionArgsAllowed(action, args);
}

/** The result row of a confirm, from what the confirmed call did. */
function outcomeOf(result: Exclude<ConfirmedToolCallResult, { kind: 'expired' | 'stale' }>) {
  if (result.kind === 'refused') {
    return {
      status: 'failed' as const,
      // The reason code only; the CSMS localizes it (no English text stored).
      result: { httpStatus: 0, body: { refused: result.reason } },
    };
  }
  return {
    status: result.httpStatus < 400 ? ('executed' as const) : ('failed' as const),
    result: {
      httpStatus: result.httpStatus,
      body: { operationId: result.operationId, response: result.body },
    },
  };
}

export function aiProposalRoutes(app: FastifyInstance): void {
  app.get(
    '/ai/proposals',
    {
      onRequest: [authorize('aiProposals:read')],
      schema: {
        tags: ['AI Proposals'],
        summary: 'List AI proposals',
        description:
          "Proposals from background AI workers and MCP clients, newest first. Worker proposals are filtered by the caller's sites (company-level ones need all-site access); an MCP proposal is listed only for the user who asked for it.",
        operationId: 'listAiProposals',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listQuery),
        response: { 200: paginatedResponse(proposalItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof listQuery>;
      const { data, total } = await listAiProposals(await scopeOf(request), {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.source !== undefined ? { source: query.source } : {}),
        ...(query.job !== undefined ? { job: query.job } : {}),
        ...(query.siteId !== undefined ? { siteId: query.siteId } : {}),
        ...(query.stationId !== undefined ? { stationId: query.stationId } : {}),
        ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
      });
      return { data: await dtosOf(data), total };
    },
  );

  app.get(
    '/ai/proposals/:id',
    {
      onRequest: [authorize('aiProposals:read')],
      schema: {
        tags: ['AI Proposals'],
        summary: 'Get an AI proposal',
        description:
          'One proposal with its full arguments. 404 when it does not exist, is outside the caller sites, or is another user MCP proposal.',
        operationId: 'getAiProposal',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          200: itemResponse(proposalItem),
          404: errorWith('Proposal not found', [ERROR_CODES.AI_PROPOSAL_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParams>;
      const row = await getAiProposal(await scopeOf(request), id);
      if (row === null) return sendError(reply, 404, 'AI_PROPOSAL_NOT_FOUND');
      return dtoOf(row);
    },
  );

  app.post(
    '/ai/proposals/:id/confirm',
    {
      onRequest: [authorize('aiProposals:write')],
      schema: {
        tags: ['AI Proposals'],
        summary: 'Confirm and run an AI proposal',
        description:
          "Runs the proposal once, as the caller: the precondition and the station's OCPP version are checked again, then the operation runs with the caller's own permissions and site access. A route refusal (403, 404) is recorded and the proposal ends failed. Needs a signed-in session: API keys get 403 AI_CONFIRMATION_REQUIRES_SESSION.",
        operationId: 'confirmAiProposal',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(
          aiProposalConfirmBody.extend({
            argsHash: z.string().min(1).max(64).describe('argsHash of the proposal as shown'),
          }),
        ),
        response: {
          200: itemResponse(proposalItem),
          400: errorWith('The arguments shown differ from the proposal', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          403: errorWith('Confirmation needs a signed-in session', [
            ERROR_CODES.AI_CONFIRMATION_REQUIRES_SESSION,
          ]),
          404: errorWith('Proposal not found', [ERROR_CODES.AI_PROPOSAL_NOT_FOUND]),
          409: errorWith('The proposal cannot be confirmed', [
            ERROR_CODES.AI_PROPOSAL_EXPIRED,
            ERROR_CODES.AI_PROPOSAL_STALE,
            ERROR_CODES.AI_PROPOSAL_ALREADY_DECIDED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof idParams>;
      const { argsHash } = request.body as z.infer<typeof aiProposalConfirmBody>;
      const row = await getAiProposal(await scopeOf(request), id);
      // Not found first, so a key learns nothing about proposals it cannot see.
      if (row === null) return sendError(reply, 404, 'AI_PROPOSAL_NOT_FOUND');
      if (isApiKeyRequest(request)) {
        return sendError(reply, 403, 'AI_CONFIRMATION_REQUIRES_SESSION');
      }
      if (row.status !== 'pending') return decidedError(reply, row);
      if (argsHash !== row.argsHash) return sendError(reply, 400, 'VALIDATION_ERROR');

      const actor = { actor: 'operator' as const, actorUserId: userId };
      const claim = await claimAiProposal(row.id, actor, request.log);
      if (claim.kind === 'not_found') return sendError(reply, 404, 'AI_PROPOSAL_NOT_FOUND');
      if (claim.kind !== 'claimed') return decidedError(reply, claim.row);

      const claimed = claim.row;
      // A stored precondition that no longer parses fails closed: the proposal ends stale.
      const parsed =
        claimed.precondition == null
          ? null
          : aiProposalPreconditionSchema.safeParse(claimed.precondition);
      const precondition = parsed === null ? null : parsed.success ? parsed.data : undefined;
      let result: ConfirmedToolCallResult;
      try {
        result = await executeConfirmedToolCall(
          app,
          {
            userId,
            authorization: callerAuthorization(request),
            hasPermission: (permission) => requestHasPermission(request, permission),
          },
          {
            operationId: claimed.operationId,
            args: claimed.args as Record<string, unknown>,
            argsHash: claimed.argsHash,
            expiresAt: claimed.expiresAt,
            // An MCP client's proposal records the MCP channel; its call log row
            // (`ai_mcp_calls.proposal_id`) names the call that asked for it.
            via: {
              channel: claimed.source === 'mcp' ? 'mcp' : 'proposal',
              proposalId: claimed.id,
              confirmedBy: userId,
            },
            ...(claimed.source === 'worker' ? { allowAction: workerActionAllowed } : {}),
            ...(precondition === undefined
              ? { precondition: () => Promise.resolve(false) }
              : precondition !== null
                ? { precondition: () => aiProposalPreconditionHolds(precondition) }
                : {}),
          },
        );
      } catch (err) {
        // Fail loud, but never leave the claim behind: whether the route ran
        // is unknown, so the proposal ends failed and is never retried (P9).
        request.log.error({ err, proposalId: claimed.id }, 'AI proposal confirm failed');
        await finishAiProposal(
          claimed.id,
          actor,
          { status: 'failed', result: { httpStatus: 0, body: { error: 'confirm_error' } } },
          request.log,
        );
        throw err;
      }
      if (result.kind === 'expired' || result.kind === 'stale') {
        await finishAiProposal(claimed.id, actor, { status: result.kind }, request.log);
        return sendError(
          reply,
          409,
          result.kind === 'expired' ? 'AI_PROPOSAL_EXPIRED' : 'AI_PROPOSAL_STALE',
        );
      }
      if (result.kind === 'refused') {
        request.log.info(
          { proposalId: claimed.id, operationId: claimed.operationId, reason: result.reason },
          'AI proposal refused at confirm',
        );
      }
      const finished = await finishAiProposal(claimed.id, actor, outcomeOf(result), request.log);
      if (finished !== null) return dtoOf(finished);
      // The sweep ended the claim first (a confirm past the claim timeout).
      const current = await getAiProposal(await scopeOf(request), id);
      return decidedError(reply, current ?? claimed);
    },
  );

  app.post(
    '/ai/proposals/:id/reject',
    {
      onRequest: [authorize('aiProposals:write')],
      schema: {
        tags: ['AI Proposals'],
        summary: 'Reject an AI proposal',
        description:
          'Records the rejection; the proposal never runs. Needs a signed-in session: API keys get 403 AI_CONFIRMATION_REQUIRES_SESSION.',
        operationId: 'rejectAiProposal',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          200: itemResponse(proposalItem),
          403: errorWith('Deciding needs a signed-in session', [
            ERROR_CODES.AI_CONFIRMATION_REQUIRES_SESSION,
          ]),
          404: errorWith('Proposal not found', [ERROR_CODES.AI_PROPOSAL_NOT_FOUND]),
          409: errorWith('The proposal cannot be rejected', [
            ERROR_CODES.AI_PROPOSAL_EXPIRED,
            ERROR_CODES.AI_PROPOSAL_STALE,
            ERROR_CODES.AI_PROPOSAL_ALREADY_DECIDED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof idParams>;
      const row = await getAiProposal(await scopeOf(request), id);
      if (row === null) return sendError(reply, 404, 'AI_PROPOSAL_NOT_FOUND');
      if (isApiKeyRequest(request)) {
        return sendError(reply, 403, 'AI_CONFIRMATION_REQUIRES_SESSION');
      }
      if (row.status !== 'pending') return decidedError(reply, row);
      const rejection = await rejectAiProposal(
        row.id,
        { actor: 'operator', actorUserId: userId },
        request.log,
      );
      if (rejection.kind === 'not_found') return sendError(reply, 404, 'AI_PROPOSAL_NOT_FOUND');
      if (rejection.kind === 'rejected') return dtoOf(rejection.row);
      return decidedError(reply, rejection.row);
    },
  );
}

/** One proposal's DTO, with the name of the API key that asked for it (MCP). */
/** A proposal as the API sends it: the DTO plus display names of its records. */
type AiProposalView = AiProposalDto & {
  stationName: string | null;
  siteName: string | null;
  requestedByName: string | null;
  decidedByName: string | null;
};

/** The user's name, never the email: proposal readers need not see other operators' addresses. */
function userName(u: { firstName: string | null; lastName: string | null }): string | null {
  const name = [u.firstName, u.lastName].filter((p) => p != null && p !== '').join(' ');
  return name !== '' ? name : null;
}

async function dtosOf(rows: readonly AiProposalRow[]): Promise<AiProposalView[]> {
  const stationIds = [...new Set(rows.map((r) => r.stationId).filter((id) => id != null))];
  const siteIds = [...new Set(rows.map((r) => r.siteId).filter((id) => id != null))];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.requestedByUserId, r.decidedBy]).filter((id) => id != null)),
  ];
  const [keyNames, stationRows, siteRows, userRows] = await Promise.all([
    aiProposalApiKeyNames(rows),
    stationIds.length === 0
      ? []
      : db
          .select({ id: chargingStations.id, name: chargingStations.stationId })
          .from(chargingStations)
          .where(inArray(chargingStations.id, stationIds)),
    siteIds.length === 0
      ? []
      : db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, siteIds)),
    userIds.length === 0
      ? []
      : db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(users)
          .where(inArray(users.id, userIds)),
  ]);
  const stationNames = new Map(stationRows.map((r) => [r.id, r.name]));
  const siteNames = new Map(siteRows.map((r) => [r.id, r.name]));
  const userNames = new Map(
    userRows.flatMap((u) => {
      const name = userName(u);
      return name != null ? [[u.id, name] as const] : [];
    }),
  );
  const lookup = (map: Map<string, string>, id: string | null): string | null =>
    id != null ? (map.get(id) ?? null) : null;
  return rows.map((row) => ({
    ...toAiProposalDto(row, keyNames),
    stationName: lookup(stationNames, row.stationId),
    siteName: lookup(siteNames, row.siteId),
    requestedByName: lookup(userNames, row.requestedByUserId),
    decidedByName: lookup(userNames, row.decidedBy),
  }));
}

async function dtoOf(row: AiProposalRow): Promise<AiProposalView> {
  const [dto] = await dtosOf([row]);
  if (dto === undefined) throw new Error('dtosOf returned no row');
  return dto;
}

/** 409 for a proposal that is no longer open to a decision. */
async function decidedError(reply: FastifyReply, row: AiProposalRow): Promise<FastifyReply> {
  if (row.status === 'expired') return sendError(reply, 409, 'AI_PROPOSAL_EXPIRED');
  if (row.status === 'stale') return sendError(reply, 409, 'AI_PROPOSAL_STALE');
  return sendError(reply, 409, 'AI_PROPOSAL_ALREADY_DECIDED');
}
