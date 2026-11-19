// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  eq,
  and,
  or,
  ilike,
  sql,
  desc,
  inArray,
  ne,
  isNull,
  notInArray,
  type SQL,
} from 'drizzle-orm';
import {
  db,
  client,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  isDriverRfidSelfServiceEnabled,
  isFleetEnabled,
} from '@evtivity/database';
import {
  chargingStations,
  driverTokens,
  driverTokenTombstones,
  drivers,
  fleetDrivers,
  fleets,
  pncContracts,
  tokenAuditLog,
  stationLocalAuthEntries,
  stationLocalAuthVersions,
  vehicles,
  writeAudit,
  currentAuditViaAi,
} from '@evtivity/database';
import {
  dispatchDriverNotification,
  createLogger,
  csvEscape,
  escapeLikePattern,
  isNewOcpiToken,
  ValidationError,
} from '@evtivity/lib';
import { isFleetUserCardType, isOcppIdTokenType } from '@evtivity/lib/id-token-types';
import {
  cardIdMatchKey,
  isVehicleIdType,
  VEHICLE_ID_TYPES,
  isVehicleShapedTokenValue,
  tokenVehicleIdCandidates,
} from '@evtivity/lib/vehicle-id';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import type { PaginationParams, PaginatedResponse } from '../lib/pagination.js';
import type { ListSortParams } from '../lib/list-sort.js';
import { tokenListSort } from '../lib/sorts/token-list-sort.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { isAllSiteUser } from '../lib/site-access.js';
import { isFleetUser } from '../lib/fleet-scope.js';
import { publishOcpiTokenPush, type OcpiTokenTombstoneRef } from '../lib/ocpi-token-push.js';
import {
  TOKEN_LABEL_MAX_LENGTH,
  tokenLabelProblem,
  type TokenLabelProblem,
} from '../lib/token-label.js';

const logger = createLogger('token-service');

interface TokenListParams extends PaginationParams, ListSortParams {
  tokenType?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
  fleetId?: string | undefined;
}

/**
 * The fleet card routes (`/fleets/:id/cards`) act on the cards of one fleet:
 * the locked row must belong to it, and only the label, the status and the
 * member it is given to change. `byFleetUser` marks a fleet user's write (it
 * suspends as `fleet` and cannot lift an operator block); `revoke` is the
 * DELETE route, which deactivates for good (a revoked card never comes back
 * through the fleet routes) and is refused to a fleet user.
 */
export interface FleetCardScope {
  fleetId: string;
  byFleetUser: boolean;
  revoke?: boolean;
}

export interface TokenWriteOptions {
  fleet?: FleetCardScope | undefined;
  /**
   * Whether the caller holds `fleetCards:write`. The token routes pass it;
   * false refuses a fleet card field (fleetId, monthlyLimitCents) and any
   * write of a card that has a fleet (FleetCardPermissionError), the second
   * layer behind the route check. Left out, it is not checked (the fleet card
   * routes, which authorize fleetCards:write themselves, and system writes).
   */
  fleetCardsWrite?: boolean | undefined;
}

import {
  FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS,
  FLEET_CARD_RELEASE_REASON,
} from '@evtivity/lib/fleet-card';

export { FLEET_CARD_RELEASE_REASON };

export type TokenActor =
  | { type: 'operator'; userId: string }
  | { type: 'api_key'; apiKeyId: string; userId: string | null }
  | { type: 'driver'; driverId: string }
  | { type: 'system' };

/**
 * The token actor of a request's audit actor: an API key is recorded as the
 * key (with the user it acts for), not as that user.
 */
export function tokenActorOf(actor: AuditActorInfo): TokenActor {
  if (actor.actor === 'api_key' && actor.actorApiKeyId != null) {
    return { type: 'api_key', apiKeyId: actor.actorApiKeyId, userId: actor.actorUserId };
  }
  if (actor.actor === 'driver' && actor.actorDriverId != null) {
    return { type: 'driver', driverId: actor.actorDriverId };
  }
  if (actor.actorUserId != null) return { type: 'operator', userId: actor.actorUserId };
  return { type: 'system' };
}

const tokenSelect = {
  id: driverTokens.id,
  driverId: driverTokens.driverId,
  idToken: driverTokens.idToken,
  tokenType: driverTokens.tokenType,
  label: driverTokens.label,
  isActive: driverTokens.isActive,
  expiresAt: driverTokens.expiresAt,
  revokedAt: driverTokens.revokedAt,
  revokedReason: driverTokens.revokedReason,
  deactivatedBy: driverTokens.deactivatedBy,
  prepaidBalanceCents: driverTokens.prepaidBalanceCents,
  vehicleId: driverTokens.vehicleId,
  fleetId: driverTokens.fleetId,
  fleetName: fleets.name,
  monthlyLimitCents: driverTokens.monthlyLimitCents,
  createdAt: driverTokens.createdAt,
  updatedAt: driverTokens.updatedAt,
  driverFirstName: drivers.firstName,
  driverLastName: drivers.lastName,
  driverEmail: drivers.email,
};

interface TokenFilters {
  search?: string | undefined;
  tokenType?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
  fleetId?: string | undefined;
}

/** The list and the CSV export filter the same way, so an export holds what the list shows. */
function tokenWhere(filters: TokenFilters) {
  const { search, tokenType, status, fleetId } = filters;
  const conditions = [];
  if (search) {
    // `%` and `_` match only as typed (security review PP-I1, case 49 rule).
    const pattern = `%${escapeLikePattern(search)}%`;
    conditions.push(
      or(
        ilike(driverTokens.idToken, pattern),
        ilike(driverTokens.label, pattern),
        ilike(drivers.firstName, pattern),
        ilike(drivers.lastName, pattern),
        ilike(drivers.email, pattern),
      ),
    );
  }
  if (tokenType != null && tokenType !== '') {
    conditions.push(eq(driverTokens.tokenType, tokenType));
  }
  if (status != null) {
    conditions.push(eq(driverTokens.isActive, status === 'active'));
  }
  if (fleetId != null && fleetId !== '') {
    conditions.push(eq(driverTokens.fleetId, fleetId));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listTokens(
  params: TokenListParams,
): Promise<
  PaginatedResponse<typeof tokenSelect extends infer S ? { [K in keyof S]: unknown } : never>
> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const where = tokenWhere(params);

  const [data, countRows] = await Promise.all([
    db
      .select(tokenSelect)
      .from(driverTokens)
      .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .leftJoin(fleets, eq(driverTokens.fleetId, fleets.id))
      .where(where)
      .orderBy(...tokenListSort.orderBy(params))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(driverTokens)
      .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .where(where),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function getToken(id: string) {
  const [token] = await db
    .select(tokenSelect)
    .from(driverTokens)
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .leftJoin(fleets, eq(driverTokens.fleetId, fleets.id))
    .where(eq(driverTokens.id, id));
  return token ?? null;
}

export class DuplicateTokenError extends Error {
  constructor(
    public readonly idToken: string,
    public readonly tokenType: string,
  ) {
    super(`Token already registered`);
    this.name = 'DuplicateTokenError';
  }
}

/** The driver a token is assigned to does not exist (the driver_id foreign key). */
export class TokenDriverNotFoundError extends Error {
  constructor(public readonly driverId: string) {
    super('Driver not found');
    this.name = 'TokenDriverNotFoundError';
  }
}

/** The token would be active for a deactivated driver. */
export class TokenDriverInactiveError extends Error {
  constructor(public readonly driverId: string) {
    super('Driver is inactive');
    this.name = 'TokenDriverInactiveError';
  }
}

/**
 * A driver tried to reactivate a token an operator (or the system) deactivated.
 * Only the party that blocked a card lifts the block: a driver reactivates only
 * a card the driver removed.
 */
export class TokenReactivationBlockedError extends Error {
  constructor(public readonly tokenId: string) {
    super('Token was deactivated by the operator');
    this.name = 'TokenReactivationBlockedError';
  }
}

/**
 * A card deactivated through the fleet routes (revoked) was to be turned on
 * again there: it stays off. A fleet user turning on a card an operator turned
 * off gets TokenReactivationBlockedError instead.
 */
export class FleetCardDeactivatedError extends Error {
  constructor(public readonly tokenId: string) {
    super('This RFID card was deactivated and cannot be turned on again');
    this.name = 'FleetCardDeactivatedError';
  }
}

/** A fleet user tried to deactivate a fleet card for good: only an operator does. */
export class FleetCardRevokeRefusedError extends Error {
  constructor(public readonly tokenId: string) {
    super('Only an operator deactivates an RFID card for good');
    this.name = 'FleetCardRevokeRefusedError';
  }
}

/**
 * A site-restricted operator (or its API key) tried to write a fleet RFID
 * card: fleet cards span every site, so only an all-site operator or the
 * fleet's own fleet users change them.
 */
export class FleetCardSiteScopeError extends Error {
  constructor() {
    super('Only an operator with access to every site changes fleet RFID cards');
    this.name = 'FleetCardSiteScopeError';
  }
}

/**
 * A fleet card write through the token routes by a caller without
 * `fleetCards:write`: the fleet, the monthly limit and every write of a card
 * with a fleet need that permission on top of `drivers:write`.
 */
export class FleetCardPermissionError extends Error {
  constructor() {
    super('Changing fleet RFID cards needs the fleetCards:write permission');
    this.name = 'FleetCardPermissionError';
  }
}

/**
 * Whether the actor may write fleet cards as an operator: system writes pass,
 * an operator or API key needs access to every site. Fleet users write through
 * the fleet card routes only (fleet scope with byFleetUser).
 */
async function mayWriteFleetCardsAsOperator(actor: TokenActor): Promise<boolean> {
  if (actor.type === 'system' || actor.type === 'driver') return true;
  if (actor.userId == null) return true;
  if (await isAllSiteUser(actor.userId)) return true;
  return isFleetUser(actor.userId);
}

/**
 * Throws FleetCardSiteScopeError when the actor may not write fleet cards and
 * one of the tokens belongs to a fleet. Returns whether the actor is refused,
 * so a write can repeat the condition in its own statement.
 */
export async function assertMayWriteTokenFleets(
  ids: readonly string[],
  actor: TokenActor,
  options: Pick<TokenWriteOptions, 'fleetCardsWrite'> = {},
): Promise<boolean> {
  if (ids.length === 0) return false;
  const siteRefused = !(await mayWriteFleetCardsAsOperator(actor));
  const permissionRefused = options.fleetCardsWrite === false;
  if (!siteRefused && !permissionRefused) return false;
  const [fleetCard] = await db
    .select({ id: driverTokens.id })
    .from(driverTokens)
    .where(and(inArray(driverTokens.id, [...ids]), sql`${driverTokens.fleetId} IS NOT NULL`))
    .limit(1);
  if (fleetCard != null) {
    throw siteRefused ? new FleetCardSiteScopeError() : new FleetCardPermissionError();
  }
  return true;
}

/** Whether any of the tokens is a fleet card (driver_tokens.fleet_id set). */
export async function anyFleetCard(ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const [fleetCard] = await db
    .select({ id: driverTokens.id })
    .from(driverTokens)
    .where(and(inArray(driverTokens.id, [...ids]), sql`${driverTokens.fleetId} IS NOT NULL`))
    .limit(1);
  return fleetCard != null;
}

/**
 * A driver tried to change an RFID card while the operator manages them
 * (`portal.rfidSelfServiceEnabled` off): every driver write is refused.
 */
export class RfidSelfServiceDisabledError extends Error {
  constructor() {
    super('Drivers cannot change RFID cards; the operator manages them');
    this.name = 'RfidSelfServiceDisabledError';
  }
}

/**
 * Refuses every driver-actor card write while drivers do not manage their
 * own cards. Strictly read-only (owner decision 2026-11-10): a driver cannot
 * add, rename, deactivate, reactivate or remove a card then, and contacts the
 * operator to block a lost one. Operators, API keys and the system are never
 * refused. The reader fails closed, so a settings read error refuses too.
 */
async function assertDriverCardWriteAllowed(actor: TokenActor): Promise<void> {
  if (actor.type !== 'driver') return;
  if (!(await isDriverRfidSelfServiceEnabled())) throw new RfidSelfServiceDisabledError();
}

/**
 * The prepaid balance a token change was based on is no longer the stored
 * one: a session debited it in between.
 */
export class PrepaidBalanceConflictError extends Error {
  constructor() {
    super('The prepaid balance changed since it was read');
    this.name = 'PrepaidBalanceConflictError';
  }
}

/**
 * A driver tried to register a card whose value is a vehicle id (VIN, EVCCID
 * or MAC address) of another driver's vehicle. A card wins over a vehicle on
 * Authorize, so the card would take over that car's Autocharge starts.
 */
export class VehicleIdTokenInUseError extends Error {
  constructor() {
    super('Another vehicle uses this id');
    this.name = 'VehicleIdTokenInUseError';
  }
}

/**
 * A prepaid balance change without the balance the caller read
 * (`expectedPrepaidBalanceCents`). An absolute balance alone overwrites a
 * session debit that lands between the read and the write, so every change
 * carries the expected value.
 */
/**
 * A fleet RFID card is billed to its fleet (or the member holding it), never
 * from a prepaid balance: a card with a fleet holds no balance.
 */
function assertNoFleetCardBalance(fleetId: string | null, balanceCents: number | null): void {
  if (fleetId != null && balanceCents != null) {
    throw new ValidationError('An RFID card of a fleet has no prepaid balance', {
      field: 'prepaidBalanceCents',
    });
  }
}

/** Only a fleet RFID card has a monthly spending limit, a whole number of cents in range. */
function assertCardMonthlyLimit(fleetId: string | null, limitCents: number | null): void {
  if (limitCents == null) return;
  if (fleetId == null) {
    throw new ValidationError('Only an RFID card of a fleet has a monthly limit', {
      field: 'monthlyLimitCents',
    });
  }
  if (
    !Number.isInteger(limitCents) ||
    limitCents < 1 ||
    limitCents > FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS
  ) {
    throw new ValidationError('The monthly limit is out of range', { field: 'monthlyLimitCents' });
  }
}

export class PrepaidBalanceExpectedError extends Error {
  constructor() {
    super('A prepaid balance change needs expectedPrepaidBalanceCents');
    this.name = 'PrepaidBalanceExpectedError';
  }
}

/**
 * A driver tried to register a card whose value has a vehicle id shape (a MAC
 * address, a VIN or the `VID:` prefix). No card UID has it, and such a card
 * would take the car's 1.6 Autocharge starts before its owner adds the
 * vehicle. Operators keep every value.
 */
export class VehicleShapedCardError extends Error {
  constructor() {
    super('A vehicle id is not a card');
    this.name = 'VehicleShapedCardError';
  }
}

/**
 * The token is the eMAID of a Plug and Charge contract, and the change would
 * break the contract: a new value, type or driver (the issued certificate
 * names the eMAID and the contract its driver), reactivating it after its
 * contract was revoked (revocation is final), or deleting it while its
 * contract is active (revoke the contract first). The contract service is the
 * only path for those changes (features/pnc.md).
 */
export class PncContractTokenError extends Error {
  constructor(
    public readonly tokenId: string,
    public readonly reason: 'locked_fields' | 'contract_revoked' | 'contract_active',
  ) {
    super('Token belongs to a Plug and Charge contract');
    this.name = 'PncContractTokenError';
  }
}

/** A card names a fleet that does not exist. */
export class TokenFleetNotFoundError extends Error {
  constructor(public readonly fleetId: string) {
    super('Fleet not found');
    this.name = 'TokenFleetNotFoundError';
  }
}

/**
 * A fleet card created, moved into a fleet or given to a member while its
 * fleet does not bill on account (or Fleets is off): a fleet card charges only
 * to its own fleet's account, never to the member, so it could not charge.
 */
export class FleetCardNotBillableError extends Error {
  constructor(public readonly fleetId: string) {
    super('The fleet does not bill on account, so its RFID cards cannot charge');
    this.name = 'FleetCardNotBillableError';
  }
}

/**
 * A fleet card given to a driver that is not an active, not erased member of
 * the card's fleet.
 */
export class FleetCardDriverNotMemberError extends Error {
  constructor(public readonly driverId: string) {
    super('The driver is not an active member of the fleet');
    this.name = 'FleetCardDriverNotMemberError';
  }
}

/**
 * A fleet user gave a fleet card a type it is not offered: only an ordinary
 * RFID card or key fob (ISO14443) or another RFID card (ISO15693).
 */
export class FleetCardTypeNotAllowedError extends Error {
  constructor() {
    super('A fleet user adds only ISO14443 or ISO15693 RFID cards');
    this.name = 'FleetCardTypeNotAllowedError';
  }
}

/**
 * A driver tried to add, change, reactivate or remove a fleet card: the fleet
 * manages it, the member only uses it.
 */
export class TokenManagedByFleetError extends Error {
  constructor() {
    super('The fleet manages this RFID card');
    this.name = 'TokenManagedByFleetError';
  }
}

/** The Plug and Charge contract statuses of the given tokens, by token id. */
async function contractStatuses(
  tokenIds: string[],
  executor: TokenDb = db,
): Promise<Map<string, 'active' | 'revoked'>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await executor
    .select({ tokenId: pncContracts.driverTokenId, status: pncContracts.status })
    .from(pncContracts)
    .where(inArray(pncContracts.driverTokenId, tokenIds));
  return new Map(rows.map((r) => [r.tokenId, r.status]));
}

/**
 * Maps a unique violation on (id_token, token_type) to DuplicateTokenError and
 * a foreign key violation on driver_id to TokenDriverNotFoundError, so a race
 * or an unknown driver answers 409 or 404, not 500. drizzle wraps the
 * postgres.js error (SQLSTATE on cause); pgErrorCode reads both.
 */
function mapWriteError(
  err: unknown,
  target: { idToken: string; tokenType: string; driverId?: string | null | undefined },
): Error {
  const code = pgErrorCode(err);
  if (code === PG_UNIQUE_VIOLATION)
    return new DuplicateTokenError(target.idToken, target.tokenType);
  if (code === PG_FOREIGN_KEY_VIOLATION && target.driverId != null) {
    return new TokenDriverNotFoundError(target.driverId);
  }
  return err instanceof Error ? err : new Error(String(err));
}

type TokenDb = Pick<typeof db, 'select'>;

/**
 * The stored cards a new value of this type collides with. OCPP idTokens are
 * case-insensitive and a 1.6 idTag carries no type, so a card that is not a
 * vehicle id collides with the same value of its type in any letter case and
 * with another spelling of the value in another type. A vehicle id card keeps
 * the exact rule: its values are stored normalized.
 */
function sameCardValue(idToken: string, tokenType: string): SQL {
  const sameType = eq(driverTokens.tokenType, tokenType);
  if (isVehicleIdType(tokenType)) {
    return and(eq(driverTokens.idToken, idToken), sameType) ?? sameType;
  }
  const anyCase = sql`lower(${driverTokens.idToken}) = lower(${idToken})`;
  return (
    or(
      and(anyCase, sameType),
      and(
        anyCase,
        ne(driverTokens.idToken, idToken),
        notInArray(driverTokens.tokenType, [...VEHICLE_ID_TYPES]),
      ),
    ) ?? anyCase
  );
}

async function tokenExists(
  idToken: string,
  tokenType: string,
  excludeId?: string,
  conn: TokenDb = db,
): Promise<boolean> {
  const conditions = [sameCardValue(idToken, tokenType)];
  if (excludeId != null) conditions.push(ne(driverTokens.id, excludeId));
  const [row] = await conn
    .select({ id: driverTokens.id })
    .from(driverTokens)
    .where(and(...conditions))
    .limit(1);
  return row != null;
}

function actorColumns(actor: TokenActor): {
  actor: 'operator' | 'api_key' | 'driver' | 'system';
  actorUserId: string | null;
  actorDriverId: string | null;
  actorApiKeyId: string | null;
} {
  if (actor.type === 'operator') {
    return {
      actor: 'operator',
      actorUserId: actor.userId,
      actorDriverId: null,
      actorApiKeyId: null,
    };
  }
  if (actor.type === 'api_key') {
    return {
      actor: 'api_key',
      actorUserId: actor.userId,
      actorDriverId: null,
      actorApiKeyId: actor.apiKeyId,
    };
  }
  if (actor.type === 'driver') {
    return {
      actor: 'driver',
      actorUserId: null,
      actorDriverId: actor.driverId,
      actorApiKeyId: null,
    };
  }
  return { actor: 'system', actorUserId: null, actorDriverId: null, actorApiKeyId: null };
}

/** The notification wording: an API key acts for the operator. */
function actorLabel(actor: TokenActor): string {
  if (actor.type === 'operator' || actor.type === 'api_key') return 'operator';
  if (actor.type === 'driver') return 'you';
  return 'system';
}

interface TokenSnapshot {
  idToken: string;
  tokenType: string;
  driverId: string | null;
  label?: string | null;
  prepaidBalanceCents?: number | null;
  vehicleId?: string | null;
  fleetId?: string | null;
  monthlyLimitCents?: number | null;
}

/**
 * A card that belongs to one vehicle (route-aware charging: a card per bus)
 * names a vehicle of the card's own driver, so a card can never be bound to
 * another driver's vehicle. Refused with 400 VALIDATION_ERROR otherwise.
 */
async function assertTokenVehicle(
  vehicleId: string,
  driverId: string | null,
  conn: TokenDb = db,
): Promise<void> {
  if (driverId == null) {
    throw new ValidationError('A card without a driver cannot belong to a vehicle', {
      field: 'vehicleId',
    });
  }
  const [vehicle] = await conn
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.driverId, driverId)));
  if (vehicle == null) {
    throw new ValidationError("The vehicle is not one of the card driver's vehicles", {
      field: 'vehicleId',
    });
  }
}

/** Trims a label; an empty one is no label. `undefined` (not sent) stays `undefined`. */
export function normalizeTokenLabel(label: string | null | undefined): string | null | undefined {
  if (label === undefined) return undefined;
  const trimmed = label?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

const TOKEN_LABEL_PROBLEM_MESSAGES: Record<TokenLabelProblem, string> = {
  control_characters: 'The label must not contain control or invisible format characters',
  too_long: `The label is longer than ${String(TOKEN_LABEL_MAX_LENGTH)} characters`,
};

/** 400 VALIDATION_ERROR (field `label`) for a label that cannot be stored. */
function assertTokenLabel(label: string | null | undefined): void {
  if (label == null) return;
  const problem = tokenLabelProblem(label);
  if (problem != null) {
    throw new ValidationError(TOKEN_LABEL_PROBLEM_MESSAGES[problem], { field: 'label', problem });
  }
}

/**
 * Clears the labels of every token of a driver, inside the driver erasure
 * transaction: a label is free text the driver or an operator typed, so it
 * may hold personal data. No token audit row is written (its snapshot would
 * keep the label); the erasure audit row counts the cleared labels.
 */
export async function clearDriverTokenLabels(
  tx: Pick<typeof db, 'update'>,
  driverId: string,
): Promise<number> {
  const cleared = await tx
    .update(driverTokens)
    .set({ label: null, updatedAt: new Date() })
    .where(and(eq(driverTokens.driverId, driverId), sql`${driverTokens.label} IS NOT NULL`))
    .returning({ id: driverTokens.id });
  return cleared.length;
}

async function writeTokenAudit(args: {
  tokenId: string | null;
  entityIdSnapshot: string;
  action: 'created' | 'updated' | 'activated' | 'deactivated' | 'revoked' | 'deleted' | 'imported';
  actor: TokenActor;
  before?: TokenSnapshot | null;
  after?: TokenSnapshot | null;
  notes?: string | null;
}): Promise<void> {
  const { actor, actorUserId, actorDriverId, actorApiKeyId } = actorColumns(args.actor);
  await writeAudit(
    { table: tokenAuditLog, idColumn: 'token_id' },
    {
      entityId: args.tokenId,
      entityIdSnapshot: args.entityIdSnapshot,
      action: args.action,
      actor,
      actorUserId,
      actorDriverId,
      actorApiKeyId,
      before: args.before ?? null,
      after: args.after ?? null,
      notes: args.notes ?? null,
    },
    db,
    logger,
  );
}

type TokenNoticeEvent =
  | 'token.Added'
  | 'token.Removed'
  | 'token.Deactivated'
  | 'token.Reactivated'
  | 'token.FleetCardAssigned'
  | 'token.FleetCardTakenBack';

async function notifyDriver(
  driverId: string | null,
  eventType: TokenNoticeEvent,
  variables: Record<string, unknown>,
): Promise<void> {
  if (driverId == null) return;
  try {
    await dispatchDriverNotification(
      client,
      eventType,
      driverId,
      variables,
      ALL_TEMPLATES_DIRS,
      getPubSub(),
    );
  } catch (err) {
    // Non-critical for the mutation, but operators need a signal that SMTP/
    // Twilio is misconfigured. Logged at warn so it shows up in normal log
    // aggregation without paging.
    logger.warn(
      { err, driverId, eventType },
      'Token notification dispatch failed (mutation already committed)',
    );
  }
}

/** Tells a member that a fleet card was given to them or taken back. */
async function notifyFleetCardMember(
  driverId: string | null,
  eventType: 'token.FleetCardAssigned' | 'token.FleetCardTakenBack',
  card: { idToken: string; tokenType: string; label: string | null; fleetId: string | null },
): Promise<void> {
  if (driverId == null) return;
  // Fleets off: no fleet card notice (the dispatcher refuses it too).
  if (!(await isFleetEnabled({ failClosed: true }))) return;
  let fleetName = '';
  if (card.fleetId != null) {
    try {
      const [fleet] = await db
        .select({ name: fleets.name })
        .from(fleets)
        .where(eq(fleets.id, card.fleetId));
      fleetName = fleet?.name ?? '';
    } catch (err: unknown) {
      logger.warn({ err, fleetId: card.fleetId }, 'Fleet name read failed, notice sent without it');
    }
  }
  await notifyDriver(driverId, eventType, {
    idToken: card.idToken,
    tokenType: card.tokenType,
    label: card.label ?? '',
    fleetName,
  });
}

// Best-effort SSE so other operators viewing Tokens/TokenDetail/AuthorizeLog
// see this mutation without a manual refresh. Decoupled from
// `localAuthList.changed` because not every token mutation affects a station
// (e.g. a token not yet pushed to any local auth list).
async function publishTokenChanged(tokenId: string | null): Promise<void> {
  try {
    const pubsub = getPubSub();
    await pubsub.publish('csms_events', JSON.stringify({ eventType: 'token.changed', tokenId }));
  } catch (err) {
    logger.warn({ err, tokenId }, 'token.changed publish failed, open token pages refresh later');
  }
}

/** Stations whose local auth list holds any of these tokens. */
async function stationsHoldingTokens(tokenIds: string[]): Promise<string[]> {
  if (tokenIds.length === 0) return [];
  const rows = await db
    .select({ stationId: stationLocalAuthEntries.stationId })
    .from(stationLocalAuthEntries)
    .where(inArray(stationLocalAuthEntries.driverTokenId, tokenIds));
  return Array.from(new Set(rows.map((r) => r.stationId)));
}

/**
 * Marks the local auth list of these stations changed, so the operator UI
 * prompts a re-push, and tells open station pages through SSE.
 */
async function markLocalAuthListsChanged(stationIds: string[]): Promise<void> {
  if (stationIds.length === 0) return;
  await db
    .update(stationLocalAuthVersions)
    .set({ lastModifiedAt: new Date() })
    .where(inArray(stationLocalAuthVersions.stationId, stationIds));
  await publishLocalAuthListChanged(stationIds);
}

async function bumpStationsHoldingTokens(tokenIds: string[]): Promise<void> {
  await markLocalAuthListsChanged(await stationsHoldingTokens(tokenIds));
}

/**
 * One `localAuthList.changed` event per station, with the station's siteId so
 * the SSE stream delivers it to operators of that site only. Fail-open (P9).
 */
async function publishLocalAuthListChanged(stationIds: string[]): Promise<void> {
  try {
    const stations = await db
      .select({ id: chargingStations.id, siteId: chargingStations.siteId })
      .from(chargingStations)
      .where(inArray(chargingStations.id, stationIds));
    const pubsub = getPubSub();
    for (const station of stations) {
      await pubsub.publish(
        'csms_events',
        JSON.stringify({
          eventType: 'localAuthList.changed',
          stationId: station.id,
          siteId: station.siteId,
        }),
      );
    }
  } catch (err) {
    logger.warn(
      { err, stationIds },
      'localAuthList.changed publish failed, open station pages refresh later',
    );
  }
}

/** An API key deactivates as the operator: only the operator can lift it. */
/**
 * Records a token value that no longer exists (deleted, or its value or type
 * changed), so OCPI partners that cached it see it invalid (OCPI cannot delete
 * a Token). Fail-open (P9): the mutation committed; the partner then keeps the
 * value until it pulls the full list again.
 */
async function tombstoneTokenValue(ref: OcpiTokenTombstoneRef): Promise<boolean> {
  try {
    await db
      .insert(driverTokenTombstones)
      .values({ idToken: ref.idToken, tokenType: ref.tokenType })
      .onConflictDoUpdate({
        target: [driverTokenTombstones.idToken, driverTokenTombstones.tokenType],
        set: { invalidatedAt: new Date() },
      });
    return true;
  } catch (err) {
    logger.warn({ err, tokenType: ref.tokenType }, 'Token tombstone insert failed');
    return false;
  }
}

function deactivatedByOf(
  actor: TokenActor,
  byFleetUser = false,
): 'operator' | 'driver' | 'system' | 'fleet' {
  if (byFleetUser) return 'fleet';
  return actor.type === 'api_key' ? 'operator' : actor.type;
}

/**
 * The fleet must exist and bill on account, read FOR SHARE so its delete or a
 * switch of its account billing cannot slip in before the card write: a fleet
 * card charges only to its own fleet's account (never to the member), so a
 * card of a fleet that cannot bill it would never charge.
 */
async function assertFleetCanHoldCards(fleetId: string, conn: TokenDb): Promise<void> {
  const [fleet] = await conn
    .select({ id: fleets.id, accountBillingEnabled: fleets.accountBillingEnabled })
    .from(fleets)
    .where(eq(fleets.id, fleetId))
    .for('share');
  if (fleet == null) throw new TokenFleetNotFoundError(fleetId);
  if (!fleet.accountBillingEnabled || !(await isFleetEnabled())) {
    throw new FleetCardNotBillableError(fleetId);
  }
}

/**
 * A fleet card is given only to an active, not erased member of its fleet.
 * The driver and the membership are read FOR SHARE, so a removal from the
 * fleet or a deactivation cannot slip in between the check and the write. An
 * unknown driver answers DRIVER_NOT_FOUND like a driver card.
 */
async function assertFleetCardMember(
  fleetId: string,
  driverId: string,
  conn: TokenDb,
): Promise<void> {
  const [driver] = await conn
    .select({ isActive: drivers.isActive, erasedAt: drivers.erasedAt })
    .from(drivers)
    .where(eq(drivers.id, driverId))
    .for('share');
  if (driver == null) throw new TokenDriverNotFoundError(driverId);
  if (!driver.isActive || driver.erasedAt != null) {
    throw new FleetCardDriverNotMemberError(driverId);
  }
  const [member] = await conn
    .select({ id: fleetDrivers.id })
    .from(fleetDrivers)
    .where(and(eq(fleetDrivers.fleetId, fleetId), eq(fleetDrivers.driverId, driverId)))
    .for('share');
  if (member == null) throw new FleetCardDriverNotMemberError(driverId);
}

/**
 * Refuses a token that would be active for a deactivated driver: deactivating
 * a driver deactivates the driver's tokens, and none comes back (or is added)
 * until the driver is active again. Unknown driver: TokenDriverNotFoundError.
 */
async function assertDriverActive(driverId: string, conn: TokenDb = db): Promise<void> {
  const [driver] = await conn
    .select({ isActive: drivers.isActive })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (driver == null) throw new TokenDriverNotFoundError(driverId);
  if (!driver.isActive) throw new TokenDriverInactiveError(driverId);
}

/**
 * Refuses a card whose value, in any spelling (`tokenVehicleIdCandidates`:
 * case, separators, the `VID:` prefix), is the VIN or EVCCID of a vehicle of
 * another driver, Autocharge on or off. A card wins over a vehicle on an
 * untyped 1.6 Authorize, so the card would take over that car's starts.
 * Applies to every actor; a card without a driver collides
 * with every vehicle. The vehicle service checks the other order.
 */
async function assertNotOtherDriversVehicleId(
  idToken: string,
  driverId: string | null,
  conn: TokenDb = db,
): Promise<void> {
  const candidates = tokenVehicleIdCandidates(idToken);
  const [hit] = await conn
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(
      and(
        driverId != null ? ne(vehicles.driverId, driverId) : undefined,
        or(inArray(vehicles.vin, candidates), inArray(vehicles.evccid, candidates)),
      ),
    )
    .limit(1);
  if (hit != null) throw new VehicleIdTokenInUseError();
}

export async function createToken(
  data: {
    driverId?: string | null | undefined;
    idToken: string;
    tokenType: string;
    label?: string | null | undefined;
    expiresAt?: Date | null | undefined;
    prepaidBalanceCents?: number | null | undefined;
    vehicleId?: string | null | undefined;
    /** The fleet that owns the card (a fleet RFID card), null for a driver's own card. */
    fleetId?: string | null | undefined;
    /** The card's monthly spending limit in cents (fleet cards only), null for none. */
    monthlyLimitCents?: number | null | undefined;
  },
  actor: TokenActor = { type: 'system' },
  options: TokenWriteOptions = {},
) {
  // Before any lookup, so a refused driver learns nothing about existing cards.
  await assertDriverCardWriteAllowed(actor);
  const fleetId = options.fleet?.fleetId ?? data.fleetId ?? null;
  if (actor.type === 'driver' && fleetId != null) throw new TokenManagedByFleetError();
  if (
    fleetId != null &&
    options.fleet?.byFleetUser !== true &&
    !(await mayWriteFleetCardsAsOperator(actor))
  ) {
    throw new FleetCardSiteScopeError();
  }
  if (options.fleetCardsWrite === false && (fleetId != null || data.monthlyLimitCents != null)) {
    throw new FleetCardPermissionError();
  }
  assertTokenLabel(data.label);
  assertCardMonthlyLimit(fleetId, data.monthlyLimitCents ?? null);
  const label = normalizeTokenLabel(data.label);
  // Before any lookup, so the answer says nothing about existing cards. A
  // fleet user is held to the driver rule: no card UID has a vehicle id shape.
  if (
    (actor.type === 'driver' || options.fleet?.byFleetUser === true) &&
    isVehicleShapedTokenValue(data.idToken)
  ) {
    throw new VehicleShapedCardError();
  }
  if (options.fleet?.byFleetUser === true && !isFleetUserCardType(data.tokenType)) {
    throw new FleetCardTypeNotAllowedError();
  }
  // A fleet user's checks that do not depend on the card value run before the
  // value lookup, so a refusal for the fleet or the member never differs with
  // whether the value exists: the existence answer is always the last one
  // (security case 466). They run again under the locks of the insert below.
  if (options.fleet?.byFleetUser === true && fleetId != null) {
    assertNoFleetCardBalance(fleetId, data.prepaidBalanceCents ?? null);
    await db.transaction(async (tx) => {
      await assertFleetCanHoldCards(fleetId, tx);
      if (data.driverId != null) await assertFleetCardMember(fleetId, data.driverId, tx);
    });
  }
  // Check for an existing row first. If it already belongs to the same driver,
  // treat this as a re-add (driver removed the card, then registered it
  // again) and reactivate the existing row rather than throwing 409. This
  // closes the "can't re-add my own card" UX trap and also means the portal
  // 409 response is reserved for genuine cross-driver collisions only. A
  // driver cannot re-add a card an operator blocked (updateToken refuses).
  // A stored card that differs only in letter case is the same card at a
  // station, so it refuses the value too; only the exact spelling is re-added.
  const [existing] = await db
    .select({
      id: driverTokens.id,
      idToken: driverTokens.idToken,
      driverId: driverTokens.driverId,
      isActive: driverTokens.isActive,
      fleetId: driverTokens.fleetId,
    })
    .from(driverTokens)
    .where(sameCardValue(data.idToken, data.tokenType))
    .orderBy(desc(sql`${driverTokens.idToken} = ${data.idToken}`), driverTokens.id)
    .limit(1);

  if (existing != null) {
    if (
      existing.idToken === data.idToken &&
      data.driverId != null &&
      existing.driverId === data.driverId &&
      !existing.isActive &&
      (options.fleet == null || existing.fleetId === options.fleet.fleetId)
    ) {
      const reactivated = await updateToken(
        existing.id,
        {
          isActive: true,
          expiresAt: data.expiresAt ?? null,
          // A re-added card keeps its label unless the request names one.
          ...(label != null ? { label } : {}),
          // A reactivated card gets a balance only while it holds none: the
          // create request read no balance to compare (PP2 Info 3).
          ...(data.prepaidBalanceCents !== undefined
            ? { prepaidBalanceCents: data.prepaidBalanceCents, expectedPrepaidBalanceCents: null }
            : {}),
          // updateToken checks the vehicle against the card's driver.
          ...(data.vehicleId !== undefined ? { vehicleId: data.vehicleId } : {}),
          ...(options.fleet == null && data.fleetId !== undefined ? { fleetId: data.fleetId } : {}),
          ...(data.monthlyLimitCents !== undefined
            ? { monthlyLimitCents: data.monthlyLimitCents }
            : {}),
        },
        actor,
        options,
      );
      return reactivated;
    }
    throw new DuplicateTokenError(data.idToken, data.tokenType);
  }

  assertNoFleetCardBalance(fleetId, data.prepaidBalanceCents ?? null);
  // A fleet card's member is checked with the fleet below, under the lock.
  if (data.driverId != null && fleetId == null) await assertDriverActive(data.driverId);
  await assertNotOtherDriversVehicleId(data.idToken, data.driverId ?? null);
  if (data.vehicleId != null) await assertTokenVehicle(data.vehicleId, data.driverId ?? null);

  const insertToken = async (conn: Pick<typeof db, 'insert'>) => {
    const inserted = await conn
      .insert(driverTokens)
      .values({
        idToken: data.idToken,
        tokenType: data.tokenType,
        label: label ?? null,
        driverId: data.driverId ?? null,
        expiresAt: data.expiresAt ?? null,
        prepaidBalanceCents: data.prepaidBalanceCents ?? null,
        vehicleId: data.vehicleId ?? null,
        fleetId,
        monthlyLimitCents: data.monthlyLimitCents ?? null,
      })
      .returning();
    return inserted[0];
  };
  let token: typeof driverTokens.$inferSelect | undefined;
  try {
    // A fleet card checks its fleet and member under locks held to the insert.
    token =
      fleetId == null
        ? await insertToken(db)
        : await db.transaction(async (tx) => {
            await assertFleetCanHoldCards(fleetId, tx);
            if (data.driverId != null) await assertFleetCardMember(fleetId, data.driverId, tx);
            return insertToken(tx);
          });
  } catch (err) {
    if (
      err instanceof TokenFleetNotFoundError ||
      err instanceof FleetCardNotBillableError ||
      err instanceof FleetCardDriverNotMemberError ||
      err instanceof TokenDriverNotFoundError
    ) {
      throw err;
    }
    // A concurrent insert lost the TOCTOU race (unique index) or the driver
    // does not exist (foreign key): 409 or 404, not 500.
    throw mapWriteError(err, data);
  }
  if (token == null) return null;

  await writeTokenAudit({
    tokenId: token.id,
    entityIdSnapshot: token.id,
    action: 'created',
    actor,
    after: {
      idToken: token.idToken,
      tokenType: token.tokenType,
      driverId: token.driverId,
      label: token.label,
      prepaidBalanceCents: token.prepaidBalanceCents,
      vehicleId: token.vehicleId,
      fleetId: token.fleetId,
      monthlyLimitCents: token.monthlyLimitCents,
    },
  });
  if (token.fleetId != null) {
    await notifyFleetCardMember(token.driverId, 'token.FleetCardAssigned', token);
  } else {
    await notifyDriver(token.driverId, 'token.Added', {
      idToken: token.idToken,
      tokenType: token.tokenType,
      addedBy: actorLabel(actor),
    });
  }
  await publishTokenChanged(token.id);
  // A fleet card no member holds is not a roaming token: partners get it once a member does.
  if (token.fleetId == null || token.driverId != null) {
    await publishOcpiTokenPush({ tokenIds: [token.id] });
  }
  return token;
}

export async function updateToken(
  id: string,
  data: {
    idToken?: string | undefined;
    tokenType?: string | undefined;
    driverId?: string | null | undefined;
    label?: string | null | undefined;
    isActive?: boolean | undefined;
    expiresAt?: Date | null | undefined;
    revokedReason?: string | null | undefined;
    prepaidBalanceCents?: number | null | undefined;
    /** The vehicle the card belongs to (a vehicle of the card's driver), null for none. */
    vehicleId?: string | null | undefined;
    /**
     * The balance the caller read before changing `prepaidBalanceCents`: the
     * change applies only while the locked row still holds it, else
     * PrepaidBalanceConflictError, so a session debit in between is never
     * overwritten. Required with every balance change, else
     * PrepaidBalanceExpectedError (PP2 Info 3).
     */
    expectedPrepaidBalanceCents?: number | null | undefined;
    /** Moves the card to a fleet (a fleet card) or out of it (null). Operators only. */
    fleetId?: string | null | undefined;
    /** The card's monthly spending limit in cents (fleet cards only), null for none. */
    monthlyLimitCents?: number | null | undefined;
  },
  actor: TokenActor = { type: 'system' },
  options: TokenWriteOptions = {},
) {
  await assertDriverCardWriteAllowed(actor);
  if (data.prepaidBalanceCents !== undefined && data.expectedPrepaidBalanceCents === undefined) {
    throw new PrepaidBalanceExpectedError();
  }
  const scope = options.fleet;
  if (scope != null) {
    if (scope.revoke === true && scope.byFleetUser) throw new FleetCardRevokeRefusedError(id);
    // The fleet routes change the label, the status and the member only.
    const outside = (
      ['idToken', 'tokenType', 'expiresAt', 'prepaidBalanceCents', 'vehicleId', 'fleetId'] as const
    ).filter((key) => data[key] !== undefined);
    if (outside.length > 0) {
      throw new ValidationError(
        'A fleet card change takes the label, status, member and monthly limit only',
        {
          fields: outside,
        },
      );
    }
  }
  if (actor.type === 'driver' && data.fleetId !== undefined) throw new TokenManagedByFleetError();
  if (scope != null && !scope.byFleetUser && !(await mayWriteFleetCardsAsOperator(actor))) {
    throw new FleetCardSiteScopeError();
  }
  // Decided on the locked row below: any write of a card that has a fleet, or
  // a move into one, is refused to a site-restricted operator.
  const fleetWriteRefused = scope == null && !(await mayWriteFleetCardsAsOperator(actor));
  assertTokenLabel(data.label);
  // The row is locked for the read and the write, so two concurrent toggles
  // cannot both see the old state and both audit and notify a transition.
  let changed: {
    current: {
      idToken: string;
      tokenType: string;
      driverId: string | null;
      label: string | null;
      isActive: boolean;
      expiresAt: Date | null;
      revokedReason: string | null;
      prepaidBalanceCents: number | null;
      vehicleId: string | null;
      fleetId: string | null;
      monthlyLimitCents: number | null;
      revokedAt: Date | null;
    };
    token: typeof driverTokens.$inferSelect;
  } | null;
  try {
    changed = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          idToken: driverTokens.idToken,
          tokenType: driverTokens.tokenType,
          driverId: driverTokens.driverId,
          label: driverTokens.label,
          isActive: driverTokens.isActive,
          expiresAt: driverTokens.expiresAt,
          revokedReason: driverTokens.revokedReason,
          deactivatedBy: driverTokens.deactivatedBy,
          prepaidBalanceCents: driverTokens.prepaidBalanceCents,
          vehicleId: driverTokens.vehicleId,
          fleetId: driverTokens.fleetId,
          monthlyLimitCents: driverTokens.monthlyLimitCents,
          revokedAt: driverTokens.revokedAt,
        })
        .from(driverTokens)
        .where(eq(driverTokens.id, id))
        .for('update');
      if (current == null) return null;
      // The fleet routes reach only the cards of their fleet.
      if (scope != null && current.fleetId !== scope.fleetId) return null;
      if (fleetWriteRefused && (data.fleetId != null || current.fleetId != null)) {
        throw new FleetCardSiteScopeError();
      }
      // Without fleetCards:write no fleet card changes and no card gets a
      // fleet or a monthly limit, decided on the locked row.
      if (
        options.fleetCardsWrite === false &&
        (current.fleetId != null || data.fleetId != null || data.monthlyLimitCents != null)
      ) {
        throw new FleetCardPermissionError();
      }
      // A driver's update is decided on the locked row: the token must still
      // be the driver's, and the driver active and not erased, read FOR SHARE
      // so an erasure or a move to another driver cannot commit in between.
      // Otherwise it is not found, like a foreign card (security review PP-L1).
      if (actor.type === 'driver') {
        if (current.driverId !== actor.driverId) return null;
        const [owner] = await tx
          .select({ isActive: drivers.isActive, erasedAt: drivers.erasedAt })
          .from(drivers)
          .where(eq(drivers.id, actor.driverId))
          .for('share');
        if (owner == null || !owner.isActive || owner.erasedAt != null) return null;
        // A fleet card is the fleet's: the member using it changes nothing.
        if (current.fleetId != null) throw new TokenManagedByFleetError();
      }
      if (
        data.prepaidBalanceCents !== undefined &&
        current.prepaidBalanceCents !== data.expectedPrepaidBalanceCents
      ) {
        throw new PrepaidBalanceConflictError();
      }

      if (
        actor.type === 'driver' &&
        data.isActive === true &&
        !current.isActive &&
        current.deactivatedBy !== 'driver'
      ) {
        throw new TokenReactivationBlockedError(id);
      }
      // Through the fleet routes a revoked card never comes back, and a fleet
      // user never lifts an operator's block. A card the fleet suspended or
      // took back from a leaving member (no revokedAt) may come back.
      if (scope != null && data.isActive === true && !current.isActive) {
        if (scope.byFleetUser && current.deactivatedBy === 'operator') {
          throw new TokenReactivationBlockedError(id);
        }
        if (current.revokedAt != null) throw new FleetCardDeactivatedError(id);
      }

      // A contract eMAID keeps its value, type and driver, and stays inactive
      // once its contract is revoked.
      const contractStatus =
        current.tokenType === 'eMAID' ? (await contractStatuses([id], tx)).get(id) : undefined;
      if (contractStatus != null) {
        const changes = (field: 'idToken' | 'tokenType' | 'driverId'): boolean =>
          data[field] !== undefined && data[field] !== current[field];
        if (changes('idToken') || changes('tokenType') || changes('driverId')) {
          throw new PncContractTokenError(id, 'locked_fields');
        }
        if (data.isActive === true && !current.isActive && contractStatus === 'revoked') {
          throw new PncContractTokenError(id, 'contract_revoked');
        }
      }

      // A token that ends up active, when it is reactivated or moved to
      // another driver, needs an active driver.
      const nextDriverId = data.driverId !== undefined ? data.driverId : current.driverId;
      const nextActive = data.isActive ?? current.isActive;
      const reactivating = data.isActive === true && !current.isActive;
      const reassigned = data.driverId !== undefined && data.driverId !== current.driverId;
      const nextFleetId = data.fleetId !== undefined ? data.fleetId : current.fleetId;
      const fleetChanged = nextFleetId !== current.fleetId;
      assertNoFleetCardBalance(
        nextFleetId,
        data.prepaidBalanceCents !== undefined
          ? data.prepaidBalanceCents
          : current.prepaidBalanceCents,
      );
      // A card that leaves its fleet loses the fleet's monthly limit.
      const limitLeft = nextFleetId == null && current.monthlyLimitCents != null;
      if (data.monthlyLimitCents !== undefined || nextFleetId == null) {
        assertCardMonthlyLimit(nextFleetId, data.monthlyLimitCents ?? null);
      }
      // A card moved into a fleet or given to a member needs a fleet that bills
      // on account; taking a card back or moving it out of its fleet does not.
      const givenToMember = nextFleetId != null && nextDriverId != null && reassigned;
      if (nextFleetId != null && (fleetChanged || givenToMember)) {
        await assertFleetCanHoldCards(nextFleetId, tx);
      }
      if (nextFleetId != null && nextDriverId != null && (fleetChanged || reassigned)) {
        await assertFleetCardMember(nextFleetId, nextDriverId, tx);
      }
      if (nextActive && nextDriverId != null && (reactivating || reassigned)) {
        await assertDriverActive(nextDriverId, tx);
      }

      if (data.idToken != null || data.tokenType != null) {
        const nextIdToken = data.idToken ?? current.idToken;
        const nextTokenType = data.tokenType ?? current.tokenType;
        if (
          (nextIdToken !== current.idToken || nextTokenType !== current.tokenType) &&
          (await tokenExists(nextIdToken, nextTokenType, id, tx))
        ) {
          throw new DuplicateTokenError(nextIdToken, nextTokenType);
        }
      }

      const nextValue = data.idToken ?? current.idToken;
      if (nextValue !== current.idToken || nextDriverId !== current.driverId) {
        await assertNotOtherDriversVehicleId(nextValue, nextDriverId, tx);
      }

      // The card's vehicle stays a vehicle of its driver: a sent vehicle is
      // checked against the next driver, and a move to another driver drops a
      // vehicle of the previous one.
      const nextVehicleId = data.vehicleId !== undefined ? data.vehicleId : current.vehicleId;
      let vehicleChange: string | null | undefined = data.vehicleId;
      if (nextVehicleId != null && (data.vehicleId != null || reassigned)) {
        if (data.vehicleId != null) {
          await assertTokenVehicle(nextVehicleId, nextDriverId, tx);
        } else {
          const [kept] =
            nextDriverId == null
              ? []
              : await tx
                  .select({ id: vehicles.id })
                  .from(vehicles)
                  .where(and(eq(vehicles.id, nextVehicleId), eq(vehicles.driverId, nextDriverId)));
          if (kept == null) vehicleChange = null;
        }
      }

      const setValues: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (vehicleChange !== undefined) setValues['vehicleId'] = vehicleChange;
      if (limitLeft) setValues['monthlyLimitCents'] = null;
      // The expected balance is a condition, not a column.
      delete setValues['expectedPrepaidBalanceCents'];
      const sentLabel = normalizeTokenLabel(data.label);
      if (sentLabel !== undefined) setValues['label'] = sentLabel;
      // A token moved to another driver loses its label (owner decision): the
      // next driver sees the label, which the previous driver or an operator
      // typed for the previous driver. A label the request changes stays. A
      // fleet card given to another member, or taken back, keeps its label:
      // the fleet typed it for the card, not for the member.
      const staysFleetCard = nextFleetId != null && nextFleetId === current.fleetId;
      if (
        reassigned &&
        !staysFleetCard &&
        (sentLabel === undefined || sentLabel === current.label)
      ) {
        setValues['label'] = null;
      }
      // Stamp revokedAt and who deactivated when the token turns inactive;
      // clear all three on reactivate. Through the fleet routes a PATCH only
      // suspends (no revokedAt, so the fleet may bring the card back) and the
      // DELETE revokes.
      const byFleetUser = scope?.byFleetUser === true;
      if (data.isActive === false && current.isActive) {
        setValues['revokedAt'] = scope == null || scope.revoke === true ? new Date() : null;
        setValues['deactivatedBy'] = deactivatedByOf(actor, byFleetUser);
      } else if (scope?.revoke === true && !current.isActive && current.revokedAt == null) {
        setValues['revokedAt'] = new Date();
        setValues['deactivatedBy'] = deactivatedByOf(actor, byFleetUser);
      } else if (data.isActive === true && !current.isActive) {
        setValues['revokedAt'] = null;
        setValues['revokedReason'] = null;
        setValues['deactivatedBy'] = null;
      }

      const [token] = await tx
        .update(driverTokens)
        .set(setValues)
        .where(eq(driverTokens.id, id))
        .returning();
      return token == null ? null : { current, token };
    });
  } catch (err) {
    if (
      err instanceof DuplicateTokenError ||
      err instanceof VehicleIdTokenInUseError ||
      err instanceof PrepaidBalanceConflictError ||
      err instanceof TokenReactivationBlockedError ||
      err instanceof FleetCardDeactivatedError ||
      err instanceof TokenDriverInactiveError ||
      err instanceof TokenDriverNotFoundError ||
      err instanceof TokenFleetNotFoundError ||
      err instanceof FleetCardNotBillableError ||
      err instanceof FleetCardPermissionError ||
      err instanceof FleetCardDriverNotMemberError ||
      err instanceof TokenManagedByFleetError ||
      err instanceof ValidationError
    ) {
      throw err;
    }
    throw mapWriteError(err, {
      idToken: data.idToken ?? '',
      tokenType: data.tokenType ?? '',
      driverId: data.driverId,
    });
  }
  if (changed == null) return null;
  const { current, token } = changed;

  const beforeSnapshot: TokenSnapshot = {
    idToken: current.idToken,
    tokenType: current.tokenType,
    driverId: current.driverId,
    label: current.label,
    prepaidBalanceCents: current.prepaidBalanceCents,
    vehicleId: current.vehicleId,
    fleetId: current.fleetId,
    monthlyLimitCents: current.monthlyLimitCents,
  };
  const afterSnapshot: TokenSnapshot = {
    idToken: token.idToken,
    tokenType: token.tokenType,
    driverId: token.driverId,
    label: token.label,
    prepaidBalanceCents: token.prepaidBalanceCents,
    vehicleId: token.vehicleId,
    fleetId: token.fleetId,
    monthlyLimitCents: token.monthlyLimitCents,
  };

  const labelClearedOnMove =
    current.driverId !== token.driverId && current.label != null && token.label == null;

  // A station's local auth list carries the value, the type, the status and
  // the expiry: a change to any of them needs a re-push.
  // A token that becomes prepaid leaves every list at the next push (a
  // station checks a prepaid balance online), and one that stops being
  // prepaid may be added again.
  const listFieldsChanged =
    token.idToken !== current.idToken ||
    token.tokenType !== current.tokenType ||
    (token.prepaidBalanceCents == null) !== (current.prepaidBalanceCents == null) ||
    (token.expiresAt?.getTime() ?? null) !== (current.expiresAt?.getTime() ?? null) ||
    // A fleet card no member holds is listed only while its fleet can be billed.
    token.fleetId !== current.fleetId ||
    (token.fleetId != null && (token.driverId == null) !== (current.driverId == null));

  // Audit + side effects driven by what actually changed.
  if (data.isActive === false && current.isActive) {
    await writeTokenAudit({
      tokenId: token.id,
      entityIdSnapshot: token.id,
      action: 'deactivated',
      actor,
      before: beforeSnapshot,
      after: afterSnapshot,
      notes: data.revokedReason ?? null,
    });
    await notifyDriver(token.driverId, 'token.Deactivated', {
      idToken: token.idToken,
      tokenType: token.tokenType,
      reason: data.revokedReason ?? '',
    });
    await bumpStationsHoldingTokens([token.id]);
  } else if (data.isActive === true && !current.isActive) {
    await writeTokenAudit({
      tokenId: token.id,
      entityIdSnapshot: token.id,
      action: 'activated',
      actor,
      before: beforeSnapshot,
      after: afterSnapshot,
    });
    // Reactivation is its own template -- the driver removed (or operator
    // deactivated) this card, then it came back. Sending token.Added would
    // read as "operator added a new card" which is misleading when it's the
    // same physical card they already had.
    await notifyDriver(token.driverId, 'token.Reactivated', {
      idToken: token.idToken,
      tokenType: token.tokenType,
      reactivatedBy: actorLabel(actor),
    });
    await bumpStationsHoldingTokens([token.id]);
  } else if (token.revokedAt != null && current.revokedAt == null && !token.isActive) {
    // The fleet DELETE of a card the fleet had suspended: revoked for good.
    await writeTokenAudit({
      tokenId: token.id,
      entityIdSnapshot: token.id,
      action: 'revoked',
      actor,
      before: beforeSnapshot,
      after: afterSnapshot,
      notes: data.revokedReason ?? null,
    });
  } else {
    await writeTokenAudit({
      tokenId: token.id,
      entityIdSnapshot: token.id,
      action: 'updated',
      actor,
      before: beforeSnapshot,
      after: afterSnapshot,
      notes: labelClearedOnMove ? 'Label cleared: the token moved to another driver' : null,
    });
    if (listFieldsChanged) await bumpStationsHoldingTokens([token.id]);
  }
  // The member a fleet card was taken from, and the member it was given to, each hear it.
  if (token.fleetId != null && current.driverId !== token.driverId) {
    await notifyFleetCardMember(current.driverId, 'token.FleetCardTakenBack', {
      ...token,
      fleetId: current.fleetId ?? token.fleetId,
    });
    await notifyFleetCardMember(token.driverId, 'token.FleetCardAssigned', token);
  }
  // A changed value or OCPI type is a new OCPI Token: the old one is
  // invalidated. ISO14443 to ISO15693 (both RFID) is the same OCPI Token,
  // so no tombstone would mark the live card invalid at partners.
  const tombstones: OcpiTokenTombstoneRef[] = [];
  if (isNewOcpiToken(current, token)) {
    const old = { idToken: current.idToken, tokenType: current.tokenType };
    if (await tombstoneTokenValue(old)) tombstones.push(old);
  }
  await publishTokenChanged(token.id);
  // An OCPI Token carries no label: a change of the label alone sends
  // partners nothing.
  if (!labelOnlyChange(current, token)) {
    await publishOcpiTokenPush({ tokenIds: [token.id], tombstones });
  }
  return token;
}

/** True when an update changed the label and no other column an OCPI Token or the card holds. */
function labelOnlyChange(
  current: {
    idToken: string;
    tokenType: string;
    driverId: string | null;
    label: string | null;
    isActive: boolean;
    expiresAt: Date | null;
    revokedReason: string | null;
    prepaidBalanceCents: number | null;
    vehicleId: string | null;
    fleetId: string | null;
    monthlyLimitCents: number | null;
    revokedAt: Date | null;
  },
  token: typeof driverTokens.$inferSelect,
): boolean {
  return (
    current.label !== token.label &&
    current.idToken === token.idToken &&
    current.tokenType === token.tokenType &&
    current.driverId === token.driverId &&
    current.isActive === token.isActive &&
    (current.expiresAt?.getTime() ?? null) === (token.expiresAt?.getTime() ?? null) &&
    current.revokedReason === token.revokedReason &&
    current.prepaidBalanceCents === token.prepaidBalanceCents &&
    current.vehicleId === token.vehicleId &&
    current.fleetId === token.fleetId &&
    current.monthlyLimitCents === token.monthlyLimitCents &&
    (current.revokedAt?.getTime() ?? null) === (token.revokedAt?.getTime() ?? null)
  );
}

export async function deleteToken(
  id: string,
  actor: TokenActor = { type: 'system' },
  options: Pick<TokenWriteOptions, 'fleetCardsWrite'> = {},
) {
  // Read the stations first: the delete sets their entries' token id to null
  // (foreign key), after which they can no longer be found. The next push
  // drops those entries, so the station stops accepting the card.
  const restricted = await assertMayWriteTokenFleets([id], actor, options);
  const stationIds = await stationsHoldingTokens([id]);
  // The eMAID of an active Plug and Charge contract stays: deleting it would
  // delete the contract and its certificate records (revoke the contract first).
  const [token] = await db
    .delete(driverTokens)
    .where(
      and(
        eq(driverTokens.id, id),
        sql`NOT EXISTS (SELECT 1 FROM pnc_contracts c WHERE c.driver_token_id = ${driverTokens.id} AND c.status = 'active')`,
        // A card moved into a fleet after the check above stays.
        restricted ? isNull(driverTokens.fleetId) : undefined,
      ),
    )
    .returning();
  if (token == null) {
    if (restricted) await assertMayWriteTokenFleets([id], actor, options);
    if ((await contractStatuses([id])).get(id) === 'active') {
      throw new PncContractTokenError(id, 'contract_active');
    }
    return null;
  }
  await writeTokenAudit({
    tokenId: null,
    entityIdSnapshot: token.id,
    action: 'deleted',
    actor,
    before: {
      idToken: token.idToken,
      tokenType: token.tokenType,
      driverId: token.driverId,
    },
  });
  await notifyDriver(token.driverId, 'token.Removed', {
    idToken: token.idToken,
    tokenType: token.tokenType,
    removedBy: actorLabel(actor),
  });
  await markLocalAuthListsChanged(stationIds);
  const tombstone = { idToken: token.idToken, tokenType: token.tokenType };
  const tombstoned = await tombstoneTokenValue(tombstone);
  await publishTokenChanged(token.id);
  if (tombstoned) await publishOcpiTokenPush({ tombstones: [tombstone] });
  return token;
}

export async function bulkSetActive(
  ids: string[],
  isActive: boolean,
  actor: TokenActor = { type: 'system' },
  options: Pick<TokenWriteOptions, 'fleetCardsWrite'> = {},
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  const restricted = await assertMayWriteTokenFleets(ids, actor, options);
  if (isActive) {
    // No eMAID of a revoked Plug and Charge contract comes back.
    for (const [tokenId, status] of await contractStatuses(ids)) {
      if (status === 'revoked') throw new PncContractTokenError(tokenId, 'contract_revoked');
    }
    // No token comes back for a deactivated driver: refuse the batch.
    const [blocked] = await db
      .select({ driverId: drivers.id })
      .from(driverTokens)
      .innerJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .where(
        and(
          inArray(driverTokens.id, ids),
          eq(driverTokens.isActive, false),
          eq(drivers.isActive, false),
        ),
      )
      .limit(1);
    if (blocked != null) throw new TokenDriverInactiveError(blocked.driverId);
  }
  const updates: Partial<typeof driverTokens.$inferInsert> = {
    isActive,
    updatedAt: new Date(),
  };
  if (isActive) {
    updates.revokedAt = null;
    updates.revokedReason = null;
    updates.deactivatedBy = null;
  } else {
    updates.revokedAt = new Date();
    updates.deactivatedBy = deactivatedByOf(actor);
  }
  // Only tokens not already in the target state: a token already inactive
  // keeps its original revokedAt and who deactivated it, and its driver gets
  // no notification for a change that did not happen.
  const updated = await db
    .update(driverTokens)
    .set(updates)
    .where(
      and(
        inArray(driverTokens.id, ids),
        ne(driverTokens.isActive, isActive),
        restricted ? isNull(driverTokens.fleetId) : undefined,
      ),
    )
    .returning();
  if (updated.length === 0) return { updated: 0 };

  // Single bulk audit insert instead of N sequential. For 500-token deactivate
  // this turns ~500 round-trips into 1. Fail-open like writeAudit (P9): the
  // tokens are already changed.
  const { actor: actorKind, actorUserId, actorDriverId, actorApiKeyId } = actorColumns(actor);
  const action: 'activated' | 'deactivated' = isActive ? 'activated' : 'deactivated';
  try {
    await db.insert(tokenAuditLog).values(
      updated.map((t) => ({
        tokenId: t.id,
        tokenIdSnapshot: t.id,
        action,
        actor: actorKind,
        actorUserId,
        actorDriverId,
        actorApiKeyId,
        viaAi: currentAuditViaAi() ?? null,
        after: {
          idToken: t.idToken,
          tokenType: t.tokenType,
          driverId: t.driverId,
          isActive,
        },
        notes: null,
      })),
    );
  } catch (err) {
    logger.warn({ err, count: updated.length, action }, 'Bulk token audit insert failed');
  }

  // One batched bump for every station holding any of the affected tokens.
  await bumpStationsHoldingTokens(updated.map((t) => t.id));

  // Per-driver notifications. Bulk activate flips previously-deactivated
  // rows, so the right template is token.Reactivated (NOT token.Added: the
  // card was already on the driver's account). We await Promise.allSettled
  // so a pod restart mid-response cannot drop them: the handler does not
  // return until either every notification settled or one of them threw.
  // Failures are swallowed inside notifyDriver itself (logged at warn) so
  // this does not affect the mutation outcome from the caller's perspective.
  const notifyEvent: 'token.Reactivated' | 'token.Deactivated' = isActive
    ? 'token.Reactivated'
    : 'token.Deactivated';
  const actorString = actorLabel(actor);
  await Promise.allSettled(
    updated.map((token) =>
      notifyDriver(token.driverId, notifyEvent, {
        idToken: token.idToken,
        tokenType: token.tokenType,
        ...(isActive ? { reactivatedBy: actorString } : { reason: '' }),
      }),
    ),
  );

  // Single broadcast covers the bulk: SSE subscribers invalidate the Tokens
  // list / AuthorizeLog queries once, not N times.
  await publishTokenChanged(null);
  await publishOcpiTokenPush({ tokenIds: updated.map((t) => t.id) });

  return { updated: updated.length };
}

type ReleaseExecutor = Pick<typeof db, 'update'>;

/**
 * Takes back the fleet cards a member holds when the member leaves the fleet
 * (`fleetId` set), or is deactivated or erased (every fleet): each card is
 * given to no member and suspended (`deactivated_by` `system`, no
 * `revoked_at`), so a fleet user may hand it out and turn it on again. A
 * card already inactive keeps who deactivated it, so an operator block stays.
 * The card keeps its label (the fleet's) and drops the member's vehicle.
 *
 * With `tx` the update runs in the caller's transaction (the erasure) and the
 * returned `afterCommit` writes the audit rows and sends the list, OCPI and
 * page updates once the caller committed; without it the function runs both.
 */
export async function releaseMemberFleetCards(
  target: { driverId: string; fleetId?: string | undefined },
  actor: TokenActor = { type: 'system' },
  tx?: ReleaseExecutor,
): Promise<{ released: number; afterCommit: () => Promise<void> }> {
  const run = async (conn: ReleaseExecutor) =>
    conn
      .update(driverTokens)
      .set({
        driverId: null,
        vehicleId: null,
        isActive: false,
        deactivatedBy: sql`CASE WHEN ${driverTokens.isActive} THEN 'system' ELSE ${driverTokens.deactivatedBy} END`,
        revokedReason: sql`CASE WHEN ${driverTokens.isActive} THEN ${FLEET_CARD_RELEASE_REASON} ELSE ${driverTokens.revokedReason} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(driverTokens.driverId, target.driverId),
          target.fleetId != null
            ? eq(driverTokens.fleetId, target.fleetId)
            : sql`${driverTokens.fleetId} IS NOT NULL`,
        ),
      )
      .returning({
        id: driverTokens.id,
        idToken: driverTokens.idToken,
        tokenType: driverTokens.tokenType,
        label: driverTokens.label,
        fleetId: driverTokens.fleetId,
      });
  const released = await run(tx ?? db);
  const afterCommit = async (): Promise<void> => {
    if (released.length === 0) return;
    for (const card of released) {
      await writeTokenAudit({
        tokenId: card.id,
        entityIdSnapshot: card.id,
        action: 'updated',
        actor,
        before: {
          idToken: card.idToken,
          tokenType: card.tokenType,
          driverId: target.driverId,
          label: card.label,
          fleetId: card.fleetId,
        },
        after: {
          idToken: card.idToken,
          tokenType: card.tokenType,
          driverId: null,
          label: card.label,
          fleetId: card.fleetId,
        },
        notes: FLEET_CARD_RELEASE_REASON,
      });
      // Fail-open: the card is already taken back.
      await notifyFleetCardMember(target.driverId, 'token.FleetCardTakenBack', card);
    }
    const ids = released.map((c) => c.id);
    await bumpStationsHoldingTokens(ids);
    await publishTokenChanged(null);
    await publishOcpiTokenPush({ tokenIds: ids });
  };
  if (tx == null) await afterCommit();
  return { released: released.length, afterCommit };
}

/**
 * Marks changed the local auth lists that hold a fleet's cards: a fleet card
 * is listed Accepted only while the fleet can be billed, whoever holds it, so
 * turning the fleet's account billing on or off changes its entries.
 * Fail-open: the setting change already committed.
 */
export async function markFleetCardListsChanged(fleetId: string): Promise<void> {
  try {
    const cards = await db
      .select({ id: driverTokens.id })
      .from(driverTokens)
      .where(eq(driverTokens.fleetId, fleetId));
    await bumpStationsHoldingTokens(cards.map((c) => c.id));
  } catch (err) {
    logger.warn({ err, fleetId }, 'Fleet card local list bump failed, lists show it at next push');
  }
}

// label is the last column, so a file without it still imports.
export const TOKEN_CSV_HEADER = 'idToken,tokenType,driverEmail,isActive,expiresAt,label';

export async function exportTokensCsv(filters: TokenFilters = {}): Promise<string> {
  const data = await db
    .select(tokenSelect)
    .from(driverTokens)
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .leftJoin(fleets, eq(driverTokens.fleetId, fleets.id))
    .where(tokenWhere(filters))
    .orderBy(desc(driverTokens.createdAt), desc(driverTokens.id));

  const rows = data.map((row) => {
    const email = row.driverEmail ?? '';
    const active = row.isActive ? 'true' : 'false';
    const expires = row.expiresAt instanceof Date ? row.expiresAt.toISOString() : '';
    return `${csvEscape(row.idToken)},${csvEscape(row.tokenType)},${csvEscape(email)},${active},${csvEscape(expires)},${csvEscape(row.label ?? '')}`;
  });

  return [TOKEN_CSV_HEADER, ...rows].join('\n');
}

/** A CSV row the importer accepts; each field is checked per row so one bad row never fails the batch. */
export interface TokenImportRow {
  idToken: string;
  tokenType: string;
  driverEmail?: string | undefined;
  isActive?: boolean | undefined;
  expiresAt?: string | undefined;
  label?: string | undefined;
}

const MAX_ID_TOKEN_LENGTH = 255;
const WHITESPACE = /\s/;

/**
 * A loose shape check, `local@domain.tld` (the driver lookup decides whether
 * the address is known): the matches of `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`,
 * checked by scanning. As a regular expression the two dotted parts after the
 * `@` backtrack quadratically on a long imported value. Exported for tests.
 */
export function hasEmailShape(value: string): boolean {
  if (WHITESPACE.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || value.includes('@', at + 1)) return false;
  const domain = value.slice(at + 1);
  // A dot with at least one character on each side.
  const dot = domain.indexOf('.', 1);
  return dot > 0 && dot < domain.length - 1;
}

export async function importTokensCsv(
  rows: TokenImportRow[],
  actor: TokenActor = { type: 'system' },
): Promise<{ imported: number; errors: string[] }> {
  // Format check + intra-batch dedup happens up front so we can present every
  // row's parse error in one response. Driver email resolution and the
  // duplicate-vs-existing check both live inside the transaction so a
  // concurrent driver delete or token insert cannot leak past us.
  const errors: string[] = [];
  const seenInBatch = new Set<string>();
  type Parsed = {
    idToken: string;
    tokenType: string;
    driverEmail: string | null;
    isActive: boolean;
    expiresAt: Date | null;
    label: string | null;
  };
  const parsed: Parsed[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row == null) continue;
    const rowLabel = `Row ${String(i + 1)}`;
    const idToken = row.idToken.trim();
    const tokenType = row.tokenType.trim();
    if (idToken === '' && tokenType === '' && (row.driverEmail ?? '').trim() === '') {
      // A blank line of the file.
      continue;
    }
    if (idToken === '' || tokenType === '') {
      errors.push(`${rowLabel}: missing idToken or tokenType`);
      continue;
    }
    if (idToken.length > MAX_ID_TOKEN_LENGTH) {
      errors.push(`${rowLabel}: idToken is longer than ${String(MAX_ID_TOKEN_LENGTH)} characters`);
      continue;
    }
    if (!isOcppIdTokenType(tokenType)) {
      errors.push(`${rowLabel}: unknown tokenType ${tokenType}`);
      continue;
    }
    const driverEmail = (row.driverEmail ?? '').trim();
    if (driverEmail !== '' && !hasEmailShape(driverEmail)) {
      errors.push(`${rowLabel}: invalid driverEmail`);
      continue;
    }
    const key = `${idToken}\x00${tokenType}`;
    if (seenInBatch.has(key)) {
      errors.push(
        `${rowLabel}: duplicate of an earlier row in this import (${idToken}, ${tokenType})`,
      );
      continue;
    }
    let expiresAt: Date | null = null;
    if (row.expiresAt && row.expiresAt.trim() !== '') {
      const d = new Date(row.expiresAt.trim());
      if (Number.isNaN(d.getTime())) {
        errors.push(`${rowLabel}: invalid expiresAt`);
        continue;
      }
      expiresAt = d;
    }
    const labelProblem = row.label == null ? null : tokenLabelProblem(row.label);
    if (labelProblem === 'too_long') {
      errors.push(`${rowLabel}: label is longer than ${String(TOKEN_LABEL_MAX_LENGTH)} characters`);
      continue;
    }
    if (labelProblem === 'control_characters') {
      errors.push(`${rowLabel}: label contains control or invisible format characters`);
      continue;
    }
    const label = normalizeTokenLabel(row.label) ?? null;
    seenInBatch.add(key);
    parsed.push({
      idToken,
      tokenType,
      driverEmail: driverEmail === '' ? null : driverEmail,
      isActive: row.isActive !== false,
      expiresAt,
      label,
    });
  }

  if (parsed.length === 0) {
    return { imported: 0, errors };
  }

  const deactivatedBy = deactivatedByOf(actor);
  // Single transaction:
  //   1. Resolve all driver emails (case-insensitive) and report unknown ones
  //      row by row.
  //   2. Check for existing (idToken, tokenType) collisions.
  //   3. Insert remaining rows in one statement; a row a concurrent insert
  //      took meanwhile is skipped (ON CONFLICT) and reported, not a 500.
  // Any failure rolls everything back, so a process crash mid-loop cannot
  // leave half-imported rows that bypassed the audit/notification step below.
  const inserted: Array<{
    id: string;
    idToken: string;
    tokenType: string;
    driverId: string | null;
    label: string | null;
  }> = await db.transaction(async (tx) => {
    type Prepared = {
      idToken: string;
      tokenType: string;
      driverId: string | null;
      label: string | null;
      isActive: boolean;
      expiresAt: Date | null;
      revokedAt: Date | null;
      deactivatedBy: 'operator' | 'driver' | 'system' | 'fleet' | null;
    };
    const prepared: Prepared[] = [];

    const emails = Array.from(
      new Set(
        parsed.map((p) => p.driverEmail?.toLowerCase()).filter((e): e is string => e != null),
      ),
    );
    let emailToDriverId = new Map<string, string>();
    let inactiveDriverIds = new Set<string>();
    if (emails.length > 0) {
      const driverRows = await tx
        .select({ id: drivers.id, email: drivers.email, isActive: drivers.isActive })
        .from(drivers)
        .where(inArray(sql`lower(${drivers.email})`, emails));
      emailToDriverId = new Map(
        driverRows
          .filter((d): d is { id: string; email: string; isActive: boolean } => d.email != null)
          .map((d) => [d.email.toLowerCase(), d.id]),
      );
      inactiveDriverIds = new Set(driverRows.filter((d) => !d.isActive).map((d) => d.id));
    }

    const now = new Date();
    for (const p of parsed) {
      let driverId: string | null = null;
      if (p.driverEmail != null) {
        const found = emailToDriverId.get(p.driverEmail.toLowerCase());
        if (found == null) {
          errors.push(
            `Row for ${p.idToken} (${p.tokenType}): driver not found for email ${p.driverEmail}`,
          );
          continue;
        }
        if (p.isActive && inactiveDriverIds.has(found)) {
          errors.push(`Row for ${p.idToken} (${p.tokenType}): driver ${p.driverEmail} is inactive`);
          continue;
        }
        driverId = found;
      }
      prepared.push({
        idToken: p.idToken,
        tokenType: p.tokenType,
        driverId,
        label: p.label,
        isActive: p.isActive,
        expiresAt: p.expiresAt,
        // An inactive imported card is a block by whoever imported it.
        revokedAt: p.isActive ? null : now,
        deactivatedBy: p.isActive ? null : deactivatedBy,
      });
    }

    if (prepared.length === 0) return [];

    // Card ids collide in any letter case (`cardIdMatchKey`).
    const existing = await tx
      .select({ idToken: driverTokens.idToken, tokenType: driverTokens.tokenType })
      .from(driverTokens)
      .where(
        inArray(sql`lower(${driverTokens.idToken})`, [
          ...new Set(prepared.map((p) => p.idToken.toLowerCase())),
        ]),
      );
    const matchKey = (idToken: string, tokenType: string): string =>
      `${cardIdMatchKey(idToken, tokenType)}\x00${tokenType}`;
    const existsKey = new Set(existing.map((e) => matchKey(e.idToken, e.tokenType)));
    // The spellings each value has among cards that are not vehicle ids: another
    // spelling collides in any type (`sameCardValue`).
    const spellings = new Map<string, Set<string>>();
    const addSpelling = (idToken: string, tokenType: string): void => {
      if (isVehicleIdType(tokenType)) return;
      const lower = idToken.toLowerCase();
      const set = spellings.get(lower) ?? new Set<string>();
      set.add(idToken);
      spellings.set(lower, set);
    };
    for (const e of existing) addSpelling(e.idToken, e.tokenType);
    const otherSpelling = (idToken: string, tokenType: string): boolean =>
      !isVehicleIdType(tokenType) &&
      [...(spellings.get(idToken.toLowerCase()) ?? [])].some((v) => v !== idToken);
    // A card holding another driver's vehicle id (any spelling) is refused
    // like a single create.
    const candidatesOf = new Map(prepared.map((p) => [p, tokenVehicleIdCandidates(p.idToken)]));
    const allCandidates = [...new Set([...candidatesOf.values()].flat())];
    const vehicleIdOwners =
      allCandidates.length === 0
        ? []
        : await tx
            .select({ vin: vehicles.vin, evccid: vehicles.evccid, driverId: vehicles.driverId })
            .from(vehicles)
            .where(
              or(inArray(vehicles.vin, allCandidates), inArray(vehicles.evccid, allCandidates)),
            );
    const toInsert: Prepared[] = [];
    for (const p of prepared) {
      const key = matchKey(p.idToken, p.tokenType);
      if (existsKey.has(key) || otherSpelling(p.idToken, p.tokenType)) {
        errors.push(`Row for ${p.idToken} (${p.tokenType}): token already exists`);
        continue;
      }
      const candidates = candidatesOf.get(p) ?? [];
      const collides = vehicleIdOwners.some(
        (v) =>
          v.driverId !== p.driverId &&
          ((v.vin != null && candidates.includes(v.vin)) ||
            (v.evccid != null && candidates.includes(v.evccid))),
      );
      if (collides) {
        errors.push(`Row for ${p.idToken} (${p.tokenType}): another driver's vehicle uses this id`);
        continue;
      }
      // A later row of the same card in another letter case is a duplicate.
      existsKey.add(key);
      addSpelling(p.idToken, p.tokenType);
      toInsert.push(p);
    }
    if (toInsert.length === 0) return [];

    const insertedRows = await tx
      .insert(driverTokens)
      .values(toInsert)
      .onConflictDoNothing()
      .returning({
        id: driverTokens.id,
        idToken: driverTokens.idToken,
        tokenType: driverTokens.tokenType,
        driverId: driverTokens.driverId,
        label: driverTokens.label,
      });
    const insertedKeys = new Set(insertedRows.map((t) => `${t.idToken}\x00${t.tokenType}`));
    for (const p of toInsert) {
      if (!insertedKeys.has(`${p.idToken}\x00${p.tokenType}`)) {
        errors.push(`Row for ${p.idToken} (${p.tokenType}): token already exists`);
      }
    }

    // Audit rows for the import are written inside the same transaction so a
    // crash that prevents the post-commit notification loop still leaves an
    // audit trail for the actual inserted tokens.
    if (insertedRows.length > 0) {
      const { actor: actorKind, actorUserId, actorDriverId, actorApiKeyId } = actorColumns(actor);
      await tx.insert(tokenAuditLog).values(
        insertedRows.map((t) => ({
          tokenId: t.id,
          tokenIdSnapshot: t.id,
          action: 'imported' as const,
          actor: actorKind,
          actorUserId,
          actorDriverId,
          actorApiKeyId,
          viaAi: currentAuditViaAi() ?? null,
          after: {
            idToken: t.idToken,
            tokenType: t.tokenType,
            driverId: t.driverId,
            label: t.label,
          },
          notes: null,
        })),
      );
    }

    return insertedRows;
  });

  // Notifications happen post-commit because dispatchDriverNotification can
  // make outbound HTTP/SMTP calls that we don't want to hold a DB transaction
  // open across. The audit trail above covers the case where the process
  // crashes here.
  for (const token of inserted) {
    await notifyDriver(token.driverId, 'token.Added', {
      idToken: token.idToken,
      tokenType: token.tokenType,
      addedBy: actorLabel(actor),
    });
  }

  if (inserted.length > 0) {
    await publishTokenChanged(null);
    await publishOcpiTokenPush({ tokenIds: inserted.map((t) => t.id) });
  }

  return { imported: inserted.length, errors };
}
