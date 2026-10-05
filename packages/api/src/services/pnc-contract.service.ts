// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The only writer of pnc_contracts: ISO 15118 contracts the local contract CA
// provisions. A contract is an eMAID driver token (written through the token
// service, so it is audited and the driver notified) bound to the PCID of the
// vehicle that may install it. The OCPP local contract provider reads the
// contracts and records each certificate it issues. Revoked is terminal: it
// also deactivates the eMAID token, so Authorize rejects it and the CA
// reports the issued certificates as revoked.

import crypto from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AppError } from '@evtivity/lib';
import { db, drivers, driverTokens, pncContracts, settings } from '@evtivity/database';
import * as tokenService from './token.service.js';
import type { TokenActor } from './token.service.js';

const EMAID_INSTANCE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const EMAID_ATTEMPTS = 5;

export interface PncContract {
  id: number;
  driverId: string;
  driverTokenId: string;
  emaid: string;
  pcid: string;
  status: 'active' | 'revoked';
  createdAt: Date;
  revokedAt: Date | null;
}

/** PCID as the local provider compares it: upper case letters and digits. */
export function normalizePcid(pcid: string): string {
  return pcid.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * A new eMAID in the ISO 15118 / DIN SPEC 91286 layout without separators:
 * country code (2), provider ID (3), ID type "C", and an 8 character
 * instance. The optional check digit is not appended.
 */
export function generateEmaid(country: string, providerId: string): string {
  let instance = '';
  for (let i = 0; i < 8; i++) {
    instance += EMAID_INSTANCE_ALPHABET.charAt(crypto.randomInt(EMAID_INSTANCE_ALPHABET.length));
  }
  return `${country}${providerId}C${instance}`;
}

async function readSettings(keys: string[]): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys));
  return new Map(rows.map((r) => [r.key, r.value]));
}

const contractSelect = {
  id: pncContracts.id,
  driverId: driverTokens.driverId,
  driverTokenId: pncContracts.driverTokenId,
  emaid: driverTokens.idToken,
  pcid: pncContracts.pcid,
  status: pncContracts.status,
  createdAt: pncContracts.createdAt,
  revokedAt: pncContracts.revokedAt,
};

function toContract(row: {
  id: number;
  driverId: string | null;
  driverTokenId: string;
  emaid: string;
  pcid: string;
  status: 'active' | 'revoked';
  createdAt: Date;
  revokedAt: Date | null;
}): PncContract {
  return { ...row, driverId: row.driverId ?? '' };
}

export async function listDriverContracts(driverId: string): Promise<PncContract[]> {
  const rows = await db
    .select(contractSelect)
    .from(pncContracts)
    .innerJoin(driverTokens, eq(driverTokens.id, pncContracts.driverTokenId))
    .where(eq(driverTokens.driverId, driverId))
    .orderBy(desc(pncContracts.createdAt), desc(pncContracts.id));
  return rows.map(toContract);
}

async function getContract(id: number): Promise<PncContract | null> {
  const [row] = await db
    .select(contractSelect)
    .from(pncContracts)
    .innerJoin(driverTokens, eq(driverTokens.id, pncContracts.driverTokenId))
    .where(eq(pncContracts.id, id));
  return row == null ? null : toContract(row);
}

/**
 * Creates a contract for the driver: a new eMAID token bound to `pcid`.
 * Needs the local contract CA and the eMAID country and provider ID.
 */
export async function createContract(
  driverId: string,
  pcid: string,
  actor: TokenActor,
): Promise<PncContract> {
  const normalized = normalizePcid(pcid);
  if (normalized === '' || normalized.length > 64) {
    throw new AppError('PCID must contain letters or digits', 400, 'VALIDATION_ERROR');
  }
  const [driver] = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (driver == null) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');

  const config = await readSettings([
    'pnc.local.caEnc',
    'pnc.local.emaidCountry',
    'pnc.local.emaidProviderId',
  ]);
  const ca = config.get('pnc.local.caEnc');
  if (typeof ca !== 'string' || ca === '') {
    throw new AppError('No local contract CA', 409, 'LOCAL_CA_NOT_CONFIGURED');
  }
  const country = config.get('pnc.local.emaidCountry');
  const providerId = config.get('pnc.local.emaidProviderId');
  if (
    typeof country !== 'string' ||
    !/^[A-Z]{2}$/.test(country) ||
    typeof providerId !== 'string' ||
    !/^[A-Z0-9]{3}$/.test(providerId)
  ) {
    throw new AppError(
      'eMAID country and provider ID are not set',
      409,
      'EMAID_PREFIX_NOT_CONFIGURED',
    );
  }

  let token: Awaited<ReturnType<typeof tokenService.createToken>> = null;
  for (let attempt = 0; attempt < EMAID_ATTEMPTS && token == null; attempt++) {
    try {
      token = await tokenService.createToken(
        { driverId, idToken: generateEmaid(country, providerId), tokenType: 'eMAID' },
        actor,
      );
    } catch (err) {
      if (!(err instanceof tokenService.DuplicateTokenError)) throw err;
    }
  }
  if (token == null) throw new Error('Could not allocate a unique eMAID');

  try {
    const [row] = await db
      .insert(pncContracts)
      .values({ driverTokenId: token.id, pcid: normalized })
      .returning({ id: pncContracts.id });
    const contract = row == null ? null : await getContract(row.id);
    if (contract == null) throw new Error('Contract insert returned no row');
    return contract;
  } catch (err) {
    // Without its contract the eMAID token would be an orphan.
    await tokenService.deleteToken(token.id, actor);
    throw err;
  }
}

/** Revokes a driver's contract (terminal) and deactivates its eMAID token. Idempotent. */
export async function revokeContract(
  driverId: string,
  id: number,
  actor: TokenActor,
): Promise<PncContract> {
  const existing = await getContract(id);
  if (existing == null || existing.driverId !== driverId) {
    throw new AppError('Contract not found', 404, 'PNC_CONTRACT_NOT_FOUND');
  }
  const [revoked] = await db
    .update(pncContracts)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(pncContracts.id, id), eq(pncContracts.status, 'active')))
    .returning({ driverTokenId: pncContracts.driverTokenId });
  if (revoked != null) {
    await tokenService.updateToken(revoked.driverTokenId, { isActive: false }, actor);
  }
  const contract = await getContract(id);
  if (contract == null) throw new AppError('Contract not found', 404, 'PNC_CONTRACT_NOT_FOUND');
  return contract;
}
