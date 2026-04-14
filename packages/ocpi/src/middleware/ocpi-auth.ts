// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest, FastifyReply } from 'fastify';
import * as argon2 from 'argon2';
import { db, ocpiCredentialsTokens, ocpiPartners } from '@evtivity/database';
import { eq, and } from 'drizzle-orm';
import { ocpiError, OcpiStatusCode } from '../lib/ocpi-response.js';

export interface OcpiPartnerInfo {
  partnerId: string | null;
  partnerName: string | null;
  countryCode: string | null;
  partyId: string | null;
  tokenId: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    ocpiPartner?: OcpiPartnerInfo;
  }
}

function extractToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader == null) return null;

  const match = authHeader.match(/^Token\s+(.+)$/i);
  if (match == null || match[1] == null) return null;

  try {
    return Buffer.from(match[1], 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

async function verifyToken(
  token: string,
  requirePartner: boolean,
): Promise<OcpiPartnerInfo | null> {
  const prefix = token.slice(0, 8);

  const candidates = await db
    .select({
      tokenId: ocpiCredentialsTokens.id,
      tokenHash: ocpiCredentialsTokens.tokenHash,
      partnerId: ocpiCredentialsTokens.partnerId,
    })
    .from(ocpiCredentialsTokens)
    .where(
      and(
        eq(ocpiCredentialsTokens.tokenPrefix, prefix),
        eq(ocpiCredentialsTokens.isActive, true),
        eq(ocpiCredentialsTokens.direction, 'issued'),
      ),
    );

  // Verify all candidates to prevent timing attacks (constant-time over candidate count)
  let matchedCandidate: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    const valid = await argon2.verify(candidate.tokenHash, token);
    if (valid && matchedCandidate == null) {
      matchedCandidate = candidate;
    }
  }

  if (matchedCandidate == null) return null;

  if (matchedCandidate.partnerId == null) {
    if (requirePartner) return null;
    return {
      partnerId: null,
      partnerName: null,
      countryCode: null,
      partyId: null,
      tokenId: matchedCandidate.tokenId,
    };
  }

  const [partner] = await db
    .select({
      name: ocpiPartners.name,
      countryCode: ocpiPartners.countryCode,
      partyId: ocpiPartners.partyId,
    })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, matchedCandidate.partnerId))
    .limit(1);

  if (partner == null) return null;

  return {
    partnerId: matchedCandidate.partnerId,
    partnerName: partner.name,
    countryCode: partner.countryCode,
    partyId: partner.partyId,
    tokenId: matchedCandidate.tokenId,
  };
}

export async function ocpiAuthenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractToken(request);
  if (token == null) {
    await reply
      .status(401)
      .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Missing or invalid Authorization header'));
    return;
  }

  const partner = await verifyToken(token, true);
  if (partner == null) {
    await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Invalid token'));
    return;
  }

  request.ocpiPartner = partner;
}

export async function ocpiAuthenticateRegistration(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractToken(request);
  if (token == null) {
    await reply
      .status(401)
      .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Missing or invalid Authorization header'));
    return;
  }

  const partner = await verifyToken(token, false);
  if (partner == null) {
    await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Invalid token'));
    return;
  }

  request.ocpiPartner = partner;
}
