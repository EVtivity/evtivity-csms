// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * An in-memory `ocpi_commands` table for the command callback service tests:
 * `insert` takes the `db.insert(ocpiCommands).values(row)` rows, and `client`
 * answers the service's raw statements (claim one, record a result, claim the
 * timed out ones, prune) like PostgreSQL would.
 */

export interface FakeCommandRow {
  id: string;
  partnerId: string;
  commandType: string;
  responseUrl: string;
  result: string | null;
  resultSentAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface FakeOcpiCommands {
  rows: Map<string, FakeCommandRow>;
  insertValues: (row: Record<string, unknown>) => Promise<void>;
  client: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
}

function claimed(row: FakeCommandRow): Record<string, unknown> {
  return {
    id: row.id,
    partner_id: row.partnerId,
    response_url: row.responseUrl,
    command_type: row.commandType,
  };
}

export function createFakeOcpiCommands(): FakeOcpiCommands {
  const rows = new Map<string, FakeCommandRow>();

  const insertValues = (row: Record<string, unknown>): Promise<void> => {
    const id = row['id'] as string;
    rows.set(id, {
      id,
      partnerId: row['partnerId'] as string,
      commandType: row['commandType'] as string,
      responseUrl: row['responseUrl'] as string,
      result: null,
      resultSentAt: null,
      createdAt: new Date(),
      expiresAt: row['expiresAt'] as Date,
    });
    return Promise.resolve();
  };

  const client = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    const now = new Date();
    if (text.includes('SET result_sent_at = now()') && text.includes('WHERE id =')) {
      const row = rows.get(values[0] as string);
      if (row == null || row.resultSentAt != null) return Promise.resolve([]);
      row.resultSentAt = now;
      return Promise.resolve([claimed(row)]);
    }
    if (text.includes("result = 'TIMEOUT'")) {
      const out: unknown[] = [];
      for (const row of rows.values()) {
        if (row.resultSentAt == null && row.expiresAt < now) {
          row.resultSentAt = now;
          row.result = 'TIMEOUT';
          out.push(claimed(row));
        }
      }
      return Promise.resolve(out);
    }
    if (text.includes('SET result =')) {
      const row = rows.get(values[1] as string);
      if (row != null) row.result = values[0] as string;
      return Promise.resolve([]);
    }
    if (text.includes('DELETE FROM ocpi_commands')) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected statement: ${text}`));
  };

  return { rows, insertValues, client };
}
