// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { getAuditActor } from './audit-actor.js';
import type { AvatarUploader } from '../services/account-avatar-upload.js';

/**
 * Operator writes of another account's avatar (`/v1/drivers/:id/avatar` with
 * `drivers:write`, `/v1/users/:id/avatar` with `users:write`). The principal
 * names the operator request: `user:<id>` for a session, `api_key:<id>` for an
 * API key. Upload keys and rate limits are per principal and target.
 */
export function operatorPrincipal(request: FastifyRequest): string {
  const actor = getAuditActor(request);
  if (actor.actorApiKeyId != null) return `api_key:${actor.actorApiKeyId}`;
  return `user:${actor.actorUserId ?? 'unknown'}`;
}

/** The uploader of an operator request: its keys sit in its own quarantine folder of the target. */
export function operatorUploader(request: FastifyRequest): AvatarUploader {
  return { kind: 'operator', principal: operatorPrincipal(request) };
}

/**
 * Rate limit per operator principal and target account (`:id`): one operator
 * spends neither another operator's budget nor the account's own one.
 */
export function perOperatorAndTarget(scope: 'driver' | 'user', max: number) {
  return {
    max,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest): string => {
      // The limit can run before authentication: no principal yet.
      const user = request.user as unknown as Record<string, unknown> | undefined;
      if (user == null) return request.ip;
      const params = request.params as { id?: unknown } | undefined;
      const targetId = typeof params?.id === 'string' ? params.id : '';
      return `operator-avatar:${scope}:${operatorPrincipal(request)}:${targetId}`;
    },
  };
}
