// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import {
  db,
  sites,
  configTemplates,
  configTemplateAuditLog,
  siteAuditLog,
  stationConfigurations,
  chargingStations,
  writeAudit,
  clearFreeVendCache,
} from '@evtivity/database';
import {
  FREE_VEND_OCPP_21_VARIABLES,
  FREE_VEND_OCPP_16_KEYS,
  freeVendRestoreVariables21,
  freeVendRestoreKeys16,
} from '@evtivity/lib';
import type { ConfigTemplateVariable, FreeVendRestoreKey16 } from '@evtivity/lib';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { pushTemplateToSiteStations } from '../lib/config-push.js';
import { publishOcpiLocationPush } from '../lib/ocpi-location-push.js';

type SiteRow = typeof sites.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface FreeVendSwitchResult {
  /** Config push of the 2.1 template, '' when no online 2.1 station got one. */
  pushId21: string;
  /** Config push of the 1.6 template, '' when no online 1.6 station got one. */
  pushId16: string;
}

interface AutoTemplate {
  name: string;
  description: string;
  ocppVersion: '2.1' | '1.6';
  variables: ConfigTemplateVariable[];
}

/**
 * The site's auto-generated template: kept when it still exists (its
 * variables replaced when `replaceVariables`), created otherwise. A stored id
 * whose template was deleted gets a new template.
 */
async function ensureAutoTemplate(
  tx: Tx,
  site: SiteRow,
  existingId: string | null,
  template: AutoTemplate,
  replaceVariables: boolean,
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<string | null> {
  if (existingId != null) {
    const [existing] = await tx
      .select()
      .from(configTemplates)
      .where(eq(configTemplates.id, existingId));
    if (existing != null) {
      if (
        replaceVariables &&
        JSON.stringify(existing.variables) !== JSON.stringify(template.variables)
      ) {
        const [updated] = await tx
          .update(configTemplates)
          .set({ variables: template.variables, updatedAt: new Date() })
          .where(eq(configTemplates.id, existing.id))
          .returning();
        await writeAudit(
          { table: configTemplateAuditLog, idColumn: 'template_id' },
          {
            entityId: existing.id,
            entityIdSnapshot: existing.id,
            action: 'updated',
            ...actor,
            before: existing,
            after: updated ?? existing,
            notes: `restore values captured for free-vend on site ${site.id}`,
          },
          tx,
          log,
        );
      }
      return existing.id;
    }
  }
  const [created] = await tx
    .insert(configTemplates)
    .values({ ...template, targetFilter: { siteId: site.id } })
    .returning();
  if (created == null) return null;
  await writeAudit(
    { table: configTemplateAuditLog, idColumn: 'template_id' },
    {
      entityId: created.id,
      entityIdSnapshot: created.id,
      action: 'created',
      ...actor,
      after: created,
      notes: `auto-created for free-vend on site ${site.id}`,
    },
    tx,
    log,
  );
  return created.id;
}

/** The value most of the site's stations of a protocol reported for a variable. */
async function reportedValue(
  tx: Tx,
  siteId: string,
  protocol: 'ocpp2.1' | 'ocpp1.6',
  component: string,
  variable: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ value: stationConfigurations.value, n: sql<number>`count(*)::int` })
    .from(stationConfigurations)
    .innerJoin(chargingStations, eq(chargingStations.id, stationConfigurations.stationId))
    .where(
      and(
        eq(chargingStations.siteId, siteId),
        eq(chargingStations.ocppProtocol, protocol),
        eq(stationConfigurations.component, component),
        eq(stationConfigurations.variable, variable),
        eq(stationConfigurations.attributeType, 'Actual'),
        isNotNull(stationConfigurations.value),
      ),
    )
    .groupBy(stationConfigurations.value)
    .orderBy(desc(sql`count(*)`), stationConfigurations.value)
    .limit(1);
  return row?.value ?? null;
}

function restoreTemplates(
  site: SiteRow,
  variables21: ConfigTemplateVariable[],
  variables16: ConfigTemplateVariable[],
): { t21: AutoTemplate; t16: AutoTemplate } {
  return {
    t21: {
      name: `Free Vend Off - ${site.name} (OCPP 2.1)`,
      description: `Auto generated. Restores authorization at ${site.name} when free vend is turned off (OCPP 2.1): the values the stations reported when free vend was turned on.`,
      ocppVersion: '2.1',
      variables: variables21,
    },
    t16: {
      name: `Free Vend Off - ${site.name} (OCPP 1.6)`,
      description: `Auto generated. Restores authorization at ${site.name} when free vend is turned off (OCPP 1.6): the values the stations reported when free vend was turned on.`,
      ocppVersion: '1.6',
      variables: variables16,
    },
  };
}

/**
 * Turns free vend on or off for a site (`POST /v1/sites/:id/free-vend`).
 *
 * On: the free vend templates are created when missing and, when the site
 * was off, the restore templates take the values the stations report now.
 * Off: the restore templates (created with the documented defaults for a site
 * turned on before they existed) push authorization back. Each switch locks
 * the site row, so two switches at once create one set of templates. The
 * pushes run after the commit and reach the online stations of each protocol.
 */
export async function setSiteFreeVend(
  site: SiteRow,
  enabled: boolean,
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<FreeVendSwitchResult> {
  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(sites).where(eq(sites.id, site.id)).for('update');
    const current = locked ?? site;

    let pushTemplate21: string | null;
    let pushTemplate16: string | null;
    let changes: Partial<SiteRow>;
    if (enabled) {
      const free21 = await ensureAutoTemplate(
        tx,
        current,
        current.freeVendTemplateId21,
        {
          name: `Free Vend - ${current.name} (OCPP 2.1)`,
          description: `Auto generated. Free Vend configuration for ${current.name} (OCPP 2.1).`,
          ocppVersion: '2.1',
          variables: FREE_VEND_OCPP_21_VARIABLES,
        },
        false,
        actor,
        log,
      );
      const free16 = await ensureAutoTemplate(
        tx,
        current,
        current.freeVendTemplateId16,
        {
          name: `Free Vend - ${current.name} (OCPP 1.6)`,
          description: `Auto generated. Free Vend configuration for ${current.name} (OCPP 1.6). OCPP 1.6 has no standard free-vend mechanism; these keys work with most stations but some vendors require vendor-specific keys (edit and re-push as needed).`,
          ocppVersion: '1.6',
          variables: FREE_VEND_OCPP_16_KEYS.map((k) => ({
            component: k.key,
            variable: k.key,
            value: k.value,
          })),
        },
        false,
        actor,
        log,
      );
      changes = { freeVendTemplateId21: free21, freeVendTemplateId16: free16 };
      // Capture what the stations have before free vend changes it. While
      // free vend is already on the stations hold its values: keep the stored ones.
      if (!current.freeVendEnabled) {
        const local16: Partial<Record<FreeVendRestoreKey16, string | null>> = {};
        for (const key of ['LocalPreAuthorize', 'LocalAuthorizeOffline'] as const) {
          local16[key] = await reportedValue(tx, current.id, 'ocpp1.6', 'OCPP', key);
        }
        const { t21, t16 } = restoreTemplates(
          current,
          freeVendRestoreVariables21(
            await reportedValue(tx, current.id, 'ocpp2.1', 'TxCtrlr', 'TxStartPoint'),
          ),
          freeVendRestoreKeys16(local16),
        );
        changes.freeVendRestoreTemplateId21 = await ensureAutoTemplate(
          tx,
          current,
          current.freeVendRestoreTemplateId21,
          t21,
          true,
          actor,
          log,
        );
        changes.freeVendRestoreTemplateId16 = await ensureAutoTemplate(
          tx,
          current,
          current.freeVendRestoreTemplateId16,
          t16,
          true,
          actor,
          log,
        );
      }
      pushTemplate21 = free21;
      pushTemplate16 = free16;
    } else {
      // A site turned on before the restore templates existed gets them now,
      // with the defaults: its stations already hold the free vend values.
      const { t21, t16 } = restoreTemplates(
        current,
        freeVendRestoreVariables21(null),
        freeVendRestoreKeys16({}),
      );
      const restore21 = await ensureAutoTemplate(
        tx,
        current,
        current.freeVendRestoreTemplateId21,
        t21,
        false,
        actor,
        log,
      );
      const restore16 = await ensureAutoTemplate(
        tx,
        current,
        current.freeVendRestoreTemplateId16,
        t16,
        false,
        actor,
        log,
      );
      changes = { freeVendRestoreTemplateId21: restore21, freeVendRestoreTemplateId16: restore16 };
      pushTemplate21 = restore21;
      pushTemplate16 = restore16;
    }

    const [updated] = await tx
      .update(sites)
      .set({ ...changes, freeVendEnabled: enabled, updatedAt: new Date() })
      .where(eq(sites.id, current.id))
      .returning();
    await writeAudit(
      { table: siteAuditLog, idColumn: 'site_id' },
      {
        entityId: current.id,
        entityIdSnapshot: current.id,
        action: 'updated',
        ...actor,
        before: current,
        after: updated ?? current,
        notes: enabled ? 'free-vend enabled' : 'free-vend disabled',
      },
      tx,
      log,
    );
    return { wasEnabled: current.freeVendEnabled, pushTemplate21, pushTemplate16 };
  });

  clearFreeVendCache();
  // The OCPI location tells partners whether charging is free.
  if (outcome.wasEnabled !== enabled) await publishOcpiLocationPush(site.id, null, log);

  // Outside the transaction: the pushes dispatch OCPP commands. The 2.1 and
  // 1.6 pushes reach disjoint station sets, so they run in parallel.
  const [pushId21, pushId16] = await Promise.all([
    outcome.pushTemplate21 != null
      ? pushTemplateToSiteStations(outcome.pushTemplate21, site.id)
      : Promise.resolve(''),
    outcome.pushTemplate16 != null
      ? pushTemplateToSiteStations(outcome.pushTemplate16, site.id)
      : Promise.resolve(''),
  ]);
  return { pushId21, pushId16 };
}
