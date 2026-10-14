// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { controlRoutes } from '../routes/control.js';
import { state } from '../state.js';

const app = Fastify();

describe('POST /sim/push-session', () => {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify({ data: null, status_code: 1000, status_message: 'OK' })),
    ),
  );

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('OCPI_SIM_TARGET_ORIGIN', 'http://ocpi:7104');
    // The session push is a CPO control route.
    state.role = 'cpo';
    state.isRegistered = true;
    state.theirToken = 'token';
    state.partnerEndpoints = [
      {
        identifier: 'sessions',
        role: 'RECEIVER',
        url: 'http://localhost:7104/ocpi/2.2.1/emsp/sessions',
      },
    ];
    await app.register(controlRoutes);
    await app.ready();
  });

  afterEach(() => {
    fetchMock.mockClear();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await app.close();
  });

  it('refuses a session id that is not a safe path segment, without a request', async () => {
    for (const sessionId of ['../../credentials', 'a/b', '..', '', 'x'.repeat(37), 'a?b=1']) {
      const res = await app.inject({
        method: 'POST',
        url: '/sim/push-session',
        payload: { session_id: sessionId },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pushes the session to the target origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sim/push-session',
      payload: { session_id: 'SIM-SESSION-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://ocpi:7104/ocpi/2.2.1/emsp/sessions/NL/SIM/SIM-SESSION-1',
    );
  });
});
