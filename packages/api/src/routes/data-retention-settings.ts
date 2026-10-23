// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import {
  clearAiSettingsCache,
  db,
  settingAuditLog,
  settings,
  userPermissions,
  users,
  writeAudit,
} from '@evtivity/database';
import {
  DATA_RETENTION_KEYS,
  DATA_RETENTION_SETTINGS,
  SIM_SETTING_KEYS,
  effectiveRetentionDays,
  isAllowedRetentionDays,
  shortensSecurityHistory,
  type DataRetentionDefinition,
  type DataRetentionSettingKey,
} from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { authorize } from '../middleware/rbac.js';
import { rejectUnknownBodyKeys, zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { clearSimCaches } from '../lib/sim.js';
import { factorProof } from '../lib/mfa-factor-proof.js';
import { requireSessionProof } from '../lib/session-proof.js';
import { sendSecurityNotice } from '../lib/security-notice.js';

// Retention applies to the data of every site: a site-restricted user gets
// this 404 before any read or write.
const ALL_SITES_SETTING_NOT_FOUND = {
  error: 'Setting not found',
  code: 'SETTING_NOT_FOUND',
} as const;

function rangeText(key: DataRetentionSettingKey): string {
  const def: DataRetentionDefinition = DATA_RETENTION_SETTINGS[key];
  if (def.keptMin != null) {
    return `0 (keeps the data forever) or ${String(def.keptMin)} to ${String(def.max)} days, default ${String(def.defaultDays)}`;
  }
  const forever = def.keepForever ? ', 0 keeps the data forever' : '';
  return `${String(def.min)} to ${String(def.max)} days, default ${String(def.defaultDays)}${forever}`;
}

const responseShape = Object.fromEntries(
  DATA_RETENTION_KEYS.map((key) => [key, z.number().describe(`Days kept (${rangeText(key)})`)]),
) as Record<DataRetentionSettingKey, z.ZodNumber>;

const dataRetentionResponse = z
  .object(responseShape)
  .describe(
    'Data retention settings keyed by setting name: the days each prune job keeps, the stored value or the default',
  );

const bodyShape = Object.fromEntries(
  DATA_RETENTION_KEYS.map((key) => {
    const def = DATA_RETENTION_SETTINGS[key];
    return [
      key,
      z
        .number()
        .int()
        .min(def.min)
        .max(def.max)
        .optional()
        .describe(`Days kept (${rangeText(key)})`),
    ];
  }),
) as Record<DataRetentionSettingKey, z.ZodOptional<z.ZodNumber>>;

const updateDataRetentionBody = z
  .object({
    ...bodyShape,
    proof: factorProof
      .optional()
      .describe(
        'Fresh proof of the account, required from a signed-in session (not from an API key) when the change shortens the retention of the audit history, sign-in history or security events (a smaller number of days, or a number where 0 kept them forever)',
      ),
  })
  .describe(
    'Data retention settings to change, keyed by setting name; an omitted key keeps its value',
  );

/** Active all-site users who may change the retention: they get the notice. */
async function retentionAdminIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userPermissions, eq(userPermissions.userId, users.id))
    .where(
      and(
        eq(users.isActive, true),
        eq(users.hasAllSiteAccess, true),
        eq(userPermissions.permission, 'settings.system:write'),
      ),
    );
  return rows.map((r) => r.id);
}

async function readStoredRetention(): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...DATA_RETENTION_KEYS]));
  return new Map(rows.map((row) => [row.key, row.value]));
}

function effectiveValues(stored: Map<string, unknown>): Record<DataRetentionSettingKey, number> {
  return Object.fromEntries(
    DATA_RETENTION_KEYS.map((key) => [key, effectiveRetentionDays(key, stored.get(key))]),
  ) as Record<DataRetentionSettingKey, number>;
}

export function dataRetentionSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/settings/data-retention',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get data retention settings',
        description:
          'Returns the days each prune job keeps OCPP messages, meter values, logs, audit history, sign-in tokens, AI data and SIM data. A setting without a stored value shows its default.',
        operationId: 'getDataRetentionSettings',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(dataRetentionResponse),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      return effectiveValues(await readStoredRetention());
    },
  );

  app.put(
    '/settings/data-retention',
    {
      onRequest: [authorize('settings.system:write')],
      preValidation: [rejectUnknownBodyKeys(updateDataRetentionBody)],
      schema: {
        tags: ['Settings'],
        summary: 'Update data retention settings',
        description:
          'Updates the given data retention settings; an omitted key keeps its value. Each value is a whole number of days in its range. The prune jobs use a new value at their next run. Shortening the audit history, sign-in history or security event retention takes a fresh proof from a signed-in session (400 with proofKinds otherwise) and emails a security.RetentionLowered notice to every active all-site user with settings.system:write.',
        operationId: 'updateDataRetentionSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateDataRetentionBody),
        response: {
          200: itemResponse(dataRetentionResponse),
          400: errorWith('Validation error, or a missing or wrong proof', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof updateDataRetentionBody>;
      // The security history takes 0 or 30 days and more.
      const details: Record<string, string> = {};
      for (const key of DATA_RETENTION_KEYS) {
        const value = body[key];
        if (value !== undefined && !isAllowedRetentionDays(key, value)) {
          details[key] = `Use ${rangeText(key)}`;
        }
      }
      if (Object.keys(details).length > 0) {
        await reply
          .status(400)
          .send({ error: 'Retention out of range', code: 'VALIDATION_ERROR', details });
        return;
      }
      const stored = await readStoredRetention();

      // A value equal to the stored one writes nothing and leaves no audit row.
      const changed: Array<{ key: DataRetentionSettingKey; value: number }> = [];
      for (const key of DATA_RETENTION_KEYS) {
        const value = body[key];
        if (value !== undefined && stored.get(key) !== value) changed.push({ key, value });
      }

      const shortened = changed
        .map(({ key, value }) => ({
          key,
          before: effectiveRetentionDays(key, stored.get(key)),
          after: value,
        }))
        .filter(({ key, before, after }) => shortensSecurityHistory(key, before, after));
      if (shortened.length > 0 && !(await requireSessionProof(request, reply, body.proof))) return;

      if (changed.length > 0) {
        await db.transaction(async (tx) => {
          for (const { key, value } of changed) {
            await tx
              .insert(settings)
              .values({ key, value })
              .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
          }
        });

        if (changed.some(({ key }) => DATA_RETENTION_SETTINGS[key].group === 'ai')) {
          clearAiSettingsCache();
        }
        if (changed.some(({ key }) => key === SIM_SETTING_KEYS.retentionDays)) {
          clearSimCaches();
          // The other processes drop their SIM settings cache now instead of after its 60 s.
          try {
            await getPubSub().publish('cache_invalidate', JSON.stringify({ kind: 'sim_settings' }));
          } catch (err: unknown) {
            request.log.warn(
              { err },
              'SIM settings invalidation publish failed, peers refresh within 60s',
            );
          }
        }

        const actor = getAuditActor(request);
        await Promise.allSettled(
          changed.map(({ key, value }) =>
            writeAudit(
              { table: settingAuditLog, idColumn: 'setting_key' },
              {
                entityId: key,
                entityIdSnapshot: key,
                action: 'updated',
                ...actor,
                before: { key, value: stored.get(key) ?? null },
                after: { key, value },
              },
              db,
              request.log,
            ),
          ),
        );
        for (const { key, value } of changed) stored.set(key, value);

        if (shortened.length > 0) {
          const changes = shortened
            .map(({ key, before, after }) => `${key} ${String(before)} -> ${String(after)}`)
            .join(', ');
          // Fail-open: the change stands, a lost notice is logged.
          void retentionAdminIds()
            .then((ids) => {
              for (const userId of ids) {
                sendSecurityNotice(
                  { userId },
                  'security.RetentionLowered',
                  { changes },
                  request.log,
                );
              }
            })
            .catch((err: unknown) => {
              request.log.warn({ err }, 'Retention notice recipients failed, the change stands');
            });
        }
      }

      return effectiveValues(stored);
    },
  );
}
