// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Write a docs index and point DOCS_INDEX_PATH at it BEFORE the service module
// is imported, so the module-load `docsIndex` is non-empty and the
// docs-section branch in handleAssistantChat is exercised. vi.hoisted runs
// before the (hoisted) import of the service under test.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ai-docs-'));
  const path = join(dir, 'docs-index.json');
  writeFileSync(
    path,
    JSON.stringify([{ path: '/docs/getting-started', title: 'Getting Started', description: 'd' }]),
  );
  process.env['DOCS_INDEX_PATH'] = path;
});

const TABLES = vi.hoisted(() => ({
  chatbotAiConfigs: { __table: 'chatbotAiConfigs', userId: 'user_id' },
  settings: { __table: 'settings', key: 'key', value: 'value' },
  users: {
    __table: 'users',
    id: 'id',
    firstName: 'first_name',
    lastName: 'last_name',
    language: 'language',
  },
}));
const dbResultsByTable = vi.hoisted((): { map: Record<string, unknown[]> } => ({ map: {} }));
function setDbResults(opts: {
  chatbotAiConfigs?: unknown[];
  settings?: unknown[];
  users?: unknown[];
}) {
  dbResultsByTable.map = {
    chatbotAiConfigs: opts.chatbotAiConfigs ?? [],
    settings: opts.settings ?? [],
    users: opts.users ?? [],
  };
}
const makeChain = vi.hoisted(() => () => {
  const chain: Record<string, unknown> = {};
  let table = '';
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn((t: { __table?: string }) => {
    table = t.__table ?? '';
    return chain;
  });
  for (const m of ['where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(dbResultsByTable.map[table] ?? []).then(resolve, reject);
  return chain;
});

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  chatbotAiConfigs: TABLES.chatbotAiConfigs,
  settings: TABLES.settings,
  users: TABLES.users,
  getCompanyCurrency: vi.fn(() => Promise.resolve('USD')),
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), like: vi.fn() }));
vi.mock('@evtivity/lib', () => ({ decryptString: vi.fn((v: string) => `decrypted:${v}`) }));
vi.mock('../lib/config.js', () => ({ config: { SETTINGS_ENCRYPTION_KEY: 'enc-key' } }));
const createAiProvider = vi.hoisted(() => vi.fn());
vi.mock('../services/ai/provider-factory.js', () => ({ createAiProvider }));
const executeToolLoop = vi.hoisted(() => vi.fn());
vi.mock('../services/ai/tool-executor.js', () => ({ executeToolLoop }));

import { handleAssistantChat } from '../services/ai/assistant.service.js';

function makeApp(): FastifyInstance {
  return { inject: vi.fn() } as unknown as FastifyInstance;
}

beforeEach(() => {
  createAiProvider.mockReset();
  executeToolLoop.mockReset();
});

function baseUserConfig() {
  return {
    provider: 'anthropic',
    apiKeyEnc: 'enc',
    model: null,
    temperature: null,
    topP: null,
    topK: null,
    systemPrompt: null,
  };
}

describe('handleAssistantChat docs index injection', () => {
  it('appends the docs section with the en base URL for English users', async () => {
    setDbResults({
      chatbotAiConfigs: [baseUserConfig()],
      users: [{ firstName: 'A', lastName: 'B', language: 'en' }],
    });
    createAiProvider.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' }),
    });
    executeToolLoop.mockResolvedValue({ content: 'ok', apiCallsMade: 0 });

    await handleAssistantChat(makeApp(), 'usr', 'how do I configure X?', [], 'Bearer t');

    const systemPrompt = executeToolLoop.mock.calls[0]![4] as string;
    expect(systemPrompt).toContain('Documentation index');
    expect(systemPrompt).toContain('Getting Started: https://evtivity.com/docs/getting-started');
  });

  it('uses the language-prefixed docs base URL for non-English users', async () => {
    setDbResults({
      chatbotAiConfigs: [baseUserConfig()],
      users: [{ firstName: 'A', lastName: 'B', language: 'es' }],
    });
    createAiProvider.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' }),
    });
    executeToolLoop.mockResolvedValue({ content: 'ok', apiCallsMade: 0 });

    await handleAssistantChat(makeApp(), 'usr', 'como configuro X?', [], 'Bearer t');

    const systemPrompt = executeToolLoop.mock.calls[0]![4] as string;
    expect(systemPrompt).toContain('https://evtivity.com/es/docs/getting-started');
  });
});
