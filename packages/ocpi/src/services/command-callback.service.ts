// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { client, db, ocpiCommands, ocpiPartners } from '@evtivity/database';
import {
  createInFlightTracker,
  createLogger,
  OCPP_COMMAND_RESULTS_CHANNEL,
  publishOcppCommand,
  safeFetch,
  tryParseJson,
} from '@evtivity/lib';
import type { SafeFetchResponse } from '@evtivity/lib';
import { eq } from 'drizzle-orm';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { drainListener, trackListenerWork } from '../lib/listener-drain.js';
import { getOutboundToken } from '../lib/outbound-token.js';
import { config } from '../lib/config.js';
import type { OcpiCommandType, OcpiCommandResult, OcpiCommandResultType } from '../types/ocpi.js';

const logger = createLogger('ocpi-command-callback');
const COMMAND_TIMEOUT_MS = 30_000;
const CLEANUP_INTERVAL_MS = 10_000;
/** Answered commands are kept this long, then pruned by the sweep. */
const COMMAND_RETENTION_DAYS = 7;
/** Timed out commands claimed per sweep tick. */
const TIMEOUT_BATCH = 100;

/** A command a partner sent us, stored until its result is posted. */
export interface RegisterCommandInput {
  commandId: string;
  responseUrl: string;
  partnerId: string;
  commandType: OcpiCommandType;
  /** The station's OCPP id (START_SESSION: binds the token to the station). */
  stationId?: string | null;
  tokenUid?: string | null;
  tokenType?: string | null;
  /** The StartSession's Token object. */
  tokenData?: unknown;
  remoteStartId?: number | null;
  authorizationReference?: string | null;
}

interface ClaimedCommand {
  id: string;
  partner_id: string;
  response_url: string;
  command_type: string;
}

interface CommandResult {
  commandId: string;
  response?: Record<string, unknown>;
  error?: string;
  /** The station did not answer (set by the OCPP command listener). */
  timedOut?: boolean;
}

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

function mapOcppResultToOcpi(
  commandType: OcpiCommandType,
  response: Record<string, unknown> | undefined,
  error: string | undefined,
  timedOut = false,
): OcpiCommandResultType {
  if (timedOut) {
    return 'TIMEOUT';
  }
  if (error != null) {
    return 'FAILED';
  }

  if (response == null) {
    return 'FAILED';
  }

  // Map OCPP response status to OCPI command result
  const status = (response['status'] as string | undefined) ?? '';

  switch (commandType) {
    case 'START_SESSION': {
      if (status === 'Accepted') return 'ACCEPTED';
      return 'REJECTED';
    }
    case 'STOP_SESSION': {
      if (status === 'Accepted') return 'ACCEPTED';
      return 'REJECTED';
    }
    case 'RESERVE_NOW': {
      if (status === 'Accepted') return 'ACCEPTED';
      if (status === 'Occupied') return 'EVSE_OCCUPIED';
      if (status === 'Faulted') return 'EVSE_INOPERATIVE';
      if (status === 'Rejected') return 'REJECTED';
      return 'REJECTED';
    }
    case 'CANCEL_RESERVATION': {
      if (status === 'Accepted') return 'CANCELED_RESERVATION';
      if (status === 'Rejected') return 'UNKNOWN_RESERVATION';
      return 'REJECTED';
    }
    case 'UNLOCK_CONNECTOR': {
      if (status === 'Unlocked') return 'ACCEPTED';
      if (status === 'UnlockFailed') return 'FAILED';
      return 'REJECTED';
    }
    default:
      return 'FAILED';
  }
}

/**
 * The asynchronous CommandResult flow (OCPI 13): each command a partner sends
 * is stored in `ocpi_commands`; the OCPP result (on `ocpp_command_results`)
 * or the timeout claims the row with a guarded UPDATE (`result_sent_at IS
 * NULL`) and posts the result to the partner's response_url. The claim makes
 * one replica post it, and the stored row lets a result or TIMEOUT still
 * reach the partner after an OCPI restart.
 */
export class OcpiCommandCallbackService {
  private readonly pubsub: PubSubClient;
  private subscription: Subscription | null = null;
  private readonly inFlight = createInFlightTracker();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(pubsub: PubSubClient) {
    this.pubsub = pubsub;
  }

  generateCommandId(): string {
    return crypto.randomUUID();
  }

  /** Stores the command before it is dispatched, so its result has a row to claim. */
  async registerCommand(input: RegisterCommandInput): Promise<void> {
    await db.insert(ocpiCommands).values({
      id: input.commandId,
      partnerId: input.partnerId,
      commandType: input.commandType,
      responseUrl: input.responseUrl,
      stationId: input.stationId ?? null,
      tokenUid: input.tokenUid ?? null,
      tokenType: input.tokenType ?? null,
      tokenData: input.tokenData ?? null,
      remoteStartId: input.remoteStartId ?? null,
      authorizationReference: input.authorizationReference ?? null,
      expiresAt: new Date(Date.now() + COMMAND_TIMEOUT_MS),
    });
  }

  /**
   * Publishes the OCPP command, never queued for an offline station: run on
   * a later reconnect it would start or unlock with no partner waiting.
   */
  async dispatchOcppCommand(
    commandId: string,
    stationId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await publishOcppCommand(this.pubsub, {
      commandId,
      stationId,
      action,
      payload,
      noQueue: true,
    });
    logger.info({ commandId, stationId, action }, 'Dispatched OCPP command');
  }

  async start(): Promise<void> {
    this.subscription = await this.pubsub.subscribe(
      OCPP_COMMAND_RESULTS_CHANNEL,
      (payload: string) => {
        trackListenerWork(this.inFlight, logger, () => this.handleResult(payload));
      },
    );

    this.cleanupTimer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = true;
      trackListenerWork(this.inFlight, logger, () =>
        this.cleanupExpired().finally(() => {
          this.sweeping = false;
        }),
      );
    }, CLEANUP_INTERVAL_MS);

    logger.info({ channel: OCPP_COMMAND_RESULTS_CHANNEL }, 'Listening for OCPP command results');
  }

  private async handleResult(raw: string): Promise<void> {
    const parsed = tryParseJson(raw);
    if (parsed === undefined) {
      logger.error({ raw }, 'Invalid command result payload');
      return;
    }
    const result = parsed as CommandResult;
    const { commandId } = result;
    if (typeof commandId !== 'string' || commandId === '') return;

    // Only an OCPI command has a row; the claim lets one replica post it.
    const [claimed] = await client<ClaimedCommand[]>`
      UPDATE ocpi_commands SET result_sent_at = now()
      WHERE id = ${commandId} AND result_sent_at IS NULL
      RETURNING id, partner_id, response_url, command_type
    `;
    if (claimed == null) return;

    const commandType = claimed.command_type as OcpiCommandType;
    const ocpiResult = mapOcppResultToOcpi(
      commandType,
      result.response,
      result.error,
      result.timedOut === true,
    );
    await this.recordResult(commandId, ocpiResult);
    logger.info(
      { commandId, commandType, result: ocpiResult },
      'Sending command result to partner',
    );
    await this.postCommandResult(claimed.response_url, claimed.partner_id, { result: ocpiResult });
  }

  private async recordResult(commandId: string, result: OcpiCommandResultType): Promise<void> {
    try {
      await client`UPDATE ocpi_commands SET result = ${result} WHERE id = ${commandId}`;
    } catch (err: unknown) {
      // fail-open: the column is informational; the claim already holds.
      logger.warn({ err, commandId }, 'Failed to record the OCPI command result');
    }
  }

  private async postCommandResult(
    responseUrl: string,
    partnerId: string,
    commandResult: OcpiCommandResult,
  ): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'OCPI-from-country-code': getCountryCode(),
        'OCPI-from-party-id': getPartyId(),
      };

      const token = await getOutboundToken(partnerId);
      if (token == null) {
        // Sending the callback unauthenticated guarantees a 401 at the
        // partner: refuse and log, so the dropped result is visible.
        logger.error(
          { partnerId, responseUrl },
          'Cannot dispatch OCPI command callback: no outbound token for partner',
        );
        return;
      }
      // The response_url is partner input: safeFetch checks every resolved
      // address at connect time, allowing private ones only for a partner
      // with the operator's private-network flag.
      const [partner] = await db
        .select({
          allowPrivateNetwork: ocpiPartners.allowPrivateNetwork,
          allowRawToken: ocpiPartners.allowRawToken,
        })
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, partnerId))
        .limit(1);
      // A partner with the raw token flag gets the token without Base64.
      const encoded =
        partner?.allowRawToken === true ? token : Buffer.from(token).toString('base64');
      headers['Authorization'] = `Token ${encoded}`;

      // Cap the partner callback at 30s, so a slow partner cannot hold the
      // listener's tracked work forever.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 30_000);
      let response: SafeFetchResponse;
      try {
        response = await safeFetch(responseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(commandResult),
          signal: controller.signal,
          allowPrivateNetworks: partner?.allowPrivateNetwork ?? false,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        logger.warn(
          { responseUrl, status: response.status },
          'Partner rejected command result callback',
        );
      }
    } catch (err) {
      logger.error({ responseUrl, err }, 'Failed to POST command result to partner');
    }
  }

  /**
   * Claims the commands whose result did not arrive in time (also ones an
   * earlier process registered before it stopped) and posts TIMEOUT, then
   * prunes answered commands past the retention period.
   */
  async cleanupExpired(): Promise<void> {
    try {
      const expired = await client<ClaimedCommand[]>`
        UPDATE ocpi_commands SET result_sent_at = now(), result = 'TIMEOUT'
        WHERE id IN (
          SELECT id FROM ocpi_commands
          WHERE result_sent_at IS NULL AND expires_at < now()
          ORDER BY expires_at
          LIMIT ${TIMEOUT_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, partner_id, response_url, command_type
      `;
      for (const row of expired) {
        logger.warn({ commandId: row.id, commandType: row.command_type }, 'Command timed out');
        await this.postCommandResult(row.response_url, row.partner_id, { result: 'TIMEOUT' });
      }
      await client`
        DELETE FROM ocpi_commands
        WHERE result_sent_at IS NOT NULL
          AND created_at < now() - make_interval(days => ${COMMAND_RETENTION_DAYS})
      `;
    } catch (err: unknown) {
      logger.error({ err }, 'OCPI command timeout sweep failed');
    }
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer != null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.subscription != null) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    await drainListener(this.inFlight, logger);
    logger.info('Command callback service stopped');
  }
}

// Singleton for use across routes
let instance: OcpiCommandCallbackService | null = null;

export function getCommandCallbackService(): OcpiCommandCallbackService {
  if (instance == null) {
    throw new Error('Command callback service not initialized');
  }
  return instance;
}

export function initCommandCallbackService(pubsub: PubSubClient): OcpiCommandCallbackService {
  instance = new OcpiCommandCallbackService(pubsub);
  return instance;
}
