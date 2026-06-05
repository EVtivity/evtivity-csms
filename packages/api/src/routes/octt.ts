// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import { db, octtRuns, octtTestResults } from '@evtivity/database';
import { itemResponse, paginatedResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { zodSchema } from '../lib/zod-schema.js';
import { getPubSub } from '../lib/pubsub.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';

const runResponseSchema = z
  .object({
    id: z.number().int().min(1).describe('Run ID'),
    status: z.enum(['pending', 'running', 'completed', 'failed']).describe('Run status'),
    ocppVersion: z.enum(['ocpp2.1', 'ocpp1.6', 'all']).describe('OCPP version filter'),
    sutType: z.enum(['csms', 'cs']).describe('System under test'),
    totalTests: z.number().int().min(0).describe('Total number of tests in this run'),
    passed: z.number().int().min(0).describe('Number of passed tests'),
    failed: z.number().int().min(0).describe('Number of failed tests'),
    skipped: z.number().int().min(0).describe('Number of skipped tests'),
    errors: z.number().int().min(0).describe('Number of tests that errored'),
    durationMs: z.number().int().min(0).nullable().describe('Total run duration in ms'),
    triggeredBy: z.string().nullable().describe('User ID that triggered the run'),
    startedAt: z.string().nullable().describe('Run start timestamp'),
    completedAt: z.string().nullable().describe('Run completion timestamp'),
    createdAt: z.string().describe('Row creation timestamp'),
  })
  .passthrough();

const testResultSchema = z
  .object({
    id: z.number().int().min(1).describe('Test result row ID'),
    runId: z.number().int().min(1).describe('Parent run ID'),
    testId: z.string().max(100).describe('OCTT test case ID'),
    testName: z.string().max(500).describe('Human-readable test case name'),
    module: z.string().max(100).describe('OCTT module name'),
    ocppVersion: z.enum(['ocpp2.1', 'ocpp1.6']).describe('OCPP version for this test'),
    status: z.enum(['passed', 'failed', 'skipped', 'error']).describe('Test status'),
    durationMs: z.number().int().min(0).describe('Test duration in ms'),
    steps: z.array(z.record(z.unknown())).max(500).nullable().describe('Per-step result details'),
    error: z.string().max(10000).nullable().describe('Error message if the test failed or errored'),
    createdAt: z.string().describe('Row creation timestamp'),
  })
  .passthrough();

const moduleSummarySchema = z
  .object({
    module: z.string().max(100).describe('OCTT module name'),
    ocppVersion: z.enum(['ocpp2.1', 'ocpp1.6']).describe('OCPP version covered by this module'),
    total: z.number().int().min(0).describe('Total test cases in this module'),
    passed: z.number().int().min(0).describe('Number of passed tests'),
    failed: z.number().int().min(0).describe('Number of failed tests'),
    skipped: z.number().int().min(0).describe('Number of skipped tests'),
    errors: z.number().int().min(0).describe('Number of tests that errored'),
  })
  .passthrough();

export function octtRoutes(app: FastifyInstance): void {
  // POST /octt/runs - Trigger a new test run
  app.post(
    '/octt/runs',
    {
      onRequest: [authorize('conformance:write')],
      schema: {
        tags: ['OCTT'],
        summary: 'Trigger a conformance test run',
        operationId: 'createOcttRun',
        security: [{ bearerAuth: [] }],
        body: zodSchema(
          z.object({
            ocppVersion: z
              .enum(['ocpp2.1', 'ocpp1.6', 'all'])
              .optional()
              .default('all')
              .describe('OCPP version filter'),
            sutType: z
              .enum(['csms', 'cs'])
              .optional()
              .default('csms')
              .describe('System under test: csms or cs'),
          }),
        ),
        response: {
          201: itemResponse(runResponseSchema),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          500: errorWith('Insert failed', [ERROR_CODES.INSERT_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const body = request.body as { ocppVersion: string; sutType: string };

      const [run] = await db
        .insert(octtRuns)
        .values({
          ocppVersion: body.ocppVersion,
          sutType: body.sutType,
          triggeredBy: userId,
        })
        .returning();

      if (run == null) {
        await reply.status(500).send({ error: 'Failed to create run', code: 'INSERT_FAILED' });
        return;
      }

      const pubsub = getPubSub();
      await pubsub.publish(
        'octt_run',
        JSON.stringify({ runId: run.id, ocppVersion: body.ocppVersion, sutType: body.sutType }),
      );

      await reply.status(201).send(run);
    },
  );

  // GET /octt/runs - List past runs
  app.get(
    '/octt/runs',
    {
      onRequest: [authorize('conformance:read')],
      schema: {
        tags: ['OCTT'],
        summary: 'List conformance test runs',
        operationId: 'listOcttRuns',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(
          z.object({
            status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
            limit: z.coerce.number().int().min(1).max(100).optional().default(20),
            offset: z.coerce.number().int().min(0).optional().default(0),
          }),
        ),
        response: { 200: paginatedResponse(runResponseSchema) },
      },
    },
    async (request) => {
      const query = request.query as { status?: string; limit: number; offset: number };
      const conditions = [];

      if (query.status != null) {
        conditions.push(
          eq(octtRuns.status, query.status as 'pending' | 'running' | 'completed' | 'failed'),
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [runs, totalResult] = await Promise.all([
        db
          .select()
          .from(octtRuns)
          .where(where)
          .orderBy(desc(octtRuns.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(octtRuns)
          .where(where),
      ]);

      // Compute live counts for in-progress runs
      const inProgressIds = runs
        .filter((r) => r.status === 'running' || r.status === 'pending')
        .map((r) => r.id);

      if (inProgressIds.length > 0) {
        const liveCounts = await db
          .select({
            runId: octtTestResults.runId,
            total: sql<number>`count(*)::int`,
            passed: sql<number>`count(*) filter (where ${octtTestResults.status} = 'passed')::int`,
            failed: sql<number>`count(*) filter (where ${octtTestResults.status} = 'failed')::int`,
            skipped: sql<number>`count(*) filter (where ${octtTestResults.status} = 'skipped')::int`,
            errors: sql<number>`count(*) filter (where ${octtTestResults.status} = 'error')::int`,
          })
          .from(octtTestResults)
          .where(inArray(octtTestResults.runId, inProgressIds))
          .groupBy(octtTestResults.runId);

        const countsMap = new Map(liveCounts.map((c) => [c.runId, c]));
        for (const run of runs) {
          const counts = countsMap.get(run.id);
          if (counts != null) {
            run.totalTests = counts.total;
            run.passed = counts.passed;
            run.failed = counts.failed;
            run.skipped = counts.skipped;
            run.errors = counts.errors;
          }
        }
      }

      return { data: runs, total: totalResult[0]?.count ?? 0 };
    },
  );

  // GET /octt/runs/:id - Run detail with test results
  app.get(
    '/octt/runs/:id',
    {
      onRequest: [authorize('conformance:read')],
      schema: {
        tags: ['OCTT'],
        summary: 'Get conformance test run detail',
        operationId: 'getOcttRun',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ id: z.coerce.number().int().describe('Run ID') })),
        querystring: zodSchema(
          z.object({
            module: z.string().optional(),
            status: z.enum(['passed', 'failed', 'skipped', 'error']).optional(),
          }),
        ),
        response: {
          200: zodSchema(
            z
              .object({
                run: runResponseSchema,
                results: z.array(testResultSchema),
              })
              .passthrough(),
          ),
          404: errorWith('Run not found', [ERROR_CODES.OCTT_RUN_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const query = request.query as { module?: string; status?: string };

      const [run] = await db.select().from(octtRuns).where(eq(octtRuns.id, id));
      if (run == null) {
        await reply.status(404).send({ error: 'Run not found', code: 'OCTT_RUN_NOT_FOUND' });
        return;
      }

      const conditions = [eq(octtTestResults.runId, id)];
      if (query.module != null) {
        conditions.push(eq(octtTestResults.module, query.module));
      }
      if (query.status != null) {
        conditions.push(
          eq(octtTestResults.status, query.status as 'passed' | 'failed' | 'skipped' | 'error'),
        );
      }

      const results = await db
        .select()
        .from(octtTestResults)
        .where(and(...conditions))
        .orderBy(octtTestResults.module, octtTestResults.testId);

      // For in-progress runs, compute live counts from test results
      const runData = { ...run };
      if (run.status === 'running' || run.status === 'pending') {
        const allResults = await db
          .select({
            total: sql<number>`count(*)::int`,
            passed: sql<number>`count(*) filter (where ${octtTestResults.status} = 'passed')::int`,
            failed: sql<number>`count(*) filter (where ${octtTestResults.status} = 'failed')::int`,
            skipped: sql<number>`count(*) filter (where ${octtTestResults.status} = 'skipped')::int`,
            errors: sql<number>`count(*) filter (where ${octtTestResults.status} = 'error')::int`,
          })
          .from(octtTestResults)
          .where(eq(octtTestResults.runId, id));
        const counts = allResults[0];
        if (counts != null) {
          runData.totalTests = counts.total;
          runData.passed = counts.passed;
          runData.failed = counts.failed;
          runData.skipped = counts.skipped;
          runData.errors = counts.errors;
        }
      }

      return { run: runData, results };
    },
  );

  // GET /octt/runs/:id/summary - Per-module aggregation
  app.get(
    '/octt/runs/:id/summary',
    {
      onRequest: [authorize('conformance:read')],
      schema: {
        tags: ['OCTT'],
        summary: 'Get per-module summary for a test run',
        operationId: 'getOcttRunSummary',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ id: z.coerce.number().int().describe('Run ID') })),
        response: {
          200: zodSchema(z.array(moduleSummarySchema)),
          404: errorWith('Run not found', [ERROR_CODES.OCTT_RUN_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };

      const [run] = await db.select().from(octtRuns).where(eq(octtRuns.id, id));
      if (run == null) {
        await reply.status(404).send({ error: 'Run not found', code: 'OCTT_RUN_NOT_FOUND' });
        return;
      }

      const summary = await db
        .select({
          module: octtTestResults.module,
          ocppVersion: octtTestResults.ocppVersion,
          total: sql<number>`count(*)::int`,
          passed: sql<number>`count(*) filter (where ${octtTestResults.status} = 'passed')::int`,
          failed: sql<number>`count(*) filter (where ${octtTestResults.status} = 'failed')::int`,
          skipped: sql<number>`count(*) filter (where ${octtTestResults.status} = 'skipped')::int`,
          errors: sql<number>`count(*) filter (where ${octtTestResults.status} = 'error')::int`,
        })
        .from(octtTestResults)
        .where(eq(octtTestResults.runId, id))
        .groupBy(octtTestResults.module, octtTestResults.ocppVersion)
        .orderBy(octtTestResults.ocppVersion, octtTestResults.module);

      return summary;
    },
  );
}
