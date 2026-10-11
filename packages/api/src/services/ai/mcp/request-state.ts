// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * MCP `requestState` for a write that became a proposal. The state
 * travels through the MCP client and comes back as attacker-controlled input,
 * so it is sealed with AES-256-GCM (AEAD) under a key derived from
 * `SETTINGS_ENCRYPTION_KEY` with HKDF, bound to the principal (user and API
 * key), the tool name as called, the hash of the arguments as called and an
 * expiry. A state that fails any check is refused as a whole.
 *
 * The state never authorizes anything by itself: it only names the proposal
 * whose stored status the retry reports. The proposal runs only when its
 * requester confirms it in the CSMS, and its result is returned once (the
 * `delivered` claim in `ai_mcp_calls`), so a replayed state gets
 * `AI_PROPOSAL_ALREADY_DECIDED`.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_SALT = 'evtivity-mcp-request-state';
const HKDF_INFO = 'evtivity:mcp:request-state:v1';
const AAD = Buffer.from(`evtivity-mcp-request-state-v${String(VERSION)}`);

const payloadSchema = z.object({
  v: z.literal(VERSION),
  proposalId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  apiKeyId: z.string().min(1).max(32),
  toolName: z.string().min(1).max(200),
  argsHash: z.string().min(1).max(64),
  /** Expiry, epoch milliseconds. */
  exp: z.number().int().positive(),
  /** Random, so two states for one proposal never look alike. */
  nonce: z.string().min(1).max(32),
});

export type McpRequestStatePayload = z.infer<typeof payloadSchema>;

export interface McpRequestStateInput {
  proposalId: string;
  userId: string;
  apiKeyId: string;
  toolName: string;
  argsHash: string;
  expiresAt: Date;
}

/** Who sends a retry and what they call. */
export interface McpRequestStateExpectation {
  userId: string;
  apiKeyId: string;
  toolName: string;
  argsHash: string;
  now: Date;
}

export type McpRequestStateFailure =
  | 'malformed'
  | 'tampered'
  | 'expired'
  | 'other_principal'
  | 'other_tool'
  | 'other_arguments';

export type McpRequestStateVerification =
  | { ok: true; payload: McpRequestStatePayload }
  | { ok: false; reason: McpRequestStateFailure };

function deriveKey(secret: string): Buffer {
  if (secret === '') throw new Error('SETTINGS_ENCRYPTION_KEY is required for MCP request state');
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, 32));
}

/** Seals the state of one proposal for one principal, tool and argument set. */
export function sealMcpRequestState(input: McpRequestStateInput, secret: string): string {
  const payload: McpRequestStatePayload = {
    v: VERSION,
    proposalId: input.proposalId,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    toolName: input.toolName,
    argsHash: input.argsHash,
    exp: input.expiresAt.getTime(),
    nonce: randomBytes(12).toString('base64url'),
  };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function open(state: string, secret: string): unknown {
  const raw = Buffer.from(state, 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES || raw.toString('base64url') !== state) {
    return { malformed: true };
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), raw.subarray(0, IV_BYTES));
  decipher.setAAD(AAD);
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    const plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plain) as unknown;
  } catch (err) {
    // An authentication failure is the expected answer to a forged or
    // changed state; the caller refuses it.
    if (err instanceof Error) return { tampered: true };
    throw err;
  }
}

/**
 * Opens a state and checks it against the retry: the principal, the tool,
 * the arguments and the expiry must all match.
 */
export function verifyMcpRequestState(
  state: unknown,
  expected: McpRequestStateExpectation,
  secret: string,
): McpRequestStateVerification {
  if (typeof state !== 'string' || state.length === 0 || state.length > 2048) {
    return { ok: false, reason: 'malformed' };
  }
  const opened = open(state, secret);
  if (typeof opened === 'object' && opened !== null && 'malformed' in opened) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof opened === 'object' && opened !== null && 'tampered' in opened) {
    return { ok: false, reason: 'tampered' };
  }
  const parsed = payloadSchema.safeParse(opened);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const payload = parsed.data;
  if (payload.userId !== expected.userId || payload.apiKeyId !== expected.apiKeyId) {
    return { ok: false, reason: 'other_principal' };
  }
  if (payload.toolName !== expected.toolName) return { ok: false, reason: 'other_tool' };
  if (payload.argsHash !== expected.argsHash) return { ok: false, reason: 'other_arguments' };
  if (expected.now.getTime() >= payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}
