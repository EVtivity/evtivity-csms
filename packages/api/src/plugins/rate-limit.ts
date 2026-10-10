// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config } from '../lib/config.js';
import { isAiToolRequest } from '../services/ai/tools/execute.js';

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // AI tool calls are injected requests from 127.0.0.1: they would share
    // one bucket for every user. The AI limits count them instead (per user
    // and site per minute, and the per-turn tool call cap).
    allowList: (request) => request.url.startsWith('/v1/ocpp/commands/') || isAiToolRequest(),
  });
}
