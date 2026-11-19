// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

const errors = vi.hoisted(() => {
  class DuplicateTokenError extends Error {}
  class VehicleShapedCardError extends Error {}
  class FleetCardTypeNotAllowedError extends Error {}
  class VehicleIdTokenInUseError extends Error {}
  class FleetCardDeactivatedError extends Error {}
  class TokenReactivationBlockedError extends Error {}
  class PncContractTokenError extends Error {}
  class FleetCardDriverNotMemberError extends Error {}
  class TokenDriverNotFoundError extends Error {}
  class TokenDriverInactiveError extends Error {}
  class FleetCardNotBillableError extends Error {}
  return {
    DuplicateTokenError,
    VehicleShapedCardError,
    FleetCardTypeNotAllowedError,
    VehicleIdTokenInUseError,
    FleetCardDeactivatedError,
    TokenReactivationBlockedError,
    PncContractTokenError,
    FleetCardDriverNotMemberError,
    TokenDriverNotFoundError,
    TokenDriverInactiveError,
    FleetCardNotBillableError,
    createToken: vi.fn(),
  };
});

vi.mock('../services/token.service.js', () => errors);
vi.mock('@evtivity/database', () => ({ db: {}, drivers: {}, fleetDrivers: {} }));

import {
  FLEET_CARD_IMPORT_MAX_ROWS,
  FLEET_CARD_IMPORT_TEMPLATE,
} from '@evtivity/lib/fleet-card-import';
import { importFleetCards, type FleetCardImportDeps } from '../services/fleet-card-import.js';

const scope = { fleetId: 'flt_1', byFleetUser: false };
const fleetUserScope = { fleetId: 'flt_1', byFleetUser: true };
const actor = { type: 'operator', userId: 'usr_1' } as const;

function deps(
  members: Record<string, string> = {},
  createCard: FleetCardImportDeps['createCard'] = vi.fn(() =>
    Promise.resolve({ id: 'dtk_x' }),
  ) as unknown as FleetCardImportDeps['createCard'],
): FleetCardImportDeps {
  return {
    memberEmails: () => Promise.resolve(new Map(Object.entries(members))),
    createCard,
  };
}

describe('importFleetCards', () => {
  it('answers a fleet user a value registered outside its fleet as not valid, never as registered', async () => {
    const createCard = vi.fn((data: { idToken: string }) =>
      data.idToken === 'TAKEN'
        ? Promise.reject(new errors.DuplicateTokenError())
        : Promise.resolve({ id: 'dtk_x' }),
    );
    const csv = ['idToken,tokenType,label', 'TAKEN,,', 'CARD-2,,', 'CARD-2,,'].join('\n');
    const asFleetUser = await importFleetCards(
      fleetUserScope,
      csv,
      actor,
      deps({}, createCard as unknown as FleetCardImportDeps['createCard']),
    );
    expect(asFleetUser.refused).toEqual([
      { row: 2, field: 'idToken', reason: 'invalid' },
      // A repeat within the file says nothing about other fleets.
      { row: 4, field: 'idToken', reason: 'duplicate' },
    ]);
    const asOperator = await importFleetCards(
      scope,
      csv,
      actor,
      deps({}, createCard as unknown as FleetCardImportDeps['createCard']),
    );
    expect(asOperator.refused[0]).toEqual({ row: 2, field: 'idToken', reason: 'duplicate' });
  });

  it('refuses a fleet user every card type but ISO14443 and ISO15693, and writes nothing for them', async () => {
    const createCard = vi.fn(() => Promise.resolve({ id: 'dtk_x' }));
    const csv = [
      'idToken,tokenType,label',
      'CARD-1,,',
      'CARD-2,ISO15693,',
      'CARD-3,KeyCode,',
      'CARD-4,eMAID,',
      'CARD-5,Local,',
    ].join('\n');
    const result = await importFleetCards(
      fleetUserScope,
      csv,
      actor,
      deps({}, createCard as unknown as FleetCardImportDeps['createCard']),
    );
    expect(result.created).toBe(2);
    expect(result.refused).toEqual([
      { row: 4, field: 'tokenType', reason: 'invalid' },
      { row: 5, field: 'tokenType', reason: 'invalid' },
      { row: 6, field: 'tokenType', reason: 'invalid' },
    ]);
    expect(createCard.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({ idToken: 'CARD-1', tokenType: 'ISO14443' }),
      expect.objectContaining({ idToken: 'CARD-2', tokenType: 'ISO15693' }),
    ]);
  });

  it('adds every valid row through the token service with the fleet scope', async () => {
    const createCard = vi.fn(() => Promise.resolve({ id: 'dtk_x' }));
    const csv =
      '﻿Card Value,Type,Label,Member Email\r\nCARD-1,,Van 1,\r\n"CARD,2",ISO15693,,Lee@Example.com\r\n\r\n';
    const result = await importFleetCards(
      scope,
      csv,
      actor,
      deps(
        { 'lee@example.com': 'drv_lee' },
        createCard as unknown as FleetCardImportDeps['createCard'],
      ),
    );
    expect(result).toEqual({ created: 2, refused: [] });
    expect(createCard).toHaveBeenNthCalledWith(
      1,
      { idToken: 'CARD-1', tokenType: 'ISO14443', label: 'Van 1', driverId: null },
      actor,
      { fleet: scope },
    );
    expect(createCard).toHaveBeenNthCalledWith(
      2,
      { idToken: 'CARD,2', tokenType: 'ISO15693', label: null, driverId: 'drv_lee' },
      actor,
      { fleet: scope },
    );
  });

  it('refuses rows by line, field and reason without the value, and keeps the others', async () => {
    const createCard = vi.fn((data: { idToken: string }) => {
      if (data.idToken === 'TAKEN') return Promise.reject(new errors.DuplicateTokenError());
      if (data.idToken === 'VID:ABC') return Promise.reject(new errors.VehicleShapedCardError());
      if (data.idToken === 'GONE') {
        return Promise.reject(new errors.FleetCardDriverNotMemberError());
      }
      return Promise.resolve({ id: 'dtk_x' });
    });
    const csv = [
      'idToken,tokenType,label,memberEmail',
      ',ISO14443,,',
      'CARD-1,Central,,',
      'CARD-2,,,nobody@example.com',
      'TAKEN,,,',
      'VID:ABC,,,',
      'CARD-3,,Bad‮label,',
      'CARD-4,,,',
      'CARD-4,,,',
      'GONE,,,lee@example.com',
    ].join('\n');
    const result = await importFleetCards(
      scope,
      csv,
      actor,
      deps(
        { 'lee@example.com': 'drv_lee' },
        createCard as unknown as FleetCardImportDeps['createCard'],
      ),
    );
    expect(result.created).toBe(1);
    expect(result.refused).toEqual([
      { row: 2, field: 'idToken', reason: 'missing' },
      { row: 3, field: 'tokenType', reason: 'invalid' },
      { row: 4, field: 'memberEmail', reason: 'not_found' },
      { row: 5, field: 'idToken', reason: 'duplicate' },
      { row: 6, field: 'idToken', reason: 'invalid' },
      { row: 7, field: 'label', reason: 'invalid' },
      { row: 9, field: 'idToken', reason: 'duplicate' },
      { row: 10, field: 'memberEmail', reason: 'not_found' },
    ]);
    expect(JSON.stringify(result)).not.toContain('nobody@example.com');
    expect(JSON.stringify(result)).not.toContain('TAKEN');
  });

  it('refuses a file over the size cap, over the row cap or without an idToken column', async () => {
    const big = `idToken\n${'x'.repeat(512 * 1024)}`;
    await expect(importFleetCards(scope, big, actor, deps())).rejects.toThrow('512 KB');
    const many = `idToken\n${Array.from({ length: FLEET_CARD_IMPORT_MAX_ROWS + 1 }, (_, i) => `C-${String(i)}`).join('\n')}`;
    await expect(importFleetCards(scope, many, actor, deps())).rejects.toThrow('2000 rows');
    await expect(importFleetCards(scope, 'label\nVan 1\n', actor, deps())).rejects.toThrow(
      'no idToken column',
    );
    await expect(importFleetCards(scope, '', actor, deps())).rejects.toThrow('empty');
  });

  it('stops on an error the import does not expect', async () => {
    const createCard = vi.fn(() => Promise.reject(new Error('database down')));
    await expect(
      importFleetCards(
        scope,
        'idToken\nCARD-1\n',
        actor,
        deps({}, createCard as unknown as FleetCardImportDeps['createCard']),
      ),
    ).rejects.toThrow('database down');
  });

  it('never matches a member by email for a fleet user: the whole file is refused before any lookup', async () => {
    const createCard = vi.fn(() => Promise.resolve({ id: 'dtk_x' }));
    const memberEmails = vi.fn(() => Promise.resolve(new Map([['lee@example.com', 'drv_lee']])));
    const csv = 'idToken,memberEmail\nX1,lee@example.com\nX2,bob@example.com\n';
    await expect(
      importFleetCards(fleetUserScope, csv, actor, {
        memberEmails,
        createCard: createCard as unknown as FleetCardImportDeps['createCard'],
      }),
    ).rejects.toThrow('not by member email');
    expect(memberEmails).not.toHaveBeenCalled();
    expect(createCard).not.toHaveBeenCalled();
  });

  it('imports a fleet user file whose member email column is empty', async () => {
    const createCard = vi.fn(() => Promise.resolve({ id: 'dtk_x' }));
    const result = await importFleetCards(
      fleetUserScope,
      'idToken,memberEmail\nX1,\n',
      actor,
      deps({}, createCard as unknown as FleetCardImportDeps['createCard']),
    );
    expect(result).toEqual({ created: 1, refused: [] });
  });

  it('stops the whole file when the fleet does not bill on account', async () => {
    const createCard = vi.fn(() => Promise.reject(new errors.FleetCardNotBillableError()));
    await expect(
      importFleetCards(
        scope,
        'idToken\nCARD-1\nCARD-2\n',
        actor,
        deps({}, createCard as unknown as FleetCardImportDeps['createCard']),
      ),
    ).rejects.toBeInstanceOf(errors.FleetCardNotBillableError);
    expect(createCard).toHaveBeenCalledTimes(1);
  });

  it('ships a template the import reads', async () => {
    const createCard = vi.fn(() => Promise.resolve({ id: 'dtk_x' }));
    const result = await importFleetCards(
      scope,
      FLEET_CARD_IMPORT_TEMPLATE,
      actor,
      deps(
        { 'driver@example.com': 'drv_1' },
        createCard as unknown as FleetCardImportDeps['createCard'],
      ),
    );
    expect(result).toEqual({ created: 2, refused: [] });
  });
});
