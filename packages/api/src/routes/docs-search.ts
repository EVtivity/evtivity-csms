// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `GET /v1/docs/search`: passages of the public EVtivity documentation. The
 * AI tool `docs_search` (every surface with tools, and MCP) runs it. Any
 * signed-in user may call it: the passages are public website text and hold
 * no site data, so it needs no permission.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, users } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse } from '../lib/response-schemas.js';
import type { JwtPayload } from '../plugins/auth.js';
import { DOCS_LANGUAGES } from '../services/ai/docs/passages.js';
import type { DocsLanguage } from '../services/ai/docs/passages.js';
import {
  DOCS_SEARCH_DEFAULT_LIMIT,
  DOCS_SEARCH_MAX_LIMIT,
  DOCS_SEARCH_MAX_QUERY,
  DOCS_SEARCH_OPERATION_ID,
  isDocsLanguage,
  searchDocs,
} from '../services/ai/docs/docs-search.js';

const searchQuery = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(DOCS_SEARCH_MAX_QUERY)
    .describe('What to look up, in words, such as "change the company currency"'),
  language: z
    .enum(DOCS_LANGUAGES)
    .optional()
    .describe(
      "Language of the passages (en, de, es, ko, zh, zh-TW); default the user's CSMS language. English is searched when the language has no match",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DOCS_SEARCH_MAX_LIMIT)
    .optional()
    .describe(
      `Passages to return, 1 to ${String(DOCS_SEARCH_MAX_LIMIT)}; default ${String(DOCS_SEARCH_DEFAULT_LIMIT)}`,
    ),
});

const passage = z
  .object({
    id: z.string().describe('Passage id; cite the passage by this id'),
    title: z.string().describe('Page title and section heading'),
    url: z.string().describe('Link to the section on evtivity.com'),
    text: z.string().describe('Section text (markdown)'),
  })
  .passthrough();

const searchResponse = z
  .object({
    language: z.enum(DOCS_LANGUAGES).describe('Language of the returned passages'),
    fallback: z
      .boolean()
      .describe('True when the requested language had no match and English passages are returned'),
    results: z.array(passage).describe('Best matching passages, best first'),
  })
  .passthrough();

async function userLanguage(userId: string | undefined): Promise<DocsLanguage> {
  if (userId === undefined) return 'en';
  const [row] = await db
    .select({ language: users.language })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return isDocsLanguage(row?.language) ? row.language : 'en';
}

export function docsSearchRoutes(app: FastifyInstance): void {
  app.get(
    '/docs/search',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Documentation'],
        summary:
          'Search the EVtivity documentation (how to use, set up and configure the CSMS) and get passages to cite',
        operationId: DOCS_SEARCH_OPERATION_ID,
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(searchQuery),
        response: { 200: itemResponse(searchResponse) },
      },
    },
    async (request) => {
      const { query, language, limit } = request.query as z.infer<typeof searchQuery>;
      const { userId } = request.user as Partial<JwtPayload>;
      const lang = language ?? (await userLanguage(userId));
      return searchDocs(query, lang, limit ?? DOCS_SEARCH_DEFAULT_LIMIT);
    },
  );
}
