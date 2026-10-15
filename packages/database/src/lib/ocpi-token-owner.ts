// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import type { PubSubClient } from '@evtivity/lib';
import { client } from '../config.js';
import { isRoamingEnabled } from './roaming-setting.js';
import { OCPI_START_CONTEXT_MINUTES } from './ocpi-token-startable.js';

/** OCPI AuthMethod of our CPO session (OCPI 2.3.0 10.4.1). */
export type OcpiCpoAuthMethod = 'COMMAND' | 'WHITELIST';

/** The partner (eMSP) whose token a station presented, and how it was authorized. */
export interface OcpiTokenOwner {
  partnerId: string;
  /** COMMAND: the partner's START_SESSION; WHITELIST: a token the partner pushed. */
  authMethod: OcpiCpoAuthMethod;
  /** The START_SESSION that bound the token, for COMMAND. */
  commandId: string | null;
  authorizationReference: string | null;
  isValid: boolean;
  whitelist: string;
  /** The OCPI Token object (pushed, or embedded in the START_SESSION). */
  tokenData: unknown;
}

export interface OcpiTokenOwnerResult {
  owner: OcpiTokenOwner | null;
  /** Several connected partners hold a valid token with this uid and no command names one. */
  ambiguous: boolean;
}

interface CommandRow {
  id: string;
  partner_id: string;
  authorization_reference: string | null;
  token_data: unknown;
  pushed_valid: boolean | null;
  pushed_whitelist: string | null;
  pushed_data: unknown;
}

interface TokenRow {
  partner_id: string;
  is_valid: boolean;
  whitelist: string;
  token_data: unknown;
}

function embeddedValid(tokenData: unknown): boolean {
  return (tokenData as { valid?: unknown } | null)?.valid !== false;
}

/**
 * The partner a token presented at a station belongs to. A uid is unique per
 * eMSP only (OCPI 12), so two partners can hold the same one:
 *
 * 1. A START_SESSION a connected partner sent for this station and token in
 *    the last OCPI_START_CONTEXT_MINUTES, not yet linked to a session (the
 *    one with `remoteStartId` when given, else the newest): COMMAND. The eMSP
 *    authorized the token by sending the command, so its pushed token row
 *    is used when there is one, else the token embedded in the command.
 * 2. Else the connected partners holding a token with this uid: one valid
 *    token (is_valid, whitelist not NEVER) is the owner (WHITELIST); several
 *    are ambiguous (no owner); none valid returns the first row so the caller
 *    can answer Blocked.
 *
 * Partners that are not connected (suspended, disconnected, pending) never
 * own a token.
 */
export async function resolveOcpiTokenOwner(
  input: { stationOcppId: string; tokenUid: string; remoteStartId?: number | null },
  sql: postgres.Sql = client,
): Promise<OcpiTokenOwnerResult> {
  const remoteStartId = input.remoteStartId ?? null;
  const commands = await sql<CommandRow[]>`
    SELECT c.id, c.partner_id, c.authorization_reference, c.token_data,
           t.is_valid AS pushed_valid, t.whitelist AS pushed_whitelist,
           t.token_data AS pushed_data
    FROM ocpi_commands c
    JOIN ocpi_partners p ON p.id = c.partner_id AND p.status = 'connected'
    LEFT JOIN ocpi_external_tokens t ON t.partner_id = c.partner_id AND t.uid = c.token_uid
    WHERE c.command_type = 'START_SESSION'
      AND c.station_id = ${input.stationOcppId}
      AND c.token_uid = ${input.tokenUid}
      AND c.charging_session_id IS NULL
      AND c.created_at > now() - make_interval(mins => ${OCPI_START_CONTEXT_MINUTES})
    ORDER BY (c.remote_start_id IS NOT DISTINCT FROM ${remoteStartId}::integer) DESC,
             c.created_at DESC
    LIMIT 1
  `;
  const command = commands[0];
  if (command != null) {
    const pushed = command.pushed_valid != null;
    return {
      owner: {
        partnerId: command.partner_id,
        authMethod: 'COMMAND',
        commandId: command.id,
        authorizationReference: command.authorization_reference,
        isValid: pushed ? command.pushed_valid === true : embeddedValid(command.token_data),
        // The StartSession is the eMSP's authorization: a NEVER whitelist
        // (real-time authorization required) is satisfied by it.
        whitelist: 'ALLOWED',
        tokenData: pushed ? command.pushed_data : command.token_data,
      },
      ambiguous: false,
    };
  }

  const tokens = await sql<TokenRow[]>`
    SELECT t.partner_id, t.is_valid, t.whitelist, t.token_data
    FROM ocpi_external_tokens t
    JOIN ocpi_partners p ON p.id = t.partner_id AND p.status = 'connected'
    WHERE t.uid = ${input.tokenUid}
    ORDER BY t.updated_at DESC
  `;
  if (tokens.length === 0) return { owner: null, ambiguous: false };
  const valid = tokens.filter((t) => t.is_valid && t.whitelist !== 'NEVER');
  if (valid.length > 1) return { owner: null, ambiguous: true };
  const row = valid[0] ?? tokens[0];
  if (row == null) return { owner: null, ambiguous: false };
  return {
    owner: {
      partnerId: row.partner_id,
      authMethod: 'WHITELIST',
      commandId: null,
      authorizationReference: null,
      isValid: row.is_valid,
      whitelist: row.whitelist,
      tokenData: row.token_data,
    },
    ambiguous: false,
  };
}

/**
 * Tells the OCPI server a CPO session changed (`ocpi_push` session), so the
 * partner whose token started it gets its new state. Fail-open (P9): the
 * partner's next pull of GET /cpo/sessions sees the state the database holds.
 */
export async function publishOcpiSessionPush(
  pubsub: PubSubClient,
  sessionId: string,
  log: { debug: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    if (!(await isRoamingEnabled())) return;
    await pubsub.publish('ocpi_push', JSON.stringify({ type: 'session', sessionId }));
  } catch (err: unknown) {
    log.debug({ err, sessionId }, 'OCPI session push publish failed; continuing');
  }
}
