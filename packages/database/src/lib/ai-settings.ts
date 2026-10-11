// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like, or } from 'drizzle-orm';
import { AI_SETTING_KEY_PREFIXES, buildAiSettings, createLogger } from '@evtivity/lib';
import type {
  AiInsightSettings,
  AiMcpSettings,
  AiSettings,
  AiSurfaceSettings,
  AiWorkerSettings,
} from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('ai-settings');

const TTL_MS = 60_000;
let cached: AiSettings | undefined;
let cachedAt = 0;

/**
 * Every AI setting (`ai.*`, `chatbotAi.*`, `supportAi.*`, `opsAi.*`,
 * `aiInsights.*`, `aiWorkers.*`) in one query,
 * cached for 60 seconds. On a read failure the last cached value is served;
 * with none, the error propagates (a turn cannot run without its config).
 */
export async function getAiSettings(): Promise<AiSettings> {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < TTL_MS) return cached;
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(or(...AI_SETTING_KEY_PREFIXES.map((prefix) => like(settings.key, `${prefix}%`))));
    cached = buildAiSettings(rows);
    cachedAt = now;
    return cached;
  } catch (err) {
    if (cached === undefined) throw err;
    logger.warn({ err }, 'getAiSettings failed, serving the cached value');
    return cached;
  }
}

/** Whether the admin assistant is on. Fails closed (false) when settings cannot be read. */
export async function isChatbotAiEnabled(): Promise<boolean> {
  try {
    return (await getAiSettings()).chatbot.enabled;
  } catch (err) {
    logger.warn({ err, key: 'chatbotAi.enabled' }, 'isChatbotAiEnabled failed, using false');
    return false;
  }
}

/** Whether support AI drafts are on. Fails closed (false) when settings cannot be read. */
export async function isSupportAiEnabled(): Promise<boolean> {
  try {
    return (await getAiSettings()).support.enabled;
  } catch (err) {
    logger.warn({ err, key: 'supportAi.enabled' }, 'isSupportAiEnabled failed, using false');
    return false;
  }
}

/**
 * The `opsAi` surface of system-initiated runs (insights, background workers).
 * Fails closed: when settings cannot be read, the surface is reported off.
 */
export async function getOpsAiSettings(): Promise<AiSurfaceSettings> {
  try {
    return (await getAiSettings()).ops;
  } catch (err) {
    logger.warn({ err, key: 'opsAi.enabled' }, 'getOpsAiSettings failed, using off');
    return { enabled: false, provider: null, model: '', effort: 'low', systemPrompt: '' };
  }
}

/** Whether system-initiated AI runs are on. Fails closed (false). */
export async function isOpsAiEnabled(): Promise<boolean> {
  return (await getOpsAiSettings()).enabled;
}

/**
 * The insight settings. Throws when settings cannot be read and nothing is
 * cached: a caller decides (the scan skips the minute, P9).
 */
export async function getAiInsightSettings(): Promise<AiInsightSettings> {
  return (await getAiSettings()).insights;
}

/** The background worker settings. Throws like `getAiInsightSettings`. */
export async function getAiWorkerSettings(): Promise<AiWorkerSettings> {
  return (await getAiSettings()).workers;
}

/** The MCP server settings. Throws like `getAiInsightSettings`. */
export async function getAiMcpSettings(): Promise<AiMcpSettings> {
  return (await getAiSettings()).mcp;
}

/** Whether the MCP server is on. Fails closed (false) when settings cannot be read. */
export async function isAiMcpEnabled(): Promise<boolean> {
  try {
    return (await getAiSettings()).mcp.enabled;
  } catch (err) {
    logger.warn({ err, key: 'ai.mcp.enabled' }, 'isAiMcpEnabled failed, using false');
    return false;
  }
}

/**
 * Whether something can create AI proposals, so the CSMS shows the AI Inbox:
 * a proposing background worker (network summary or stuck sessions, both
 * need `opsAi.enabled`; tariff anomalies only write findings) or the MCP
 * server. Fails closed (false) when settings cannot be read.
 */
export async function isAiInboxEnabled(): Promise<boolean> {
  try {
    const { ops, workers, mcp } = await getAiSettings();
    const workerProposals =
      ops.enabled && (workers.networkSummaryEnabled || workers.stuckSessionsEnabled);
    return workerProposals || mcp.enabled;
  } catch (err) {
    logger.warn({ err }, 'isAiInboxEnabled failed, using false');
    return false;
  }
}

/**
 * Whether automatic insights are generated, so the CSMS dashboard shows the
 * Active insights card even while none is open: `opsAi.enabled` and at least
 * one insight kind switch. Fails closed (false) when settings cannot be read.
 */
export async function isAiInsightsEnabled(): Promise<boolean> {
  try {
    const { ops, insights } = await getAiSettings();
    return (
      ops.enabled &&
      (insights.stationEnabled || insights.sessionEnabled || insights.authorizationEnabled)
    );
  } catch (err) {
    logger.warn({ err }, 'isAiInsightsEnabled failed, using false');
    return false;
  }
}

/** Drops the cached AI settings; call after writing any `isAiSettingKey` key. */
export function clearAiSettingsCache(): void {
  cached = undefined;
  cachedAt = 0;
}
