// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import type { AuditActor } from '@evtivity/database';

export interface AuditActorInfo {
  actor: AuditActor;
  actorUserId: string | null;
  actorDriverId: string | null;
  actorApiKeyId: string | null;
  actorLabel: string | null;
}

// Extracts the audit actor identity from a Fastify request that has already
// been authenticated. Operator JWT and driver JWT both attach `request.user`
// via @fastify/jwt; the API-key authentication path also stuffs the resolved
// userId there alongside an `apiKeyId` field so the caller can be tracked.
//
// Routes that mutate without a user context (cron handlers, OCPP projections,
// system jobs) should NOT call this -- they pass actor='system' / 'ocpp'
// directly to writeAudit().
export function getAuditActor(request: FastifyRequest): AuditActorInfo {
  const user = request.user as unknown as Record<string, unknown> | undefined;
  if (user == null) {
    return {
      actor: 'system',
      actorUserId: null,
      actorDriverId: null,
      actorApiKeyId: null,
      actorLabel: null,
    };
  }

  // Driver portal JWT carries `type: 'driver'`.
  if (typeof user['type'] === 'string' && user['type'] === 'driver') {
    return {
      actor: 'driver',
      actorUserId: null,
      actorDriverId: typeof user['driverId'] === 'string' ? user['driverId'] : null,
      actorApiKeyId: null,
      actorLabel: null,
    };
  }

  const userId = typeof user['userId'] === 'string' ? user['userId'] : null;
  const apiKeyId = typeof user['apiKeyId'] === 'string' ? user['apiKeyId'] : null;

  if (apiKeyId != null) {
    return {
      actor: 'api_key',
      actorUserId: userId,
      actorDriverId: null,
      actorApiKeyId: apiKeyId,
      actorLabel: null,
    };
  }

  return {
    actor: 'operator',
    actorUserId: userId,
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  };
}
