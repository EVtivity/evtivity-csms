// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib';
import {
  ocppRequestSchemaPath,
  schemaToCommandDef,
  type CommandDef,
  type OcppCommandVersion,
  type OcppRequestSchema,
} from '@evtivity/lib/ocpp-command-schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ActionRegistry, ActionRegistry16, ActionRegistry201 } from '@evtivity/ocpp';
import { errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { readOcppSchemaFile } from '../lib/ocpp-schema-files.js';
import { zodSchema } from '../lib/zod-schema.js';
import { authorize } from '../middleware/rbac.js';

// Processed CommandDefs per `version:action`. The schema files never change at
// runtime, so the example's datetime fields carry the first request's time.
const commandDefCache = new Map<string, CommandDef>();

type SchemaEntry = { validateRequest: (p: unknown) => boolean };

/** The generated entry of an action in a version, own keys only (`constructor` is not an action). */
function schemaEntry(version: OcppCommandVersion, action: string): SchemaEntry | undefined {
  const registry: Readonly<Record<string, SchemaEntry>> =
    version === 'ocpp1.6'
      ? ActionRegistry16
      : version === 'ocpp2.0.1'
        ? ActionRegistry201
        : ActionRegistry;
  return Object.hasOwn(registry, action) ? registry[action] : undefined;
}

function rawSchemaVersion(version: string | undefined): OcppCommandVersion {
  return version === 'ocpp1.6' || version === 'ocpp2.0.1' ? version : 'ocpp2.1';
}

const v21SchemaQuery = z.object({
  protocol: z
    .enum(['ocpp2.0.1', 'ocpp2.1'])
    .optional()
    .describe(
      'Protocol of the station the form is for: ocpp2.0.1 serves the OCPP 2.0.1 schema, which has no 2.1-only fields or actions (default ocpp2.1)',
    ),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function ocppSchemaRoutes(app: FastifyInstance): void {
  // Raw JSON schema endpoint (existing)
  app.get(
    '/ocpp/schemas/:action',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['OCPP'],
        summary: 'Get JSON schema for an OCPP action',
        operationId: 'getOcppSchema',
        security: [{ bearerAuth: [] }],
        response: {
          404: errorWith('Resource not found', [
            ERROR_CODES.SCHEMA_NOT_FOUND,
            ERROR_CODES.UNKNOWN_ACTION,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { action } = request.params as { action: string };
      const { version: versionQuery } = request.query as { version?: string };
      const version = rawSchemaVersion(versionQuery);

      if (schemaEntry(version, action) == null) {
        return reply.status(404).send({
          error: 'Unknown OCPP action',
          code: 'UNKNOWN_ACTION',
        });
      }

      const content = await readOcppSchemaFile(ocppRequestSchemaPath(version, action));
      if (content == null) {
        return reply.status(404).send({
          error: 'Schema not found',
          code: 'SCHEMA_NOT_FOUND',
        });
      }

      void reply.header('Cache-Control', 'public, max-age=86400');
      void reply.header('Content-Type', 'application/json');
      return reply.send(content);
    },
  );

  // Processed schema endpoints (new)
  async function handleSchemaRequest(
    request: { params: unknown },
    reply: {
      status: (code: number) => { send: (body: unknown) => unknown };
      header: (name: string, value: string) => unknown;
      send: (body: unknown) => unknown;
    },
    version: OcppCommandVersion,
  ): Promise<unknown> {
    const { action } = request.params as { action: string };

    if (schemaEntry(version, action) == null) {
      return reply.status(404).send({
        error:
          version === 'ocpp2.0.1'
            ? 'OCPP 2.0.1 does not define this action'
            : 'Unknown OCPP action',
        code: 'UNKNOWN_ACTION',
      });
    }

    const cacheKey = `${version}:${action}`;
    const cached = commandDefCache.get(cacheKey);
    if (cached != null) {
      void reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(cached);
    }

    const content = await readOcppSchemaFile(ocppRequestSchemaPath(version, action));
    if (content == null) {
      return reply.status(404).send({
        error: 'Schema not found',
        code: 'SCHEMA_NOT_FOUND',
      });
    }
    const schema = tryParseJson(content) as OcppRequestSchema | undefined;
    if (schema == null)
      throw new Error(`The OCPP schema for ${version} ${action} is not valid JSON`);

    const commandDef = schemaToCommandDef(action, version, schema);
    commandDefCache.set(cacheKey, commandDef);

    void reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(commandDef);
  }

  app.get(
    '/ocpp/commands/v21/:action/schema',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['OCPP 2.1 Commands'],
        summary: 'Get processed schema for an OCPP 2.1 command',
        operationId: 'getOcppV21CommandSchema',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(v21SchemaQuery),
        response: {
          404: errorWith('Schema or action not found', [
            ERROR_CODES.SCHEMA_NOT_FOUND,
            ERROR_CODES.UNKNOWN_ACTION,
          ]),
        },
      },
    },
    async (request, reply) =>
      handleSchemaRequest(
        request,
        reply as {
          status: (code: number) => { send: (body: unknown) => unknown };
          header: (name: string, value: string) => unknown;
          send: (body: unknown) => unknown;
        },
        (request.query as z.infer<typeof v21SchemaQuery>).protocol ?? 'ocpp2.1',
      ),
  );

  app.get(
    '/ocpp/commands/v16/:action/schema',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['OCPP 1.6 Commands'],
        summary: 'Get processed schema for an OCPP 1.6 command',
        operationId: 'getOcppV16CommandSchema',
        security: [{ bearerAuth: [] }],
        response: {
          404: errorWith('Schema or action not found', [
            ERROR_CODES.SCHEMA_NOT_FOUND,
            ERROR_CODES.UNKNOWN_ACTION,
          ]),
        },
      },
    },
    async (request, reply) =>
      handleSchemaRequest(
        request,
        reply as {
          status: (code: number) => { send: (body: unknown) => unknown };
          header: (name: string, value: string) => unknown;
          send: (body: unknown) => unknown;
        },
        'ocpp1.6',
      ),
  );
}
