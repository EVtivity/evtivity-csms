// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, chatbotAiConfigs, settings, users } from '@evtivity/database';
import { decryptString } from '@evtivity/lib';
import type { ChatMessage, ChatOptions } from './types.js';
import { TOOL_CATEGORIES, getToolsForCategories, type ExtendedToolDefinition } from './tools.js';
import { createAiProvider } from './provider-factory.js';
import { executeToolLoop } from './tool-executor.js';
import { config as apiConfig } from '../../lib/config.js';

// Load docs index for AI assistant doc references
let docsIndex = '';
try {
  const indexPath = process.env['DOCS_INDEX_PATH'] ?? resolve('docs-index.json');
  const raw = readFileSync(indexPath, 'utf8');
  const pages = JSON.parse(raw) as Array<{ path: string; title: string; description: string }>;
  docsIndex =
    '\n\nDocumentation index (use these exact full URLs when linking):\n' +
    pages.map((p) => `- ${p.title}: DOCS_BASE${p.path}`).join('\n');
} catch {
  // No docs index available, AI will use hardcoded URLs from the prompt
}

const MAX_PROVIDER_TOOLS = 128;

const DEFAULT_SYSTEM_PROMPTS: Record<string, string> = {
  en: 'You are an EV charging station management assistant. Answer questions about stations, sessions, energy, revenue, and operations. Use the provided tools to fetch real-time data. Format numbers with commas, currency from cents to dollars, energy from Wh to kWh. Use markdown tables for tabular data. Be concise and direct. Before making any changes (creating, updating, or deleting data), you must first explain what you plan to do and ask the user for explicit confirmation. Never modify data without the user saying yes. Never reveal sensitive data including passwords, password hashes, API keys, secret keys, encryption keys, tokens, or authentication credentials. If a tool response contains such fields, omit them from your reply. If the user asks for passwords or secrets, decline and explain that this information is restricted. Only when the user explicitly asks how to do something, how to configure a feature, or asks for help troubleshooting, include a single relevant doc link at the end of your response using the full URL from the docs index below. Do not link docs for data queries or operational questions.',
  es: 'Eres un asistente de gestion de estaciones de carga de vehiculos electricos. Responde preguntas sobre estaciones, sesiones, energia, ingresos y operaciones. Usa las herramientas proporcionadas para obtener datos en tiempo real. Formatea numeros con comas, moneda de centavos a dolares, energia de Wh a kWh. Usa tablas markdown para datos tabulares. Se conciso y directo. Antes de realizar cambios (crear, actualizar o eliminar datos), explica lo que planeas hacer y pide confirmacion explicita al usuario. Nunca modifiques datos sin que el usuario diga si. Nunca reveles datos sensibles como contrasenas, claves API, claves secretas, claves de cifrado, tokens o credenciales de autenticacion. Solo cuando el usuario pregunte como hacer algo, como configurar una funcion o pida ayuda para resolver problemas, incluye un enlace relevante al final de la respuesta usando la URL completa del indice de documentacion a continuacion. No enlaces documentacion para consultas de datos u operaciones.',
  zh: '你是一个电动汽车充电站管理助手。回答关于充电站、会话、能源、收入和运营的问题。使用提供的工具获取实时数据。数字使用逗号格式化，货币从分转换为元，能源从Wh转换为kWh。使用markdown表格显示表格数据。简洁直接。在进行任何更改（创建、更新或删除数据）之前，必须先解释计划并请求用户明确确认。未经用户同意不得修改数据。不得泄露敏感数据，包括密码、API密钥、加密密钥、令牌或认证凭据。仅当用户明确询问如何操作、如何配置功能或请求故障排除帮助时，在回复末尾附上一个相关文档链接，使用下方文档索引中的完整URL。数据查询或运营问题不要附加文档链接。',
};

const MAX_TOOL_ITERATIONS = 10;

interface AssistantConfig {
  provider: string;
  apiKey: string;
  model?: string | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  systemPrompt?: string | undefined;
}

async function resolveConfig(userId: string): Promise<AssistantConfig> {
  const [userConfig] = await db
    .select()
    .from(chatbotAiConfigs)
    .where(eq(chatbotAiConfigs.userId, userId));

  if (userConfig) {
    const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
    }
    return {
      provider: userConfig.provider,
      apiKey: decryptString(userConfig.apiKeyEnc, encryptionKey),
      model: userConfig.model ?? undefined,
      temperature: userConfig.temperature != null ? Number(userConfig.temperature) : undefined,
      topP: userConfig.topP != null ? Number(userConfig.topP) : undefined,
      topK: userConfig.topK ?? undefined,
      systemPrompt: userConfig.systemPrompt ?? undefined,
    };
  }

  const systemRows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  const get = (k: string) => systemRows.find((r) => r.key === k)?.value;

  if (get('chatbotAi.enabled') !== true) {
    const error = new Error('AI assistant is not configured');
    (error as Error & { code: string }).code = 'AI_NOT_CONFIGURED';
    throw error;
  }

  const apiKeyEnc = get('chatbotAi.apiKeyEnc') as string | undefined;
  const provider = get('chatbotAi.provider') as string | undefined;
  if (!provider || !apiKeyEnc) {
    const error = new Error('AI assistant is not configured');
    (error as Error & { code: string }).code = 'AI_NOT_CONFIGURED';
    throw error;
  }

  const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }

  return {
    provider,
    apiKey: decryptString(apiKeyEnc, encryptionKey),
    model: (get('chatbotAi.model') as string) || undefined,
    temperature: get('chatbotAi.temperature')
      ? Number(get('chatbotAi.temperature') as string)
      : undefined,
    topP: get('chatbotAi.topP') ? Number(get('chatbotAi.topP') as string) : undefined,
    topK: get('chatbotAi.topK') ? Number(get('chatbotAi.topK') as string) : undefined,
    systemPrompt: (get('chatbotAi.systemPrompt') as string) || undefined,
  };
}

/**
 * Build a compact category list for the selection step.
 */
function buildCategorySelectionPrompt(userMessage: string, history: ChatMessage[]): string {
  const categoryList = TOOL_CATEGORIES.map(
    (c) => `- ${c.tag} (${String(c.toolCount)} tools): ${c.description}`,
  ).join('\n');

  const recentContext =
    history.length > 0
      ? `\nRecent conversation context: ${history
          .slice(-3)
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join('; ')}`
      : '';

  return `Given this user message: "${userMessage}"${recentContext}

Which tool categories are needed to answer? Pick 1-4 categories from this list:

${categoryList}

Reply with ONLY the category names separated by commas. Example: "Dashboard, Sessions"
If the message is just a greeting or doesn't need tools, reply with "NONE".`;
}

/**
 * Parse the category selection response into tag names.
 */
function parseCategories(response: string): string[] {
  const text = response.trim();
  if (text.toUpperCase() === 'NONE' || text === '') return [];

  return text
    .split(',')
    .map((s) => s.trim())
    .map((s) => TOOL_CATEGORIES.find((c) => c.tag.toLowerCase() === s.toLowerCase()))
    .filter((c): c is (typeof TOOL_CATEGORIES)[number] => c != null)
    .map((c) => c.tag);
}

export async function selectToolCategories(
  provider: ReturnType<typeof createAiProvider>,
  message: string,
  history: ChatMessage[],
): Promise<string[]> {
  const selectionPrompt = buildCategorySelectionPrompt(message, history);
  const selectionResponse = await provider.chat(
    [{ role: 'user', content: selectionPrompt }],
    [],
    'You are a tool routing assistant. Pick the most relevant categories for the user query. Reply with only category names.',
    { temperature: 0 },
  );
  return parseCategories(selectionResponse.content ?? '');
}

export async function selectTools(
  provider: ReturnType<typeof createAiProvider>,
  message: string,
  history: ChatMessage[],
  options?: { fallbackTags?: string[]; filter?: (tool: ExtendedToolDefinition) => boolean },
): Promise<ExtendedToolDefinition[]> {
  const selectedTags = await selectToolCategories(provider, message, history);
  const tags = selectedTags.length > 0 ? selectedTags : (options?.fallbackTags ?? []);
  let tools = getToolsForCategories(tags);
  if (options?.filter != null) {
    tools = tools.filter(options.filter);
  }
  return tools.slice(0, MAX_PROVIDER_TOOLS);
}

export async function handleAssistantChat(
  app: FastifyInstance,
  userId: string,
  message: string,
  history: ChatMessage[],
  authHeader: string,
): Promise<{ reply: string; apiCallsMade: number }> {
  const config = await resolveConfig(userId);
  const provider = createAiProvider(config.provider, config.apiKey, config.model);

  // Look up the operator's name and language for personalization
  const [user] = await db
    .select({ firstName: users.firstName, lastName: users.lastName, language: users.language })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userName = user != null ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : '';
  const userLang = user?.language ?? 'en';
  const userContext = userName !== '' ? `\n\nThe current user is ${userName}.` : '';
  const defaultPrompt = DEFAULT_SYSTEM_PROMPTS[userLang] ?? DEFAULT_SYSTEM_PROMPTS['en'] ?? '';
  const docsBaseUrl =
    userLang === 'en' ? 'https://evtivity.com' : `https://evtivity.com/${userLang}`;
  const docsSection = docsIndex !== '' ? docsIndex.replace(/DOCS_BASE/g, docsBaseUrl) : '';
  const systemPrompt = (config.systemPrompt ?? defaultPrompt) + userContext + docsSection;
  const chatOptions: ChatOptions = {
    temperature: config.temperature,
    topP: config.topP,
    topK: config.topK,
  };

  // Step 1: Category selection + tool loading (capped at 128)
  const selectedTools = await selectTools(provider, message, history);

  // Step 2: Main conversation with tool loop
  const messages: ChatMessage[] = [...history, { role: 'user', content: message }];
  const result = await executeToolLoop(
    app,
    provider,
    messages,
    selectedTools,
    systemPrompt,
    chatOptions,
    authHeader,
    MAX_TOOL_ITERATIONS,
  );

  return { reply: result.content, apiCallsMade: result.apiCallsMade };
}
