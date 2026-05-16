// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Handlebars from 'handlebars';

export type StationMessageState =
  // State-bound slots (9000-9005) shown by the station based on its current
  // MessageState. Pushed by the connector-status / transaction-event listeners.
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'charging'
  | 'suspended'
  | 'discharging'
  | 'faulted'
  | 'unavailable'
  // Event-bound one-shot messages (slot 9010) dispatched on demand by
  // server-side flows (e.g. payment gate stopping a session). Not bound to a
  // MessageState, render via dispatchOneShotStationMessage and auto-clear
  // after a short TTL.
  | 'payment_failed'
  | 'payment_required'
  | 'guest_unauthorized'
  | 'unauthorized';

export interface StationMessageContext {
  companyName: string;
  stationOcppId: string;
  pricingDisplay?: string;
  energyKwh?: string;
  powerKw?: string;
  costFormatted?: string;
  elapsedFormatted?: string;
  idleFeeRate?: string;
  supportPhone?: string;
  driverFirstName?: string;
  reservationExpiresAt?: string;
}

interface CachedTemplate {
  cacheKey: string;
  template: Handlebars.TemplateDelegate;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const templateCache = new Map<StationMessageState, CachedTemplate>();

export function clearStationMessageCache(): void {
  templateCache.clear();
}

export async function renderStationMessage(
  state: StationMessageState,
  ctx: StationMessageContext,
): Promise<string> {
  const cached = templateCache.get(state);
  let template: Handlebars.TemplateDelegate | null = null;

  if (cached != null && cached.expiresAt > Date.now()) {
    template = cached.template;
  } else {
    const dbModule = (await import('@evtivity/database')) as unknown as {
      db: {
        select: (selection: Record<string, unknown>) => {
          from: (table: unknown) => {
            where: (cond: unknown) => Promise<Array<{ body: string; updatedAt: Date }>>;
          };
        };
      };
      stationMessageTemplates: {
        body: unknown;
        updatedAt: unknown;
        state: unknown;
      };
    };
    const drizzle = (await import('drizzle-orm')) as unknown as {
      eq: (left: unknown, right: unknown) => unknown;
    };

    const rows = await dbModule.db
      .select({
        body: dbModule.stationMessageTemplates.body,
        updatedAt: dbModule.stationMessageTemplates.updatedAt,
      })
      .from(dbModule.stationMessageTemplates)
      .where(drizzle.eq(dbModule.stationMessageTemplates.state, state));

    const row = rows[0];
    if (row == null) {
      return '';
    }

    const cacheKey = `${state}:${row.updatedAt.getTime().toString()}`;
    if (cached != null && cached.cacheKey === cacheKey) {
      cached.expiresAt = Date.now() + CACHE_TTL_MS;
      template = cached.template;
    } else {
      template = Handlebars.compile(row.body, { noEscape: true });
      templateCache.set(state, {
        cacheKey,
        template,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
  }

  const renderContext: Record<string, string> = {
    companyName: ctx.companyName,
    stationOcppId: ctx.stationOcppId,
    pricingDisplay: ctx.pricingDisplay ?? '',
    energyKwh: ctx.energyKwh ?? '',
    powerKw: ctx.powerKw ?? '',
    costFormatted: ctx.costFormatted ?? '',
    elapsedFormatted: ctx.elapsedFormatted ?? '',
    idleFeeRate: ctx.idleFeeRate ?? '',
    supportPhone: ctx.supportPhone ?? '',
    driverFirstName: ctx.driverFirstName ?? '',
    reservationExpiresAt: ctx.reservationExpiresAt ?? '',
  };

  return template(renderContext);
}
