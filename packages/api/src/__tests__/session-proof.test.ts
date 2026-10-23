// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const proof = vi.hoisted(() => ({
  refusal: null as null | { status: number; body: Record<string, unknown> },
  calls: [] as unknown[][],
}));

vi.mock('../lib/mfa-factor-proof.js', () => ({
  FACTOR_PROOF_KINDS: ['totp', 'code', 'passkey', 'password', 'sso', 'recovery_code'],
  checkFactorProof: vi.fn((...args: unknown[]) => {
    proof.calls.push(args);
    return Promise.resolve(proof.refusal);
  }),
  sendFactorProofRefusal: vi.fn(
    async (reply: FastifyReply, refused: { status: number; body: unknown }) => {
      await reply.status(refused.status).send(refused.body);
    },
  ),
}));

import { isApiKeyRequest, requireSessionProof } from '../lib/session-proof.js';

function reply(): FastifyReply & { sent: unknown; code: number } {
  const r = {
    sent: undefined as unknown,
    code: 0,
    status(n: number) {
      r.code = n;
      return r;
    },
    send(body: unknown) {
      r.sent = body;
      return Promise.resolve(r);
    },
  };
  return r as unknown as FastifyReply & { sent: unknown; code: number };
}

const session = { user: { userId: 'usr_1', roleId: 'rol_1' } } as unknown as FastifyRequest;
const apiKey = {
  user: { userId: 'usr_1', roleId: 'rol_1', isApiKey: true },
} as unknown as FastifyRequest;

beforeEach(() => {
  proof.refusal = null;
  proof.calls = [];
});

describe('requireSessionProof', () => {
  it('lets an API key through without checking a proof', async () => {
    expect(isApiKeyRequest(apiKey)).toBe(true);
    expect(await requireSessionProof(apiKey, reply(), undefined)).toBe(true);
    expect(proof.calls).toHaveLength(0);
  });

  it('checks a session proof with the confirm purpose', async () => {
    const sent = { kind: 'password' as const, password: 'x' };
    expect(await requireSessionProof(session, reply(), sent)).toBe(true);
    expect(proof.calls[0]?.slice(1)).toEqual([{ userId: 'usr_1' }, sent, 'confirm']);
  });

  it('sends the refusal and stops a session without a proof', async () => {
    proof.refusal = {
      status: 400,
      body: { error: 'x', code: 'VALIDATION_ERROR', proofKinds: ['password'] },
    };
    const r = reply();
    expect(await requireSessionProof(session, r, undefined)).toBe(false);
    expect(r.code).toBe(400);
    expect(r.sent).toMatchObject({ proofKinds: ['password'] });
  });
});
