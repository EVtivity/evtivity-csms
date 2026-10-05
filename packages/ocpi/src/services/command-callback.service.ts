// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { db, ocpiPartners } from '@evtivity/database';
import {
  createInFlightTracker,
  createLogger,
  OCPP_COMMAND_RESULTS_CHANNEL,
  publishOcppCommand,
  safeFetch,
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

interface PendingCommand {
  responseUrl: string;
  partnerId: string;
  commandType: OcpiCommandType;
  registeredAt: number;
}

interface CommandResult {
  commandId: string;
  response?: Record<string, unknown>;
  error?: string;
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
): OcpiCommandResultType {
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

export class OcpiCommandCallbackService {
  private readonly pubsub: PubSubClient;
  private readonly pending = new Map<string, PendingCommand>();
  private subscription: Subscription | null = null;
  private readonly inFlight = createInFlightTracker();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pubsub: PubSubClient) {
    this.pubsub = pubsub;
  }

  generateCommandId(): string {
    return crypto.randomUUID();
  }

  registerCommand(
    commandId: string,
    responseUrl: string,
    partnerId: string,
    commandType: OcpiCommandType,
  ): void {
    this.pending.set(commandId, {
      responseUrl,
      partnerId,
      commandType,
      registeredAt: Date.now(),
    });
  }

  async dispatchOcppCommand(
    commandId: string,
    stationId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await publishOcppCommand(this.pubsub, { commandId, stationId, action, payload });
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
      this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);

    logger.info({ channel: OCPP_COMMAND_RESULTS_CHANNEL }, 'Listening for OCPP command results');
  }

  private async handleResult(raw: string): Promise<void> {
    let result: CommandResult;
    try {
      result = JSON.parse(raw) as CommandResult;
    } catch {
      logger.error({ raw }, 'Invalid command result payload');
      return;
    }

    const { commandId } = result;
    const pending = this.pending.get(commandId);
    if (pending == null) {
      // Not one of our OCPI-initiated commands
      return;
    }

    this.pending.delete(commandId);

    const ocpiResult = mapOcppResultToOcpi(pending.commandType, result.response, result.error);
    const commandResult: OcpiCommandResult = { result: ocpiResult };

    logger.info(
      { commandId, commandType: pending.commandType, result: ocpiResult },
      'Sending command result to partner',
    );

    await this.postCommandResult(pending.responseUrl, pending.partnerId, commandResult);
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
        // partner, dropping the command result on the floor with no signal.
        // Refuse to dispatch and surface a clear error so the entry is
        // timed out / retried upstream rather than silently lost.
        logger.error(
          { partnerId, responseUrl },
          'Cannot dispatch OCPI command callback: no outbound token for partner',
        );
        return;
      }
      const tokenBase64 = Buffer.from(token).toString('base64');
      headers['Authorization'] = `Token ${tokenBase64}`;

      // Cap the partner callback at 30s. Without a timeout the catch never
      // fires, the entry stays held in this.pending forever, and the worker
      // accumulates one stuck await per slow partner callback.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 30_000);
      // The response_url is partner input: safeFetch checks every resolved
      // address at connect time, allowing private ones only for a partner
      // with the operator's private-network flag.
      const [partner] = await db
        .select({ allowPrivateNetwork: ocpiPartners.allowPrivateNetwork })
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, partnerId))
        .limit(1);
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

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [commandId, pending] of this.pending) {
      if (now - pending.registeredAt > COMMAND_TIMEOUT_MS) {
        this.pending.delete(commandId);

        // Send TIMEOUT result to partner
        const commandResult: OcpiCommandResult = { result: 'TIMEOUT' };
        logger.warn({ commandId, commandType: pending.commandType }, 'Command timed out');
        trackListenerWork(this.inFlight, logger, () =>
          this.postCommandResult(pending.responseUrl, pending.partnerId, commandResult),
        );
      }
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
