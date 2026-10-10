// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

// The caller's permissions come from the `x-perms` header; a missing one is 403.
vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (...required: string[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const held = String(request.headers['x-perms'] ?? '').split(',');
      request.user = { userId: 'usr_000000000001', roleId: 'rol_000000000001' };
      if (!required.every((p) => held.includes(p))) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
      }
    },
}));

import { aiDefaultsRoutes } from '../routes/ai-defaults.js';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';
import {
  PROMPT_LANGUAGES,
  defaultSystemPrompt,
  storedSystemPrompt,
} from '../services/ai/engine/prompt-defaults.js';
import {
  OCPP_VERSION_RULE,
  SECURITY_RULES,
  SUPPORT_BODY_ONLY,
} from '../services/ai/engine/prompt.js';
import { listProviderEntries } from '../services/ai/core/model-registry.js';

interface DefaultsBody {
  language: string;
  chatbot: { prompt: string; fixedRules: string };
  support: { prompt: string; fixedRules: string };
  providers: Array<{
    id: string;
    defaultModel: string;
    modelsDocsUrl: string;
    models: Array<{ id: string; name: string; vision: boolean; pdf: boolean }>;
  }>;
}

const READ = { 'x-perms': 'settings.ai:read' };

describe('AI defaults routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorate('authenticate', async (request: FastifyRequest) => {
      request.user = { userId: 'usr_000000000002', roleId: 'rol_000000000001' };
      return Promise.resolve();
    });
    aiDefaultsRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    resetSiteAccessMock();
  });

  it('needs settings.ai:read', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/ai/defaults' });
    expect(res.statusCode).toBe(403);
    const other = await app.inject({
      method: 'GET',
      url: '/settings/ai/defaults',
      headers: { 'x-perms': 'settings.system:read' },
    });
    expect(other.statusCode).toBe(403);
  });

  it('answers 404 SETTING_NOT_FOUND to a site-restricted user, like the other AI settings', async () => {
    setMockUserSiteIds(['sit_000000000001']);
    const res = await app.inject({ method: 'GET', url: '/settings/ai/defaults', headers: READ });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
  });

  it.each(PROMPT_LANGUAGES)('returns the built-in prompts in %s', async (language) => {
    const res = await app.inject({
      method: 'GET',
      url: `/settings/ai/defaults?language=${language}`,
      headers: READ,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<DefaultsBody>();
    expect(body.language).toBe(language);
    expect(body.chatbot.prompt).toBe(defaultSystemPrompt('chatbot', language));
    expect(body.support.prompt).toBe(defaultSystemPrompt('support', language));
  });

  it('defaults to English and refuses an unknown language', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/ai/defaults', headers: READ });
    expect(res.json<DefaultsBody>().chatbot.prompt).toBe(defaultSystemPrompt('chatbot', 'en'));
    const bad = await app.inject({
      method: 'GET',
      url: '/settings/ai/defaults?language=fr',
      headers: READ,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('returns the rules always added per surface', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/ai/defaults', headers: READ });
    const body = res.json<DefaultsBody>();
    expect(body.chatbot.fixedRules).toBe(`${SECURITY_RULES}\n\n${OCPP_VERSION_RULE}`);
    expect(body.support.fixedRules).toBe(`${SECURITY_RULES}\n\n${SUPPORT_BODY_ONLY}`);
  });

  it('returns the model registry per provider with a docs link', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/ai/defaults', headers: READ });
    const body = res.json<DefaultsBody>();
    expect(body.providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'gemini', 'deepseek']);
    for (const provider of body.providers) {
      const entry = listProviderEntries().find((e) => e.id === provider.id);
      expect(provider.defaultModel).toBe(entry?.defaultModel);
      expect(provider.models.map((m) => m.id)).toContain(provider.defaultModel);
      expect(provider.modelsDocsUrl).toMatch(/^https:\/\//);
      for (const m of provider.models) expect(m.name).not.toBe('');
    }
    const deepseek = body.providers.find((p) => p.id === 'deepseek');
    expect(deepseek?.models.find((m) => m.id === 'deepseek-v4-pro')).toEqual({
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      vision: false,
      pdf: false,
    });
  });

  it('serves the same defaults to any signed-in user for the profile cards', async () => {
    setMockUserSiteIds(['sit_000000000001']);
    const res = await app.inject({ method: 'GET', url: '/users/me/ai-defaults?language=zh-TW' });
    expect(res.statusCode).toBe(200);
    const body = res.json<DefaultsBody>();
    expect(body.chatbot.prompt).toBe(defaultSystemPrompt('chatbot', 'zh-TW'));
    expect(body.providers).toHaveLength(4);
  });
});

describe('storedSystemPrompt', () => {
  it('stores an unchanged built-in prompt of any language as empty', () => {
    for (const language of PROMPT_LANGUAGES) {
      expect(storedSystemPrompt('chatbot', defaultSystemPrompt('chatbot', language))).toBe('');
      expect(storedSystemPrompt('support', `\n${defaultSystemPrompt('support', language)}  `)).toBe(
        '',
      );
    }
  });

  it('keeps a custom prompt and the other surface prompt as they are', () => {
    expect(storedSystemPrompt('chatbot', 'Be brief.')).toBe('Be brief.');
    const support = defaultSystemPrompt('support', 'en');
    expect(storedSystemPrompt('chatbot', support)).toBe(support);
    expect(storedSystemPrompt('chatbot', '   ')).toBe('');
  });
});
