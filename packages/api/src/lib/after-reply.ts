// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';

/**
 * Runs work after the answer was sent, without the request waiting for it: the
 * audit rows, backoff writes and links of a sign-in, reset or registration, so a
 * known email takes the time of an unknown one. The
 * answer already stands, so a failure is logged and nothing else.
 */
export function afterReply(request: FastifyRequest, work: () => Promise<unknown>): void {
  void work().catch((err: unknown) => {
    request.log.error({ err }, 'Work after the answer failed');
  });
}
