// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcpiTokenOwnerResult } from '@evtivity/database';

type Row = Record<string, unknown>;

/**
 * `resolveOcpiTokenOwner` over mocked `ocpi_external_tokens` rows, for tests
 * that mock `@evtivity/database`: one valid row (is_valid, whitelist not
 * NEVER) owns the uid (WHITELIST), several valid rows are ambiguous, and with
 * none valid the first row is returned, as the real resolver does.
 */
export function ocpiOwnerFromRows(rows: readonly unknown[]): OcpiTokenOwnerResult {
  const list = rows as Row[];
  const valid = list.filter((r) => r['isValid'] === true && r['whitelist'] !== 'NEVER');
  if (valid.length > 1) return { owner: null, ambiguous: true };
  const row = valid[0] ?? list[0];
  if (row == null) return { owner: null, ambiguous: false };
  return {
    owner: {
      partnerId: typeof row['partnerId'] === 'string' ? row['partnerId'] : 'opr_000000000001',
      authMethod: 'WHITELIST',
      commandId: null,
      authorizationReference: null,
      isValid: row['isValid'] === true,
      whitelist: typeof row['whitelist'] === 'string' ? row['whitelist'] : 'ALLOWED',
      tokenData: row['tokenData'],
    },
    ambiguous: false,
  };
}
