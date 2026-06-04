// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    execute: mockExecute,
  },
}));

// Real drizzle-orm so `sql.identifier` and template interpolation produce
// inspectable query objects that `renderSql` walks for assertions.
import { pruneOldRows } from '../../lib/prune-old-rows.js';

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function rowCountResult(n: number): { rowCount: number } {
  return { rowCount: n };
}

beforeEach(() => {
  mockExecute.mockReset();
});

describe('pruneOldRows', () => {
  it('returns 0 and never queries when retentionDays is zero', async () => {
    const log = makeLog();
    const result = await pruneOldRows({
      table: 'audit_log',
      cutoffColumn: 'created_at',
      retentionDays: 0,
      log,
    });
    expect(result).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 0 and never queries when retentionDays is negative', async () => {
    const log = makeLog();
    const result = await pruneOldRows({
      table: 'audit_log',
      cutoffColumn: 'created_at',
      retentionDays: -5,
      log,
    });
    expect(result).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 0 and never queries when retentionDays is non-finite (NaN)', async () => {
    const log = makeLog();
    const result = await pruneOldRows({
      table: 'audit_log',
      cutoffColumn: 'created_at',
      retentionDays: Number.NaN,
      log,
    });
    expect(result).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('runs a single batch and exits when the first batch deletes fewer than batchSize', async () => {
    const log = makeLog();
    mockExecute.mockResolvedValueOnce(rowCountResult(3));

    const result = await pruneOldRows({
      table: 'security_events',
      cutoffColumn: 'timestamp',
      retentionDays: 365,
      log,
    });

    expect(result).toBe(3);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('loops until a batch returns fewer rows than batchSize, summing deletions', async () => {
    const log = makeLog();
    // Three full batches (default 1000) then a partial final batch -> stop.
    mockExecute
      .mockResolvedValueOnce(rowCountResult(1000))
      .mockResolvedValueOnce(rowCountResult(1000))
      .mockResolvedValueOnce(rowCountResult(1000))
      .mockResolvedValueOnce(rowCountResult(250));

    const result = await pruneOldRows({
      table: 'notifications',
      cutoffColumn: 'created_at',
      retentionDays: 90,
      log,
    });

    expect(result).toBe(3250);
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it('honours a custom batchSize as the loop-exit threshold', async () => {
    const log = makeLog();
    // batchSize=5: a full batch of 5 keeps looping; the next batch of 2 (< 5) exits.
    mockExecute.mockResolvedValueOnce(rowCountResult(5)).mockResolvedValueOnce(rowCountResult(2));

    const result = await pruneOldRows({
      table: 'port_status_log',
      cutoffColumn: 'timestamp',
      retentionDays: 30,
      batchSize: 5,
      log,
    });

    expect(result).toBe(7);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('treats a zero-row first batch as exhaustion (deletes nothing, single query)', async () => {
    const log = makeLog();
    mockExecute.mockResolvedValueOnce(rowCountResult(0));

    const result = await pruneOldRows({
      table: 'access_logs',
      cutoffColumn: 'created_at',
      retentionDays: 30,
      log,
    });

    expect(result).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('treats a missing rowCount on the result as zero deletions and exits', async () => {
    const log = makeLog();
    // db.execute resolves without a rowCount field -> deleted defaults to 0.
    mockExecute.mockResolvedValueOnce({});

    const result = await pruneOldRows({
      table: 'access_logs',
      cutoffColumn: 'created_at',
      retentionDays: 30,
      log,
    });

    expect(result).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('targets the supplied table and cutoff column in the batched CTE/DELETE', async () => {
    const log = makeLog();
    mockExecute.mockResolvedValueOnce(rowCountResult(0));

    await pruneOldRows({
      table: 'worker_job_logs',
      cutoffColumn: 'completed_at',
      retentionDays: 30,
      log,
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    // Render the captured drizzle SQL object to inspect identifiers/params.
    const rendered = renderSql(mockExecute.mock.calls[0]![0]);
    expect(rendered.sql).toContain('"worker_job_logs"');
    expect(rendered.sql).toContain('"completed_at"');
    expect(rendered.sql).toContain('WITH batch AS');
    expect(rendered.sql).toContain('DELETE FROM');
    expect(rendered.sql).toContain('LIMIT');
    // retentionDays (30) and batchSize (1000) are interpolated into the query.
    expect(rendered.numbers).toContain(30);
    expect(rendered.numbers).toContain(1000);
  });

  it('swallows a thrown db error, logs a warn, and resolves with the running total', async () => {
    const log = makeLog();
    mockExecute
      .mockResolvedValueOnce(rowCountResult(1000))
      .mockRejectedValueOnce(new Error('deadlock detected'));

    const result = await pruneOldRows({
      table: 'ocpp_message_logs',
      cutoffColumn: 'created_at',
      retentionDays: 30,
      log,
    });

    // First batch counted (1000), second batch threw mid-loop.
    expect(result).toBe(1000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { table: 'ocpp_message_logs', err: 'deadlock detected' },
      'pruneOldRows: prune failed for table',
    );
  });

  it('stringifies non-Error throwables in the warn log', async () => {
    const log = makeLog();
    mockExecute.mockRejectedValueOnce('plain string failure');

    const result = await pruneOldRows({
      table: 'connection_logs',
      cutoffColumn: 'created_at',
      retentionDays: 90,
      log,
    });

    expect(result).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      { table: 'connection_logs', err: 'plain string failure' },
      'pruneOldRows: prune failed for table',
    );
  });
});

// Walks a drizzle SQL template's `queryChunks` to recover the rendered SQL
// string, quoted identifiers, and interpolated numeric literals so tests can
// assert on the exact table/column targets and the retention/batch params.
function renderSql(query: unknown): { sql: string; numbers: number[] } {
  const numbers: number[] = [];
  let out = '';
  walk(query, numbers, (s) => (out += s));
  return { sql: out, numbers };
}

function walk(node: unknown, numbers: number[], emit: (s: string) => void): void {
  if (node == null) return;
  if (typeof node === 'number') {
    numbers.push(node);
    emit(String(node));
    return;
  }
  if (typeof node === 'string') {
    emit(node);
    return;
  }
  const ctor = (node as { constructor?: { name?: string } }).constructor?.name;
  const c = node as Record<string, unknown>;
  if (ctor === 'StringChunk' && Array.isArray(c['value'])) {
    emit((c['value'] as string[]).join(''));
    return;
  }
  if (ctor === 'Name' && typeof c['value'] === 'string') {
    emit(`"${c['value']}"`);
    return;
  }
  if (Array.isArray(c['queryChunks'])) {
    for (const child of c['queryChunks'] as unknown[]) {
      walk(child, numbers, emit);
    }
    return;
  }
  // Param wrapper: { value, encoder }
  if ('value' in c) {
    walk(c['value'], numbers, emit);
  }
}
