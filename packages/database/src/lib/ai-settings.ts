// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { like, or } from 'drizzle-orm';
import { buildAiSettings, createLogger } from '@evtivity/lib';
import type { AiSettings } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('ai-settings');

const TTL_MS = 60_000;
let cached: AiSettings | undefined;
let cachedAt = 0;

/**
 * Every AI setting (`ai.*`, `chatbotAi.*`, `supportAi.*`) in one query,
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
      .where(
        or(
          like(settings.key, 'ai.%'),
          like(settings.key, 'chatbotAi.%'),
          like(settings.key, 'supportAi.%'),
        ),
      );
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

/** Drops the cached AI settings; call after writing any `isAiSettingKey` key. */
export function clearAiSettingsCache(): void {
  cached = undefined;
  cachedAt = 0;
}
