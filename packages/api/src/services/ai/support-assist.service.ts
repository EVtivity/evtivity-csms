// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, chatbotAiConfigs, settings, users } from '@evtivity/database';
import { decryptString } from '@evtivity/lib';
import type { ChatMessage, ChatOptions } from './types.js';
import { createAiProvider } from './provider-factory.js';
import { executeToolLoop } from './tool-executor.js';
import { selectTools } from './assistant.service.js';
import { config as apiConfig } from '../../lib/config.js';

const DEFAULT_SUPPORT_PROMPTS: Record<string, string> = {
  en: 'You are a support agent for an EV charging station management system. Use the available tools to look up the support case details, messages, linked sessions, station info, driver history, and payment records. Then generate a draft reply based on what you find. For customer replies: be empathetic, address the issue directly, propose a resolution if possible. For internal notes: analyze the root cause, suggest investigation steps, reference specific data points. Return ONLY the draft reply text. No preamble, explanation, or surrounding quotes. Never reveal sensitive data including passwords, API keys, secret keys, or tokens.',
  es: 'Eres un agente de soporte para un sistema de gestion de estaciones de carga de vehiculos electricos. Usa las herramientas disponibles para consultar los detalles del caso de soporte, mensajes, sesiones vinculadas, informacion de la estacion, historial del conductor y registros de pago. Luego genera un borrador de respuesta basado en lo que encuentres. Para respuestas al cliente: se empatico, aborda el problema directamente, propone una resolucion si es posible. Para notas internas: analiza la causa raiz, sugiere pasos de investigacion, referencia datos especificos. Devuelve SOLO el texto del borrador de respuesta. Sin preambulo, explicacion ni comillas. Nunca reveles datos sensibles como contrasenas, claves API, claves secretas o tokens.',
  zh: '你是一个电动汽车充电站管理系统的客服人员。使用可用的工具查询支持案例详情、消息、关联会话、充电站信息、司机历史和支付记录。然后根据查询结果生成回复草稿。对于客户回复：保持同理心，直接解决问题，尽可能提出解决方案。对于内部备注：分析根本原因，建议调查步骤，引用具体数据。只返回回复草稿文本，不要添加前言、解释或引号。不得泄露敏感数据，包括密码、API密钥、密钥或令牌。',
};

const MAX_TOOL_ITERATIONS = 15;

interface SupportAiConfig {
  provider: string;
  apiKey: string;
  model?: string | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  systemPrompt?: string | undefined;
  tone?: string | undefined;
}

export async function resolveSupportAiConfig(userId: string): Promise<SupportAiConfig> {
  // Check per-user support AI config first
  const [userConfig] = await db
    .select()
    .from(chatbotAiConfigs)
    .where(eq(chatbotAiConfigs.userId, userId));

  if (
    userConfig?.supportAiProvider != null &&
    userConfig.supportAiProvider !== '' &&
    userConfig.supportAiApiKeyEnc != null &&
    userConfig.supportAiApiKeyEnc !== ''
  ) {
    const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
    }
    return {
      provider: userConfig.supportAiProvider,
      apiKey: decryptString(userConfig.supportAiApiKeyEnc, encryptionKey),
      model: userConfig.supportAiModel ?? undefined,
      temperature:
        userConfig.supportAiTemperature != null
          ? Number(userConfig.supportAiTemperature)
          : undefined,
      topP: userConfig.supportAiTopP != null ? Number(userConfig.supportAiTopP) : undefined,
      topK: userConfig.supportAiTopK ?? undefined,
      systemPrompt: userConfig.supportAiSystemPrompt ?? undefined,
      tone: userConfig.supportAiTone ?? undefined,
    };
  }

  // Fall back to system support AI settings
  const systemRows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  const get = (k: string) => systemRows.find((r) => r.key === k)?.value;

  if (get('supportAi.enabled') !== true) {
    const error = new Error('Support AI is not configured');
    (error as Error & { code: string }).code = 'SUPPORT_AI_NOT_CONFIGURED';
    throw error;
  }

  const apiKeyEnc = get('supportAi.apiKeyEnc') as string | undefined;
  const provider = get('supportAi.provider') as string | undefined;
  if (!provider || !apiKeyEnc) {
    const error = new Error('Support AI is not configured');
    (error as Error & { code: string }).code = 'SUPPORT_AI_NOT_CONFIGURED';
    throw error;
  }

  const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }

  return {
    provider,
    apiKey: decryptString(apiKeyEnc, encryptionKey),
    model: (get('supportAi.model') as string) || undefined,
    temperature: get('supportAi.temperature')
      ? Number(get('supportAi.temperature') as string)
      : undefined,
    topP: get('supportAi.topP') ? Number(get('supportAi.topP') as string) : undefined,
    topK: get('supportAi.topK') ? Number(get('supportAi.topK') as string) : undefined,
    systemPrompt: (get('supportAi.systemPrompt') as string) || undefined,
    tone: (get('supportAi.tone') as string) || 'professional',
  };
}

export async function handleSupportAiAssist(
  app: FastifyInstance,
  userId: string,
  caseId: string,
  isInternalNote: boolean,
  authHeader: string,
): Promise<{ draft: string; apiCallsMade: number }> {
  const config = await resolveSupportAiConfig(userId);
  const provider = createAiProvider(config.provider, config.apiKey, config.model);

  const chatOptions: ChatOptions = {
    temperature: config.temperature,
    topP: config.topP,
    topK: config.topK,
  };

  // Look up operator's language preference
  const [user] = await db
    .select({ language: users.language })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userLang = user?.language ?? 'en';

  // Build the system prompt with tone, reply type, and language
  const toneLabel = config.tone ?? 'professional';
  const replyType = isInternalNote
    ? 'an internal note for the support team'
    : 'a customer-facing reply';

  const defaultPrompt = DEFAULT_SUPPORT_PROMPTS[userLang] ?? DEFAULT_SUPPORT_PROMPTS['en'] ?? '';
  const systemPrompt =
    (config.systemPrompt ?? defaultPrompt) + `\n\nTone: ${toneLabel}` + `\nGenerate: ${replyType}`;

  // Build the user message that tells the AI what to do
  const userMessage =
    `Look up support case ${caseId} and all its related data (messages, linked sessions, ` +
    `station details, driver info, payments). Then write ${replyType} to address the case.`;

  // Two-tier category selection with GET-only filter (support AI is read-only)
  const tools = await selectTools(provider, userMessage, [], {
    fallbackTags: ['Support Cases'],
    filter: (t) => t.method === 'GET',
  });

  const messages: ChatMessage[] = [{ role: 'user', content: userMessage }];

  const result = await executeToolLoop(
    app,
    provider,
    messages,
    tools,
    systemPrompt,
    chatOptions,
    authHeader,
    MAX_TOOL_ITERATIONS,
  );

  return { draft: result.content, apiCallsMade: result.apiCallsMade };
}
