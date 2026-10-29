// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The payment terminal flow (features/payment-terminals.md), shared by the API
// (operator start, webhooks) and the worker (events, reconciliation): start a
// card payment on a paired terminal, start charging once the card is
// authorized (C24.FR.01 through the ad hoc payment path), release the hold
// when charging cannot start, settle at the end (C24.FR.10) and show the
// prompts and the receipt link (C24.FR.11) on the terminal screen or, for a
// reader without one (VP7200), on the station display.

import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  chargingStations,
  claimTerminalOfflineAlerts,
  client,
  db,
  evses,
  getCompanyCurrency,
  guestSessions,
  paymentTerminals,
  type PaymentTerminal,
} from '@evtivity/database';
import {
  dispatchOneShotStationMessage,
  dispatchSystemNotification,
  formatCurrencyAmount,
  PAYMENT_TERMINAL_OFFLINE_ALERT_MINUTES,
  renderStationMessage,
  terminalModelHasDisplay,
  type ServiceLogger,
  type StationMessageContext,
  type StationMessageState,
} from '@evtivity/lib';
import {
  claimTerminalStart,
  handleGuestSessionEvent,
  ingestTerminalWebhook,
  reconcileTerminalTransactions,
  linkTerminalGuestSession,
  settleTerminalSession,
  startTerminalPayment,
  terminalRegistry,
  voidTerminalTransaction,
  withPaymentActor,
  type AppliedTerminalEvent,
  type AppliedTerminalResult,
  type PaymentContext,
  type StartTerminalPaymentOutcome,
  type TerminalEventJob,
  type TerminalReconcileResult,
  type TerminalSettlementOutcome,
  type TerminalTransaction,
} from '@evtivity/payments';
import {
  isTerminalProviderId,
  SIMULATED_SIGNATURE_HEADER,
  type TerminalDisplayMessage,
} from '@evtivity/payment-terminals';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { startAdHocPayment } from './ad-hoc-payment.service.js';
import { terminalStartEvse } from './payment-terminal-evse.js';
import { syncPaymentTerminalDevice } from './payment-terminal.service.js';

export interface TerminalFlowDeps {
  payments: PaymentContext;
  logger: ServiceLogger;
  /** PORTAL_URL: the receipt link is the portal's guest session page. */
  portalUrl: string;
}

const FLOW_ACTOR = { actor: 'system' as const, actorLabel: 'payment-terminal' };

interface TerminalPlace {
  terminal: PaymentTerminal;
  stationOcppId: string;
  stationDbId: string;
  /** OCPP EVSE ids of the station's connectors in service. */
  stationEvses: number[];
  /** The OCPP EVSE id of the paired connector, or null for a station-wide terminal. */
  pairedEvse: number | null;
}

async function placeOf(terminalId: string): Promise<TerminalPlace | null> {
  const [terminal] = await db
    .select()
    .from(paymentTerminals)
    .where(eq(paymentTerminals.id, terminalId));
  if (terminal?.stationId == null) return null;
  const [station] = await db
    .select({ id: chargingStations.id, stationId: chargingStations.stationId })
    .from(chargingStations)
    .where(eq(chargingStations.id, terminal.stationId));
  if (station == null) return null;
  const rows = await db
    .select({ id: evses.id, evseId: evses.evseId })
    .from(evses)
    .where(and(eq(evses.stationId, station.id), isNull(evses.retiredAt)))
    .orderBy(asc(evses.evseId));
  const paired = terminal.evseId != null ? rows.find((r) => r.id === terminal.evseId) : undefined;
  return {
    terminal,
    stationOcppId: station.stationId,
    stationDbId: station.id,
    stationEvses: rows.map((r) => r.evseId),
    pairedEvse: paired?.evseId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Shows a prompt: on the terminal's own screen when the model has one and the
 * provider can show it (VP6825), else on the station display through the
 * station message templates (VP7200, owner decision 11). Fail-open (P9).
 */
export async function showTerminalPrompt(
  place: Pick<TerminalPlace, 'terminal' | 'stationOcppId' | 'stationDbId'>,
  state: Extract<StationMessageState, 'terminal_card' | 'terminal_result' | 'terminal_receipt'>,
  context: Omit<StationMessageContext, 'companyName' | 'stationOcppId'>,
  deps: TerminalFlowDeps,
): Promise<void> {
  try {
    const full: StationMessageContext = {
      companyName: '',
      stationOcppId: place.stationOcppId,
      ...context,
    };
    const providerId = place.terminal.provider;
    if (terminalModelHasDisplay(place.terminal.model) && isTerminalProviderId(providerId)) {
      const provider = await terminalRegistry(deps.payments).getProvider(providerId);
      if (provider?.capabilities.display === true && place.terminal.providerDeviceId != null) {
        const message: TerminalDisplayMessage = {
          kind:
            state === 'terminal_card'
              ? 'present_card'
              : state === 'terminal_result'
                ? 'result'
                : 'receipt',
          text: await renderStationMessage(state, full),
          ...(context.receiptUrl != null ? { qrUrl: context.receiptUrl } : {}),
        };
        await provider.displayMessage(place.terminal.providerDeviceId, message);
        return;
      }
    }
    await dispatchOneShotStationMessage(
      getPubSub(),
      client,
      { stationOcppId: place.stationOcppId, stationDbId: place.stationDbId, state, context: full },
      { ttlSeconds: state === 'terminal_receipt' ? 120 : 60 },
    );
  } catch (err: unknown) {
    deps.logger.warn(
      { err, paymentTerminalId: place.terminal.id, state },
      'Terminal prompt not shown',
    );
  }
}

async function money(cents: number): Promise<string> {
  return formatCurrencyAmount(cents, await getCompanyCurrency());
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type StartTerminalFlowOutcome =
  | StartTerminalPaymentOutcome
  | { kind: 'charging_started'; transaction: TerminalTransaction }
  | { kind: 'charging_not_started'; transaction: TerminalTransaction; code: string };

/**
 * Starts a card payment on a terminal (operator test payment, or a driver at
 * the terminal through a provider that waits for a CSMS request) and, when
 * the card is authorized at once, starts charging. A station-wide terminal
 * offers the station's connectors on its screen; a paired one the one EVSE.
 */
export async function startTerminalPaymentFlow(
  terminalId: string,
  input: { amountCents?: number; receiptEmail?: string | null },
  deps: TerminalFlowDeps,
): Promise<StartTerminalFlowOutcome> {
  const place = await placeOf(terminalId);
  let evseNumber: number | null = null;
  let evseChoices: readonly number[] = [];
  if (place != null) {
    const single = place.pairedEvse == null && place.stationEvses.length === 1;
    evseNumber = place.pairedEvse ?? (single ? (place.stationEvses[0] ?? null) : null);
    evseChoices = place.pairedEvse == null && !single ? place.stationEvses : [];
  }
  const outcome = await startTerminalPayment(
    {
      terminalId,
      ...(input.amountCents != null ? { amountCents: input.amountCents } : {}),
      receiptEmail: input.receiptEmail ?? null,
      evseChoices,
      evseNumber,
    },
    deps.payments,
  );
  if (outcome.kind !== 'started' || place == null) return outcome;
  const txn = outcome.transaction;
  if (txn.state === 'presenting' || txn.state === 'requested') {
    await showTerminalPrompt(
      place,
      'terminal_card',
      { terminalAmount: await money(txn.requestedCents) },
      deps,
    );
    return outcome;
  }
  if (txn.state === 'authorized') {
    return startChargingForTerminal(txn, deps);
  }
  if (txn.state === 'declined' || txn.state === 'failed') {
    await showTerminalPrompt(place, 'terminal_result', { paymentApproved: false }, deps);
  }
  return outcome;
}

/**
 * Starts charging for an authorized hold (C24.FR.01): claims the start once,
 * then the ad hoc payment path stores the guest session (CSMS token) and
 * sends RequestStartTransaction with the authorized amount as the limit. The
 * EVSE is the paired one, the one the driver picked on the terminal screen,
 * the station's only one, else 0 (the station starts on the connector the
 * driver plugs in). A start that fails releases the hold at once.
 */
export async function startChargingForTerminal(
  authorized: TerminalTransaction,
  deps: TerminalFlowDeps,
): Promise<StartTerminalFlowOutcome> {
  const txn = await claimTerminalStart(authorized.id);
  if (txn?.providerTxnRef == null || txn.authorizedCents == null) {
    return { kind: 'started', transaction: authorized };
  }
  const place = await placeOf(txn.paymentTerminalId);
  if (place == null || place.terminal.stationId !== txn.stationId) {
    await voidTerminalTransaction(txn.id, 'terminal_unpaired', deps.payments);
    return { kind: 'charging_not_started', transaction: txn, code: 'PAYMENT_TERMINAL_NOT_PAIRED' };
  }
  const evseId = terminalStartEvse(place.pairedEvse, txn.evseNumber, place.stationEvses);
  const result = await startAdHocPayment(
    {
      stationId: place.stationOcppId,
      evseId,
      pspRef: txn.providerTxnRef,
      ...(txn.cardLast4 != null ? { cardLast4Digits: txn.cardLast4 } : {}),
      ...(txn.cardBin != null ? { cardBin: txn.cardBin } : {}),
      maxCostCents: txn.authorizedCents,
      ...(txn.receiptEmail != null ? { email: txn.receiptEmail } : {}),
    },
    {
      // The station comes from the stored pairing, never from the caller or
      // the provider event (a forged event cannot start another site's station).
      siteAllowed: () => true,
      actor: { ...FLOW_ACTOR, actorUserId: null, actorDriverId: null, actorApiKeyId: null },
      logger: deps.logger,
      terminalToken: true,
    },
  );
  if (!result.ok) {
    deps.logger.warn(
      { terminalTransactionId: txn.id, code: result.code },
      'Charging did not start for a terminal payment; releasing the hold',
    );
    await voidTerminalTransaction(txn.id, `start_${result.code.toLowerCase()}`, deps.payments);
    await showTerminalPrompt(place, 'terminal_result', { paymentApproved: false }, deps);
    return { kind: 'charging_not_started', transaction: txn, code: result.code };
  }
  await linkTerminalGuestSession(txn.id, result.guestSessionId, evseId);
  await showTerminalPrompt(
    place,
    'terminal_result',
    { paymentApproved: true, plugInAnyConnector: evseId === 0 },
    deps,
  );
  return {
    kind: 'charging_started',
    transaction: { ...txn, guestSessionId: result.guestSessionId },
  };
}

/**
 * Acts on applied provider results (webhooks, the simulated event queue, the
 * reconciliation): an authorization starts charging, a decline shows the
 * result, a device report updates the terminal. Fail-open per event (warn).
 */
export async function handleTerminalResults(
  applied: readonly AppliedTerminalEvent[],
  provider: string,
  deps: TerminalFlowDeps,
): Promise<void> {
  for (const event of applied) {
    try {
      if (event.applied != null) await handleTerminalResult(event.applied, deps);
      if (event.device != null) {
        const [terminal] = await db
          .select({ id: paymentTerminals.id })
          .from(paymentTerminals)
          .where(
            and(
              eq(paymentTerminals.provider, provider),
              eq(paymentTerminals.providerDeviceId, event.device.providerDeviceId),
            ),
          );
        if (terminal != null) {
          await syncPaymentTerminalDevice(terminal.id, event.device, {
            actor: {
              audit: { actor: 'system', actorLabel: `terminal-webhook:${provider}` },
              userId: null,
            },
            log: deps.logger,
          });
        }
      }
    } catch (err: unknown) {
      deps.logger.warn({ err, eventId: event.eventId }, 'Terminal event follow-up failed');
    }
  }
}

export async function handleTerminalResult(
  applied: AppliedTerminalResult,
  deps: TerminalFlowDeps,
): Promise<void> {
  const txn = applied.transaction;
  if (txn == null) return;
  if (applied.transition === 'authorized') {
    await startChargingForTerminal(txn, deps);
    return;
  }
  if (applied.transition === 'declined' || applied.transition === 'expired') {
    const place = await placeOf(txn.paymentTerminalId);
    if (place != null)
      await showTerminalPrompt(place, 'terminal_result', { paymentApproved: false }, deps);
  }
}

// ---------------------------------------------------------------------------
// Device status and the offline alert (worker cron)
// ---------------------------------------------------------------------------

/** System event sent to operators when a terminal stays offline (owner decision 8). */
export const PAYMENT_TERMINAL_OFFLINE_EVENT = 'paymentTerminal.Offline';

export interface TerminalStatusPollResult {
  polled: number;
  changed: number;
  errors: number;
  alerted: number;
}

/**
 * Polls the device status of every active cloud terminal (providers that
 * report it), one call per terminal, stopping a provider at its first rate
 * limit (it is asked again at the next run), then alerts the operators about
 * terminals offline for PAYMENT_TERMINAL_OFFLINE_ALERT_MINUTES, once per
 * offline period. Fail-open per terminal (warn).
 */
export async function pollTerminalDevices(
  deps: TerminalFlowDeps & { templatesDirs: string[] },
  now: Date = new Date(),
): Promise<TerminalStatusPollResult> {
  const out: TerminalStatusPollResult = { polled: 0, changed: 0, errors: 0, alerted: 0 };
  const terminals = await db
    .select()
    .from(paymentTerminals)
    .where(
      and(eq(paymentTerminals.status, 'active'), eq(paymentTerminals.integrationMode, 'cloud')),
    );
  const limited = new Set<string>();
  for (const terminal of terminals) {
    if (terminal.providerDeviceId == null || limited.has(terminal.provider)) continue;
    if (!isTerminalProviderId(terminal.provider)) continue;
    try {
      const provider = await terminalRegistry(deps.payments).getProvider(terminal.provider);
      if (provider?.capabilities.deviceStatus !== true) continue;
      const device = await provider.getDevice(terminal.providerDeviceId);
      out.polled++;
      const synced = await syncPaymentTerminalDevice(
        terminal.id,
        {
          online: device?.online ?? false,
          lastSeenAt: device?.lastSeenAt ?? null,
          firmwareVersion: device?.firmwareVersion ?? null,
          iccid: device?.iccid ?? null,
        },
        {
          actor: {
            audit: { actor: 'system', actorLabel: 'payment-terminal-status' },
            userId: null,
          },
          log: deps.logger,
        },
        now,
      );
      if (synced?.onlineChanged === true) out.changed++;
    } catch (err: unknown) {
      out.errors++;
      if (err instanceof Error && 'kind' in err && err.kind === 'rate_limited') {
        limited.add(terminal.provider);
      }
      deps.logger.warn({ err, paymentTerminalId: terminal.id }, 'Terminal status poll failed');
    }
  }
  out.alerted = await alertOfflineTerminals(deps, now);
  return out;
}

/**
 * Sends PAYMENT_TERMINAL_OFFLINE_EVENT for terminals offline longer than the
 * alert delay, once per offline period (claimed on the terminal row), to every
 * active user with `paymentTerminals:write` and access to the terminal's site
 * (all-site users for a terminal without a site). Fail-open (P9).
 */
export async function alertOfflineTerminals(
  deps: Pick<TerminalFlowDeps, 'logger'> & { templatesDirs: string[] },
  now: Date = new Date(),
): Promise<number> {
  const claimed = await claimTerminalOfflineAlerts(
    new Date(now.getTime() - PAYMENT_TERMINAL_OFFLINE_ALERT_MINUTES * 60_000),
    now,
  );
  for (const terminal of claimed) {
    try {
      const [place] = await client`
        SELECT st.station_id AS station_ocpp_id, si.name AS site_name
        FROM payment_terminals pt
        LEFT JOIN charging_stations st ON st.id = pt.station_id
        LEFT JOIN sites si ON si.id = pt.site_id
        WHERE pt.id = ${terminal.id}
      `;
      const recipients = await client`
        SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.language, u.timezone
        FROM users u
        WHERE u.is_active
          AND EXISTS (SELECT 1 FROM user_permissions p
            WHERE p.user_id = u.id AND p.permission = 'paymentTerminals:write')
          AND (u.has_all_site_access
            OR EXISTS (SELECT 1 FROM user_site_assignments a
              WHERE a.user_id = u.id AND a.site_id = ${terminal.siteId}))
        ORDER BY u.id
      `;
      const variables = {
        terminalLabel: terminal.label ?? terminal.serialNumber ?? terminal.id,
        terminalModel: terminal.model ?? '',
        stationId: (place?.['station_ocpp_id'] as string | null) ?? '',
        siteName: (place?.['site_name'] as string | null) ?? '',
        offlineSince: terminal.offlineSince?.toISOString() ?? '',
        minutes: PAYMENT_TERMINAL_OFFLINE_ALERT_MINUTES,
      };
      for (const user of recipients) {
        await dispatchSystemNotification(
          client,
          PAYMENT_TERMINAL_OFFLINE_EVENT,
          {
            email: user['email'] as string,
            phone: (user['phone'] as string | null) ?? undefined,
            firstName: (user['first_name'] as string | null) ?? undefined,
            lastName: (user['last_name'] as string | null) ?? undefined,
            language: user['language'] as string,
            timezone: user['timezone'] as string,
            userId: user['id'] as string,
          },
          variables,
          deps.templatesDirs,
        );
      }
    } catch (err: unknown) {
      deps.logger.warn({ err, paymentTerminalId: terminal.id }, 'Terminal offline alert not sent');
    }
  }
  return claimed.length;
}

/**
 * The reconciliation cron: resolves stale terminal transactions and finishes
 * the guest sessions it settled (completion and receipt) through the guest
 * finalization, which repeats safely.
 */
export async function reconcileTerminals(
  deps: TerminalFlowDeps & { templatesDirs: string[] },
  now: Date = new Date(),
): Promise<TerminalReconcileResult> {
  const result = await reconcileTerminalTransactions(deps.payments, now);
  for (const sessionId of result.settledSessionIds) {
    try {
      await handleGuestSessionEvent(
        { type: 'TransactionEnded', sessionId },
        { ...deps.payments, templatesDirs: deps.templatesDirs },
      );
      await finishTerminalSession(sessionId, deps);
    } catch (err: unknown) {
      deps.logger.warn({ err, sessionId }, 'Terminal session finish after reconciliation failed');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Simulated terminal events (worker queue)
// ---------------------------------------------------------------------------

export type { TerminalEventJob };

/** The worker side of a queued event: verified and applied like a webhook, then acted on. */
export async function runTerminalEventJob(
  job: TerminalEventJob,
  deps: TerminalFlowDeps,
): Promise<void> {
  const result = await ingestTerminalWebhook(
    job.provider,
    Buffer.from(job.rawBody, 'utf8'),
    { [SIMULATED_SIGNATURE_HEADER]: job.signature },
    deps.payments,
  );
  await handleTerminalResults(result.applied, job.provider, deps);
}

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

// A backwards scan, linear in the length (a regex would be quadratic on many slashes).
function trimSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/** The portal guest session page of a terminal payment: the receipt link (C24.FR.11). */
export async function terminalReceiptUrl(
  txn: Pick<TerminalTransaction, 'guestSessionId' | 'receiptUrl'>,
  portalUrl: string,
): Promise<string | null> {
  if (txn.guestSessionId != null) {
    const [guest] = await db
      .select({ token: guestSessions.sessionToken })
      .from(guestSessions)
      .where(eq(guestSessions.id, txn.guestSessionId));
    if (guest != null && /^[0-9a-f]{20}$/.test(guest.token)) {
      return `${trimSlashes(portalUrl)}/guest-session/${guest.token}`;
    }
  }
  return txn.receiptUrl;
}

/**
 * Settles an ended session paid at a terminal (capture of the final cost,
 * capped at the hold) and shows the receipt link. Called by the guest
 * finalization of the session and by the reconciliation.
 */
export async function finishTerminalSession(
  sessionId: string,
  deps: TerminalFlowDeps,
): Promise<TerminalSettlementOutcome> {
  const outcome = await settleTerminalSession(
    sessionId,
    withPaymentActor(deps.payments, { actor: 'system', actorLabel: 'terminal-settlement' }),
  );
  if (outcome.kind === 'captured') {
    const place = await placeOf(outcome.transaction.paymentTerminalId);
    const receiptUrl = await terminalReceiptUrl(outcome.transaction, deps.portalUrl);
    if (place != null) {
      await showTerminalPrompt(
        place,
        'terminal_receipt',
        {
          terminalAmount: await money(outcome.capturedCents),
          ...(receiptUrl != null ? { receiptUrl } : {}),
        },
        deps,
      );
    }
  }
  return outcome;
}
