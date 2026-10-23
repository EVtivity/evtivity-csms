// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JwtPayload } from '../plugins/auth.js';
import { ERROR_CODES } from './error-codes.generated.js';
import {
  FACTOR_PROOF_KINDS,
  checkFactorProof,
  sendFactorProofRefusal,
  type FactorProof,
} from './mfa-factor-proof.js';

/** The extra field of a refused proof: the kinds the account accepts. */
export const sessionProofErrorFields = {
  proofKinds: z
    .array(z.enum(FACTOR_PROOF_KINDS))
    .optional()
    .describe('A missing or wrong proof: the proof kinds the account accepts'),
};

/** The 400 codes of a refused proof (VALIDATION_ERROR with proofKinds for a missing one). */
export const SESSION_PROOF_ERROR_CODES = [
  ERROR_CODES.VALIDATION_ERROR,
  ERROR_CODES.MFA_CODE_INVALID,
  ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
  ERROR_CODES.INVALID_PASSWORD,
  ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
  ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
] as const;

/** Whether the request was made with an API key, not a signed-in session. */
export function isApiKeyRequest(request: FastifyRequest): boolean {
  return (request.user as JwtPayload | undefined)?.isApiKey === true;
}

/**
 * The fresh proof a signed-in operator sends with a change that grants lasting
 * access: SSO settings, a privileged user, a permission grant, an email change
 * of a privileged user, the reset of another account. A
 * stolen session alone must not make it. An API key needs none: it already is
 * a credential, and minting one takes the same proof. True when the request may
 * go on; otherwise the refusal (400 with `proofKinds`, or the proof error) is sent.
 */
export async function requireSessionProof(
  request: FastifyRequest,
  reply: FastifyReply,
  proof: FactorProof | undefined,
): Promise<boolean> {
  if (isApiKeyRequest(request)) return true;
  const { userId } = request.user as JwtPayload;
  const refused = await checkFactorProof(request, { userId }, proof, 'confirm');
  if (refused == null) return true;
  await sendFactorProofRefusal(reply, refused);
  return false;
}
