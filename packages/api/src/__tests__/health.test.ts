// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../routes/health.js';

vi.mock('@evtivity/database', () => ({
  db: { execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn().mockReturnValue({ ping: vi.fn().mockResolvedValue(true) }),
}));

describe('Health route', () => {
  it('GET /health returns 200 with status ok', async () => {
    const app = Fastify();
    await app.register(healthRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body).toHaveProperty('timestamp');
    expect(body['database']).toBe('ok');
    expect(body['redis']).toBe('ok');
  });
});
