// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, isNotNull, asc, inArray, exists, sql } from 'drizzle-orm';
import {
  db,
  configTemplates,
  configTemplatePushes,
  configTemplatePushStations,
  chargingStations,
  stationConfigurations,
  sites,
  vendors,
  writeAudit,
  configTemplateAuditLog,
  effectiveDataPlanSql,
  isOperatorStation,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { processConfigPush } from '../lib/config-push.js';
import {
  assertNoBootOwnedVariables,
  assertNoCredentialVariables,
} from '../lib/station-credential-guard.js';
import {
  DATA_PLANS,
  findTemplateTargetConfiguration,
  hasConfigDrift,
  configTemplateTarget,
  configTemplateMatchesStation,
  isBootOwnedStationSetting,
  isDataPlan,
} from '@evtivity/lib';
import type { SQL } from 'drizzle-orm';
import { getUserSiteIds } from '../lib/site-access.js';
import {
  configTemplateInScopeSql,
  findScopedConfigTemplate,
  stationInSitesSql,
  targetFilterNotFound,
  targetFilterOutOfScope,
  isRestrictedCompanyWideWrite,
  TEMPLATE_NOT_FOUND,
} from '../lib/fleet-operation-scope.js';
import { authorize } from '../middleware/rbac.js';
import { siteInScope } from '../lib/site-scope.js';
import { templateProtocolCondition, templateReachesProtocol } from '../lib/template-protocols.js';

const VARIABLE_INSTANCE_DESCRIPTION =
  'OCPP 2.0.1 and 2.1 variable instance, such as Default for OCPPCommCtrlr.MessageTimeout or TransactionEvent for OCPPCommCtrlr.MessageAttempts. Null or absent: no instance. OCPP 1.6 templates have none';

const DATA_PLAN_FILTER_DESCRIPTION =
  "Only stations whose effective data plan is this one (the station's own choice, else cellular for a confirmed SIM, else the site's plan, else wifi_or_wired)";

const templateVariableSchema = z
  .object({
    component: z.string().describe('OCPP component name'),
    variable: z.string().describe('OCPP variable name'),
    variableInstance: z.string().nullable().optional().describe(VARIABLE_INSTANCE_DESCRIPTION),
    value: z.string().describe('Variable value to set'),
  })
  .passthrough();

const targetFilterResponseSchema = z
  .object({
    siteId: z.string().optional(),
    vendorId: z.string().optional(),
    model: z.string().optional(),
    stationId: z.string().optional(),
    dataPlan: z.enum(DATA_PLANS).optional().describe(DATA_PLAN_FILTER_DESCRIPTION),
  })
  .passthrough();

const templateItem = z
  .object({
    id: z.string().describe('Template ID'),
    name: z.string().describe('Template name'),
    description: z.string().nullable().describe('Template description'),
    variables: z.array(templateVariableSchema).describe('Variable definitions'),
    ocppVersion: z.string().describe('OCPP version (1.6 or 2.1)'),
    targetFilter: targetFilterResponseSchema.nullable().describe('Target station filter'),
    stationId: z
      .string()
      .nullable()
      .describe('Station ID when template is auto-created for a single station'),
    createdAt: z.string().describe('ISO timestamp when template was created'),
    updatedAt: z.string().describe('ISO timestamp when template was last updated'),
    matchingStationsCount: z
      .number()
      .optional()
      .describe('Count of stations matching the target filter (list endpoint only)'),
  })
  .passthrough();

const filterOptionSiteSchema = z
  .object({
    id: z.string().describe('Site ID'),
    name: z.string().describe('Site name'),
  })
  .passthrough();

const filterOptionVendorSchema = z
  .object({
    id: z.string().describe('Vendor ID'),
    name: z.string().describe('Vendor name'),
  })
  .passthrough();

const filterOptionStationSchema = z
  .object({
    id: z.string().describe('Station UUID'),
    stationId: z.string().describe('Human-readable station identifier'),
  })
  .passthrough();

const filterOptionsItem = z
  .object({
    sites: z.array(filterOptionSiteSchema).describe('Available sites for filtering'),
    vendors: z.array(filterOptionVendorSchema).describe('Available vendors for filtering'),
    models: z.array(z.string()).describe('Available station models for filtering'),
    stations: z.array(filterOptionStationSchema).describe('Available stations for filtering'),
    dataPlans: z.array(z.enum(DATA_PLANS)).describe('Data plans a target filter can name'),
  })
  .passthrough();

const matchingStationItem = z
  .object({
    id: z.string().describe('Station UUID'),
    stationId: z.string().describe('Human-readable station identifier'),
    model: z.string().nullable().describe('Station model'),
    isOnline: z.boolean().describe('Whether the station is currently connected'),
    siteName: z.string().nullable().describe('Site name'),
    vendorName: z.string().nullable().describe('Vendor name'),
  })
  .passthrough();

const configDriftItem = z
  .object({
    component: z.string().describe('OCPP component name'),
    variable: z.string().describe('OCPP variable name'),
    variableInstance: z.string().nullable().describe('Variable instance, null when none'),
    expectedValue: z.string().describe('Value the template expects for the variable'),
    actualValue: z.string().nullable().describe('Value currently set on the station'),
    hasDrift: z.boolean().describe('Whether the actual value differs from the expected value'),
  })
  .passthrough();

const pushItem = z
  .object({
    id: z.string().describe('Push ID'),
    templateId: z.string().describe('Source config template ID'),
    status: z.string().describe('Push status (active or completed)'),
    stationCount: z.number().describe('Total number of target stations'),
    createdAt: z.string().describe('ISO timestamp when push was created'),
    updatedAt: z.string().describe('ISO timestamp when push was last updated'),
    pendingCount: z.number().describe('Stations still pending'),
    acceptedCount: z.number().describe('Stations that accepted the configuration'),
    rejectedCount: z.number().describe('Stations that rejected the configuration'),
    failedCount: z.number().describe('Stations where the push failed'),
  })
  .passthrough();

const pushStationItem = z
  .object({
    id: z.number().describe('Push station row ID'),
    stationId: z.string().describe('Station UUID'),
    stationName: z.string().describe('Human-readable station identifier'),
    status: z.string().describe('Per-station push status'),
    errorInfo: z.string().nullable().describe('Error details when status is rejected or failed'),
    updatedAt: z.string().describe('ISO timestamp when this row was last updated'),
  })
  .passthrough();

const pushDetailItem = z
  .object({
    id: z.string().describe('Push ID'),
    templateId: z.string().describe('Source config template ID'),
    status: z.string().describe('Push status (active or completed)'),
    stationCount: z.number().describe('Total number of target stations'),
    createdAt: z.string().describe('ISO timestamp when push was created'),
    updatedAt: z.string().describe('ISO timestamp when push was last updated'),
    pendingCount: z.number().describe('Stations still pending'),
    acceptedCount: z.number().describe('Stations that accepted the configuration'),
    rejectedCount: z.number().describe('Stations that rejected the configuration'),
    failedCount: z.number().describe('Stations where the push failed'),
    stations: z.array(pushStationItem).describe('Paginated per-station results'),
    stationsTotal: z.number().describe('Total number of stations in this push'),
  })
  .passthrough();

const templateParams = z.object({ id: z.string().describe('Template ID') });

// The extra field of a 400 reply: DATA_PLAN_SETTING_IN_TEMPLATE names the
// refused variables, VALIDATION_ERROR describes the variable problem.
export const templateRefusalDetails = {
  details: z
    .object({
      variables: z
        .union([z.array(z.string()), z.string()])
        .optional()
        .describe(
          'DATA_PLAN_SETTING_IN_TEMPLATE: the refused variables (Component.Variable, or the OCPP 1.6 key); VALIDATION_ERROR: the variable problem',
        ),
    })
    .passthrough()
    .optional()
    .describe('Details of the refusal'),
};

const targetFilterSchema = z
  .object({
    siteId: z.string().optional(),
    vendorId: z.string().optional(),
    model: z.string().optional(),
    stationId: z.string().optional(),
    dataPlan: z.enum(DATA_PLANS).optional().describe(DATA_PLAN_FILTER_DESCRIPTION),
  })
  .optional()
  .nullable();

const templateVariableInput = z.object({
  // OCPP 1.6 has no Component concept - empty string is valid for 1.6 templates
  component: z.string().max(100),
  variable: z.string().min(1).max(100),
  variableInstance: z
    .string()
    .min(1)
    .max(50)
    .nullable()
    .optional()
    .describe(VARIABLE_INSTANCE_DESCRIPTION),
  value: z.string().max(2500),
});

type TemplateVariable = z.infer<typeof templateVariableInput>;

/**
 * Template variable rules beyond the schema: an OCPP 1.6 key has no variable
 * instance, and a template sets each (component, variable, variable
 * instance) once. Returns the 400 body, or null when valid.
 */
export function templateVariablesProblem(
  ocppVersion: string,
  variables: readonly TemplateVariable[],
): { error: string; code: 'VALIDATION_ERROR'; details: { variables: string } } | null {
  if (ocppVersion === '1.6' && variables.some((v) => v.variableInstance != null)) {
    return {
      error: 'OCPP 1.6 configuration keys have no variable instance',
      code: 'VALIDATION_ERROR',
      details: { variables: 'Remove the variable instance of every OCPP 1.6 key' },
    };
  }
  const seen = new Set<string>();
  for (const v of variables) {
    const identity = JSON.stringify([
      v.component.trim(),
      v.variable.trim(),
      v.variableInstance ?? null,
    ]);
    if (seen.has(identity)) {
      const name = [v.component.trim(), v.variable.trim()].filter((p) => p !== '').join('.');
      const instance = v.variableInstance != null ? `[${v.variableInstance}]` : '';
      return {
        error: 'A template sets each variable once',
        code: 'VALIDATION_ERROR',
        details: { variables: `${name}${instance} is listed more than once` },
      };
    }
    seen.add(identity);
  }
  return null;
}

const filterOptionsQuery = z.object({
  siteId: z.string().optional().describe('Filter stations by site'),
  vendorId: z.string().optional().describe('Filter stations by vendor'),
  model: z.string().optional().describe('Filter stations by model'),
});

const createTemplateBody = z.object({
  name: z.string().min(1).max(255).describe('Template name'),
  description: z.string().max(1000).optional().describe('Template description'),
  ocppVersion: z.enum(['2.1', '1.6']).default('2.1').describe('OCPP version for this template'),
  variables: z
    .array(templateVariableInput)
    .min(1)
    .max(500)
    .describe('Variable definitions to set on target stations'),
  targetFilter: targetFilterSchema.describe('Filter to select target stations'),
});

const updateTemplateBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  ocppVersion: z.enum(['2.1', '1.6']).optional().describe('OCPP version for this template'),
  variables: z.array(templateVariableInput).min(1).max(500).optional(),
  targetFilter: targetFilterSchema,
});

/** Station conditions for the stations a config template targets. */
function templateTargetConditions(template: {
  stationId: string | null;
  targetFilter: unknown;
}): SQL[] {
  const target = configTemplateTarget(template);
  // Conformance test stations are never a template target.
  const conds: SQL[] = [isOperatorStation()];
  if (target.stationId != null) conds.push(eq(chargingStations.id, target.stationId));
  if (target.siteId != null) conds.push(eq(chargingStations.siteId, target.siteId));
  if (target.vendorId != null) conds.push(eq(chargingStations.vendorId, target.vendorId));
  if (target.model != null) conds.push(eq(chargingStations.model, target.model));
  if (target.dataPlan != null) conds.push(sql`${effectiveDataPlanSql} = ${target.dataPlan}`);
  return conds;
}

export function configTemplateRoutes(app: FastifyInstance): void {
  // Filter options for target filter dropdowns
  app.get(
    '/config-templates/filter-options',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Get filter options for config template targeting',
        operationId: 'getConfigTemplateFilterOptions',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(filterOptionsQuery),
        response: { 200: itemResponse(filterOptionsItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof filterOptionsQuery>;
      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);

      const siteQuery = db.select({ id: sites.id, name: sites.name }).from(sites);
      const [siteRows, vendorRows, modelRows] = await Promise.all([
        accessibleSiteIds != null
          ? siteQuery.where(inArray(sites.id, accessibleSiteIds)).orderBy(asc(sites.name))
          : siteQuery.orderBy(asc(sites.name)),
        db.select({ id: vendors.id, name: vendors.name }).from(vendors).orderBy(asc(vendors.name)),
        db
          .selectDistinct({ model: chargingStations.model })
          .from(chargingStations)
          .where(
            accessibleSiteIds != null
              ? and(
                  isNotNull(chargingStations.model),
                  isOperatorStation(),
                  inArray(chargingStations.siteId, accessibleSiteIds),
                )
              : and(isNotNull(chargingStations.model), isOperatorStation()),
          )
          .orderBy(asc(chargingStations.model)),
      ]);

      const stationConds = [isOperatorStation()];
      if (query.siteId) stationConds.push(eq(chargingStations.siteId, query.siteId));
      if (query.vendorId) stationConds.push(eq(chargingStations.vendorId, query.vendorId));
      if (query.model) stationConds.push(eq(chargingStations.model, query.model));
      if (accessibleSiteIds != null && accessibleSiteIds.length > 0) {
        stationConds.push(inArray(chargingStations.siteId, accessibleSiteIds));
      }

      const stationRows =
        accessibleSiteIds != null && accessibleSiteIds.length === 0
          ? []
          : await db
              .select({ id: chargingStations.id, stationId: chargingStations.stationId })
              .from(chargingStations)
              .where(and(...stationConds))
              .orderBy(asc(chargingStations.stationId))
              .limit(500);

      return {
        sites: siteRows,
        vendors: vendorRows,
        models: modelRows.map((r) => r.model as string),
        stations: stationRows,
        dataPlans: [...DATA_PLANS],
      };
    },
  );

  // List templates
  app.get(
    '/config-templates',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'List configuration templates',
        operationId: 'listConfigTemplates',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(templateItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      // A restricted user sees company-wide templates and the templates bound
      // to its own sites or stations, never another site's.
      const scope =
        accessibleSiteIds != null ? configTemplateInScopeSql(accessibleSiteIds) : undefined;

      const [rows, countResult] = await Promise.all([
        db
          .select()
          .from(configTemplates)
          .where(scope)
          .orderBy(desc(configTemplates.createdAt), desc(configTemplates.id))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(configTemplates).where(scope),
      ]);

      const data = await Promise.all(
        rows.map(async (template) => {
          const conds = [
            templateProtocolCondition(template.ocppVersion),
            ...templateTargetConditions(template),
          ];
          if (accessibleSiteIds != null) {
            if (accessibleSiteIds.length === 0) return { ...template, matchingStationsCount: 0 };
            conds.push(inArray(chargingStations.siteId, accessibleSiteIds));
          }
          const [r] = await db
            .select({ total: count() })
            .from(chargingStations)
            .where(and(...conds));
          return { ...template, matchingStationsCount: r?.total ?? 0 };
        }),
      );

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Get template
  app.get(
    '/config-templates/:id',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Get configuration template',
        operationId: 'getConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          200: itemResponse(templateItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const template = await findScopedConfigTemplate(id, accessibleSiteIds);
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      return template;
    },
  );

  // Create template
  app.post(
    '/config-templates',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Create a configuration template',
        description:
          'Creates a configuration template. A variable that names a station credential (BasicAuthPassword, AuthorizationKey) is refused with 400 STATION_CREDENTIALS_ROUTE_REQUIRED: change station passwords with POST /v1/stations/{id}/credentials. A variable the boot push owns (the heartbeat interval and the meter value settings) is refused with 400 DATA_PLAN_SETTING_IN_TEMPLATE, details.variables naming the refused variables: they come from the OCPP settings and the station data plan. An OCPP 1.6 template with a variable instance, or a variable listed twice, answers 400 VALIDATION_ERROR.',
        operationId: 'createConfigTemplate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTemplateBody),
        response: {
          201: itemResponse(templateItem),
          400: errorWith(
            'Invalid variables, a station credential, security or boot-owned variable',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.STATION_CREDENTIALS_ROUTE_REQUIRED,
              ERROR_CODES.STATION_SECURITY_ROUTE_REQUIRED,
              ERROR_CODES.DATA_PLAN_SETTING_IN_TEMPLATE,
            ],
            templateRefusalDetails,
          ),
          404: errorWith('Target not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.TEMPLATE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createTemplateBody>;
      assertNoCredentialVariables(body.variables);
      assertNoBootOwnedVariables(body.ocppVersion, body.variables);
      const problem = templateVariablesProblem(body.ocppVersion, body.variables);
      if (problem != null) {
        await reply.status(400).send(problem);
        return;
      }
      const { userId } = request.user as { userId: string };
      const createSiteIds = await getUserSiteIds(userId);
      if (isRestrictedCompanyWideWrite(createSiteIds, body.targetFilter)) {
        await reply.status(404).send(TEMPLATE_NOT_FOUND);
        return;
      }
      const outOfScope = await targetFilterOutOfScope(body.targetFilter, createSiteIds);
      if (outOfScope != null) {
        await reply.status(404).send(targetFilterNotFound(outOfScope));
        return;
      }

      const [template] = await db
        .insert(configTemplates)
        .values({
          name: body.name,
          description: body.description ?? null,
          ocppVersion: body.ocppVersion,
          variables: body.variables,
          targetFilter: body.targetFilter ?? null,
        })
        .returning();

      if (template != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: configTemplateAuditLog, idColumn: 'template_id' },
          {
            entityId: template.id,
            entityIdSnapshot: template.id,
            action: 'created',
            ...actor,
            after: template,
          },
          db,
          request.log,
        );
      }

      return reply.status(201).send(template);
    },
  );

  // Update template
  app.patch(
    '/config-templates/:id',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Update a configuration template',
        operationId: 'updateConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        body: zodSchema(updateTemplateBody),
        response: {
          200: itemResponse(templateItem),
          400: errorWith(
            'Validation error, a station credential, security or boot-owned variable',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.STATION_CREDENTIALS_ROUTE_REQUIRED,
              ERROR_CODES.STATION_SECURITY_ROUTE_REQUIRED,
              ERROR_CODES.DATA_PLAN_SETTING_IN_TEMPLATE,
            ],
            templateRefusalDetails,
          ),
          404: errorWith('Template, site or station not found', [
            ERROR_CODES.TEMPLATE_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const body = request.body as z.infer<typeof updateTemplateBody>;
      if (body.variables !== undefined) assertNoCredentialVariables(body.variables);

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const existing = await findScopedConfigTemplate(id, accessibleSiteIds);
      if (
        existing == null ||
        isRestrictedCompanyWideWrite(
          accessibleSiteIds,
          existing.targetFilter,
          existing.stationId,
        ) ||
        (body.targetFilter !== undefined &&
          isRestrictedCompanyWideWrite(accessibleSiteIds, body.targetFilter, existing.stationId))
      ) {
        await reply.status(404).send(TEMPLATE_NOT_FOUND);
        return;
      }
      // A template bound to a station targets that station only: its target
      // filter cannot be changed (it would widen the template's reach).
      if (existing.stationId != null && body.targetFilter !== undefined) {
        await reply.status(400).send({
          error: 'A station template has no target filter',
          code: 'VALIDATION_ERROR',
          details: { targetFilter: 'A template bound to a station targets that station only' },
        });
        return;
      }
      const outOfScope = await targetFilterOutOfScope(body.targetFilter, accessibleSiteIds);
      if (outOfScope != null) {
        await reply.status(404).send(targetFilterNotFound(outOfScope));
        return;
      }
      // The version and the variables are checked together, whichever changes.
      if (body.variables !== undefined || body.ocppVersion !== undefined) {
        const ocppVersion = body.ocppVersion ?? existing.ocppVersion;
        const variables =
          body.variables ??
          (Array.isArray(existing.variables) ? (existing.variables as TemplateVariable[]) : []);
        assertNoBootOwnedVariables(ocppVersion, variables);
        const problem = templateVariablesProblem(ocppVersion, variables);
        if (problem != null) {
          await reply.status(400).send(problem);
          return;
        }
      }

      const [updated] = await db
        .update(configTemplates)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(configTemplates.id, id))
        .returning();

      if (updated != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: configTemplateAuditLog, idColumn: 'template_id' },
          {
            entityId: updated.id,
            entityIdSnapshot: updated.id,
            action: 'updated',
            ...actor,
            before: existing,
            after: updated,
          },
          db,
          request.log,
        );
      }

      return updated;
    },
  );

  // Duplicate template
  app.post(
    '/config-templates/:id/duplicate',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Duplicate a configuration template',
        operationId: 'duplicateConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          201: itemResponse(templateItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const original = await findScopedConfigTemplate(id, accessibleSiteIds);
      if (
        original == null ||
        isRestrictedCompanyWideWrite(accessibleSiteIds, original.targetFilter, original.stationId)
      ) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const [duplicate] = await db
        .insert(configTemplates)
        .values({
          name: `${original.name} (Copy)`,
          description: original.description,
          ocppVersion: original.ocppVersion,
          variables: original.variables,
          // The copy is not bound to a station. A copy of a station template
          // targets that station through its filter, so it never reaches
          // further than the original.
          targetFilter:
            original.stationId != null ? { stationId: original.stationId } : original.targetFilter,
        })
        .returning();

      if (duplicate != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: configTemplateAuditLog, idColumn: 'template_id' },
          {
            entityId: duplicate.id,
            entityIdSnapshot: duplicate.id,
            action: 'created',
            ...actor,
            after: duplicate,
            notes: `Duplicated from ${id}`,
          },
          db,
          request.log,
        );
      }

      return reply.status(201).send(duplicate);
    },
  );

  // Delete template
  app.delete(
    '/config-templates/:id',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Delete a configuration template',
        operationId: 'deleteConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          204: { type: 'null' as const },
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const existing = await findScopedConfigTemplate(id, accessibleSiteIds);
      if (
        existing == null ||
        isRestrictedCompanyWideWrite(accessibleSiteIds, existing.targetFilter, existing.stationId)
      ) {
        await reply.status(404).send(TEMPLATE_NOT_FOUND);
        return;
      }

      await db.delete(configTemplates).where(eq(configTemplates.id, id));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: configTemplateAuditLog, idColumn: 'template_id' },
        {
          entityId: null,
          entityIdSnapshot: id,
          action: 'deleted',
          ...actor,
          before: existing,
        },
        db,
        request.log,
      );

      return reply.status(204).send();
    },
  );

  const matchingStationsQuery = paginationQuery.extend({
    status: z.enum(['online', 'offline']).optional().describe('Filter by online status'),
  });

  // Preview matching stations for a template's target filter
  app.get(
    '/config-templates/:id/matching-stations',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Preview stations matching the template target filter',
        operationId: 'listConfigTemplateMatchingStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        querystring: zodSchema(matchingStationsQuery),
        response: {
          200: paginatedResponse(matchingStationItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const query = request.query as z.infer<typeof matchingStationsQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const template = await findScopedConfigTemplate(id, accessibleSiteIds);
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const ocppVersion = template.ocppVersion;

      // Show all stations matching the filter (online + offline) so this list
      // agrees with the matchingStationsCount shown on the templates list page.
      // The push endpoint applies its own isOnline check separately.
      const conditions = [
        templateProtocolCondition(ocppVersion),
        ...templateTargetConditions(template),
      ];
      if (query.status === 'online') conditions.push(eq(chargingStations.isOnline, true));
      if (query.status === 'offline') conditions.push(eq(chargingStations.isOnline, false));

      if (accessibleSiteIds != null && accessibleSiteIds.length === 0)
        return { data: [], total: 0 };
      if (accessibleSiteIds != null)
        conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));

      const whereClause = and(...conditions);

      const [data, countResult] = await Promise.all([
        db
          .select({
            id: chargingStations.id,
            stationId: chargingStations.stationId,
            model: chargingStations.model,
            isOnline: chargingStations.isOnline,
            siteName: sites.name,
            vendorName: vendors.name,
          })
          .from(chargingStations)
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .leftJoin(vendors, eq(chargingStations.vendorId, vendors.id))
          .where(whereClause)
          .orderBy(asc(chargingStations.stationId))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(chargingStations).where(whereClause),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Push config to matching stations (tracked)
  app.post(
    '/config-templates/:id/push',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Push configuration template variables to matching stations via SetVariables',
        description:
          'Resolves online stations matching the template target filter and dispatches SetVariables (OCPP 2.1) or ChangeConfiguration (OCPP 1.6) for every variable. Creates a config_template_pushes row plus one config_template_push_stations row per target. Per-variable results stream back asynchronously. Returns the pushId so the caller can poll progress. A template that names a station credential (BasicAuthPassword, AuthorizationKey) is refused with 400 STATION_CREDENTIALS_ROUTE_REQUIRED, and one saved before v0.1.48 that names a boot-owned variable (the heartbeat interval or a meter value setting) with 400 DATA_PLAN_SETTING_IN_TEMPLATE until those rows are removed.',
        operationId: 'pushConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          200: itemResponse(z.object({ success: z.boolean(), pushId: z.string() }).passthrough()),
          400: errorWith(
            'Station credential, security or boot-owned variable',
            [
              ERROR_CODES.STATION_CREDENTIALS_ROUTE_REQUIRED,
              ERROR_CODES.STATION_SECURITY_ROUTE_REQUIRED,
              ERROR_CODES.DATA_PLAN_SETTING_IN_TEMPLATE,
            ],
            templateRefusalDetails,
          ),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const template = await findScopedConfigTemplate(id, accessibleSiteIds);
      // A company-wide template reaches every site, so pushing it needs
      // access to every site (owner decision 2026-10-09).
      if (
        template == null ||
        isRestrictedCompanyWideWrite(accessibleSiteIds, template.targetFilter, template.stationId)
      ) {
        await reply.status(404).send(TEMPLATE_NOT_FOUND);
        return;
      }

      const variables = template.variables as TemplateVariable[];
      if (variables.length === 0) {
        return { success: true, pushId: '' };
      }
      // A template saved before v0.1.45 can still name a credential, and one
      // saved before v0.1.48 a boot-owned variable.
      assertNoCredentialVariables(variables);
      assertNoBootOwnedVariables(template.ocppVersion, variables);

      const ocppVersion = template.ocppVersion;

      // Resolve target stations, filtered by OCPP protocol. A template bound
      // to a station reaches that station only.
      const conditions = [
        eq(chargingStations.isOnline, true),
        templateProtocolCondition(ocppVersion),
        ...templateTargetConditions(template),
      ];

      if (accessibleSiteIds != null && accessibleSiteIds.length === 0) {
        return { success: true, pushId: '' };
      }
      if (accessibleSiteIds != null)
        conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));

      const targetStations = await db
        .select({ id: chargingStations.id, stationId: chargingStations.stationId })
        .from(chargingStations)
        .where(and(...conditions));

      if (targetStations.length === 0) {
        return { success: true, pushId: '' };
      }

      // Create push record
      const [push] = await db
        .insert(configTemplatePushes)
        .values({
          templateId: id,
          status: 'active',
          stationCount: targetStations.length,
        })
        .returning();

      const pushId = push?.id ?? '';

      // Insert push station rows
      await db.insert(configTemplatePushStations).values(
        targetStations.map((s) => ({
          pushId,
          stationId: s.id,
          status: 'pending' as const,
        })),
      );

      // Process in background
      void processConfigPush(pushId, targetStations, variables, ocppVersion);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: configTemplateAuditLog, idColumn: 'template_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'pushed',
          ...actor,
          notes: `Pushed to ${String(targetStations.length)} station(s)`,
        },
        db,
        request.log,
      );

      return { success: true, pushId };
    },
  );

  // Push history for a template
  app.get(
    '/config-templates/:id/pushes',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'List push history for a configuration template',
        operationId: 'listConfigTemplatePushes',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(pushItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const template = await findScopedConfigTemplate(id, accessibleSiteIds);
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      // A restricted user sees only the pushes that reached its stations, with
      // the counts of those stations only.
      const stationScope =
        accessibleSiteIds != null
          ? stationInSitesSql(configTemplatePushStations.stationId, accessibleSiteIds)
          : undefined;
      const pushWhere =
        stationScope == null
          ? eq(configTemplatePushes.templateId, id)
          : and(
              eq(configTemplatePushes.templateId, id),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(configTemplatePushStations)
                  .where(
                    and(
                      eq(configTemplatePushStations.pushId, configTemplatePushes.id),
                      stationScope,
                    ),
                  ),
              ),
            );

      const [pushes, countResult] = await Promise.all([
        db
          .select()
          .from(configTemplatePushes)
          .where(pushWhere)
          .orderBy(desc(configTemplatePushes.createdAt), desc(configTemplatePushes.id))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(configTemplatePushes).where(pushWhere),
      ]);

      // Batch-fetch status counts for all pushes in one query
      const pushIds = pushes.map((p) => p.id);
      const allStatusCounts =
        pushIds.length > 0
          ? await db
              .select({
                pushId: configTemplatePushStations.pushId,
                status: configTemplatePushStations.status,
                count: count(),
              })
              .from(configTemplatePushStations)
              .where(and(inArray(configTemplatePushStations.pushId, pushIds), stationScope))
              .groupBy(configTemplatePushStations.pushId, configTemplatePushStations.status)
          : [];

      // Group counts by pushId
      const countsByPush = new Map<string, Record<string, number>>();
      for (const row of allStatusCounts) {
        if (!countsByPush.has(row.pushId)) {
          countsByPush.set(row.pushId, {
            pendingCount: 0,
            acceptedCount: 0,
            rejectedCount: 0,
            failedCount: 0,
          });
        }
        const counts = countsByPush.get(row.pushId);
        if (counts != null) {
          counts[`${row.status}Count`] = row.count;
        }
      }

      const data = pushes.map((push) => {
        const counts = countsByPush.get(push.id) ?? {
          pendingCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          failedCount: 0,
        };
        const stationCount =
          stationScope == null
            ? push.stationCount
            : Object.values(counts).reduce((sum, n) => sum + n, 0);
        return { ...push, ...counts, stationCount };
      });

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Push detail with per-station results (paginated)
  app.get(
    '/config-template-pushes/:pushId',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Get config template push detail with per-station results',
        operationId: 'getConfigTemplatePushDetail',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ pushId: z.string().describe('Push ID') })),
        querystring: zodSchema(paginationQuery),
        response: {
          200: itemResponse(pushDetailItem),
          404: errorWith('Push not found', [ERROR_CODES.PUSH_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { pushId } = request.params as { pushId: string };
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [push] = await db
        .select()
        .from(configTemplatePushes)
        .where(eq(configTemplatePushes.id, pushId));
      if (push == null) {
        await reply.status(404).send({ error: 'Push not found', code: 'PUSH_NOT_FOUND' });
        return;
      }

      // A restricted user sees only its own stations of the push, and a push
      // that reached none of them does not exist for it.
      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const stationWhere =
        accessibleSiteIds == null
          ? eq(configTemplatePushStations.pushId, pushId)
          : and(
              eq(configTemplatePushStations.pushId, pushId),
              stationInSitesSql(configTemplatePushStations.stationId, accessibleSiteIds),
            );

      // Get status counts
      const statusCounts = await db
        .select({
          status: configTemplatePushStations.status,
          count: count(),
        })
        .from(configTemplatePushStations)
        .where(stationWhere)
        .groupBy(configTemplatePushStations.status);
      const visibleTotal = statusCounts.reduce((sum, row) => sum + row.count, 0);
      if (accessibleSiteIds != null && visibleTotal === 0) {
        await reply.status(404).send({ error: 'Push not found', code: 'PUSH_NOT_FOUND' });
        return;
      }

      const counts: Record<string, number> = {
        acceptedCount: 0,
        rejectedCount: 0,
        failedCount: 0,
        pendingCount: 0,
      };
      for (const row of statusCounts) {
        counts[`${row.status}Count`] = row.count;
      }

      const stations = await db
        .select({
          id: configTemplatePushStations.id,
          stationId: configTemplatePushStations.stationId,
          stationName: chargingStations.stationId,
          status: configTemplatePushStations.status,
          errorInfo: configTemplatePushStations.errorInfo,
          updatedAt: configTemplatePushStations.updatedAt,
        })
        .from(configTemplatePushStations)
        .innerJoin(chargingStations, eq(configTemplatePushStations.stationId, chargingStations.id))
        .where(stationWhere)
        .orderBy(asc(chargingStations.stationId))
        .limit(limit)
        .offset(offset);

      const stationCount = accessibleSiteIds == null ? push.stationCount : visibleTotal;
      return { ...push, ...counts, stationCount, stations, stationsTotal: stationCount };
    },
  );

  // Config drift detection for a station
  app.get(
    '/stations/:id/config-drift',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Compare station variables against matching config templates',
        operationId: 'getStationConfigDrift',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ id: z.string().describe('Station ID') })),
        response: {
          200: arrayResponse(configDriftItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      // Get station details for filter matching
      const [station] = await db
        .select({
          id: chargingStations.id,
          siteId: chargingStations.siteId,
          vendorId: chargingStations.vendorId,
          model: chargingStations.model,
          ocppProtocol: chargingStations.ocppProtocol,
          dataPlan: sql<string>`${effectiveDataPlanSql}`,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (!siteInScope(accessibleSiteIds, station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Get all templates
      const templates = await db.select().from(configTemplates);

      // Templates that target this station. A template bound to a station
      // matches that station only. A template of another OCPP version is
      // never pushed to the station (its variable names differ), so it
      // cannot drift either.
      const matchStation = {
        ...station,
        dataPlan: isDataPlan(station.dataPlan) ? station.dataPlan : ('wifi_or_wired' as const),
      };
      const matchingTemplates = templates.filter(
        (t) =>
          templateReachesProtocol(t.ocppVersion, station.ocppProtocol) &&
          configTemplateMatchesStation(t, matchStation),
      );

      if (matchingTemplates.length === 0) return [];

      // Get actual station variables
      const actualVars = await db
        .select()
        .from(stationConfigurations)
        .where(eq(stationConfigurations.stationId, id));

      const drifts = [];
      for (const template of matchingTemplates) {
        // The data plan sets the boot-owned values at every boot: never drift.
        const variables = (template.variables as TemplateVariable[]).filter(
          (v) => !isBootOwnedStationSetting(template.ocppVersion, v.component, v.variable),
        );

        for (const expected of variables) {
          const actual = findTemplateTargetConfiguration(
            actualVars,
            expected.component,
            expected.variable,
            expected.variableInstance,
          );
          if (hasConfigDrift(station.ocppProtocol, expected, actual)) {
            drifts.push({
              component: expected.component,
              variable: expected.variable,
              variableInstance: expected.variableInstance ?? null,
              expectedValue: expected.value,
              actualValue: actual?.value ?? null,
              hasDrift: true,
            });
          }
        }
      }

      return drifts;
    },
  );
}
