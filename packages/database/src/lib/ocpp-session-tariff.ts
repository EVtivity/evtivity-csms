// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPP 2.1 tariff a station uses for local cost calculation: built from
// the tariffs the CSMS bills with (AuthorizeResponse.tariff, I08) and sent
// again with ChangeTransactionTariff when the CSMS switches a session's tariff
// segment and the station's tariff no longer describes it (I11). Shared by
// the OCPP server (Authorize, MeterValues split billing) and the worker
// (tariff boundary job).

import type postgres from 'postgres';
import {
  buildOcppKindTariff,
  buildOcppTariff,
  chargingKindsOf,
  createLogger,
  isOcpp21,
  publishOcppCommand,
} from '@evtivity/lib';
import type {
  ChargingKind,
  OcppTariff,
  OcppTariffStationSupport,
  PubSubClient,
} from '@evtivity/lib';
import { loadStationEvseKinds } from './charging-kind.js';
import { getIdlingGracePeriodMinutes } from './idling-setting.js';
import { isSplitBillingEnabled } from './pricing-settings.js';
import { getCompanyCurrency, getCompanyTaxBasis } from './system-settings.js';
import { getPricingHolidays, resolveStationPricing } from './tariff-resolution.js';
import type { GroupTariff, StationTariff } from './tariff-resolution.js';

const logger = createLogger('ocpp-session-tariff');

/** What a station reported about local cost calculation (TariffCostCtrlr, device model). */
export interface StationTariffCapabilities extends OcppTariffStationSupport {
  /**
   * TariffCostCtrlr.Enabled[Tariff] reported true: the station calculates the
   * cost from a TariffType. Unreported counts as no (the station would answer
   * ChangeTransactionTariff with CALLERROR NotSupported, I11.FR.01).
   */
  localCost: boolean;
}

function isTrue(value: string | null | undefined): boolean {
  return value != null && value.trim().toLowerCase() === 'true';
}

/**
 * The station's TariffCostCtrlr variables (Actual, station-wide), as
 * NotifyReport, GetVariables or GetBaseReport stored them. The variable
 * instance is `Tariff`; a station that reports the variable without an
 * instance counts too.
 */
export async function stationTariffCapabilities(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<StationTariffCapabilities> {
  const rows = await sql<
    Array<{ variable: string; variable_instance: string | null; value: string | null }>
  >`
    SELECT variable, variable_instance, value FROM station_configurations
    WHERE station_id = ${stationUuid}
      AND component = 'TariffCostCtrlr'
      AND attribute_type = 'Actual'
      AND evse_id IS NULL
      AND variable IN ('Enabled', 'ConditionsSupported', 'MaxElements')
      AND (variable_instance IS NULL OR variable_instance = 'Tariff')
    ORDER BY variable_instance NULLS LAST
  `;
  const value = (variable: string): string | null | undefined =>
    rows.find((r) => r.variable === variable)?.value;
  const conditions = value('ConditionsSupported');
  const maxElements = Number(value('MaxElements'));
  return {
    localCost: isTrue(value('Enabled')),
    conditions: conditions == null || conditions.trim().toLowerCase() !== 'false',
    maxElements: Number.isInteger(maxElements) && maxElements > 0 ? maxElements : null,
  };
}

export interface StationTariffQuery {
  stationUuid: string;
  driverUuid: string | null;
  /** When the tariff applies (default now). */
  at?: Date;
  /** The session's energy so far, for an energy-threshold tariff (default 0). */
  sessionEnergyKwh?: number;
  /** The session's charging kind; null or omitted: not known (the Both tariffs). */
  chargingKind?: ChargingKind | null;
  /** The station's capabilities, when the caller read them already. */
  capabilities?: StationTariffCapabilities;
}

/**
 * The TariffType for the driver at the station: the tariff the resolver picks
 * (the one the session is billed with), with the idle grace as minIdleTime
 * and the reservation fee as reservationTime. With split billing on, the
 * other tariffs of its pricing group come along as conditioned elements, as
 * the CSMS moves the session between them (see buildOcppTariff). Null when no
 * tariff applies.
 */
export async function buildStationOcppTariff(
  sql: postgres.Sql,
  q: StationTariffQuery,
): Promise<OcppTariff | null> {
  const at = q.at ?? new Date();
  const [priced, env] = await Promise.all([
    resolveKind(sql, q, at, q.chargingKind ?? null),
    tariffEnvironment(sql, q),
  ]);
  if (priced == null) return null;
  return buildOcppTariff({
    current: priced.current,
    groupTariffs: env.splitBilling ? priced.groupTariffs : [],
    graceMinutes: env.graceMinutes,
    holidays: env.holidays,
    at,
    // The site's timezone, else system.timezone (resolved with the tariff, B22).
    timezone: priced.current.timezone,
    currency: env.currency,
    taxBasis: env.taxBasis,
    support: env.capabilities,
  });
}

async function resolveKind(
  sql: postgres.Sql,
  q: StationTariffQuery,
  at: Date,
  chargingKind: ChargingKind | null,
): Promise<{ current: StationTariff; groupTariffs: GroupTariff[] } | null> {
  const resolved = await resolveStationPricing(
    {
      stationUuid: q.stationUuid,
      driverUuid: q.driverUuid,
      at,
      chargingKind,
      ...(q.sessionEnergyKwh != null ? { sessionEnergyKwh: q.sessionEnergyKwh } : {}),
    },
    sql,
  );
  return resolved == null
    ? null
    : { current: resolved.tariff, groupTariffs: resolved.groupTariffs };
}

async function tariffEnvironment(sql: postgres.Sql, q: StationTariffQuery) {
  const [capabilities, splitBilling, graceMinutes, holidays, currency, taxBasis] =
    await Promise.all([
      q.capabilities ?? stationTariffCapabilities(sql, q.stationUuid),
      isSplitBillingEnabled(),
      getIdlingGracePeriodMinutes(),
      getPricingHolidays(sql),
      getCompanyCurrency(),
      getCompanyTaxBasis(),
    ]);
  return { capabilities, splitBilling, graceMinutes, holidays, currency, taxBasis };
}

/**
 * The AuthorizeResponse tariff (I08), before the EVSE is known. A station
 * whose EVSEs are all AC or all DC gets the tariff of that kind. A station
 * with AC and DC EVSEs (or a mixed EVSE) whose AC and DC tariffs differ
 * (owner decision D-D) gets AC and DC elements with `evseKind` and the Both
 * tariff as the fallback when it supports conditions; otherwise null (no
 * tariff in AuthorizeResponse), and the session's tariff follows with
 * ChangeTransactionTariff after TransactionEvent Started
 * (sendStartedTariffChange).
 */
export async function buildStationAuthorizeTariff(
  sql: postgres.Sql,
  q: Omit<StationTariffQuery, 'chargingKind' | 'sessionEnergyKwh'>,
): Promise<OcppTariff | null> {
  const kinds = chargingKindsOf([...(await loadStationEvseKinds(sql, q.stationUuid)).values()]);
  if (kinds.length < 2) {
    return buildStationOcppTariff(sql, { ...q, chargingKind: kinds[0] ?? null });
  }
  const at = q.at ?? new Date();
  const [ac, dc, both, env] = await Promise.all([
    resolveKind(sql, q, at, 'ac'),
    resolveKind(sql, q, at, 'dc'),
    resolveKind(sql, q, at, null),
    tariffEnvironment(sql, q),
  ]);
  if (ac == null || dc == null || both == null) return null;
  const common = {
    graceMinutes: env.graceMinutes,
    holidays: env.holidays,
    at,
    timezone: both.current.timezone,
    currency: env.currency,
    taxBasis: env.taxBasis,
    support: env.capabilities,
  };
  const forKind = (k: { current: StationTariff; groupTariffs: GroupTariff[] }) => ({
    current: k.current,
    groupTariffs: env.splitBilling ? k.groupTariffs : [],
  });
  const acTariff = buildOcppTariff({ ...common, ...forKind(ac) });
  const dcTariff = buildOcppTariff({ ...common, ...forKind(dc) });
  if (acTariff.tariffId === dcTariff.tariffId) return acTariff;
  return buildOcppKindTariff({
    ...common,
    ac: forKind(ac),
    dc: forKind(dc),
    fallback: both.current,
  });
}

/**
 * True when the station has AC and DC EVSEs (or a mixed one): its Authorize
 * tariff could not name the session's kind, so the session's own tariff goes
 * with ChangeTransactionTariff after Started.
 */
export async function stationHasSeveralKinds(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<boolean> {
  const kinds = chargingKindsOf([...(await loadStationEvseKinds(sql, stationUuid)).values()]);
  return kinds.length > 1;
}

export type TariffChangeOutcome = 'sent' | 'unchanged' | 'skipped' | 'failed';

/**
 * After the CSMS switched a session's tariff segment: sends the station a
 * ChangeTransactionTariff with the tariff that applies from now (I11), when
 * the session runs on an online OCPP 2.1 station that calculates the cost
 * locally and the tariff differs from the one the station reported for the
 * transaction (`charging_sessions.station_tariff_id`, I08.FR.22, I11.FR.07).
 * A station that got the group's conditioned tariff already moves to the new
 * window by itself (I11 remarks), so its tariff id is unchanged and nothing
 * is sent. Fire and forget: the CSMS bills from the segments either way, so a
 * failure is logged and the session goes on (P9).
 */
export async function sendSessionTariffChange(
  sql: postgres.Sql,
  pubsub: PubSubClient,
  q: { sessionId: string; at: Date; energyWh: number },
): Promise<TariffChangeOutcome> {
  try {
    const [session] = await sql<
      Array<{
        transaction_id: string | null;
        station_uuid: string;
        driver_id: string | null;
        charging_kind: string | null;
        station_tariff_id: string | null;
        status: string;
        ocpp_id: string;
        ocpp_protocol: string | null;
        is_online: boolean | null;
      }>
    >`
      SELECT cs.transaction_id, cs.station_id AS station_uuid, cs.driver_id, cs.charging_kind,
             cs.station_tariff_id, cs.status, st.station_id AS ocpp_id,
             st.ocpp_protocol, st.is_online
      FROM charging_sessions cs
      JOIN charging_stations st ON st.id = cs.station_id
      WHERE cs.id = ${q.sessionId}
    `;
    if (
      session == null ||
      session.status !== 'active' ||
      session.transaction_id == null ||
      !isOcpp21(session.ocpp_protocol) ||
      session.is_online !== true
    ) {
      return 'skipped';
    }
    const capabilities = await stationTariffCapabilities(sql, session.station_uuid);
    if (!capabilities.localCost) return 'skipped';
    const tariff = await buildStationOcppTariff(sql, {
      stationUuid: session.station_uuid,
      driverUuid: session.driver_id,
      at: q.at,
      sessionEnergyKwh: q.energyWh / 1000,
      chargingKind:
        session.charging_kind === 'ac' || session.charging_kind === 'dc'
          ? session.charging_kind
          : null,
      capabilities,
    });
    if (tariff == null) return 'skipped';
    if (tariff.tariffId === session.station_tariff_id) return 'unchanged';
    await publishOcppCommand(pubsub, {
      stationId: session.ocpp_id,
      action: 'ChangeTransactionTariff',
      payload: { transactionId: session.transaction_id, tariff },
      version: 'ocpp2.1',
    });
    logger.info(
      { sessionId: q.sessionId, tariffId: tariff.tariffId },
      'ChangeTransactionTariff sent at the tariff boundary',
    );
    return 'sent';
  } catch (err) {
    logger.warn(
      { err, sessionId: q.sessionId },
      'ChangeTransactionTariff at the tariff boundary failed; billing is unchanged',
    );
    return 'failed';
  }
}
