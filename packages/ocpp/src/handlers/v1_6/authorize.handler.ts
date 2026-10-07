// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { Authorize } from '../../generated/v1_6/types/messages/Authorize.js';
import type { AuthorizeResponse } from '../../generated/v1_6/types/messages/AuthorizeResponse.js';
import type { AuthorizeTokenInput } from '../../authorization/authorize-context.js';
import {
  authorizeToken,
  logAuthorizeDecision,
  recordAuthorizeDecision,
} from '../../authorization/authorize-token.js';
import { idTagInfoFor } from './id-tag-info.js';

/**
 * OCPP 1.6 Authorize: an adapter over the shared authorize pipeline. The idTag
 * has no token type; the event and the attempts log name it ISO14443.
 */
export async function handleAuthorize(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as Authorize;
  const idTag = request.idTag;

  ctx.logger.info({ stationId: ctx.stationId, idTag }, 'Authorize received (1.6)');

  await ctx.eventBus.publish({
    eventType: 'ocpp.Authorize',
    aggregateType: 'Driver',
    aggregateId: idTag,
    payload: { stationId: ctx.stationId, idToken: idTag, tokenType: 'ISO14443' },
  });

  const input: AuthorizeTokenInput = {
    stationId: ctx.stationId,
    stationDbId: ctx.stationDbId,
    evseId: null,
    token: { value: idTag, type: null },
    context: 'authorize',
    ocppVersion: 'ocpp1.6',
  };
  const decision = await authorizeToken(input, ctx.logger);
  logAuthorizeDecision(input, decision, ctx.logger);
  recordAuthorizeDecision(input, decision, ctx.logger);

  const response: AuthorizeResponse = { idTagInfo: idTagInfoFor(decision) };
  return response as unknown as Record<string, unknown>;
}
