// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, drivers, fleetDrivers } from '@evtivity/database';
import { ValidationError } from '@evtivity/lib';
import { isFleetUserCardType, PORTAL_ID_TOKEN_TYPES } from '@evtivity/lib/id-token-types';
import {
  FLEET_CARD_IMPORT_MAX_BYTES,
  FLEET_CARD_IMPORT_MAX_ROWS,
} from '@evtivity/lib/fleet-card-import';
import { cardIdMatchKey } from '@evtivity/lib/vehicle-id';
import { parseCsv } from '@evtivity/services/departure-import';
import { tokenLabelProblem } from '../lib/token-label.js';
import * as tokenService from './token.service.js';

export type FleetCardImportField = 'idToken' | 'tokenType' | 'label' | 'memberEmail';
export type FleetCardImportReason = 'missing' | 'invalid' | 'duplicate' | 'not_found';

/** A refused row: its line in the file (the header is line 1), the field and why. Never the value. */
export interface FleetCardImportRefusal {
  row: number;
  field: FleetCardImportField;
  reason: FleetCardImportReason;
}

export interface FleetCardImportResult {
  created: number;
  refused: FleetCardImportRefusal[];
}

export interface FleetCardImportDeps {
  /** The active, not erased members of the fleet by lowercased email. */
  memberEmails(fleetId: string): Promise<Map<string, string>>;
  createCard: typeof tokenService.createToken;
}

const HEADER_ALIASES: Record<string, FleetCardImportField> = {
  idtoken: 'idToken',
  id_token: 'idToken',
  card: 'idToken',
  card_value: 'idToken',
  value: 'idToken',
  rfid: 'idToken',
  rfid_card: 'idToken',
  tokentype: 'tokenType',
  token_type: 'tokenType',
  type: 'tokenType',
  label: 'label',
  name: 'label',
  memberemail: 'memberEmail',
  member_email: 'memberEmail',
  member: 'memberEmail',
  email: 'memberEmail',
};

class RowRefusal extends Error {
  constructor(
    readonly field: FleetCardImportField,
    readonly reason: FleetCardImportReason,
  ) {
    super(`${field} ${reason}`);
  }
}

function headerKey(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

async function activeMemberEmails(fleetId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: drivers.id, email: drivers.email })
    .from(fleetDrivers)
    .innerJoin(drivers, eq(drivers.id, fleetDrivers.driverId))
    .where(
      and(
        eq(fleetDrivers.fleetId, fleetId),
        eq(drivers.isActive, true),
        isNull(drivers.erasedAt),
        sql`${drivers.email} IS NOT NULL`,
      ),
    );
  const byEmail = new Map<string, string>();
  for (const row of rows) {
    if (row.email != null) byEmail.set(row.email.trim().toLowerCase(), row.id);
  }
  return byEmail;
}

export const defaultFleetCardImportDeps: FleetCardImportDeps = {
  memberEmails: activeMemberEmails,
  createCard: tokenService.createToken,
};

/** The refusal a token service error stands for, or null for an error the import does not expect. */
function refusalOf(err: unknown, byFleetUser: boolean): RowRefusal | null {
  if (err instanceof RowRefusal) return err;
  // A fleet user never learns that a value is registered outside its fleet (security case 466).
  if (err instanceof tokenService.DuplicateTokenError)
    return new RowRefusal('idToken', byFleetUser ? 'invalid' : 'duplicate');
  if (
    err instanceof tokenService.VehicleShapedCardError ||
    err instanceof tokenService.FleetCardTypeNotAllowedError ||
    err instanceof tokenService.VehicleIdTokenInUseError ||
    err instanceof tokenService.FleetCardDeactivatedError ||
    err instanceof tokenService.TokenReactivationBlockedError ||
    err instanceof tokenService.PncContractTokenError
  ) {
    return new RowRefusal('idToken', 'invalid');
  }
  if (
    err instanceof tokenService.FleetCardDriverNotMemberError ||
    err instanceof tokenService.TokenDriverNotFoundError ||
    err instanceof tokenService.TokenDriverInactiveError
  ) {
    return new RowRefusal('memberEmail', 'not_found');
  }
  return null;
}

/**
 * Adds the fleet RFID cards of a CSV file, each row through the token service
 * like a single add (its own transaction, so a refused row changes nothing).
 * The caller checked the fleet scope. Only an operator gives cards to members
 * by email (an active member of the fleet); a fleet user's file with a member
 * email is refused whole. A fleet that does not bill on account refuses the
 * file (FleetCardNotBillableError, nothing written). Refused rows name their
 * line, field and reason, never the cell value.
 */
export async function importFleetCards(
  scope: tokenService.FleetCardScope,
  csv: string,
  actor: tokenService.TokenActor,
  deps: FleetCardImportDeps = defaultFleetCardImportDeps,
): Promise<FleetCardImportResult> {
  if (Buffer.byteLength(csv, 'utf8') > FLEET_CARD_IMPORT_MAX_BYTES) {
    throw new ValidationError('The CSV file is larger than 512 KB', { field: 'csv' });
  }
  const lines = parseCsv(csv);
  const header = lines[0];
  if (header == null) throw new ValidationError('The CSV file is empty', { field: 'csv' });
  const columns = new Map<FleetCardImportField, number>();
  header.forEach((cell, index) => {
    const field = HEADER_ALIASES[headerKey(cell)];
    if (field != null && !columns.has(field)) columns.set(field, index);
  });
  if (!columns.has('idToken')) {
    throw new ValidationError('The CSV file has no idToken column', { field: 'csv' });
  }
  const dataRows = lines
    .map((cells, index) => ({ cells, line: index + 1 }))
    .slice(1)
    .filter(({ cells }) => cells.some((c) => c.trim() !== ''));
  if (dataRows.length > FLEET_CARD_IMPORT_MAX_ROWS) {
    throw new ValidationError('A CSV import takes at most 2000 rows', { field: 'csv' });
  }
  const cellOf = (cells: string[], field: FleetCardImportField): string => {
    const index = columns.get(field);
    return index == null ? '' : (cells[index] ?? '').trim();
  };

  // A fleet user never matches a member by email: a created or refused row
  // would tell it which address belongs to a member (security case 449). It
  // gives cards to members on the RFID Cards tab, where it picks them by name.
  if (scope.byFleetUser && dataRows.some(({ cells }) => cellOf(cells, 'memberEmail') !== '')) {
    throw new ValidationError(
      'Fleet users give imported cards to members on the RFID Cards tab, not by member email',
      { field: 'memberEmail' },
    );
  }
  const members: Map<string, string> = columns.has('memberEmail')
    ? await deps.memberEmails(scope.fleetId)
    : new Map<string, string>();
  const seen = new Set<string>();
  const result: FleetCardImportResult = { created: 0, refused: [] };
  for (const { cells, line } of dataRows) {
    try {
      const idToken = cellOf(cells, 'idToken');
      if (idToken === '') throw new RowRefusal('idToken', 'missing');
      if (idToken.length > 255) throw new RowRefusal('idToken', 'invalid');
      const typeCell = cellOf(cells, 'tokenType');
      const tokenType = typeCell === '' ? 'ISO14443' : typeCell;
      if (!(PORTAL_ID_TOKEN_TYPES as readonly string[]).includes(tokenType)) {
        throw new RowRefusal('tokenType', 'invalid');
      }
      if (scope.byFleetUser && !isFleetUserCardType(tokenType)) {
        throw new RowRefusal('tokenType', 'invalid');
      }
      const key = `${tokenType}\u0000${cardIdMatchKey(idToken, tokenType)}`;
      if (seen.has(key)) throw new RowRefusal('idToken', 'duplicate');
      const label = cellOf(cells, 'label');
      if (label !== '' && tokenLabelProblem(label) != null) {
        throw new RowRefusal('label', 'invalid');
      }
      const email = cellOf(cells, 'memberEmail').toLowerCase();
      let driverId: string | null = null;
      if (email !== '') {
        driverId = members.get(email) ?? null;
        if (driverId == null) throw new RowRefusal('memberEmail', 'not_found');
      }
      seen.add(key);
      const token = await deps.createCard(
        { idToken, tokenType, label: label === '' ? null : label, driverId },
        actor,
        { fleet: scope },
      );
      if (token == null) throw new RowRefusal('idToken', 'invalid');
      result.created += 1;
    } catch (err) {
      const refusal = refusalOf(err, scope.byFleetUser);
      if (refusal == null) throw err;
      result.refused.push({ row: line, field: refusal.field, reason: refusal.reason });
    }
  }
  return result;
}
