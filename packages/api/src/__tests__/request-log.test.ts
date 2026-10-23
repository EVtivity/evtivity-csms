// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializeRequestForLog, type LoggedRequest } from '@evtivity/lib/request-log';

describe('serializeRequestForLog', () => {
  it('drops the whole query string, every token parameter included', async () => {
    const app = Fastify();
    app.get('/v1/things/:id', (request) => serializeRequestForLog(request));
    const res = await app.inject({
      method: 'GET',
      url: '/v1/things/7?token=first&x=1&token=second&code=123456',
    });
    await app.close();
    const logged = res.json<LoggedRequest>();
    expect(logged.url).toBe('/v1/things/7');
    expect(logged.route).toBe('/v1/things/:id');
    expect(JSON.stringify(logged)).not.toMatch(/first|second|123456/);
  });
});
