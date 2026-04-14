// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import type { TriggerCommandFn } from './types.js';

export interface OcttApiClient {
  triggerCommand: TriggerCommandFn;
}

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;

function parseRetryDelay(body: Record<string, unknown>): number {
  const message =
    typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string'
        ? body.message
        : '';
  const match = /retry\s+in\s+(\d+)\s+second/i.exec(message);
  if (match?.[1] != null) {
    return parseInt(match[1], 10) * 1000;
  }
  return DEFAULT_RETRY_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createApiClient(
  apiUrl: string,
  apiToken: string,
  logger?: Logger,
): Promise<OcttApiClient> {
  // Verify the API is reachable
  const healthRes = await fetch(`${apiUrl}/health`);
  if (!healthRes.ok) {
    throw new Error(`API health check failed (${String(healthRes.status)})`);
  }

  return {
    async triggerCommand(version, action, body) {
      const url = `${apiUrl}/v1/ocpp/commands/${version}/${action}`;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiToken}`,
            },
            body: JSON.stringify(body),
          });

          if (res.status === 429 && attempt < MAX_RETRIES) {
            const json = (await res.json()) as Record<string, unknown>;
            const delayMs = parseRetryDelay(json);
            logger?.warn(
              { action, attempt: attempt + 1, retryDelayMs: delayMs },
              'triggerCommand rate limited (429), retrying',
            );
            await sleep(delayMs);
            continue;
          }

          const json = (await res.json()) as Record<string, unknown>;
          if (!res.ok) {
            logger?.warn({ action, status: res.status, response: json }, 'triggerCommand failed');
          }
          return json;
        } catch (err) {
          if (attempt < MAX_RETRIES) {
            logger?.warn(
              {
                action,
                attempt: attempt + 1,
                error: err instanceof Error ? err.message : String(err),
              },
              'triggerCommand network error, retrying',
            );
            await sleep(DEFAULT_RETRY_DELAY_MS);
            continue;
          }
          logger?.error(
            { action, error: err instanceof Error ? err.message : String(err) },
            'triggerCommand error after retries',
          );
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      return { error: 'triggerCommand exhausted all retries' };
    },
  };
}
