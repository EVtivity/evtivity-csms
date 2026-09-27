// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
}));

const { buildOcpiApp } = await import('../app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildOcpiApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('OCPI health endpoint', () => {
  it('returns 200 even when roaming is disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('still gates OCPI protocol routes on the roaming toggle', async () => {
    const res = await app.inject({ method: 'GET', url: '/ocpi/versions' });
    expect(res.statusCode).toBe(503);
  });
});
