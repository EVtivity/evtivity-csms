// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import { registerOpenApi } from '../plugins/openapi.js';

describe('OpenAPI servers', () => {
  const app = Fastify({ logger: false });

  afterAll(async () => {
    await app.close();
  });

  it('lists the production server first and the Docker Compose API port as the local server', async () => {
    await registerOpenApi(app);
    await app.ready();
    const { servers = [] } = app.swagger() as { servers?: { url: string }[] };
    const urls = servers.map((s) => s.url);

    expect(urls[0]).toBe('https://api.{tenantId}.evtivity.com');
    expect(urls).toContain('http://localhost:7102');
    expect(urls).not.toContain('http://localhost:3001');
  });
});
