// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { sims } from '@evtivity/database';
import { isSimFeatureOn, readSimSettings } from './sim.js';

/** The 404 body of every SIM route: unknown SIMs and SIMs out of scope look the same. */
export const SIM_NOT_FOUND = { error: 'SIM not found', code: 'SIM_NOT_FOUND' } as const;

/**
 * The SIMs a site-restricted user sees: only a SIM with an open
 * confirmed attachment to a station of one of their sites. Unattached SIMs,
 * SIMs with an unconfirmed attachment (a station may report another site's
 * SIM) and SIMs at unsited stations are for all-site users only. A
 * correlated condition on `sims`, for the list, the detail routes and the
 * neighbors.
 */
export function simVisibleWhere(siteIds: readonly string[]): SQL {
  return simVisibleSql(sql`${sims.id}`, siteIds);
}

/**
 * Whether a fetch time of the SIM (`sims.status_fetched_at`,
 * `sims.sessions_synced_at`) falls inside a period the SIM was
 * confirmed-attached to a station of one of the sites (attached to closed,
 * open without an end): what a site-restricted reader may see of its fetch
 * state. False for a null time. A correlated condition on `sims`.
 */
export function fetchedInSiteWindowsSql(at: SQL, siteIds: readonly string[]): SQL {
  return inSimSiteWindowsSql(sql`${sims.id}`, at, siteIds);
}

/**
 * `fetchedInSiteWindowsSql` for any SQL expression holding a SIM id (the SIM
 * audit rows' `sim_id`): whether `at` falls inside a period that SIM was
 * confirmed-attached to a station of one of the sites.
 */
export function inSimSiteWindowsSql(simIdExpr: SQL, at: SQL, siteIds: readonly string[]): SQL {
  if (siteIds.length === 0) return sql`false`;
  return sql`(${at} IS NOT NULL AND EXISTS (SELECT 1 FROM sim_attachments win_a
    JOIN charging_stations win_cs ON win_cs.id = win_a.station_id
    WHERE win_a.sim_id = ${simIdExpr} AND win_a.confirmed_at IS NOT NULL
      AND win_a.attached_at <= ${at}
      AND (win_a.detached_at IS NULL OR win_a.detached_at >= ${at})
      AND win_cs.site_id IN (${sql.join(
        siteIds.map((siteId) => sql`${siteId}`),
        sql`, `,
      )})))`;
}

/**
 * `simVisibleWhere` for any SQL expression holding a SIM id (the SIM audit
 * rows' `sim_id`): true while that SIM has an open confirmed attachment to a
 * station of one of the sites.
 */
export function simVisibleSql(simIdExpr: SQL, siteIds: readonly string[]): SQL {
  if (siteIds.length === 0) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM sim_attachments vis_a
    JOIN charging_stations vis_cs ON vis_cs.id = vis_a.station_id
    WHERE vis_a.sim_id = ${simIdExpr} AND vis_a.detached_at IS NULL
      AND vis_a.confirmed_at IS NOT NULL
      AND vis_cs.site_id IN (${sql.join(
        siteIds.map((siteId) => sql`${siteId}`),
        sql`, `,
      )}))`;
}

/**
 * The SIM pages follow the feature switches: every `/v1/sims` route answers
 * 400 SIM_FEATURE_DISABLED while the provider and the station signal reads
 * are both off, before it reads anything else. Returns false after the reply
 * was sent.
 */
export async function requireSimFeature(reply: FastifyReply): Promise<boolean> {
  if (isSimFeatureOn(await readSimSettings())) return true;
  await reply.status(400).send({
    error: 'SIM providers and station signal reads are turned off',
    code: 'SIM_FEATURE_DISABLED',
  });
  return false;
}

/**
 * `requireSimFeature` as an onRequest hook, placed after `authorize`: a
 * request without the permission is refused first, and a malformed one gets
 * the feature-off answer before its params, query and body are validated.
 */
export async function simFeatureOnRequest(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  return (await requireSimFeature(reply)) ? undefined : reply;
}
