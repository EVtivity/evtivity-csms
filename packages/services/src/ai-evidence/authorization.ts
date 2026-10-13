// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Authorization evidence: the refused
 * attempts of one token at one station in the hour bucket, with outcome and
 * reason, the token's state (known, active, expired, revoked, prepaid credit
 * left), whether its driver is active (a boolean, nothing else about the
 * driver), whether the driver's fleet has a credit limit, and the token's
 * local authorization list entry at the station. The token value goes in as
 * `idToken`, which the redactor replaces by a short hash.
 */

import { client, toIsoOrNull } from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import type { EvidenceItem, EvidencePack } from './pack.js';

export const AUTHORIZATION_ATTEMPT_LIMIT = 10;

export interface AuthorizationAttemptRow {
  id: number;
  id_token: string;
  token_type: string | null;
  outcome: string;
  reason: string | null;
  ocpp_version: string | null;
  created_at: RawTimestamp;
}

export interface AuthorizationTokenRow {
  token_type: string;
  is_active: boolean;
  expired: boolean;
  revoked: boolean;
  prepaid: boolean;
  prepaid_credit_left: boolean | null;
  driver_active: boolean | null;
  fleet_credit_limited: boolean;
}

export interface AuthorizationLocalListRow {
  auth_status: string;
  pushed: boolean;
}

export interface AuthorizationEvidenceRows {
  stationDbId: string;
  siteId: string | null;
  idToken: string;
  attempts: AuthorizationAttemptRow[];
  token: AuthorizationTokenRow | null;
  localList: AuthorizationLocalListRow | null;
}

export function buildAuthorizationEvidence(
  rows: AuthorizationEvidenceRows,
  subjectId: string,
): EvidencePack {
  const items: EvidenceItem[] = rows.attempts.map((a) => ({
    id: `auth:${String(a.id)}`,
    kind: 'authorize_attempt',
    data: {
      outcome: a.outcome,
      reason: a.reason,
      tokenType: a.token_type,
      ocppVersion: a.ocpp_version,
      at: toIsoOrNull(a.created_at),
    },
  }));
  const t = rows.token;
  return {
    subject: { type: 'authorization', id: subjectId, siteId: rows.siteId },
    facts: {
      idToken: rows.idToken,
      refusals: rows.attempts.length,
      tokenKnown: t != null,
      tokenType: t?.token_type ?? rows.attempts[0]?.token_type ?? null,
      tokenActive: t?.is_active ?? null,
      tokenExpired: t?.expired ?? null,
      tokenRevoked: t?.revoked ?? null,
      prepaid: t?.prepaid ?? null,
      prepaidCreditLeft: t?.prepaid_credit_left ?? null,
      driverActive: t?.driver_active ?? null,
      fleetCreditLimited: t?.fleet_credit_limited ?? null,
      localListEntry: rows.localList == null ? null : rows.localList.auth_status,
      localListPushed: rows.localList?.pushed ?? null,
    },
    items,
    untrusted: [],
  };
}

export interface AuthorizationSubject {
  /** charging_stations.id */
  stationDbId: string;
  idToken: string;
  /** Start of the hour bucket. */
  since: Date;
  until: Date;
}

export async function loadAuthorizationEvidenceRows(
  subject: AuthorizationSubject,
): Promise<AuthorizationEvidenceRows | null> {
  const [station] = await client<{ station_id: string; site_id: string | null }[]>`
    SELECT station_id, site_id FROM charging_stations WHERE id = ${subject.stationDbId}
  `;
  if (station == null) return null;
  const [attempts, tokens, localList] = await Promise.all([
    client<AuthorizationAttemptRow[]>`
      SELECT id, id_token, token_type, outcome::text AS outcome, reason, ocpp_version, created_at
      FROM authorize_attempts
      WHERE station_id = ${station.station_id} AND id_token = ${subject.idToken}
        AND outcome <> 'accepted'
        AND created_at >= ${subject.since} AND created_at < ${subject.until}
      ORDER BY created_at DESC, id DESC LIMIT ${AUTHORIZATION_ATTEMPT_LIMIT}
    `,
    client<AuthorizationTokenRow[]>`
      SELECT t.token_type, t.is_active,
        (t.expires_at IS NOT NULL AND t.expires_at < now()) AS expired,
        t.revoked_at IS NOT NULL AS revoked,
        t.prepaid_balance_cents IS NOT NULL AS prepaid,
        CASE WHEN t.prepaid_balance_cents IS NULL THEN NULL
          ELSE t.prepaid_balance_cents > 0 END AS prepaid_credit_left,
        d.is_active AS driver_active,
        EXISTS (
          SELECT 1 FROM fleet_drivers fd JOIN fleets f ON f.id = fd.fleet_id
          WHERE fd.driver_id = t.driver_id AND f.credit_limit_cents IS NOT NULL
        ) AS fleet_credit_limited
      FROM driver_tokens t
      LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE t.id_token = ${subject.idToken}
      ORDER BY t.is_active DESC, t.updated_at DESC LIMIT 1
    `,
    client<AuthorizationLocalListRow[]>`
      SELECT auth_status, pushed_at IS NOT NULL AS pushed
      FROM station_local_auth_entries
      WHERE station_id = ${subject.stationDbId} AND id_token = ${subject.idToken}
      LIMIT 1
    `,
  ]);
  return {
    stationDbId: subject.stationDbId,
    siteId: station.site_id,
    idToken: subject.idToken,
    attempts,
    token: tokens[0] ?? null,
    localList: localList[0] ?? null,
  };
}

/**
 * The evidence of the refusals of one attempt's token at its station in the
 * attempt's hour. Null when the attempt or the station is gone.
 */
export async function collectAttemptAuthorizationEvidence(
  attemptId: number,
  stationDbId: string,
  subjectId: string,
): Promise<{ pack: EvidencePack; outcome: string | null } | null> {
  const [attempt] = await client<{ id_token: string; created_at: Date | string }[]>`
    SELECT id_token, created_at FROM authorize_attempts WHERE id = ${attemptId}
  `;
  if (attempt == null) return null;
  const since = new Date(attempt.created_at);
  since.setUTCMinutes(0, 0, 0);
  const until = new Date(since.getTime() + 3_600_000);
  return collectAuthorizationEvidence(
    { stationDbId, idToken: attempt.id_token, since, until },
    subjectId,
  );
}

export async function collectAuthorizationEvidence(
  subject: AuthorizationSubject,
  subjectId: string,
): Promise<{ pack: EvidencePack; outcome: string | null } | null> {
  const rows = await loadAuthorizationEvidenceRows(subject);
  if (rows == null) return null;
  return {
    pack: buildAuthorizationEvidence(rows, subjectId),
    outcome: rows.attempts[0]?.outcome ?? null,
  };
}
