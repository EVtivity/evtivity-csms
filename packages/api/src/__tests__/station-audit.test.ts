// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

const { mockWriteAudit, stationAuditLogTable, dbStub } = vi.hoisted(() => ({
  mockWriteAudit: vi.fn(() => Promise.resolve()),
  stationAuditLogTable: { name: 'station_audit_log' },
  dbStub: { insert: vi.fn() },
}));

vi.mock('@evtivity/database', () => ({
  db: dbStub,
  stationAuditLog: stationAuditLogTable,
  writeAudit: mockWriteAudit,
}));

import { auditStationChange } from '../lib/station-audit.js';

describe('auditStationChange', () => {
  it('writes one station_audit_log row with the request actor', async () => {
    const log = { warn: vi.fn() };
    const request = {
      user: { userId: 'usr_1', roleId: 'rol_1' },
      log,
    } as unknown as FastifyRequest;

    await auditStationChange(request, 'sta_1', 'evse_changed', {
      before: { evseId: 1 },
      notes: 'EVSE 1 deleted',
    });

    expect(mockWriteAudit).toHaveBeenCalledWith(
      { table: stationAuditLogTable, idColumn: 'station_id' },
      {
        entityId: 'sta_1',
        entityIdSnapshot: 'sta_1',
        action: 'evse_changed',
        actor: 'operator',
        actorUserId: 'usr_1',
        actorDriverId: null,
        actorApiKeyId: null,
        actorLabel: null,
        before: { evseId: 1 },
        after: null,
        notes: 'EVSE 1 deleted',
      },
      dbStub,
      log,
    );
  });
});
