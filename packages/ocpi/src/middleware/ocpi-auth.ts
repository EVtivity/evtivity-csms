// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import { roleNamesOf } from '@evtivity/lib/ocpi-roles';
import { moduleRouteAllows } from '../lib/partner-roles.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as argon2 from 'argon2';
import {
  db,
  isOcpiRegistrationTokenExpired,
  ocpiCredentialsTokens,
  ocpiPartners,
} from '@evtivity/database';
import { eq, and } from 'drizzle-orm';
import { ocpiError, OcpiStatusCode } from '../lib/ocpi-response.js';

export type OcpiTokenKind = 'registration' | 'credentials';
export type OcpiPartnerStatus = 'pending' | 'connected' | 'suspended' | 'disconnected';

export interface OcpiPartnerInfo {
  partnerId: string | null;
  partnerName: string | null;
  countryCode: string | null;
  partyId: string | null;
  /** ocpi_partners.allow_private_network. */
  allowPrivateNetwork: boolean;
  tokenId: number;
}

/** What the authenticated token may do, beside the partner it belongs to. */
export interface OcpiTokenInfo {
  /** A registration token (CREDENTIALS_TOKEN_A) or a credentials token. */
  kind: OcpiTokenKind;
  partnerStatus: OcpiPartnerStatus;
  /**
   * The role names the operator approved for the partner (CPO, EMSP, HUB,
   * ...), never the roles the partner declares in its credentials.
   */
  roleNames: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    ocpiPartner?: OcpiPartnerInfo;
    ocpiToken?: OcpiTokenInfo;
  }
}

// ---------- failed authentication limit (per client IP, per process) ----------

/** Failed authentications an IP may make per window before it gets 429. */
export const OCPI_AUTH_FAILURE_LIMIT = 60;
export const OCPI_AUTH_FAILURE_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;

const authFailures = new Map<string, { count: number; resetAt: number }>();

function failureLimited(ip: string, now: number): boolean {
  const entry = authFailures.get(ip);
  if (entry == null) return false;
  if (entry.resetAt <= now) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= OCPI_AUTH_FAILURE_LIMIT;
}

function recordFailure(ip: string, now: number): void {
  const entry = authFailures.get(ip);
  if (entry != null && entry.resetAt > now) {
    entry.count += 1;
    return;
  }
  if (authFailures.size >= MAX_TRACKED_IPS) {
    for (const [key, value] of authFailures) {
      if (value.resetAt <= now) authFailures.delete(key);
    }
    // Still full of live entries: drop the oldest insertion to stay bounded.
    if (authFailures.size >= MAX_TRACKED_IPS) {
      const oldest = authFailures.keys().next().value;
      if (oldest != null) authFailures.delete(oldest);
    }
  }
  authFailures.set(ip, { count: 1, resetAt: now + OCPI_AUTH_FAILURE_WINDOW_MS });
}

/** Test hook: forget every recorded failure. */
export function resetOcpiAuthFailures(): void {
  authFailures.clear();
}

// ---------- token lookup ----------

interface HeaderToken {
  /** The Base64-decoded header value (OCPI 2.2-d2 and later). */
  decoded: string;
  /** The header value as sent (OCPI 2.1.1 and 2.2 peers that do not encode). */
  raw: string;
}

function extractToken(request: FastifyRequest): HeaderToken | null {
  const authHeader = request.headers.authorization;
  if (authHeader == null) return null;

  const match = authHeader.match(/^Token\s+(\S+)$/i);
  if (match == null || match[1] == null) return null;

  const raw = match[1];
  return { decoded: Buffer.from(raw, 'base64').toString('utf-8'), raw };
}

let dummyHash: Promise<string> | null = null;

/** An argon2 hash of a random value, made once per process, for the dummy verify. */
function dummyTokenHash(): Promise<string> {
  dummyHash ??= argon2.hash(randomBytes(32).toString('hex'));
  return dummyHash;
}

async function findIssuedToken(
  token: string,
): Promise<{ tokenId: number; partnerId: string | null; kind: OcpiTokenKind } | null> {
  if (token === '') return null;
  const prefix = token.slice(0, 8);

  const candidates = await db
    .select({
      tokenId: ocpiCredentialsTokens.id,
      tokenHash: ocpiCredentialsTokens.tokenHash,
      partnerId: ocpiCredentialsTokens.partnerId,
      kind: ocpiCredentialsTokens.kind,
      createdAt: ocpiCredentialsTokens.createdAt,
    })
    .from(ocpiCredentialsTokens)
    .where(
      and(
        eq(ocpiCredentialsTokens.tokenPrefix, prefix),
        eq(ocpiCredentialsTokens.isActive, true),
        eq(ocpiCredentialsTokens.direction, 'issued'),
      ),
    );

  // No candidate: one dummy verify, so the answer time does not show whether
  // a token with this prefix exists.
  if (candidates.length === 0) {
    await argon2.verify(await dummyTokenHash(), token);
    return null;
  }
  // Verify all candidates to prevent timing attacks (constant-time over candidate count)
  let matched: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    const valid = await argon2.verify(candidate.tokenHash, token);
    if (valid && matched == null) {
      matched = candidate;
    }
  }
  if (matched == null) return null;
  // A registration token past its lifetime is refused like an unknown one.
  if (matched.kind === 'registration' && isOcpiRegistrationTokenExpired(matched.createdAt)) {
    return null;
  }
  return { tokenId: matched.tokenId, partnerId: matched.partnerId, kind: matched.kind };
}

/**
 * Resolves the Authorization header to the partner the token was issued to.
 * Every issued token is bound to its partner; an unbound token is refused. A
 * token sent without Base64 encoding is accepted only from a partner whose
 * `allow_raw_token` flag is on.
 */
async function verifyToken(
  header: HeaderToken,
): Promise<{ partner: OcpiPartnerInfo; token: OcpiTokenInfo } | null> {
  let found = await findIssuedToken(header.decoded);
  let raw = false;
  if (found == null && header.raw !== header.decoded) {
    found = await findIssuedToken(header.raw);
    raw = true;
  }
  if (found?.partnerId == null) return null;

  const [partner] = await db
    .select({
      name: ocpiPartners.name,
      countryCode: ocpiPartners.countryCode,
      partyId: ocpiPartners.partyId,
      status: ocpiPartners.status,
      approvedRoles: ocpiPartners.approvedRoles,
      allowPrivateNetwork: ocpiPartners.allowPrivateNetwork,
      allowRawToken: ocpiPartners.allowRawToken,
    })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, found.partnerId))
    .limit(1);

  if (partner == null) return null;
  if (raw && !partner.allowRawToken) return null;

  return {
    partner: {
      partnerId: found.partnerId,
      partnerName: partner.name,
      countryCode: partner.countryCode,
      partyId: partner.partyId,
      allowPrivateNetwork: partner.allowPrivateNetwork,
      tokenId: found.tokenId,
    },
    token: {
      kind: found.kind,
      partnerStatus: partner.status,
      roleNames: roleNamesOf(partner.approvedRoles),
    },
  };
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  accept: (token: OcpiTokenInfo) => boolean,
): Promise<void> {
  const now = Date.now();
  if (failureLimited(request.ip, now)) {
    await reply
      .status(429)
      .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Too many failed authentication attempts'));
    return;
  }

  const header = extractToken(request);
  if (header == null) {
    recordFailure(request.ip, now);
    await reply
      .status(401)
      .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Missing or invalid Authorization header'));
    return;
  }

  const verified = await verifyToken(header);
  if (verified == null || !accept(verified.token)) {
    recordFailure(request.ip, now);
    await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Invalid token'));
    return;
  }

  request.ocpiPartner = verified.partner;
  request.ocpiToken = verified.token;
}

/**
 * Module endpoints: a credentials token of a connected partner. A
 * registration token gets 401 (OCPI 2.3.0 4.1), and so does a partner that
 * is pending, suspended or disconnected. Then the partner needs an
 * operator-approved role the module interface serves (`moduleRouteAllows`,
 * deny by default): else 403, and a route of no known module
 * serves nobody.
 */
export async function ocpiAuthenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticate(
    request,
    reply,
    (token) => token.kind === 'credentials' && token.partnerStatus === 'connected',
  );
  if (reply.sent || request.ocpiToken == null) return;
  const routeUrl = request.routeOptions.url ?? '';
  if (!moduleRouteAllows(routeUrl, request.ocpiToken.roleNames)) {
    await reply
      .status(403)
      .send(
        ocpiError(
          OcpiStatusCode.CLIENT_ERROR,
          'No role the operator approved for this partner serves this module',
        ),
      );
  }
}

/**
 * Versions, version details and the credentials module: any active token we
 * issued to a partner (registration or credentials), whatever the partner's
 * status. The credentials handlers decide per method what each kind may do.
 */
export async function ocpiAuthenticateRegistration(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticate(request, reply, () => true);
}
