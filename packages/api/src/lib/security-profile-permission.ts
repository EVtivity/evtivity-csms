// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { SECURITY_PROFILE_PERMISSION } from '@evtivity/lib/ocpp-command-permissions';
import { requestHasPermission } from '../middleware/rbac.js';

/**
 * Answers 403 `INSUFFICIENT_PERMISSIONS` and returns true when the body asks
 * for a security profile change the caller may not make
 * (`SECURITY_PROFILE_PERMISSION`). Decides on the body
 * and the caller's permissions only, before any station read.
 */
export async function refuseSecurityProfileChange(
  request: FastifyRequest,
  reply: FastifyReply,
  securityProfile: number | null | undefined,
): Promise<boolean> {
  if (securityProfile == null) return false;
  if (await requestHasPermission(request, SECURITY_PROFILE_PERMISSION)) return false;
  await reply
    .status(403)
    .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
  return true;
}
