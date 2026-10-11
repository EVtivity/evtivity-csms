// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { sealMcpRequestState, verifyMcpRequestState } from '../services/ai/mcp/request-state.js';

const SECRET = 'test-settings-encryption-key-0123456789';
const NOW = new Date('2026-10-10T12:00:00Z');

const input = {
  proposalId: 'apr_000000000001',
  userId: 'usr_000000000001',
  apiKeyId: '42',
  toolName: 'ocppv21_reset',
  argsHash: 'a'.repeat(64),
  expiresAt: new Date(NOW.getTime() + 30 * 60_000),
};

const expected = {
  userId: input.userId,
  apiKeyId: input.apiKeyId,
  toolName: input.toolName,
  argsHash: input.argsHash,
  now: NOW,
};

function flipByte(state: string, index: number): string {
  const raw = Buffer.from(state, 'base64url');
  raw[index] = (raw[index] ?? 0) ^ 0x01;
  return raw.toString('base64url');
}

describe('MCP request state', () => {
  it('TC-AI-MCP-09: a sealed state opens for its principal, tool and arguments', () => {
    const state = sealMcpRequestState(input, SECRET);
    const result = verifyMcpRequestState(state, expected, SECRET);
    expect(result).toMatchObject({ ok: true, payload: { proposalId: input.proposalId } });
    // No proposal id, user or key in clear text.
    expect(state).not.toContain(input.proposalId);
    expect(Buffer.from(state, 'base64url').toString('latin1')).not.toContain(input.userId);
  });

  it('TC-AI-MCP-09: two states for one proposal differ', () => {
    expect(sealMcpRequestState(input, SECRET)).not.toBe(sealMcpRequestState(input, SECRET));
  });

  it('TC-AI-MCP-09: a tampered state is refused', () => {
    const state = sealMcpRequestState(input, SECRET);
    const raw = Buffer.from(state, 'base64url');
    for (const index of [0, 13, raw.length - 1]) {
      expect(verifyMcpRequestState(flipByte(state, index), expected, SECRET)).toEqual({
        ok: false,
        reason: 'tampered',
      });
    }
    expect(verifyMcpRequestState(state, expected, 'another-secret-0123456789')).toEqual({
      ok: false,
      reason: 'tampered',
    });
  });

  it('TC-AI-MCP-09: a state of another principal is refused', () => {
    const state = sealMcpRequestState(input, SECRET);
    expect(
      verifyMcpRequestState(state, { ...expected, userId: 'usr_000000000002' }, SECRET),
    ).toEqual({ ok: false, reason: 'other_principal' });
    expect(verifyMcpRequestState(state, { ...expected, apiKeyId: '43' }, SECRET)).toEqual({
      ok: false,
      reason: 'other_principal',
    });
  });

  it('TC-AI-MCP-09: an expired state is refused', () => {
    const state = sealMcpRequestState(input, SECRET);
    expect(verifyMcpRequestState(state, { ...expected, now: input.expiresAt }, SECRET)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('TC-AI-MCP-09: a state of another tool or other arguments is refused', () => {
    const state = sealMcpRequestState(input, SECRET);
    expect(
      verifyMcpRequestState(state, { ...expected, toolName: 'ocppv21_unlock_connector' }, SECRET),
    ).toEqual({ ok: false, reason: 'other_tool' });
    expect(verifyMcpRequestState(state, { ...expected, argsHash: 'b'.repeat(64) }, SECRET)).toEqual(
      { ok: false, reason: 'other_arguments' },
    );
  });

  it('TC-AI-MCP-09: a malformed state is refused', () => {
    for (const state of [undefined, 42, '', 'not base64url!', 'AAAA', 'x'.repeat(3000)]) {
      expect(verifyMcpRequestState(state, expected, SECRET).ok).toBe(false);
    }
  });
});
