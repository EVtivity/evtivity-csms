// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';

/**
 * Per user and route. One open dashboard refetches a route at most once per
 * 5 s on CSMS events plus the 60 s poll (about 14 a minute); 120 leaves room
 * for several tabs and windows. The response cache and the one-minute totals
 * cache keep the database load per minute bounded whatever the request rate.
 */
export const DASHBOARD_RATE_LIMIT = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => {
      const user = request.user as { userId?: string } | undefined;
      return user?.userId ?? request.ip;
    },
  },
};
