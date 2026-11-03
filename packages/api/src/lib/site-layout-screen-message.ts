// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// What each charger screen of the site layout shows, as the real charger
// would: its active display message, else the station message template of its
// state (while station messages are on), else a welcome with the company name.
// The text is rendered in the viewer's language, not the station's.

import { eq, inArray } from 'drizzle-orm';
import {
  db,
  client,
  users,
  pricingGroupStations,
  getCompanyName,
  getCompanySupportPhone,
  getCompanyCurrency,
  getCompanyPriceDisplay,
  getCompanyTaxBasis,
  getStationMessageBrandLine,
  getStationMessagePricingFormat,
  isStationMessageEnabled,
  resolveStationTariff,
} from '@evtivity/database';
import {
  buildStationPriceContext,
  DEFAULT_STATION_MESSAGE_LANGUAGE,
  formatCurrencyAmount,
  formatStationElapsed,
  formatStationQuantity,
  formatStationTime,
  isOcpp2x,
  isStationMessageLanguage,
  renderStationMessage,
  stationScreenWelcome,
  type ServiceLogger,
  type StationMessageContext,
  type StationMessageLanguage,
  type StationMessageState,
} from '@evtivity/lib';

export const SCREEN_MESSAGE_SOURCES = [
  'display_message',
  'station_message_template',
  'default_welcome',
] as const;

export type ScreenMessageSource = (typeof SCREEN_MESSAGE_SOURCES)[number];

export interface ScreenMessage {
  text: string;
  source: ScreenMessageSource;
}

/** The station facts the screen text depends on, from the layout reply. */
export interface ScreenStation {
  id: string;
  stationOcppId: string;
  ocppProtocol: string | null;
  /** The derived station status (the layout `status`). */
  status: string;
  connectorStatuses: readonly string[];
  hasActiveSession: boolean;
  displayMessage: string | null;
  /** Energy of the active session (Wh), as the layout connectors carry it. */
  energyDeliveredWh: number | null;
  /** The active session, only when the viewer may read sessions. */
  session: { startedAt: string; currentCostCents: number | null; currency: string } | null;
  /** End of the reservation holding the station, only when the viewer may read reservations. */
  reservationEndsAt: string | null;
}

type ScreenState = Extract<
  StationMessageState,
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'charging'
  | 'suspended'
  | 'discharging'
  | 'faulted'
  | 'unavailable'
>;

const IDLE_STATES: ReadonlySet<ScreenState> = new Set(['available', 'occupied', 'reserved']);
const TRANSACTION_STATES: ReadonlySet<ScreenState> = new Set([
  'charging',
  'suspended',
  'discharging',
]);
const OCCUPIED_STATUSES = new Set(['occupied', 'preparing', 'ev_connected', 'finishing']);

/**
 * The station message template a station shows now, by the push rules: a
 * station-level fault or unavailability first, then the transaction screens
 * (charging, suspended, discharging) of a session in progress, then the idle
 * screen (reserved, occupied without a session, else available; a session
 * that is neither charging nor paused shows the idle available screen).
 */
export function screenTemplateState(
  s: Pick<ScreenStation, 'status' | 'connectorStatuses' | 'hasActiveSession'>,
): ScreenState {
  if (s.status === 'faulted') return 'faulted';
  if (s.status === 'unavailable') return 'unavailable';
  const statuses = s.connectorStatuses;
  if (s.hasActiveSession) {
    if (statuses.includes('charging')) return 'charging';
    if (statuses.includes('suspended_ev') || statuses.includes('suspended_evse')) {
      return 'suspended';
    }
    if (statuses.includes('discharging')) return 'discharging';
  }
  if (statuses.includes('reserved')) return 'reserved';
  if (!s.hasActiveSession && statuses.some((c) => OCCUPIED_STATUSES.has(c))) return 'occupied';
  return 'available';
}

/**
 * Whether the station gets the screen of a state: OCPP 2.0.1 and 2.1 every
 * state screen, OCPP 1.6 only the idle screen (its vendor DataTransfer), a
 * station of unknown protocol none.
 */
export function stationReceivesState(protocol: string | null, state: ScreenState): boolean {
  if (isOcpp2x(protocol)) return true;
  return protocol === 'ocpp1.6' && IDLE_STATES.has(state);
}

/** The viewer's language for screen text: the user's language, else English. */
export async function viewerScreenLanguage(userId: string): Promise<StationMessageLanguage> {
  const [row] = await db
    .select({ language: users.language })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const language = row?.language;
  return isStationMessageLanguage(language) ? language : DEFAULT_STATION_MESSAGE_LANGUAGE;
}

type StationTariff = Awaited<ReturnType<typeof resolveStationTariff>>;

/**
 * The tariff each station shows on its idle screen. Stations of one site
 * differ only by a station-level pricing group, so the tariff is resolved
 * once per group (and once for the stations without one). Fail-open: a
 * failed resolution shows no prices.
 */
async function idleTariffs(
  stationIds: readonly string[],
  log: ServiceLogger,
): Promise<Map<string, StationTariff>> {
  const result = new Map<string, StationTariff>();
  if (stationIds.length === 0) return result;
  const groupRows = await db
    .select({
      stationId: pricingGroupStations.stationId,
      groupId: pricingGroupStations.pricingGroupId,
    })
    .from(pricingGroupStations)
    .where(inArray(pricingGroupStations.stationId, [...stationIds]));
  const groupOf = new Map(groupRows.map((r) => [r.stationId, r.groupId]));
  const byKey = new Map<string, string[]>();
  for (const id of stationIds) {
    const key = groupOf.get(id) ?? '';
    const list = byKey.get(key) ?? [];
    list.push(id);
    byKey.set(key, list);
  }
  await Promise.all(
    [...byKey.values()].map(async (ids) => {
      const first = ids[0];
      if (first == null) return;
      let tariff: StationTariff = null;
      try {
        tariff = await resolveStationTariff({ stationUuid: first, driverUuid: null }, client);
      } catch (err: unknown) {
        log.warn(
          { err, stationId: first },
          'Screen message tariff lookup failed, showing no prices',
        );
      }
      for (const id of ids) result.set(id, tariff);
    }),
  );
  return result;
}

/**
 * The screen text of every station, rendered in `language`. A template is
 * rendered once per state and context, so stations that share them share
 * one render. A template that fails to render falls back to the welcome.
 */
export async function resolveLayoutScreenMessages(
  stations: readonly ScreenStation[],
  opts: { language: StationMessageLanguage; timezone: string | null; log: ServiceLogger },
): Promise<Map<string, ScreenMessage>> {
  const { language, timezone, log } = opts;
  const result = new Map<string, ScreenMessage>();
  const [companyName, enabled] = await Promise.all([getCompanyName(), isStationMessageEnabled()]);
  const welcome: ScreenMessage = {
    text: stationScreenWelcome(language, companyName),
    source: 'default_welcome',
  };

  const templated: Array<{ station: ScreenStation; state: ScreenState }> = [];
  for (const station of stations) {
    if (station.displayMessage != null && station.displayMessage.trim() !== '') {
      result.set(station.id, { text: station.displayMessage, source: 'display_message' });
      continue;
    }
    const state = screenTemplateState(station);
    if (enabled && stationReceivesState(station.ocppProtocol, state)) {
      templated.push({ station, state });
    } else {
      result.set(station.id, welcome);
    }
  }
  if (templated.length === 0) return result;

  const priced = templated.filter((t) => !TRANSACTION_STATES.has(t.state));
  const [brandLine, supportPhone, pricingFormat, currency, priceDisplay, taxBasis, tariffs] =
    await Promise.all([
      getStationMessageBrandLine(),
      getCompanySupportPhone(),
      getStationMessagePricingFormat(),
      getCompanyCurrency(),
      getCompanyPriceDisplay(),
      getCompanyTaxBasis(),
      idleTariffs(
        priced.map((t) => t.station.id),
        log,
      ),
    ]);

  const renders = new Map<string, Promise<string>>();
  function render(state: ScreenState, ctx: StationMessageContext): Promise<string> {
    const key = `${state}|${JSON.stringify(ctx)}`;
    let pending = renders.get(key);
    if (pending == null) {
      pending = renderStationMessage(state, ctx, language);
      renders.set(key, pending);
    }
    return pending;
  }

  await Promise.all(
    templated.map(async ({ station, state }) => {
      const ctx: StationMessageContext = {
        companyName,
        brandLine,
        stationOcppId: station.stationOcppId,
        supportPhone,
      };
      if (TRANSACTION_STATES.has(state)) {
        ctx.energyKwh = formatStationQuantity((station.energyDeliveredWh ?? 0) / 1000, language);
        if (station.session != null) {
          ctx.costFormatted = formatCurrencyAmount(
            station.session.currentCostCents ?? 0,
            station.session.currency,
            language,
          );
          ctx.elapsedFormatted = formatStationElapsed(station.session.startedAt, language);
        }
      } else {
        Object.assign(
          ctx,
          buildStationPriceContext({
            tariff: tariffs.get(station.id) ?? null,
            priceDisplay,
            taxBasis,
            pricingFormat,
            currency,
            language,
          }),
        );
        if (state === 'reserved' && station.reservationEndsAt != null) {
          ctx.reservationExpiresAt = formatStationTime(
            new Date(station.reservationEndsAt),
            language,
            timezone ?? undefined,
          );
        }
      }
      let text = '';
      try {
        text = (await render(state, ctx)).trim();
      } catch (err: unknown) {
        log.warn(
          { err, stationId: station.stationOcppId, state },
          'Screen message template failed to render, showing the welcome',
        );
      }
      result.set(station.id, text === '' ? welcome : { text, source: 'station_message_template' });
    }),
  );
  return result;
}
