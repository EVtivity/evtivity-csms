// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { healthRoutes } from '../routes/health.js';

vi.mock('@evtivity/database', () => ({
  db: { execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn().mockReturnValue({ ping: vi.fn().mockResolvedValue(true) }),
}));

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify();
  await app.register(healthRoutes);
  await app.ready();
});

describe('Health route', () => {
  it('returns status ok', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('Route registration', () => {
  it('returns 404 for unknown routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent',
    });

    expect(response.statusCode).toBe(404);
  });
});
