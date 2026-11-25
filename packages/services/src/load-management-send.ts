// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import {
  db,
  chargingStations,
  evses,
  stationConfigurations,
  claimAndLogAllocations,
  client,
  loadManagementFenceHolds,
  recordAllocationEntryReply,
  writeLoadManagementRecords,
} from '@evtivity/database';
import type { LoadAllocationEntryInput, LoadAllocationHeader } from '@evtivity/database';
import {
  entriesAfterFailures,
  entriesForCuts,
  entriesForRaises,
  cutsBeforeRaises,
  defaultReleaseKey,
  RaiseBasisChanged,
  SendClassificationChanged,
  type AppliedAllocation,
  type CountedLimit,
  type LimitSendCommand,
  type LimitSendFailure,
} from './load-limit-entries.js';
import type { ServiceLogger } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';
import {
  OCPP_COMMAND_RESULTS_CHANNEL,
  awaitPubSubReply,
  circuitConductorPhases,
  createLogger,
  publishOcppCommand,
} from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  chargingNeedsProfileId,
  loadManagementDefaultProfileId,
} from '@evtivity/lib/charging-profile-ids';
import { stationProfileWatts } from './evse-limits.js';
import { buildEvseDefaultProfile, buildEvseLimitProfile } from './evse-limit-profiles.js';
import type {
  EvseDefaultCommand,
  EvseDefaultRelease,
  EvseLimitCommand,
  EvseLimitRelease,
} from './evse-limit-profiles.js';
import {
  type StationRate,
  loadManagementProfileId,
  loadManagementCreditProfileId,
  buildLoadManagementProfile,
} from './load-management-profiles.js';
import {
  MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE,
  sendRateUnit,
} from './load-management-rate-units.js';
import {
  type AllocationResult,
  EPSILON_KW,
  type HierarchyNode,
  type ChargingRateUnit,
} from './load-management-model.js';

const logger = createLogger('load-management');

/** One SetChargingProfile of a send, built before it is logged and published. */
export interface PreparedLimitCommand {
  stationId: string;
  stationDbId: string;
  commandId: string;
  payload: Record<string, unknown>;
  /** The limit in kW. */
  kw: number;
  /** What the station enforces once it applies the command, kW (`LimitCommand.enforcedKw`). */
  enforcedKw: number;
  /** A station limit (or its credit profile), the TxProfile of one EVSE, or an EVSE's TxDefaultProfile. */
  source:
    | { scope: 'station'; command: LimitCommand; rate: StationRate | undefined }
    | { scope: 'evse'; command: EvseLimitCommand }
    | { scope: 'evseDefault'; command: EvseDefaultCommand };
}

/** The commands of one send, in their groups: cuts go out before raises. */
export interface AllocationSend {
  stationCuts: PreparedLimitCommand[];
  evseCuts: PreparedLimitCommand[];
  evseRaises: PreparedLimitCommand[];
  stationRaises: PreparedLimitCommand[];
  releases: EvseLimitRelease[];
  /** The defaults no longer needed, cleared by id with the raises. */
  defaultReleases: EvseDefaultRelease[];
  /**
   * Stations the allocation counts at a reservation (an unconfirmed or refused
   * limit): no raise depends on their cut, so it is not awaited.
   */
  reservedStations: string[];
}

/** What a send did: what it held back and which awaited cuts went unconfirmed. */
export interface AllocationSendOutcome {
  /** Every command was published, and every awaited cut accepted. */
  sent: boolean;
  /** The commands the stations never decided on: an awaited cut not accepted, or a command not published. */
  failures: LimitSendFailure[];
  /** Command ids of the limits that were not published (held raises included). */
  heldCommandIds: { stationDbId: string; commandId: string }[];
}

export interface AllocationSendHooks {
  /**
   * Records the raises as sends before they are published (the second claim,
   * fenced). False: the site lock was lost or load management turned off, and
   * no raise goes out.
   */
  beforeRaises?: () => Promise<boolean>;
  /** Energy assets were not read and are not known: every raise is held. */
  holdRaises?: boolean;
}

/** The state model's view of one prepared command (none for a release). */
export function limitSendCommand(command: PreparedLimitCommand): LimitSendCommand {
  if (command.source.scope === 'evse') {
    return {
      stationDbId: command.stationDbId,
      commandId: command.commandId,
      kw: command.kw,
      target: 'evse',
      transactionId: command.source.command.limit.transactionId,
      ...(command.source.command.rateUnit === 'W' ? { watts: true } : {}),
    };
  }
  if (command.source.scope === 'evseDefault') {
    return {
      stationDbId: command.stationDbId,
      commandId: command.commandId,
      kw: command.kw,
      target: 'evseDefault',
      evseNumber: command.source.command.value.evseNumber,
      ...(command.source.command.value.rateUnit === 'W' ? { watts: true } : {}),
    };
  }
  const validTo = command.source.command.validTo;
  return {
    stationDbId: command.stationDbId,
    commandId: command.commandId,
    kw: command.enforcedKw,
    target: validTo != null ? 'credit' : 'station',
    ...(validTo != null ? { validTo: validTo.toISOString() } : {}),
    ...((command.source.rate?.rateUnit ?? 'W') === 'W' ? { watts: true } : {}),
  };
}

function sendFailure(
  command: PreparedLimitCommand,
  kind: LimitSendFailure['kind'],
): LimitSendFailure {
  const c = limitSendCommand(command);
  return {
    stationDbId: c.stationDbId,
    commandId: c.commandId,
    target: c.target,
    ...(c.transactionId != null ? { transactionId: c.transactionId } : {}),
    ...(c.evseNumber != null ? { evseNumber: c.evseNumber } : {}),
    kind,
  };
}

async function publishPreparedCommand(
  pubsub: PubSubClient,
  command: PreparedLimitCommand,
  log: ServiceLogger,
): Promise<boolean> {
  // Never queued for an offline station: the limit would be stale on
  // reconnect, and the next cycle sends the current one (the station is
  // reserved while offline). Clears stay queued.
  try {
    await publishOcppCommand(pubsub, {
      stationId: command.stationId,
      action: 'SetChargingProfile',
      payload: command.payload,
      commandId: command.commandId,
      noQueue: true,
    });
    return true;
  } catch (err: unknown) {
    log.error(
      {
        err,
        stationId: command.stationId,
        ...(command.source.scope === 'evse'
          ? { evseId: command.source.command.limit.evseNumber }
          : command.source.scope === 'evseDefault'
            ? { evseId: command.source.command.value.evseNumber }
            : {}),
      },
      command.source.scope === 'station'
        ? 'Failed to dispatch SetChargingProfile'
        : command.source.scope === 'evse'
          ? 'Failed to dispatch the EVSE limit'
          : 'Failed to dispatch the EVSE default limit',
    );
    return false;
  }
}

/**
 * Remove the load management limit from stations it no longer manages (load
 * management turned off, the station left its circuit or the site). Returns
 * false when a publish failed.
 */
export async function clearLoadManagementProfiles(
  stationIds: readonly string[],
  log: ServiceLogger,
): Promise<boolean> {
  const pubsub = getPubSub();
  const unique = [...new Set(stationIds)];
  // Each station's profile id follows its MaxExternalConstraintsId.
  const maxExternalIds = new Map<string, string>();
  if (unique.length > 0) {
    try {
      const rows = await db
        .select({ stationId: chargingStations.stationId, value: stationConfigurations.value })
        .from(stationConfigurations)
        .innerJoin(chargingStations, eq(stationConfigurations.stationId, chargingStations.id))
        .where(
          and(
            inArray(chargingStations.stationId, unique),
            eq(stationConfigurations.variable, MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE),
            eq(stationConfigurations.attributeType, 'Actual'),
          ),
        );
      for (const row of rows) {
        if (row.value != null) maxExternalIds.set(row.stationId, row.value);
      }
    } catch (err: unknown) {
      // fail-open: clear by the default id; a station with a higher
      // MaxExternalConstraintsId answers Unknown and keeps its limit until
      // the next clear.
      log.warn({ err }, 'Reading MaxExternalConstraintsId failed, clearing by the default id');
    }
  }
  // The unit box defaults go too, by the id of each EVSE of a unit.
  const unitEvses = new Map<string, number[]>();
  if (unique.length > 0) {
    try {
      const rows = await db
        .select({ stationId: chargingStations.stationId, evseNumber: evses.evseId })
        .from(evses)
        .innerJoin(chargingStations, eq(evses.stationId, chargingStations.id))
        .where(and(inArray(chargingStations.stationId, unique), isNotNull(evses.unitId)));
      for (const row of rows) {
        unitEvses.set(row.stationId, [...(unitEvses.get(row.stationId) ?? []), row.evseNumber]);
      }
    } catch (err: unknown) {
      // fail-open: a default left at a station only lowers what its EVSE may draw.
      log.warn({ err }, 'Reading the unit EVSEs failed, their default limits are not cleared');
    }
  }
  // Both limits go: the load management profile and the credit profile
  // (security case 334; a station that holds no credit profile answers
  // Unknown for it).
  const results = await Promise.all(
    unique.flatMap((stationId) => {
      const profileId = loadManagementProfileId(maxExternalIds.get(stationId));
      const defaultIds = (unitEvses.get(stationId) ?? [])
        .map((evseNumber) => loadManagementDefaultProfileId(profileId, evseNumber))
        .filter((id): id is number => id != null);
      return [profileId, loadManagementCreditProfileId(profileId), ...defaultIds].map(
        async (chargingProfileId) => {
          try {
            await publishOcppCommand(pubsub, {
              stationId,
              action: 'ClearChargingProfile',
              payload: { chargingProfileId },
            });
            return true;
          } catch (err: unknown) {
            log.error(
              { err, stationId, chargingProfileId },
              'Failed to dispatch ClearChargingProfile',
            );
            return false;
          }
        },
      );
    }),
  );
  return results.every(Boolean);
}

async function broadcastLoadUpdate(pubsub: PubSubClient, siteId: string): Promise<void> {
  try {
    const event = JSON.stringify({
      eventType: 'load.updated',
      siteId,
      stationId: null,
      sessionId: null,
    });
    await pubsub.publish('csms_events', event);
  } catch (err) {
    logger.warn(
      { err, siteId },
      'Load update event publish failed, the dashboard refreshes on its next poll',
    );
  }
}

/**
 * The credit profile of one station for a send (security case 334): its limit
 * (`allocatedKw`) goes as the credit profile until `validTo`, and `baseKw` as
 * the load management profile, the limit once the credit profile ends.
 */
export interface CreditLimit {
  /** The limit without readings (stack level 1). */
  baseKw: number;
  /** The stack level 1 limit the station holds; absent: its last limit. */
  previousBaseKw?: number;
  /** End of the credit profile. */
  validTo: Date;
}

/** One SetChargingProfile of a send: a station limit, or its credit profile (`validTo`). */
export interface LimitCommand {
  allocation: AllocationResult;
  kw: number;
  /**
   * What the station enforces once it applies the profile, kW: `kw`, or for a
   * limit split per phase its busiest phase times three (`stationProfileWatts`).
   * The send orders and records it, so it compares with what the station may hold.
   */
  enforcedKw: number;
  /** The limit this profile replaces at the station; absent: none known. */
  previousKw?: number;
  validTo?: Date;
}

/**
 * The profiles of a send. A station without a credit limit gets its limit as
 * the load management profile. One with a credit limit gets the credit
 * profile (its limit, compared with the limit it holds now) and the load
 * management profile at `baseKw` (compared with the stack level 1 limit it
 * holds, which applies only after the credit profile ends). `creditOnly`
 * sends the credit profiles only (a refresh of their end).
 */
export function limitCommands(
  allocations: readonly AllocationResult[],
  previousKw: ReadonlyMap<string, number>,
  credit: ReadonlyMap<string, CreditLimit> = new Map(),
  creditOnly = false,
): LimitCommand[] {
  const commands: LimitCommand[] = [];
  const enforced = (allocation: AllocationResult, kw: number): number =>
    stationProfileWatts(kw, allocation.phaseWeights) / 1000;
  for (const allocation of allocations) {
    const before = previousKw.get(allocation.stationDbId);
    const limit = credit.get(allocation.stationDbId);
    const held = before != null ? { previousKw: before } : {};
    const kw = allocation.allocatedKw;
    if (limit == null) {
      if (!creditOnly)
        commands.push({ allocation, kw, enforcedKw: enforced(allocation, kw), ...held });
      continue;
    }
    commands.push({
      allocation,
      kw,
      enforcedKw: enforced(allocation, kw),
      validTo: limit.validTo,
      ...held,
    });
    if (creditOnly) continue;
    const baseBefore = limit.previousBaseKw ?? before;
    commands.push({
      allocation,
      kw: limit.baseKw,
      enforcedKw: enforced(allocation, limit.baseKw),
      ...(baseBefore != null ? { previousKw: baseBefore } : {}),
    });
  }
  return commands;
}

/**
 * How long a send waits for the stations to answer its cuts before it sends
 * its raises. A raise published right after a cut can reach its station
 * first (the cut waits behind another CALL of its station, or a slower
 * link), so for that moment the stations together hold more than the
 * capacity. Past this wait the raises are held for the next cycle.
 */
export const LOAD_MANAGEMENT_CUT_CONFIRM_MS = 5_000;

/** How often the worker runs the cycle for every enabled site. */
export const LOAD_MANAGEMENT_CYCLE_MS = 10_000;

class CutNotPublished extends Error {}

/**
 * True for a cut that lowers what its station may hold: a lower limit, or one
 * whose previous limit is unknown. An unchanged limit lowers nothing, so no
 * raise needs to wait for its answer.
 */
function lowersLimit(command: PreparedLimitCommand): boolean {
  const previousKw = command.source.command.previousKw;
  return previousKw == null || command.enforcedKw < previousKw - EPSILON_KW;
}

/**
 * Publishes one cut and waits for its station's answer. `published` settles
 * once the publish is done; `confirmed` once the station accepted it (true),
 * or refused it, did not answer in time or the publish failed (false). When
 * replies cannot be received (no pub/sub subscription) the cut is still
 * published, and counts as unconfirmed.
 */
function publishConfirmedCut(
  pubsub: PubSubClient,
  command: PreparedLimitCommand,
  log: ServiceLogger,
): { published: Promise<boolean>; confirmed: Promise<boolean> } {
  let markPublished: (sent: boolean) => void = () => undefined;
  const published = new Promise<boolean>((resolve) => {
    markPublished = resolve;
  });
  const state = { sendStarted: false };
  const confirmed = (async (): Promise<boolean> => {
    try {
      const reply = await awaitPubSubReply<{
        commandId: string;
        response?: Record<string, unknown>;
        error?: string;
      }>(pubsub, {
        replyChannel: OCPP_COMMAND_RESULTS_CHANNEL,
        commandId: command.commandId,
        timeoutMs: LOAD_MANAGEMENT_CUT_CONFIRM_MS,
        send: async () => {
          state.sendStarted = true;
          const sent = await publishPreparedCommand(pubsub, command, log);
          markPublished(sent);
          // A cut that was not published gets no answer: stop waiting at once.
          if (!sent) throw new CutNotPublished();
        },
      });
      if (reply == null) {
        log.warn(
          { stationId: command.stationId, commandId: command.commandId },
          'Load management limit cut not answered in time, raises held back',
        );
        return false;
      }
      // An answer can arrive before the publish call returns: it proves the publish.
      markPublished(true);
      return reply.error == null && reply.response?.['status'] === 'Accepted';
    } catch (err: unknown) {
      if (err instanceof CutNotPublished) return false;
      if (!state.sendStarted) {
        log.warn(
          { err, stationId: command.stationId },
          'Load management limit cut replies cannot be received, the cut is sent unconfirmed',
        );
        markPublished(await publishPreparedCommand(pubsub, command, log));
        return false;
      }
      log.error(
        { err, stationId: command.stationId },
        'Load management limit cut reply not read, raises held back',
      );
      return false;
    } finally {
      markPublished(false);
    }
  })();
  return { published, confirmed };
}

async function dispatchEvseLimitRelease(
  pubsub: PubSubClient,
  release: EvseLimitRelease,
  log: ServiceLogger,
): Promise<boolean> {
  try {
    // Not queued: a late clear could remove a TxProfile sent after it.
    await publishOcppCommand(pubsub, {
      stationId: release.stationId,
      action: 'ClearChargingProfile',
      payload: {
        chargingProfileId: chargingNeedsProfileId(release.stationId, release.transactionId),
      },
      noQueue: true,
    });
    return true;
  } catch (err: unknown) {
    log.error({ err, stationId: release.stationId }, 'Failed to clear the EVSE limit');
    return false;
  }
}

async function dispatchEvseDefaultRelease(
  pubsub: PubSubClient,
  release: EvseDefaultRelease,
  log: ServiceLogger,
): Promise<boolean> {
  try {
    // Not queued: a late clear could remove a default sent after it.
    await publishOcppCommand(pubsub, {
      stationId: release.stationId,
      action: 'ClearChargingProfile',
      payload: { chargingProfileId: release.chargingProfileId },
      noQueue: true,
    });
    return true;
  } catch (err: unknown) {
    log.error(
      { err, stationId: release.stationId, evseId: release.evseNumber },
      'Failed to clear the EVSE default limit',
    );
    return false;
  }
}

export interface AllocationSendOptions {
  /** Stations counted at a reservation (`AllocationSend.reservedStations`). */
  reserved?: ReadonlySet<string>;
  credit?: ReadonlyMap<string, CreditLimit>;
  creditOnly?: boolean;
  evse?: readonly EvseLimitCommand[];
  evseReleases?: readonly EvseLimitRelease[];
  evseDefaults?: readonly EvseDefaultCommand[];
  defaultReleases?: readonly EvseDefaultRelease[];
}

/**
 * Builds the SetChargingProfile commands of a send, each with its command id,
 * in the groups `dispatchAllocationSend` publishes them in, so the cycle can
 * log every limit before any goes out.
 */
export function prepareAllocationSend(
  allocations: readonly AllocationResult[],
  now: Date,
  rates: ReadonlyMap<string, StationRate> = new Map(),
  previousKw: ReadonlyMap<string, number> = new Map(),
  options: AllocationSendOptions = {},
): AllocationSend {
  const station = (command: LimitCommand): PreparedLimitCommand => {
    const rate = rates.get(command.allocation.stationDbId);
    return {
      stationId: command.allocation.stationId,
      stationDbId: command.allocation.stationDbId,
      commandId: randomUUID(),
      payload: buildLoadManagementProfile(
        stationProfileWatts(command.kw, command.allocation.phaseWeights),
        now,
        rate,
        command.validTo,
      ),
      kw: command.kw,
      enforcedKw: command.enforcedKw,
      source: { scope: 'station', command, rate },
    };
  };
  const evse = (command: EvseLimitCommand): PreparedLimitCommand => ({
    stationId: command.stationId,
    stationDbId: command.stationDbId,
    commandId: randomUUID(),
    payload: buildEvseLimitProfile(command.stationId, command.limit, command.rateUnit, now),
    kw: command.limit.limitKw,
    enforcedKw: command.limit.limitKw,
    source: { scope: 'evse', command },
  });
  const evseDefault = (command: EvseDefaultCommand): PreparedLimitCommand => ({
    stationId: command.stationId,
    stationDbId: command.stationDbId,
    commandId: randomUUID(),
    payload: buildEvseDefaultProfile(command.profileId, command.value, now),
    kw: command.value.limitKw,
    enforcedKw: command.value.limitKw,
    source: { scope: 'evseDefault', command },
  });
  const ordered = cutsBeforeRaises(
    limitCommands(allocations, previousKw, options.credit, options.creditOnly === true),
    (c) => c.enforcedKw,
  );
  // A reserved station's retry was fitted against every other station at what it
  // might enforce, so it goes out with the cuts, never held as a raise.
  const reserved = new Set(options.reserved ?? []);
  const isRetry = (c: LimitCommand): boolean => reserved.has(c.allocation.stationDbId);
  const cuts = [...ordered.cuts, ...ordered.raises.filter(isRetry)];
  const raises = ordered.raises.filter((c) => !isRetry(c));
  const evseOrder = cutsBeforeRaises(options.evse ?? [], (c) => c.limit.limitKw);
  const defaultOrder = cutsBeforeRaises(options.evseDefaults ?? [], (c) => c.value.limitKw);
  return {
    stationCuts: cuts.map(station),
    evseCuts: [...evseOrder.cuts.map(evse), ...defaultOrder.cuts.map(evseDefault)],
    evseRaises: [...evseOrder.raises.map(evse), ...defaultOrder.raises.map(evseDefault)],
    stationRaises: raises.map(station),
    releases: [...(options.evseReleases ?? [])],
    defaultReleases: [...(options.defaultReleases ?? [])],
    reservedStations: [...(options.reserved ?? [])],
  };
}

/**
 * Publishes a prepared send, then tells the dashboards. The order keeps every
 * station within its limit while the limits change: station limit cuts and
 * EVSE limit cuts, then (only after every cut a raise depends on was accepted,
 * and while this cycle still holds the site) EVSE limit raises and clears,
 * then station limit raises. The cuts a raise depends on are every cut of the
 * site that lowers a limit of a station not counted at a reservation (all of
 * them, not only those on the raise's path: a superset is never less safe).
 * Returns what it held back and which awaited cuts went unconfirmed, so the
 * caller moves their records to lost (`entriesAfterFailures`) and sends again on the next cycle.
 */
export async function dispatchAllocationSend(
  siteId: string,
  send: AllocationSend,
  log: ServiceLogger,
  hooks: AllocationSendHooks = {},
): Promise<AllocationSendOutcome> {
  const pubsub = getPubSub();
  const reserved = new Set(send.reservedStations);
  const failures: LimitSendFailure[] = [];
  const addFailure = (command: PreparedLimitCommand, kind: LimitSendFailure['kind']): void => {
    failures.push(sendFailure(command, kind));
  };

  // Within each group the publishes run in parallel: each is an independent
  // pub/sub publish, so serializing them adds (N * publish latency) of
  // needless delay at the end of every 10s control cycle.
  const publishAll = async (
    group: readonly PreparedLimitCommand[],
  ): Promise<PreparedLimitCommand[]> => {
    const results = await Promise.all(group.map((c) => publishPreparedCommand(pubsub, c, log)));
    return group.filter((_, i) => !results[i]);
  };
  const raiseCount =
    send.stationRaises.length +
    send.evseRaises.length +
    send.releases.length +
    send.defaultReleases.length;
  // With raises to follow, a cut that lowers a limit is confirmed by its
  // station first: a cut can wait behind another CALL of its station, so a
  // raise published after it could reach its own station first. A station
  // counted at a reservation, and a cut that lowers nothing, are not awaited.
  const unconfirmed: PreparedLimitCommand[] = [];
  const waits: Promise<void>[] = [];
  const cutGroup = async (
    group: readonly PreparedLimitCommand[],
  ): Promise<PreparedLimitCommand[]> => {
    if (raiseCount === 0) return publishAll(group);
    const pending = group.map((c) =>
      lowersLimit(c) && !reserved.has(c.stationDbId) ? publishConfirmedCut(pubsub, c, log) : null,
    );
    for (const [i, wait] of pending.entries()) {
      const command = group[i];
      if (wait == null || command == null) continue;
      waits.push(
        wait.confirmed.then((ok) => {
          if (!ok) unconfirmed.push(command);
        }),
      );
    }
    const published = await Promise.all(
      group.map((c, i) => pending[i]?.published ?? publishPreparedCommand(pubsub, c, log)),
    );
    return group.filter((_, i) => !published[i]);
  };
  const unpublishedCuts = [
    ...(await cutGroup(send.stationCuts)),
    ...(await cutGroup(send.evseCuts)),
  ];
  await Promise.all(waits);
  const unpublishedIds = new Set(unpublishedCuts.map((c) => c.commandId));
  for (const c of unpublishedCuts) addFailure(c, 'unpublished');
  for (const c of unconfirmed) if (!unpublishedIds.has(c.commandId)) addFailure(c, 'timeout');

  let raisesGo = unpublishedCuts.length === 0 && unconfirmed.length === 0;
  if (raiseCount > 0) {
    if (!raisesGo) {
      // A cut not published, refused or not answered in time leaves its station
      // above its new limit: no raise goes out on top of it.
      log.warn({ siteId, raiseCount }, 'Load management limit raises held back after a failed cut');
    } else if (hooks.holdRaises === true) {
      log.warn({ siteId, raiseCount }, 'Load management raises held back, energy assets unknown');
      raisesGo = false;
    } else if (hooks.beforeRaises == null && !(await loadManagementFenceHolds(client, siteId))) {
      // The waits can outlast this cycle's lease: a newer holder owns the site
      // then. The raise claim checks the fence inside its own transaction.
      log.warn({ siteId, raiseCount }, 'Load management raises held back, the site lock was lost');
      raisesGo = false;
    } else if (hooks.beforeRaises != null && !(await hooks.beforeRaises())) {
      log.warn({ siteId, raiseCount }, 'Load management raises held back, not recorded');
      raisesGo = false;
    }
  }

  const held: PreparedLimitCommand[] = [];
  const heldReleases: Array<EvseLimitRelease | EvseDefaultRelease> = [];
  if (raisesGo) {
    const evseUnpublished = await publishAll(send.evseRaises);
    const released = await Promise.all(
      send.releases.map((r) => dispatchEvseLimitRelease(pubsub, r, log)),
    );
    heldReleases.push(...send.releases.filter((_, i) => !released[i]));
    const defaultsReleased = await Promise.all(
      send.defaultReleases.map((r) => dispatchEvseDefaultRelease(pubsub, r, log)),
    );
    heldReleases.push(...send.defaultReleases.filter((_, i) => !defaultsReleased[i]));
    const stationUnpublished = await publishAll(send.stationRaises);
    // A publish error is ambiguous (the message may have reached the station):
    // a raise is counted at the higher of what it sent and what it held.
    for (const c of [...evseUnpublished, ...stationUnpublished]) {
      held.push(c);
      addFailure(c, 'timeout');
    }
  } else {
    held.push(...send.evseRaises, ...send.stationRaises);
    heldReleases.push(...send.releases, ...send.defaultReleases);
  }

  await broadcastLoadUpdate(pubsub, siteId);
  return {
    sent:
      raisesGo &&
      unpublishedCuts.length === 0 &&
      held.length === 0 &&
      heldReleases.length === 0 &&
      failures.length === 0,
    failures,
    heldCommandIds: [...unpublishedCuts, ...held].map((c) => ({
      stationDbId: c.stationDbId,
      commandId: c.commandId,
    })),
  };
}

export function allocationKey(entries: readonly AppliedAllocation[]): string {
  return JSON.stringify(
    [...entries]
      .map((a) => ({
        s: a.stationDbId,
        kw: Math.round(a.allocatedKw * 100),
        r: a.reserved === true,
        u: [...(a.rejectedUnits ?? [])].sort().join(','),
        b: a.allocatedBaseKw != null ? Math.round(a.allocatedBaseKw * 100) : null,
        w:
          a.phaseWeights != null
            ? [a.phaseWeights.L1, a.phaseWeights.L2, a.phaseWeights.L3].map((x) =>
                Math.round(x * 1000),
              )
            : null,
        e: [...(a.evses ?? [])]
          .map((e) => [
            e.transactionId,
            Math.round(e.limitKw * 100),
            e.limitA != null ? Math.round(e.limitA * 10) : null,
            e.phases,
            e.rateUnit,
            e.phaseToUse ?? null,
            e.phaseToUseRefused === true,
          ])
          .sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
        d: [...(a.evseDefaults ?? [])]
          .map((d) => [d.evseNumber, Math.round(d.limitKw * 100), d.rateUnit] as const)
          .sort((x, y) => x[0] - y[0]),
      }))
      .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)),
  );
}

/**
 * Unit and circuit of each managed station, for a limit in A: the circuit's
 * panel voltage and the conductor phases of the circuit. `rejected` holds the
 * units each station rejected (`sendRateUnit`).
 */
export function stationRates(
  nodes: readonly HierarchyNode[],
  rejected: ReadonlyMap<string, readonly ChargingRateUnit[]> = new Map(),
): Map<string, StationRate> {
  const rates = new Map<string, StationRate>();
  const walk = (list: readonly HierarchyNode[]): void => {
    for (const node of list) {
      if (node.type === 'circuit') {
        const phases = circuitConductorPhases(node.phaseConnections, node.phases);
        for (const station of node.stations) {
          rates.set(station.id, {
            rateUnit: sendRateUnit(station, rejected.get(station.id) ?? []),
            voltageV: node.voltageV,
            phases: station.singlePhaseOnThreePhase === true ? 1 : phases,
            profileId: station.profileId,
          });
        }
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return rates;
}

/**
 * The send pipeline of the safety spec: the first claim (fenced, row lock)
 * records the cuts as sends and logs every limit, after checking each cut
 * against the locked state; the cuts go out and the ones that lower a limit
 * are awaited; the second claim records the raises right before they go out;
 * the failures move their records to lost. Returns whether the first claim
 * wrote and what the send did.
 */
export async function runLimitSend(input: {
  siteId: string;
  applied: readonly AppliedAllocation[];
  send: AllocationSend;
  nowMs: number;
  appliedAt?: Date;
  header: LoadAllocationHeader;
  logEntries: readonly LoadAllocationEntryInput[];
  holdRaises: boolean;
  /** What the allocation counted each station at; the raise claim checks it again. */
  counted: ReadonlyMap<string, CountedLimit>;
  log: ServiceLogger;
  onLogFailure?: (err: unknown) => void;
}): Promise<{ claimed: boolean; outcome: AllocationSendOutcome | null }> {
  const { siteId, send, log, nowMs } = input;
  const retried = new Set(send.reservedStations);
  // A retry is fitted jointly, not checked as a cut against the station's own might.
  const cuts = [...send.stationCuts, ...send.evseCuts].map((c) =>
    c.source.scope === 'station' && retried.has(c.stationDbId)
      ? { ...limitSendCommand(c), retry: true as const }
      : limitSendCommand(c),
  );
  const raises = [...send.evseRaises, ...send.stationRaises].map(limitSendCommand);
  const releaseKeys = new Set([
    ...send.releases
      .filter((r) => r.stationDbId != null)
      .map((r) => `${r.stationDbId ?? ''}:${r.transactionId}`),
    ...send.defaultReleases.map((r) => defaultReleaseKey(r.stationDbId, r.evseNumber)),
  ]);
  let claimed: boolean;
  try {
    claimed = await claimAndLogAllocations({
      siteId,
      applied: input.applied,
      mergeLocked: (locked) => entriesForCuts(input.applied, locked, cuts, releaseKeys, nowMs),
      // A send with raises is complete only once the raise claim records them:
      // until then the next cycle (any worker) sends again.
      ...(input.appliedAt != null ? { appliedAt: raises.length > 0 ? null : input.appliedAt } : {}),
      ...(input.onLogFailure != null ? { onLogFailure: input.onLogFailure } : {}),
      header: input.header,
      entries: input.logEntries,
    });
  } catch (err: unknown) {
    if (!(err instanceof SendClassificationChanged)) throw err;
    log.info(
      { siteId, stationDbId: err.stationDbId },
      'Load management send ordered again next cycle: a station reply changed a cut into a raise',
    );
    return { claimed: false, outcome: null };
  }
  if (!claimed) return { claimed: false, outcome: null };
  // A cycle that lost its site lock after the claim sends nothing.
  if (!(await loadManagementFenceHolds(client, siteId))) return { claimed: true, outcome: null };
  const outcome = await dispatchAllocationSend(siteId, send, log, {
    holdRaises: input.holdRaises,
    beforeRaises: async () => {
      try {
        return await writeLoadManagementRecords(
          client,
          siteId,
          (locked) => entriesForRaises(locked, raises, releaseKeys, nowMs, input.counted),
          input.appliedAt != null ? { appliedAt: input.appliedAt } : {},
        );
      } catch (err: unknown) {
        if (err instanceof RaiseBasisChanged) {
          log.info(
            { siteId, stationDbId: err.stationDbId, reason: err.reason },
            'Load management raises held back: a station changed since the allocation, ordered again next cycle',
          );
          return false;
        }
        log.warn({ err, siteId }, 'Load management raises not recorded, held back');
        return false;
      }
    },
  });
  if (!outcome.sent) {
    try {
      await writeLoadManagementRecords(
        client,
        siteId,
        (locked) =>
          entriesAfterFailures(
            locked,
            outcome.failures,
            new Set(
              send.stationRaises
                .filter((c) => outcome.heldCommandIds.some((h) => h.commandId === c.commandId))
                .map((c) => c.stationDbId),
            ),
            nowMs,
          ),
        { nullAppliedAt: true },
      );
    } catch (err: unknown) {
      log.warn(
        { err, siteId },
        'Load management send failures not stored, the next cycle sends again',
      );
    }
    for (const held of outcome.heldCommandIds) {
      try {
        await recordAllocationEntryReply(client, held.stationDbId, held.commandId, 'not_sent');
      } catch (err: unknown) {
        log.warn(
          { err, siteId, stationDbId: held.stationDbId },
          'Recording a held limit on the load allocation log failed',
        );
      }
    }
  }
  return { claimed: true, outcome };
}
