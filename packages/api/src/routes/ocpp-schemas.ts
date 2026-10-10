// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib';
import {
  ocppRequestSchemaPath,
  schemaToCommandDef,
  type CommandDef,
  type OcppRequestSchema,
} from '@evtivity/lib/ocpp-command-schema';
import type { FastifyInstance } from 'fastify';
import {
  ActionRegistry,
  type ActionName,
  ActionRegistry16,
  type ActionName16,
} from '@evtivity/ocpp';
import { errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { readOcppSchemaFile } from '../lib/ocpp-schema-files.js';
import { authorize } from '../middleware/rbac.js';

// Processed CommandDefs per `version:action`. The schema files never change at
// runtime, so the example's datetime fields carry the first request's time.
const commandDefCache = new Map<string, CommandDef>();

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
      const { version } = request.query as { version?: string };
      const is16 = version === 'ocpp1.6';

      const registry = is16 ? ActionRegistry16 : ActionRegistry;
      const entry = registry[action as ActionName & ActionName16] as
        | { validateRequest: (p: unknown) => boolean }
        | undefined;
      if (entry == null) {
        return reply.status(404).send({
          error: 'Unknown OCPP action',
          code: 'UNKNOWN_ACTION',
        });
      }

      const content = await readOcppSchemaFile(
        ocppRequestSchemaPath(is16 ? 'ocpp1.6' : 'ocpp2.1', action),
      );
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
    is16: boolean,
  ): Promise<unknown> {
    const { action } = request.params as { action: string };
    const version = is16 ? 'ocpp1.6' : 'ocpp2.1';

    const registry = is16 ? ActionRegistry16 : ActionRegistry;
    const entry = registry[action as ActionName & ActionName16] as
      | { validateRequest: (p: unknown) => boolean }
      | undefined;
    if (entry == null) {
      return reply.status(404).send({
        error: 'Unknown OCPP action',
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
        false,
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
        true,
      ),
  );
}
