// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { PROMPT_LANGUAGES, promptLanguage } from '../services/ai/engine/prompt-defaults.js';
import { buildAiDefaults } from '../services/ai/surfaces/defaults.js';

// Settings > AI is company-wide: a site-restricted user gets the same 404 as
// the other AI settings (features/site-access-control.md).
const settingNotFound = { error: 'Setting not found', code: 'SETTING_NOT_FOUND' } as const;

const defaultsQuery = z.object({
  language: z
    .enum(PROMPT_LANGUAGES)
    .optional()
    .describe('CSMS language of the built-in prompts (en, de, es, ko, zh, zh-TW); default en'),
});

const surfaceDefaults = z
  .object({
    prompt: z.string().describe('Built-in system prompt, used when no custom prompt is saved'),
    fixedRules: z
      .string()
      .describe('Rules always added to the system prompt; they cannot be changed or removed'),
  })
  .passthrough();

const modelOption = z
  .object({
    id: z.string().describe('Model id to enter in the model setting'),
    name: z.string().describe('Display name'),
    vision: z.boolean().describe('Whether the model reads image attachments'),
    pdf: z.boolean().describe('Whether the model reads PDF attachments'),
  })
  .passthrough();

const providerModels = z
  .object({
    id: z.string().describe('Provider id (anthropic, openai, gemini, deepseek)'),
    defaultModel: z.string().describe('Model used when the model setting is empty'),
    modelsDocsUrl: z.string().describe("The provider's official page listing its model ids"),
    models: z.array(modelOption).describe('Models known to this release'),
  })
  .passthrough();

const aiDefaultsResponse = z
  .object({
    language: z.enum(PROMPT_LANGUAGES).describe('Language of the returned prompts'),
    chatbot: surfaceDefaults.describe('AI assistant (chatbot) defaults'),
    support: surfaceDefaults.describe('Support case AI draft defaults'),
    providers: z.array(providerModels).describe('Known models per provider'),
  })
  .passthrough();

/**
 * Built-in AI defaults: system prompts, the fixed rules and the model
 * registry. Settings > AI reads the settings route; the profile AI cards,
 * open to every signed-in user, read the `users/me` one.
 */
export function aiDefaultsRoutes(app: FastifyInstance): void {
  app.get(
    '/settings/ai/defaults',
    {
      onRequest: [authorize('settings.ai:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get the built-in AI prompts and models',
        operationId: 'getAiDefaults',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(defaultsQuery),
        response: {
          200: itemResponse(aiDefaultsResponse),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, settingNotFound))) return;
      const { language } = request.query as z.infer<typeof defaultsQuery>;
      return buildAiDefaults(promptLanguage(language));
    },
  );

  app.get(
    '/users/me/ai-defaults',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Get the built-in AI prompts and models for personal AI configuration',
        operationId: 'getMyAiDefaults',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(defaultsQuery),
        response: { 200: itemResponse(aiDefaultsResponse) },
      },
    },
    (request) => {
      const { language } = request.query as z.infer<typeof defaultsQuery>;
      return buildAiDefaults(promptLanguage(language));
    },
  );
}
