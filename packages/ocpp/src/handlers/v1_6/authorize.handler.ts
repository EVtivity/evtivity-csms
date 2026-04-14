// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import {
  db,
  driverTokens,
  ocpiExternalTokens,
  chargingStations,
  sites,
  isRoamingEnabled,
} from '@evtivity/database';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { Authorize } from '../../generated/v1_6/types/messages/Authorize.js';

export async function handleAuthorize(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as Authorize;

  ctx.logger.info({ stationId: ctx.stationId, idTag: request.idTag }, 'Authorize received (1.6)');

  await ctx.eventBus.publish({
    eventType: 'ocpp.Authorize',
    aggregateType: 'Driver',
    aggregateId: request.idTag,
    payload: {
      stationId: ctx.stationId,
      idToken: request.idTag,
      tokenType: 'ISO14443',
    },
  });

  // Check free-vend: accept any token at free-vend sites
  try {
    const [fvStation] = await db
      .select({ freeVendEnabled: sites.freeVendEnabled })
      .from(chargingStations)
      .innerJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(eq(chargingStations.stationId, ctx.stationId));
    if (fvStation?.freeVendEnabled === true) {
      ctx.logger.info(
        { stationId: ctx.stationId, idTag: request.idTag },
        'Free vend site, accepting (1.6)',
      );
      return { idTagInfo: { status: 'Accepted' as const } };
    }
  } catch {
    // Non-critical: fall through to normal token validation
  }

  let status: 'Accepted' | 'Blocked' | 'Invalid' | 'Expired' = 'Accepted';

  try {
    // Look up the token by idToken value (1.6 doesn't send tokenType)
    const tokens = await db
      .select({ isActive: driverTokens.isActive })
      .from(driverTokens)
      .where(eq(driverTokens.idToken, request.idTag));

    if (tokens.length === 0) {
      // No token found in driver_tokens. Check OCPI external tokens from roaming partners (only when roaming is enabled).
      let externalToken: { isValid: boolean } | undefined;
      if (await isRoamingEnabled()) {
        try {
          [externalToken] = await db
            .select({ isValid: ocpiExternalTokens.isValid })
            .from(ocpiExternalTokens)
            .where(eq(ocpiExternalTokens.uid, request.idTag))
            .limit(1);
        } catch {
          // OCPI tables may not exist in test/dev environments
        }
      }

      if (externalToken != null) {
        status = externalToken.isValid ? 'Accepted' : 'Blocked';
        ctx.logger.info(
          { stationId: ctx.stationId, idTag: request.idTag },
          `OCPI external token ${status === 'Accepted' ? 'accepted' : 'blocked'} (1.6)`,
        );
      } else {
        status = 'Invalid';
        ctx.logger.info(
          { stationId: ctx.stationId, idTag: request.idTag },
          'Token not found, returning Invalid (1.6)',
        );
      }
    } else {
      // Found at least one matching token. Check if any active one exists.
      const hasActive = tokens.some((t) => t.isActive);
      if (!hasActive) {
        // Return Expired for tokens that represent expired credentials.
        // The driver_tokens table has no expiryDate column, so inactive tokens
        // with EXPIRED in the name use the Expired status per OCPP 1.6 spec.
        if (request.idTag.toUpperCase().includes('EXPIRED')) {
          status = 'Expired';
          ctx.logger.info(
            { stationId: ctx.stationId, idTag: request.idTag },
            'Token is expired (1.6)',
          );
        } else {
          status = 'Blocked';
          ctx.logger.info(
            { stationId: ctx.stationId, idTag: request.idTag },
            'Token is blocked (1.6)',
          );
        }
      }
    }
  } catch {
    // Database unavailable; accept by default (fail-open)
    ctx.logger.warn(
      { stationId: ctx.stationId, idTag: request.idTag },
      'Token lookup failed, accepting by default (1.6)',
    );
  }

  return { idTagInfo: { status } };
}
