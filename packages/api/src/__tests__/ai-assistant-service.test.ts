// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// --- DB mock: results keyed by the queried table so parallel queries
// (resolveConfig + the user lookup) resolve deterministically regardless of
// await ordering. ---
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
  for (const m of ['where', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResultsByTable.map[table] ?? [];
    return Promise.resolve(r).then(resolve, reject);
  };
  return chain;
});

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  chatbotAiConfigs: TABLES.chatbotAiConfigs,
  settings: TABLES.settings,
  users: TABLES.users,
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  like: vi.fn(),
}));

const decryptString = vi.hoisted(() => vi.fn((v: string) => `decrypted:${v}`));
vi.mock('@evtivity/lib', () => ({ decryptString }));

const mockConfig = vi.hoisted(() => ({ SETTINGS_ENCRYPTION_KEY: 'enc-key' }));
vi.mock('../lib/config.js', () => ({ config: mockConfig }));

const createAiProvider = vi.hoisted(() => vi.fn());
vi.mock('../services/ai/provider-factory.js', () => ({ createAiProvider }));

const executeToolLoop = vi.hoisted(() => vi.fn());
vi.mock('../services/ai/tool-executor.js', () => ({ executeToolLoop }));

import {
  handleAssistantChat,
  selectToolCategories,
  selectTools,
} from '../services/ai/assistant.service.js';

function makeApp(): FastifyInstance {
  return { inject: vi.fn() } as unknown as FastifyInstance;
}

beforeEach(() => {
  setDbResults({});
  createAiProvider.mockReset();
  executeToolLoop.mockReset();
  decryptString.mockClear();
  mockConfig.SETTINGS_ENCRYPTION_KEY = 'enc-key';
});

describe('selectToolCategories / parseCategories', () => {
  it('calls the provider with temperature 0 and parses comma-separated categories', async () => {
    const chat = vi
      .fn()
      .mockResolvedValue({ content: 'Dashboard, Sessions', toolCalls: [], finishReason: 'end' });
    const provider = { chat } as never;
    const tags = await selectToolCategories(provider, 'how many sessions', []);
    expect(tags).toEqual(['Dashboard', 'Sessions']);
    expect(chat).toHaveBeenCalledTimes(1);
    const [msgs, tools, sys, opts] = chat.mock.calls[0]!;
    expect(msgs[0].role).toBe('user');
    expect(tools).toEqual([]);
    expect(sys).toContain('tool routing');
    expect(opts).toEqual({ temperature: 0 });
  });

  it('is case-insensitive and drops unknown category names', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: 'dashboard, nonsense, AUDIT',
      toolCalls: [],
      finishReason: 'end',
    });
    const tags = await selectToolCategories({ chat }, 'q', []);
    expect(tags).toEqual(['Dashboard', 'Audit']);
  });

  it('returns an empty array for NONE', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    expect(await selectToolCategories({ chat }, 'hi', [])).toEqual([]);
  });

  it('returns an empty array for empty / null content', async () => {
    const chat = vi.fn().mockResolvedValue({ content: null, toolCalls: [], finishReason: 'end' });
    expect(await selectToolCategories({ chat }, 'hi', [])).toEqual([]);
  });

  it('includes recent user history context in the selection prompt', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    await selectToolCategories({ chat }, 'follow up', [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ]);
    const prompt = chat.mock.calls[0]![0][0].content as string;
    expect(prompt).toContain('Recent conversation context');
    expect(prompt).toContain('earlier question');
    // assistant messages are filtered out of the recent context
    expect(prompt).not.toContain('earlier answer');
  });
});

describe('selectTools', () => {
  it('loads tools for the selected categories', async () => {
    const chat = vi
      .fn()
      .mockResolvedValue({ content: 'Access Logs', toolCalls: [], finishReason: 'end' });
    const tools = await selectTools({ chat }, 'list logs', []);
    expect(tools.map((t) => t.name)).toContain('list_access_logs');
  });

  it('falls back to fallbackTags when no categories selected', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    const tools = await selectTools({ chat }, 'hi', [], { fallbackTags: ['Audit'] });
    expect(tools.map((t) => t.name)).toContain('list_audit');
  });

  it('applies the GET-only filter', async () => {
    const chat = vi
      .fn()
      .mockResolvedValue({ content: 'Access Logs', toolCalls: [], finishReason: 'end' });
    const tools = await selectTools({ chat }, 'hi', [], { filter: (t) => t.method === 'GET' });
    expect(tools.every((t) => t.method === 'GET')).toBe(true);
    // POST tool create_access_log filtered out
    expect(tools.map((t) => t.name)).not.toContain('create_access_log');
  });

  it('caps the result at the provider tool limit', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: 'CSS OCPP 2.1 Actions, CSS OCPP 1.6 Actions, CSS Actions, CSS Management',
      toolCalls: [],
      finishReason: 'end',
    });
    const tools = await selectTools({ chat }, 'hi', []);
    expect(tools.length).toBeLessThanOrEqual(128);
  });
});

describe('handleAssistantChat - config resolution', () => {
  it('uses a per-user config when present and decrypts the api key', async () => {
    setDbResults({
      chatbotAiConfigs: [
        {
          provider: 'anthropic',
          apiKeyEnc: 'enc-secret',
          model: 'claude-x',
          temperature: '0.4',
          topP: '0.8',
          topK: 30,
          systemPrompt: 'custom prompt',
        },
      ],
      users: [{ firstName: 'Jane', lastName: 'Doe', language: 'en' }],
    });
    const selectChat = vi
      .fn()
      .mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    createAiProvider.mockReturnValue({ chat: selectChat });
    executeToolLoop.mockResolvedValue({ content: 'Final answer', apiCallsMade: 2 });

    const result = await handleAssistantChat(makeApp(), 'usr_1', 'hello', [], 'Bearer t');

    expect(decryptString).toHaveBeenCalledWith('enc-secret', 'enc-key');
    expect(createAiProvider).toHaveBeenCalledWith('anthropic', 'decrypted:enc-secret', 'claude-x');
    expect(result).toEqual({ reply: 'Final answer', apiCallsMade: 2 });

    const [, , , tools, systemPrompt, chatOptions] = executeToolLoop.mock.calls[0]!;
    expect(tools).toEqual([]);
    expect(systemPrompt).toContain('custom prompt');
    expect(systemPrompt).toContain('Jane Doe');
    expect(systemPrompt).toContain("in the record's own currency field");
    expect(systemPrompt).toContain('the company currency, EUR.');
    expect(chatOptions).toEqual({ temperature: 0.4, topP: 0.8, topK: 30 });
  });

  it('falls through to system config when the per-user row has empty chatbot fields', async () => {
    setDbResults({
      chatbotAiConfigs: [
        {
          provider: '',
          apiKeyEnc: '',
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
        },
      ],
      settings: [
        { key: 'chatbotAi.enabled', value: true },
        { key: 'chatbotAi.provider', value: 'openai' },
        { key: 'chatbotAi.apiKeyEnc', value: 'sys-enc' },
        { key: 'chatbotAi.model', value: 'gpt-4o' },
        { key: 'chatbotAi.temperature', value: '0' },
        { key: 'chatbotAi.topP', value: '' },
        { key: 'chatbotAi.topK', value: '' },
        { key: 'chatbotAi.systemPrompt', value: '' },
      ],
      users: [{ firstName: 'Sam', lastName: '', language: 'es' }],
    });
    const selectChat = vi
      .fn()
      .mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    createAiProvider.mockReturnValue({ chat: selectChat });
    executeToolLoop.mockResolvedValue({ content: 'respuesta', apiCallsMade: 0 });

    const result = await handleAssistantChat(makeApp(), 'usr_2', 'hola', [], 'Bearer t');

    expect(createAiProvider).toHaveBeenCalledWith('openai', 'decrypted:sys-enc', 'gpt-4o');
    expect(result.reply).toBe('respuesta');
    // temperature 0 preserved; topP/topK empty string -> undefined
    const chatOptions = executeToolLoop.mock.calls[0]![5];
    expect(chatOptions).toEqual({ temperature: 0, topP: undefined, topK: undefined });
    // Spanish default prompt used since systemPrompt empty
    const systemPrompt = executeToolLoop.mock.calls[0]![4] as string;
    expect(systemPrompt).toContain('asistente de gestion');
    expect(systemPrompt).toContain('Sam');
    expect(systemPrompt).toContain('unidades enteras');
    expect(systemPrompt).not.toContain('dolares');
  });

  it('throws AI_NOT_CONFIGURED when system AI is disabled', async () => {
    setDbResults({ settings: [{ key: 'chatbotAi.enabled', value: false }] });
    await expect(handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t')).rejects.toMatchObject(
      {
        code: 'AI_NOT_CONFIGURED',
      },
    );
  });

  it('throws AI_NOT_CONFIGURED when provider or key missing in system config', async () => {
    setDbResults({
      settings: [
        { key: 'chatbotAi.enabled', value: true },
        { key: 'chatbotAi.provider', value: 'openai' },
      ],
    });
    await expect(handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t')).rejects.toMatchObject(
      {
        code: 'AI_NOT_CONFIGURED',
      },
    );
  });

  it('throws when the encryption key is missing for a per-user config', async () => {
    mockConfig.SETTINGS_ENCRYPTION_KEY = '';
    setDbResults({
      chatbotAiConfigs: [
        {
          provider: 'anthropic',
          apiKeyEnc: 'enc',
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
        },
      ],
    });
    await expect(handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t')).rejects.toThrow(
      'SETTINGS_ENCRYPTION_KEY',
    );
  });

  it('throws when the encryption key is missing for a system config', async () => {
    mockConfig.SETTINGS_ENCRYPTION_KEY = '';
    setDbResults({
      settings: [
        { key: 'chatbotAi.enabled', value: true },
        { key: 'chatbotAi.provider', value: 'openai' },
        { key: 'chatbotAi.apiKeyEnc', value: 'sys-enc' },
      ],
    });
    await expect(handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t')).rejects.toThrow(
      'SETTINGS_ENCRYPTION_KEY',
    );
  });

  it('handles a missing user row (no name context, default en prompt)', async () => {
    setDbResults({
      chatbotAiConfigs: [
        {
          provider: 'gemini',
          apiKeyEnc: 'enc',
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
        },
      ],
    });
    const selectChat = vi
      .fn()
      .mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    createAiProvider.mockReturnValue({ chat: selectChat });
    executeToolLoop.mockResolvedValue({ content: 'ok', apiCallsMade: 0 });

    await handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t');

    expect(createAiProvider).toHaveBeenCalledWith('gemini', 'decrypted:enc', undefined);
    const systemPrompt = executeToolLoop.mock.calls[0]![4] as string;
    expect(systemPrompt).toContain('EV charging station management assistant');
    const chatOptions = executeToolLoop.mock.calls[0]![5];
    expect(chatOptions).toEqual({ temperature: undefined, topP: undefined, topK: undefined });
  });

  it('parses non-empty topP/topK/systemPrompt from a system config', async () => {
    setDbResults({
      settings: [
        { key: 'chatbotAi.enabled', value: true },
        { key: 'chatbotAi.provider', value: 'anthropic' },
        { key: 'chatbotAi.apiKeyEnc', value: 'sys-enc' },
        { key: 'chatbotAi.temperature', value: '0.7' },
        { key: 'chatbotAi.topP', value: '0.95' },
        { key: 'chatbotAi.topK', value: '12' },
        { key: 'chatbotAi.systemPrompt', value: 'system custom prompt' },
      ],
      users: [{ firstName: 'X', lastName: 'Y', language: 'en' }],
    });
    const selectChat = vi
      .fn()
      .mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    createAiProvider.mockReturnValue({ chat: selectChat });
    executeToolLoop.mockResolvedValue({ content: 'ok', apiCallsMade: 0 });

    await handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t');

    const chatOptions = executeToolLoop.mock.calls[0]![5];
    expect(chatOptions).toEqual({ temperature: 0.7, topP: 0.95, topK: 12 });
    const systemPrompt = executeToolLoop.mock.calls[0]![4] as string;
    expect(systemPrompt).toContain('system custom prompt');
  });

  it('omits the user-name context when firstName and lastName are null', async () => {
    setDbResults({
      chatbotAiConfigs: [
        {
          provider: 'anthropic',
          apiKeyEnc: 'enc',
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
        },
      ],
      users: [{ firstName: null, lastName: null, language: 'en' }],
    });
    const selectChat = vi
      .fn()
      .mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    createAiProvider.mockReturnValue({ chat: selectChat });
    executeToolLoop.mockResolvedValue({ content: 'ok', apiCallsMade: 0 });

    await handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t');
    const systemPrompt = executeToolLoop.mock.calls[0]![4] as string;
    expect(systemPrompt).not.toContain('The current user is');
  });

  it('treats an empty-string system temperature as undefined', async () => {
    setDbResults({
      settings: [
        { key: 'chatbotAi.enabled', value: true },
        { key: 'chatbotAi.provider', value: 'anthropic' },
        { key: 'chatbotAi.apiKeyEnc', value: 'sys-enc' },
        { key: 'chatbotAi.temperature', value: '' },
      ],
      users: [{ firstName: 'X', lastName: 'Y', language: 'en' }],
    });
    const selectChat = vi
      .fn()
      .mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    createAiProvider.mockReturnValue({ chat: selectChat });
    executeToolLoop.mockResolvedValue({ content: 'ok', apiCallsMade: 0 });

    await handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t');
    const chatOptions = executeToolLoop.mock.calls[0]![5];
    expect(chatOptions.temperature).toBeUndefined();
  });

  it('falls back to the en prompt for an unknown user language', async () => {
    setDbResults({
      chatbotAiConfigs: [
        {
          provider: 'anthropic',
          apiKeyEnc: 'enc',
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
        },
      ],
      users: [{ firstName: 'X', lastName: 'Y', language: 'fr' }],
    });
    const selectChat = vi
      .fn()
      .mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    createAiProvider.mockReturnValue({ chat: selectChat });
    executeToolLoop.mockResolvedValue({ content: 'ok', apiCallsMade: 0 });

    await handleAssistantChat(makeApp(), 'usr', 'hi', [], 'Bearer t');
    const systemPrompt = executeToolLoop.mock.calls[0]![4] as string;
    expect(systemPrompt).toContain('EV charging station management assistant');
  });

  it('passes history plus the new user message into the tool loop', async () => {
    setDbResults({
      chatbotAiConfigs: [
        {
          provider: 'anthropic',
          apiKeyEnc: 'enc',
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
        },
      ],
      users: [{ firstName: 'A', lastName: 'B', language: 'en' }],
    });
    const selectChat = vi
      .fn()
      .mockResolvedValue({ content: 'NONE', toolCalls: [], finishReason: 'end' });
    createAiProvider.mockReturnValue({ chat: selectChat });
    executeToolLoop.mockResolvedValue({ content: 'ok', apiCallsMade: 0 });

    const history = [{ role: 'user' as const, content: 'prior' }];
    await handleAssistantChat(makeApp(), 'usr', 'new question', history, 'Bearer xyz');

    const messages = executeToolLoop.mock.calls[0]![2];
    expect(messages).toEqual([
      { role: 'user', content: 'prior' },
      { role: 'user', content: 'new question' },
    ]);
    const authHeader = executeToolLoop.mock.calls[0]![6];
    expect(authHeader).toBe('Bearer xyz');
    const maxIterations = executeToolLoop.mock.calls[0]![7];
    expect(maxIterations).toBe(10);
  });
});
