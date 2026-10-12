// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like, or } from 'drizzle-orm';
import { AI_SETTING_KEY_PREFIXES, buildAiSettings, createLogger } from '@evtivity/lib';
import type {
  AiDriverSurfaceSettings,
  AiInsightSettings,
  AiMcpSettings,
  AiSettings,
  AiSurfaceSettings,
  AiWorkerSettings,
} from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';
import { isReservationEnabled } from './reservation-setting.js';

const logger = createLogger('ai-settings');

const TTL_MS = 60_000;
let cached: AiSettings | undefined;
let cachedAt = 0;

/**
 * Every AI setting (`ai.*`, `chatbotAi.*`, `supportAi.*`, `opsAi.*`,
 * `driverAi.*`, `aiInsights.*`, `aiWorkers.*`) in one query,
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
 * The `driverAi` surface of driver support analyses. Fails closed: when
 * settings cannot be read, the surface is reported off (no consent offered,
 * no analysis run; P9).
 */
export async function getDriverAiSettings(): Promise<AiDriverSurfaceSettings> {
  try {
    return (await getAiSettings()).driver;
  } catch (err) {
    logger.warn({ err, surface: 'driverAi' }, 'getDriverAiSettings failed, using off');
    // The built-in defaults: the switch is off (decision E7).
    return buildAiSettings([]).driver;
  }
}

/** Whether driver support analyses are on. Fails closed (false). */
export async function isDriverAiEnabled(): Promise<boolean> {
  return (await getDriverAiSettings()).enabled;
}

/**
 * The AI settings the insight paths run on (scan, generation, translation,
 * the insight routes): reservation insights count as on only while the
 * reservation feature is on too (`reservation.enabled`, owner rule v0.1.45),
 * so `insights.reservationEnabled` is the effective switch. Both readers are
 * cached (P6). Throws like `getAiSettings`.
 */
export async function getInsightAiSettings(): Promise<AiSettings> {
  const all = await getAiSettings();
  if (!all.insights.reservationEnabled || (await isReservationEnabled())) return all;
  return { ...all, insights: { ...all.insights, reservationEnabled: false } };
}

/**
 * The insight settings, with the effective reservation switch
 * (`getInsightAiSettings`). Throws when settings cannot be read and nothing
 * is cached: a caller decides (the scan skips the minute, P9).
 */
export async function getAiInsightSettings(): Promise<AiInsightSettings> {
  return (await getInsightAiSettings()).insights;
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
 * Whether AI Insights are on, so the CSMS shows insights (the dashboard card)
 * and the pending action count: `opsAi.enabled` and at least one insight kind
 * switch (reservation insights only while reservations are on) or background
 * worker job (its suggestions are insights). Fails closed (false) when
 * settings cannot be read.
 */
export async function isAiInsightsEnabled(): Promise<boolean> {
  try {
    const { ops, insights, workers } = await getInsightAiSettings();
    return (
      ops.enabled &&
      (insights.stationEnabled ||
        insights.sessionEnabled ||
        insights.authorizationEnabled ||
        insights.reservationEnabled ||
        workers.networkSummaryEnabled ||
        workers.stuckSessionsEnabled ||
        workers.tariffAnomaliesEnabled)
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
