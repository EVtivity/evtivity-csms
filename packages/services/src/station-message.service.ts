// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, gt, inArray, desc, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import {
  db,
  client,
  chargingStations,
  sites,
  evses,
  connectors,
  reservations,
  drivers,
  chargingSessions,
  meterValues,
  stationMessagePushes,
  getStationMessagePricingFormat,
  getStationMessageLanguage,
  getStationMessageBrandLine,
  isStationMessageEnabled,
  getCompanyCurrency,
  getSystemTimezone,
  getCompanyPriceDisplay,
  getCompanyTaxBasis,
  resolveStationTariff,
} from '@evtivity/database';
import {
  buildStationPriceContext,
  formatStationElapsed,
  formatStationIdleFeeRate,
  formatStationQuantity,
  isStationMessageLanguage,
  formatStationTime,
  renderStationMessage,
  stationTaxNoteContext,
  taxRateFraction,
  type StationMessageLanguage,
  type StationMessageState,
  type StationMessageContext,
  formatCurrencyAmount,
  publishOcppCommand,
  resolveTaxBasis,
} from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { sessionCurrencySql } from './company-currency.js';

/** OCPP to worker: re-render the Idle, Faulted and Unavailable screens of a station. */
export const STATION_MESSAGE_REFRESH_CHANNEL = 'station_message_refresh';
/** OCPP and worker cron to worker: re-render the transaction screen of a session. */
export const STATION_MESSAGE_TRANSACTION_CHANNEL = 'station_message_transaction';
/** Worker bridge channel: re-render the station screens after a config change. */
export const STATION_MESSAGE_REPUSH_CHANNEL = 'station_message_repush';

/** Scope of a repush. At most one field; none means every online station. */
export interface StationMessageRepushJob {
  /** The stations of this site. */
  siteId?: string;
  /** One station (internal id). */
  stationId?: string;
  /** The stations whose tariff can come from this pricing group: assigned directly or through their site, or every station when it is the default group. */
  pricingGroupId?: string;
}

/** Runs one station's render; the worker wraps it in a cross-replica lock. */
export type StationRenderRunner = (
  internalStationId: string,
  render: () => Promise<void>,
) => Promise<void>;

export const STATION_MESSAGE_SLOT_IDLE = 9000;
export const STATION_MESSAGE_SLOT_CHARGING = 9001;
export const STATION_MESSAGE_SLOT_SUSPENDED = 9002;
export const STATION_MESSAGE_SLOT_DISCHARGING = 9003;
export const STATION_MESSAGE_SLOT_FAULTED = 9004;
export const STATION_MESSAGE_SLOT_UNAVAILABLE = 9005;

type DispatchState = 'Idle' | 'Charging' | 'Suspended' | 'Discharging' | 'Faulted' | 'Unavailable';

export async function pushStationMessageSlot(
  stationOcppId: string,
  ocppProtocol: string | null,
  slot: number,
  state: DispatchState,
  content: string,
): Promise<void> {
  const pubsub = getPubSub();

  if (ocppProtocol != null && ocppProtocol.startsWith('ocpp2')) {
    await publishOcppCommand(pubsub, {
      stationId: stationOcppId,
      action: 'SetDisplayMessage',
      payload: {
        message: {
          id: slot,
          priority: 'NormalCycle',
          state,
          message: { format: 'UTF8', content },
        },
      },
      version: ocppProtocol,
    });
    return;
  }

  if (slot === STATION_MESSAGE_SLOT_IDLE) {
    await publishOcppCommand(pubsub, {
      stationId: stationOcppId,
      action: 'DataTransfer',
      payload: {
        vendorId: 'com.evtivity',
        messageId: 'PricingDisplay',
        data: JSON.stringify({ pricing: content }),
      },
      version: 'ocpp1.6',
    });
  }
}

export async function clearStationMessageSlot(
  stationOcppId: string,
  ocppProtocol: string | null,
  slot: number,
): Promise<void> {
  if (ocppProtocol == null || !ocppProtocol.startsWith('ocpp2')) return;

  await publishOcppCommand(getPubSub(), {
    stationId: stationOcppId,
    action: 'ClearDisplayMessage',
    payload: { id: slot },
    version: ocppProtocol,
  });
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function getCompanySettings(): Promise<{
  companyName: string;
  supportPhone: string;
  brandLine: string;
}> {
  const [rows, brandLine] = await Promise.all([
    client`
      SELECT key, value FROM settings
      WHERE key IN ('company.name', 'company.supportPhone')
    `,
    getStationMessageBrandLine(),
  ]);
  let companyName = 'EVtivity';
  let supportPhone = '';
  for (const row of rows) {
    const key = row['key'] as string;
    const value: unknown = row['value'];
    if (key === 'company.name' && typeof value === 'string') companyName = value;
    if (key === 'company.supportPhone' && typeof value === 'string') supportPhone = value;
  }
  return { companyName, supportPhone, brandLine };
}

/**
 * Display language of a station: its site's `station_message_language`, else
 * the `stationMessage.language` setting.
 */
async function resolveDisplayLanguage(
  siteLanguage: string | null | undefined,
): Promise<StationMessageLanguage> {
  if (isStationMessageLanguage(siteLanguage)) return siteLanguage;
  return getStationMessageLanguage();
}

/** The site display language of a station, null when the site has none. */
async function getStationSiteLanguage(internalStationId: string): Promise<string | null> {
  const [row] = await db
    .select({ language: sites.stationMessageLanguage })
    .from(chargingStations)
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .where(eq(chargingStations.id, internalStationId))
    .limit(1);
  return row?.language ?? null;
}

function isOcpp2(ocppProtocol: string): boolean {
  return ocppProtocol.startsWith('ocpp2');
}

async function dispatchAndUpsert(
  internalStationId: string,
  stationOcppId: string,
  ocppProtocol: string,
  slot: number,
  state: DispatchState,
  templateState: StationMessageState,
  content: string,
  log: ServiceLogger,
): Promise<void> {
  if (content.length === 0) return;

  const contentHash = sha256Hex(content);

  const [existing] = await db
    .select({ contentHash: stationMessagePushes.contentHash })
    .from(stationMessagePushes)
    .where(
      and(
        eq(stationMessagePushes.stationId, internalStationId),
        eq(stationMessagePushes.ocppMessageId, slot),
      ),
    );

  if (existing != null && existing.contentHash === contentHash) {
    return;
  }

  await pushStationMessageSlot(stationOcppId, ocppProtocol, slot, state, content);

  await db
    .insert(stationMessagePushes)
    .values({
      stationId: internalStationId,
      state: templateState,
      ocppMessageId: slot,
      contentHash,
    })
    .onConflictDoUpdate({
      target: [stationMessagePushes.stationId, stationMessagePushes.ocppMessageId],
      set: {
        state: templateState,
        contentHash,
        pushedAt: new Date(),
      },
    });

  log.debug({ stationId: stationOcppId, slot, templateState }, 'Station message dispatched');
}

interface IdleResolution {
  state: 'available' | 'occupied' | 'reserved';
  driverFirstName?: string;
  reservationExpiresAt?: string;
}

async function resolveIdleState(
  internalStationId: string,
  language: StationMessageLanguage,
): Promise<IdleResolution> {
  const connectorRows = await db
    .select({ status: connectors.status })
    .from(connectors)
    .innerJoin(evses, eq(connectors.evseId, evses.id))
    .where(eq(evses.stationId, internalStationId));

  const statuses = connectorRows.map((r) => r.status);
  const isReserved = statuses.includes('reserved');
  const isOccupied = statuses.some((s) =>
    ['occupied', 'preparing', 'ev_connected', 'finishing'].includes(s),
  );

  if (isReserved) {
    const now = new Date();
    const [reservation] = await db
      .select({
        expiresAt: reservations.expiresAt,
        driverFirstName: drivers.firstName,
        siteTimezone: sites.timezone,
      })
      .from(reservations)
      .leftJoin(drivers, eq(reservations.driverId, drivers.id))
      .leftJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
      .leftJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(
        and(
          eq(reservations.stationId, internalStationId),
          inArray(reservations.status, ['active', 'in_use']),
          gt(reservations.expiresAt, now),
        ),
      )
      .limit(1);

    const result: IdleResolution = { state: 'reserved' };
    if (reservation?.driverFirstName != null) {
      result.driverFirstName = reservation.driverFirstName;
    }
    if (reservation?.expiresAt != null) {
      // Shown on the station display, so in the time zone of the station's site.
      const timezone = reservation.siteTimezone ?? (await getSystemTimezone());
      result.reservationExpiresAt = formatStationTime(reservation.expiresAt, language, timezone);
    }
    return result;
  }

  if (isOccupied) {
    const [activeSession] = await db
      .select({ id: chargingSessions.id })
      .from(chargingSessions)
      .where(
        and(
          eq(chargingSessions.stationId, internalStationId),
          eq(chargingSessions.status, 'active'),
        ),
      )
      .limit(1);

    if (activeSession == null) {
      return { state: 'occupied' };
    }
  }

  return { state: 'available' };
}

export async function pushAllStationMessages(
  stationOcppId: string,
  internalStationId: string,
  ocppProtocol: string | null,
  log: ServiceLogger,
): Promise<void> {
  // OCPP 1.6 has no SetDisplayMessage: it gets the Idle screen only, through
  // the vendor DataTransfer in pushStationMessageSlot.
  if (ocppProtocol == null || (!isOcpp2(ocppProtocol) && ocppProtocol !== 'ocpp1.6')) return;

  const enabled = await isStationMessageEnabled();
  if (!enabled) return;

  const [station] = await db
    .select({
      id: chargingStations.id,
      siteLanguage: sites.stationMessageLanguage,
    })
    .from(chargingStations)
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .where(eq(chargingStations.id, internalStationId))
    .limit(1);

  if (station == null) return;

  const language = await resolveDisplayLanguage(station.siteLanguage);
  const [
    { companyName, supportPhone, brandLine },
    pricingFormat,
    idle,
    currency,
    priceDisplay,
    taxBasis,
    tariff,
  ] = await Promise.all([
    getCompanySettings(),
    getStationMessagePricingFormat(),
    resolveIdleState(internalStationId, language),
    getCompanyCurrency(),
    getCompanyPriceDisplay(),
    getCompanyTaxBasis(),
    resolveStationTariff({ stationUuid: internalStationId, driverUuid: null }, client),
  ]);

  // Prices at the point of sale follow company.priceDisplay: gross adds the
  // tariff tax (EU Price Indication Directive 98/6/EC, PAngV).
  const baseCtx: StationMessageContext = {
    companyName,
    brandLine,
    stationOcppId,
    supportPhone,
    ...buildStationPriceContext({
      tariff,
      priceDisplay,
      taxBasis,
      pricingFormat,
      currency,
      language,
    }),
  };

  const idleCtx: StationMessageContext = { ...baseCtx };
  if (idle.driverFirstName != null) {
    idleCtx.driverFirstName = idle.driverFirstName;
  }
  if (idle.reservationExpiresAt != null) {
    idleCtx.reservationExpiresAt = idle.reservationExpiresAt;
  }

  try {
    const idleContent = await renderStationMessage(idle.state, idleCtx, language);
    await dispatchAndUpsert(
      internalStationId,
      stationOcppId,
      ocppProtocol,
      STATION_MESSAGE_SLOT_IDLE,
      'Idle',
      idle.state,
      idleContent,
      log,
    );

    if (!isOcpp2(ocppProtocol)) return;

    const faultedContent = await renderStationMessage('faulted', baseCtx, language);
    await dispatchAndUpsert(
      internalStationId,
      stationOcppId,
      ocppProtocol,
      STATION_MESSAGE_SLOT_FAULTED,
      'Faulted',
      'faulted',
      faultedContent,
      log,
    );

    const unavailableContent = await renderStationMessage('unavailable', baseCtx, language);
    await dispatchAndUpsert(
      internalStationId,
      stationOcppId,
      ocppProtocol,
      STATION_MESSAGE_SLOT_UNAVAILABLE,
      'Unavailable',
      'unavailable',
      unavailableContent,
      log,
    );
  } catch (err: unknown) {
    log.warn({ stationId: stationOcppId, error: err }, 'Failed to push station messages');
  }
}

// Renders for one station run one at a time. Two events close together (a
// TransactionEvent and its meter values) would otherwise both read the old
// content hash and send the same message twice.
const stationRenderQueues = new Map<string, Promise<void>>();

export function runStationRender(
  internalStationId: string,
  render: () => Promise<void>,
): Promise<void> {
  const previous = stationRenderQueues.get(internalStationId) ?? Promise.resolve();
  // A failed render is logged by its caller and must not block the next one.
  const next = previous.catch(() => undefined).then(render);
  stationRenderQueues.set(internalStationId, next);
  void next.then(
    () => {
      if (stationRenderQueues.get(internalStationId) === next) {
        stationRenderQueues.delete(internalStationId);
      }
    },
    () => {
      if (stationRenderQueues.get(internalStationId) === next) {
        stationRenderQueues.delete(internalStationId);
      }
    },
  );
  return next;
}

export interface TransactionSessionRow {
  id: string;
  stationId: string;
  evseId: string | null;
  driverId: string | null;
  transactionId: string;
  startedAt: Date | string | null;
  energyDeliveredWh: string | number | null;
  currentCostCents: number | null;
  currency: string;
  chargingState: string | null;
  tariffIdleFeePricePerMinute: string | number | null;
  taxBasis: string | null;
  tariffTaxRate: string | number | null;
  /** Session status; absent in callers that build the row by hand. */
  status?: string;
}

interface TransactionMapping {
  templateState: 'charging' | 'suspended' | 'discharging';
  slot: number;
  dispatchState: DispatchState;
}

function mapChargingState(chargingState: string | null): TransactionMapping | null {
  if (chargingState === 'Charging') {
    return {
      templateState: 'charging',
      slot: STATION_MESSAGE_SLOT_CHARGING,
      dispatchState: 'Charging',
    };
  }
  if (chargingState === 'SuspendedEV' || chargingState === 'SuspendedEVSE') {
    return {
      templateState: 'suspended',
      slot: STATION_MESSAGE_SLOT_SUSPENDED,
      dispatchState: 'Suspended',
    };
  }
  if (chargingState === 'Discharging') {
    return {
      templateState: 'discharging',
      slot: STATION_MESSAGE_SLOT_DISCHARGING,
      dispatchState: 'Discharging',
    };
  }
  return null;
}

async function getLatestPowerKw(sessionId: string): Promise<number | null> {
  const rows = await db
    .select({ value: meterValues.value, unit: meterValues.unit })
    .from(meterValues)
    .where(
      and(eq(meterValues.sessionId, sessionId), eq(meterValues.measurand, 'Power.Active.Import')),
    )
    .orderBy(desc(meterValues.timestamp))
    .limit(1);

  const row = rows[0];
  if (row == null) return null;
  let kw = Number(row.value);
  if (!Number.isFinite(kw)) return null;
  if (row.unit == null || row.unit === 'W') {
    kw = kw / 1000;
  }
  return kw;
}

async function getDriverFirstName(driverId: string | null): Promise<string | undefined> {
  if (driverId == null) return undefined;
  const [row] = await db
    .select({ firstName: drivers.firstName })
    .from(drivers)
    .where(eq(drivers.id, driverId))
    .limit(1);
  return row?.firstName ?? undefined;
}

export async function pushTransactionMessage(
  internalStationId: string,
  stationOcppId: string,
  ocppProtocol: string | null,
  sessionRow: TransactionSessionRow,
  log: ServiceLogger,
): Promise<void> {
  if (ocppProtocol == null || !ocppProtocol.startsWith('ocpp2')) return;

  const enabled = await isStationMessageEnabled();
  if (!enabled) return;

  const mapping = mapChargingState(sessionRow.chargingState);

  // Always inspect the existing slot rows so we can clear stale ones when the
  // charging state transitions out of Suspended/Discharging back to Charging
  // (or to a non-transaction state like Idle / EVConnected).
  const transactionSlots = [
    STATION_MESSAGE_SLOT_CHARGING,
    STATION_MESSAGE_SLOT_SUSPENDED,
    STATION_MESSAGE_SLOT_DISCHARGING,
  ];
  const existingPushes = await db
    .select({
      ocppMessageId: stationMessagePushes.ocppMessageId,
      contentHash: stationMessagePushes.contentHash,
    })
    .from(stationMessagePushes)
    .where(
      and(
        eq(stationMessagePushes.stationId, internalStationId),
        inArray(stationMessagePushes.ocppMessageId, transactionSlots),
      ),
    );

  const existingBySlot = new Map<number, string>();
  for (const row of existingPushes) {
    existingBySlot.set(row.ocppMessageId, row.contentHash);
  }

  if (mapping == null) {
    // Idle / EVConnected / null -- no active transaction message; clear any
    // tracked transaction slots so the station falls back to slot 9000.
    for (const slot of transactionSlots) {
      if (existingBySlot.has(slot)) {
        try {
          await clearStationMessageSlot(stationOcppId, ocppProtocol, slot);
          await db
            .delete(stationMessagePushes)
            .where(
              and(
                eq(stationMessagePushes.stationId, internalStationId),
                eq(stationMessagePushes.ocppMessageId, slot),
              ),
            );
        } catch (err: unknown) {
          log.warn(
            { stationId: stationOcppId, slot, error: err },
            'Failed to clear stale transaction message slot',
          );
        }
      }
    }
    return;
  }

  const energyWh = sessionRow.energyDeliveredWh != null ? Number(sessionRow.energyDeliveredWh) : 0;

  const [
    { companyName, supportPhone, brandLine },
    powerKw,
    driverFirstName,
    siteLanguage,
    priceDisplay,
  ] = await Promise.all([
    getCompanySettings(),
    getLatestPowerKw(sessionRow.id),
    getDriverFirstName(sessionRow.driverId),
    getStationSiteLanguage(internalStationId),
    getCompanyPriceDisplay(),
  ]);
  const language = await resolveDisplayLanguage(siteLanguage);

  // The session cost always includes tax. The idle fee rate is a unit price,
  // shown net or gross per company.priceDisplay at the session's tax rate.
  const costFormatted = formatCurrencyAmount(
    sessionRow.currentCostCents ?? 0,
    sessionRow.currency,
    language,
  );
  const elapsedFormatted = formatStationElapsed(sessionRow.startedAt, language);
  const idleFeeRate = formatStationIdleFeeRate({
    pricePerMinute: sessionRow.tariffIdleFeePricePerMinute,
    taxRate: sessionRow.tariffTaxRate,
    priceDisplay,
    // The session's prices are in the basis it was priced in.
    taxBasis: resolveTaxBasis(sessionRow.taxBasis),
    currency: sessionRow.currency,
    language,
  });

  const ctx: StationMessageContext = {
    companyName,
    brandLine,
    stationOcppId,
    supportPhone,
    energyKwh: formatStationQuantity(energyWh / 1000, language),
    powerKw: powerKw == null ? '' : formatStationQuantity(powerKw, language),
    costFormatted,
    elapsedFormatted,
    ...stationTaxNoteContext(taxRateFraction(sessionRow.tariffTaxRate), priceDisplay, language),
  };
  if (idleFeeRate.length > 0) {
    ctx.idleFeeRate = idleFeeRate;
  }
  if (driverFirstName != null) {
    ctx.driverFirstName = driverFirstName;
  }

  let content: string;
  try {
    content = await renderStationMessage(mapping.templateState, ctx, language);
  } catch (err: unknown) {
    log.warn(
      { stationId: stationOcppId, templateState: mapping.templateState, error: err },
      'Failed to render transaction station message',
    );
    return;
  }

  if (content.length === 0) return;
  const contentHash = sha256Hex(content);

  if (existingBySlot.get(mapping.slot) !== contentHash) {
    try {
      await pushStationMessageSlot(
        stationOcppId,
        ocppProtocol,
        mapping.slot,
        mapping.dispatchState,
        content,
      );

      await db
        .insert(stationMessagePushes)
        .values({
          stationId: internalStationId,
          state: mapping.templateState,
          ocppMessageId: mapping.slot,
          contentHash,
        })
        .onConflictDoUpdate({
          target: [stationMessagePushes.stationId, stationMessagePushes.ocppMessageId],
          set: {
            state: mapping.templateState,
            contentHash,
            pushedAt: new Date(),
          },
        });

      log.debug(
        {
          stationId: stationOcppId,
          slot: mapping.slot,
          templateState: mapping.templateState,
          transactionId: sessionRow.transactionId,
        },
        'Transaction station message dispatched',
      );
    } catch (err: unknown) {
      log.warn(
        { stationId: stationOcppId, slot: mapping.slot, error: err },
        'Failed to dispatch transaction station message',
      );
    }
  }

  // Clear any sibling transaction slots that aren't this one. When transitioning
  // Charging -> Suspended, slot 9001 must be cleared so the station's MessageState
  // can match Suspended's slot. Same logic applies for the reverse direction.
  for (const slot of transactionSlots) {
    if (slot === mapping.slot) continue;
    if (!existingBySlot.has(slot)) continue;
    try {
      await clearStationMessageSlot(stationOcppId, ocppProtocol, slot);
      await db
        .delete(stationMessagePushes)
        .where(
          and(
            eq(stationMessagePushes.stationId, internalStationId),
            eq(stationMessagePushes.ocppMessageId, slot),
          ),
        );
    } catch (err: unknown) {
      log.warn(
        { stationId: stationOcppId, slot, error: err },
        'Failed to clear stale transaction message slot',
      );
    }
  }
}

export async function clearAllTransactionMessages(
  internalStationId: string,
  stationOcppId: string,
  ocppProtocol: string | null,
  log: ServiceLogger,
): Promise<void> {
  if (ocppProtocol == null || !ocppProtocol.startsWith('ocpp2')) return;

  const transactionSlots = [
    STATION_MESSAGE_SLOT_CHARGING,
    STATION_MESSAGE_SLOT_SUSPENDED,
    STATION_MESSAGE_SLOT_DISCHARGING,
  ];

  const existingPushes = await db
    .select({ ocppMessageId: stationMessagePushes.ocppMessageId })
    .from(stationMessagePushes)
    .where(
      and(
        eq(stationMessagePushes.stationId, internalStationId),
        inArray(stationMessagePushes.ocppMessageId, transactionSlots),
      ),
    );

  for (const row of existingPushes) {
    try {
      await clearStationMessageSlot(stationOcppId, ocppProtocol, row.ocppMessageId);
      await db
        .delete(stationMessagePushes)
        .where(
          and(
            eq(stationMessagePushes.stationId, internalStationId),
            eq(stationMessagePushes.ocppMessageId, row.ocppMessageId),
          ),
        );
    } catch (err: unknown) {
      log.warn(
        { stationId: stationOcppId, slot: row.ocppMessageId, error: err },
        'Failed to clear transaction message slot on session end',
      );
    }
  }
}

export async function loadTransactionSessionById(
  sessionId: string,
): Promise<TransactionSessionRow | null> {
  const [row] = await db
    .select({
      id: chargingSessions.id,
      stationId: chargingSessions.stationId,
      evseId: chargingSessions.evseId,
      driverId: chargingSessions.driverId,
      transactionId: chargingSessions.transactionId,
      startedAt: chargingSessions.startedAt,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      currentCostCents: chargingSessions.currentCostCents,
      currency: sessionCurrencySql(),
      tariffIdleFeePricePerMinute: chargingSessions.tariffIdleFeePricePerMinute,
      taxBasis: chargingSessions.taxBasis,
      tariffTaxRate: chargingSessions.tariffTaxRate,
      status: chargingSessions.status,
      // A station sends chargingState only when it changes, so the state is the
      // one in the latest stored TransactionEvent that carried it.
      chargingState: sql<string | null>`(
        SELECT te.payload->>'chargingState' FROM transaction_events te
        WHERE te.session_id = charging_sessions.id
          AND te.payload->>'chargingState' IS NOT NULL
        ORDER BY te.seq_no DESC, te.id DESC
        LIMIT 1
      )`,
    })
    .from(chargingSessions)
    .where(eq(chargingSessions.id, sessionId))
    .limit(1);

  if (row == null) return null;

  return {
    id: row.id,
    stationId: row.stationId,
    evseId: row.evseId,
    driverId: row.driverId,
    transactionId: row.transactionId,
    startedAt: row.startedAt,
    energyDeliveredWh: row.energyDeliveredWh,
    currentCostCents: row.currentCostCents,
    currency: row.currency,
    chargingState: row.chargingState,
    tariffIdleFeePricePerMinute: row.tariffIdleFeePricePerMinute,
    taxBasis: row.taxBasis,
    tariffTaxRate: row.tariffTaxRate,
    status: row.status,
  };
}

export interface StationRefreshJob {
  stationOcppId: string;
  internalStationId: string;
  ocppProtocol: string;
}

export interface StationTransactionJob {
  sessionId: string;
  internalStationId: string;
  stationOcppId: string;
  ocppProtocol: string;
  eventType: 'started' | 'updated' | 'ended';
  chargingState?: string | null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field !== '' ? field : null;
}

/** Validates a station_message_refresh payload. Null when malformed. */
export function parseStationRefreshPayload(raw: string): StationRefreshJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed == null) return null;
  const value = parsed as Record<string, unknown>;
  const stationOcppId = stringField(value, 'stationOcppId');
  const internalStationId = stringField(value, 'internalStationId');
  const ocppProtocol = stringField(value, 'ocppProtocol');
  if (stationOcppId == null || internalStationId == null || ocppProtocol == null) return null;
  return { stationOcppId, internalStationId, ocppProtocol };
}

/** Validates a station_message_transaction payload. Null when malformed. */
export function parseStationTransactionPayload(raw: string): StationTransactionJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed == null) return null;
  const value = parsed as Record<string, unknown>;
  const sessionId = stringField(value, 'sessionId');
  const internalStationId = stringField(value, 'internalStationId');
  const stationOcppId = stringField(value, 'stationOcppId');
  const ocppProtocol = stringField(value, 'ocppProtocol');
  const eventType = value['eventType'];
  if (
    sessionId == null ||
    internalStationId == null ||
    stationOcppId == null ||
    ocppProtocol == null ||
    (eventType !== 'started' && eventType !== 'updated' && eventType !== 'ended')
  ) {
    return null;
  }
  const chargingState = value['chargingState'];
  return {
    sessionId,
    internalStationId,
    stationOcppId,
    ocppProtocol,
    eventType,
    chargingState: typeof chargingState === 'string' ? chargingState : null,
  };
}

/** Re-renders the Idle, Faulted and Unavailable screens of one station. */
export async function runStationRefresh(
  job: StationRefreshJob,
  log: ServiceLogger,
  render: StationRenderRunner = runStationRender,
): Promise<void> {
  await render(job.internalStationId, () =>
    pushAllStationMessages(job.stationOcppId, job.internalStationId, job.ocppProtocol, log),
  );
}

/**
 * Re-renders the transaction screen of a session. An ended event, or a
 * session that is no longer active (a debounced job can run after the
 * session ended), clears the transaction slots instead.
 */
export async function runStationTransaction(
  job: StationTransactionJob,
  log: ServiceLogger,
  render: StationRenderRunner = runStationRender,
): Promise<void> {
  const { sessionId, internalStationId, stationOcppId, ocppProtocol } = job;
  await render(internalStationId, async () => {
    if (job.eventType === 'ended') {
      await clearAllTransactionMessages(internalStationId, stationOcppId, ocppProtocol, log);
      return;
    }

    const sessionRow = await loadTransactionSessionById(sessionId);
    if (sessionRow == null) return;
    if (sessionRow.status != null && sessionRow.status !== 'active') {
      await clearAllTransactionMessages(internalStationId, stationOcppId, ocppProtocol, log);
      return;
    }

    // Without a chargingState in the event, keep the last state the station reported.
    if (job.chargingState != null) sessionRow.chargingState = job.chargingState;

    await pushTransactionMessage(internalStationId, stationOcppId, ocppProtocol, sessionRow, log);
  });
}

/**
 * Re-renders the Idle, Faulted and Unavailable screens of every online station
 * (or of one site's stations). The content hash skips stations whose screen
 * did not change.
 */
export async function pushAllMessagesToAllStations(
  log: ServiceLogger,
  options: StationMessageRepushJob = {},
  render: StationRenderRunner = runStationRender,
): Promise<void> {
  const conditions = [eq(chargingStations.isOnline, true)];
  if (options.siteId != null) conditions.push(eq(chargingStations.siteId, options.siteId));
  if (options.stationId != null) conditions.push(eq(chargingStations.id, options.stationId));
  if (options.pricingGroupId != null) {
    conditions.push(sql`(
      EXISTS (
        SELECT 1 FROM pricing_groups pg
        WHERE pg.id = ${options.pricingGroupId} AND pg.is_default
      )
      OR EXISTS (
        SELECT 1 FROM pricing_group_stations pgs
        WHERE pgs.pricing_group_id = ${options.pricingGroupId}
          AND pgs.station_id = ${chargingStations.id}
      )
      OR EXISTS (
        SELECT 1 FROM pricing_group_sites pgsi
        WHERE pgsi.pricing_group_id = ${options.pricingGroupId}
          AND pgsi.site_id = ${chargingStations.siteId}
      )
    )`);
  }
  const onlineStations = await db
    .select({
      id: chargingStations.id,
      stationOcppId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(and(...conditions));

  let pushed = 0;
  for (const station of onlineStations) {
    try {
      await render(station.id, () =>
        pushAllStationMessages(station.stationOcppId, station.id, station.ocppProtocol, log),
      );
      pushed++;
    } catch (err: unknown) {
      log.warn(
        { stationId: station.stationOcppId, error: err },
        'Failed to push station messages to station',
      );
    }
  }

  if (pushed > 0) {
    log.info({ pushed, ...options }, 'Station messages pushed to stations');
  }
}

/**
 * Asks every process to drop its station message caches and the worker to
 * re-render the station screens (all online stations, or a scope). Called
 * after a change to a setting, a state template, a site display language, a
 * station's site, or pricing.
 * Fail-open: a lost publish leaves the screens to the next event or cron tick.
 */
export async function requestStationMessageRepush(
  log: ServiceLogger,
  job: StationMessageRepushJob = {},
): Promise<void> {
  const pubsub = getPubSub();
  try {
    await pubsub.publish('cache_invalidate', JSON.stringify({ kind: 'station_message' }));
    await pubsub.publish(STATION_MESSAGE_REPUSH_CHANNEL, JSON.stringify(job));
  } catch (err: unknown) {
    log.warn({ error: err, ...job }, 'Station message repush request failed');
  }
}
