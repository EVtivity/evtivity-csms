// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { recordSessionEndRequest } from '../lib/session-end-request.js';

function makeSql(rows: Record<string, unknown>[]): {
  sql: postgres.Sql;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(rows);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

describe('recordSessionEndRequest', () => {
  it('records the request on an active session', async () => {
    const { sql, calls } = makeSql([{ id: 'ses_1' }]);
    expect(await recordSessionEndRequest(sql, 'ses_1', 'GhostRecovered')).toBe(true);
    expect(calls[0]?.text).toContain('SET end_request_reason = ?');
    expect(calls[0]?.text).toContain("WHERE id = ? AND status = 'active'");
    expect(calls[0]?.values).toEqual(['GhostRecovered', 'ses_1']);
  });

  it('records nothing for a session that is no longer active (P5)', async () => {
    const { sql } = makeSql([]);
    expect(await recordSessionEndRequest(sql, 'ses_1', 'GhostRecovered')).toBe(false);
  });
});
