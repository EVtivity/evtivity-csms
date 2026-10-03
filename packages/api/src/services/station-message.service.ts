// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, gt, inArray, desc, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import {
  db,
  client,
  chargingStations,
  evses,
  connectors,
  reservations,
  drivers,
  chargingSessions,
  meterValues,
  stationMessagePushes,
  getStationMessagePricingFormat,
  getStationMessageLanguage,
  isStationMessageEnabled,
  getCompanyCurrency,
  getCompanyPriceDisplay,
  getCompanyTaxBasis,
  resolveStationTariff,
} from '@evtivity/database';
import {
  buildStationPriceContext,
  formatStationIdleFeeRate,
  formatStationQuantity,
  formatStationTime,
  renderStationMessage,
  stationTaxNoteContext,
  taxRateFraction,
  type StationMessageLanguage,
  type StationMessageState,
  type StationMessageContext,
  type Subscription,
  formatCurrencyAmount,
  resolveTaxBasis,
} from '@evtivity/lib';
import type { FastifyBaseLogger } from 'fastify';
import { getPubSub } from '../lib/pubsub.js';
import { sessionCurrencySql } from '../lib/company-currency.js';

const STATION_MESSAGE_REFRESH_CHANNEL = 'station_message_refresh';
const STATION_MESSAGE_TRANSACTION_CHANNEL = 'station_message_transaction';

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
  const commandId = crypto.randomUUID();

  if (ocppProtocol != null && ocppProtocol.startsWith('ocpp2')) {
    await pubsub.publish(
      'ocpp_commands',
      JSON.stringify({
        commandId,
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
      }),
    );
    return;
  }

  if (slot === STATION_MESSAGE_SLOT_IDLE) {
    await pubsub.publish(
      'ocpp_commands',
      JSON.stringify({
        commandId,
        stationId: stationOcppId,
        action: 'DataTransfer',
        payload: {
          vendorId: 'com.evtivity',
          messageId: 'PricingDisplay',
          data: JSON.stringify({ pricing: content }),
        },
        version: 'ocpp1.6',
      }),
    );
  }
}

export async function clearStationMessageSlot(
  stationOcppId: string,
  ocppProtocol: string | null,
  slot: number,
): Promise<void> {
  if (ocppProtocol == null || !ocppProtocol.startsWith('ocpp2')) return;

  const pubsub = getPubSub();
  const commandId = crypto.randomUUID();
  await pubsub.publish(
    'ocpp_commands',
    JSON.stringify({
      commandId,
      stationId: stationOcppId,
      action: 'ClearDisplayMessage',
      payload: { id: slot },
      version: ocppProtocol,
    }),
  );
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function getCompanySettings(): Promise<{ companyName: string; supportPhone: string }> {
  const rows = await client`
    SELECT key, value FROM settings
    WHERE key IN ('company.name', 'company.supportPhone')
  `;
  let companyName = 'EVtivity';
  let supportPhone = '';
  for (const row of rows) {
    const key = row['key'] as string;
    const value: unknown = row['value'];
    if (key === 'company.name' && typeof value === 'string') companyName = value;
    if (key === 'company.supportPhone' && typeof value === 'string') supportPhone = value;
  }
  return { companyName, supportPhone };
}

async function dispatchAndUpsert(
  internalStationId: string,
  stationOcppId: string,
  ocppProtocol: string,
  slot: number,
  state: DispatchState,
  templateState: StationMessageState,
  content: string,
  log: FastifyBaseLogger,
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
      })
      .from(reservations)
      .leftJoin(drivers, eq(reservations.driverId, drivers.id))
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
      result.reservationExpiresAt = formatStationTime(reservation.expiresAt, language);
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
  log: FastifyBaseLogger,
): Promise<void> {
  if (ocppProtocol == null || !ocppProtocol.startsWith('ocpp2')) return;

  const enabled = await isStationMessageEnabled();
  if (!enabled) return;

  const [station] = await db
    .select({
      id: chargingStations.id,
      stationOcppId: chargingStations.stationId,
      siteId: chargingStations.siteId,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, internalStationId))
    .limit(1);

  if (station == null) return;

  const language = await getStationMessageLanguage();
  const [
    { companyName, supportPhone },
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

export async function startStationMessageRefreshListener(
  log: FastifyBaseLogger,
): Promise<Subscription> {
  const pubsub = getPubSub();
  return pubsub.subscribe(STATION_MESSAGE_REFRESH_CHANNEL, (raw: string) => {
    void (async () => {
      try {
        const parsed = JSON.parse(raw) as {
          stationOcppId?: string;
          internalStationId?: string;
          ocppProtocol?: string;
        };
        if (
          parsed.stationOcppId == null ||
          parsed.internalStationId == null ||
          parsed.ocppProtocol == null
        ) {
          return;
        }
        const { stationOcppId, internalStationId, ocppProtocol } = parsed;
        await runStationRender(internalStationId, () =>
          pushAllStationMessages(stationOcppId, internalStationId, ocppProtocol, log),
        );
      } catch (err: unknown) {
        log.warn({ error: err }, 'station_message_refresh handler failed');
      }
    })();
  });
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

function formatElapsed(startedAt: Date | string | null): string {
  if (startedAt == null) return '';
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const ms = Date.now() - start.getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes.toString()}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours.toString()}h ${mins.toString()}m`;
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
  log: FastifyBaseLogger,
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

  const [{ companyName, supportPhone }, powerKw, driverFirstName, language, priceDisplay] =
    await Promise.all([
      getCompanySettings(),
      getLatestPowerKw(sessionRow.id),
      getDriverFirstName(sessionRow.driverId),
      getStationMessageLanguage(),
      getCompanyPriceDisplay(),
    ]);

  // The session cost always includes tax. The idle fee rate is a unit price,
  // shown net or gross per company.priceDisplay at the session's tax rate.
  const costFormatted = formatCurrencyAmount(
    sessionRow.currentCostCents ?? 0,
    sessionRow.currency,
    language,
  );
  const elapsedFormatted = formatElapsed(sessionRow.startedAt);
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
  log: FastifyBaseLogger,
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
  };
}

interface TransactionEvent {
  sessionId?: string;
  internalStationId?: string;
  stationOcppId?: string;
  ocppProtocol?: string;
  eventType?: 'started' | 'updated' | 'ended';
  chargingState?: string | null;
}

export async function startStationMessageTransactionListener(
  log: FastifyBaseLogger,
): Promise<Subscription> {
  const pubsub = getPubSub();
  return pubsub.subscribe(STATION_MESSAGE_TRANSACTION_CHANNEL, (raw: string) => {
    void (async () => {
      try {
        const parsed = JSON.parse(raw) as TransactionEvent;
        if (
          parsed.sessionId == null ||
          parsed.internalStationId == null ||
          parsed.stationOcppId == null ||
          parsed.ocppProtocol == null ||
          parsed.eventType == null
        ) {
          return;
        }

        const { sessionId, internalStationId, stationOcppId, ocppProtocol } = parsed;
        await runStationRender(internalStationId, async () => {
          if (parsed.eventType === 'ended') {
            await clearAllTransactionMessages(internalStationId, stationOcppId, ocppProtocol, log);
            return;
          }

          const sessionRow = await loadTransactionSessionById(sessionId);
          if (sessionRow == null) return;

          // Without a chargingState in the event, keep the last state the station reported.
          if (parsed.chargingState != null) sessionRow.chargingState = parsed.chargingState;

          await pushTransactionMessage(
            internalStationId,
            stationOcppId,
            ocppProtocol,
            sessionRow,
            log,
          );
        });
      } catch (err: unknown) {
        log.warn({ error: err }, 'station_message_transaction handler failed');
      }
    })();
  });
}

export async function pushAllMessagesToAllStations(log: FastifyBaseLogger): Promise<void> {
  const onlineStations = await db
    .select({
      id: chargingStations.id,
      stationOcppId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(eq(chargingStations.isOnline, true));

  let pushed = 0;
  for (const station of onlineStations) {
    try {
      await pushAllStationMessages(station.stationOcppId, station.id, station.ocppProtocol, log);
      pushed++;
    } catch (err: unknown) {
      log.warn(
        { stationId: station.stationOcppId, error: err },
        'Failed to push station messages to station',
      );
    }
  }

  if (pushed > 0) {
    log.info({ pushed }, 'Station messages pushed to stations');
  }
}
