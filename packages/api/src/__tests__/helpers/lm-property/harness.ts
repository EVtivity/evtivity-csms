// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The property test harness: one model site runs through real load
// management cycles (`runSiteLoadManagement`, both claims, the send, the
// fence) against an in-memory `site_load_management` row with a fence token,
// an OCPP server that queues each station's calls and times them out, the
// reply writer of the database package and the one rule of the other profile
// writers. The node, unit box and minimum checks read the station models
// only (what each station holds, the calls on their way to it, its cars);
// the counted check compares the CSMS records with the same models.

import {
  clearRemovesLoadManagementProfile,
  isLoadManagementCreditProfile,
  isLoadManagementProfile,
  clearRemovesDefaultProfiles,
  loadManagementProfileId,
  profileRateUnit,
} from '@evtivity/services/load-management-profiles';
import {
  LOAD_MANAGEMENT_CUT_CONFIRM_MS,
  LOAD_MANAGEMENT_CYCLE_MS,
  stationRates,
} from '@evtivity/services/load-management-send';
import { storedLimitsOf, allocateSite } from '@evtivity/services/load-management-site-allocation';
import {
  CREDIT_CLOCK_MARGIN_MS,
  mightEnforceInWatts,
  mightEnforceKw,
  parseAppliedAllocations,
} from '@evtivity/services/load-limit-entries';
import { runSiteLoadManagement } from '@evtivity/services/load-management.service';
import {
  type HierarchyNode,
  type StationPowerInfo,
} from '@evtivity/services/load-management-model';
import {
  allocationsAfterStationEvent,
  bootAddsEntry,
  type StationLimitEvent,
} from '@evtivity/database/src/lib/load-management-state.js';
import {
  currentLoadManagementFence,
  runWithLoadManagementFence,
} from '@evtivity/database/src/lib/load-management-fence.js';
import { chargingProfileClearCriteria } from '@evtivity/lib';
import { chargingNeedsProfileId } from '@evtivity/lib/charging-profile-ids';
import {
  WORST_FILLS,
  applyClear,
  applyProfile,
  actualDraws,
  carPanelPhases,
  cloneStation,
  enforcedStationKw,
  evseCapA,
  maxPhaseKw,
  maxTotalKw,
  maxUnitPhaseA,
  PHASE_VOLTAGE_V,
  PHASES,
  stationLimit,
  withNewCars,
  type ModelProfile,
  type ModelStation,
  type Phase,
  type PhaseKw,
} from './station-physics.js';
import {
  circuitKw,
  panelPhaseKw,
  SITE_ID,
  siteTree,
  stationStatus,
  type SiteSpec,
  type SolarState,
} from './site-model.js';

const EPS = 1e-6;
/** The OCPP server answers a CALL the station never answers after this long (MessageCorrelator). */
export const OCPP_CALL_TIMEOUT_MS = 30_000;
/** Unit boxes carry at most this share of their budget (I2). */
const UNIT_BOX_SHARE = 0.8;
/** The AC minimum per session (I3). */
const AC_MIN_A = 6;
/**
 * A station's clock may run this far behind the CSMS's, so a profile with a
 * validTo may still hold that long after it (the margin the CSMS keeps a
 * credit profile counted for).
 */
const STATION_CLOCK_LAG_MS = 60_000;

export type Answer = 'accept' | 'reject' | 'callError' | 'silentApplied' | 'silentDropped';

export interface StationScript {
  answers: Answer[];
  delaysMs: number[];
}

export interface Command {
  stationId: string;
  action: string;
  commandId?: string;
  payload: Record<string, unknown>;
}

/** The in-memory `site_load_management` row. */
export interface SiteRow {
  enabled: boolean;
  appliedAllocations: unknown;
  appliedAt: Date | null;
  /** `cycle_fence`: raised by every lock holder. */
  fence: number;
}

/** A stored copy of a profile the CSMS sent and the station accepted (`charging_profiles`, csms_set). */
export interface StoredProfileRow {
  stationId: string;
  profileData: Record<string, unknown>;
}

export interface Harness {
  row: SiteRow;
  models: ModelStation[];
  violations: string[];
  /** The stored accepted profiles the cycle reads for stations without a record. */
  storedRows: StoredProfileRow[];
  /** The calls on their way to each station (published, not yet run by it). */
  pending: Map<string, Command[]>;
  /** Command ids a station answered Accepted. */
  acceptedIds: Set<string>;
  /** Stations whose last answer to a station limit (stack level 1) was a refusal. */
  refusedLimit: Set<string>;
  /** Commands whose reply comes after the cycle's confirmation wait (lost for that cycle). */
  lateIds: Set<string>;
  /** The commands and answers of the case, for a violation message. */
  trace: string[];
  /** Command ids published in the running cycle. */
  cycleIds: Set<string>;
  /** Record changes that no command of the running cycle caused (a boot, a late reply). */
  foreignEvents: number;
  /** Claims and record writes a stale worker tried (refused by the row, as the database does). */
  staleAttempts: number;
  /** Credit profiles (stack level 2) the stations were sent. */
  creditSends: number;
  publish: (command: Command) => void;
  resultHandlers: Set<(raw: string) => void>;
}

/** The bus and database the test's module mocks route to: set per case. */
export const shared: { harness: Harness | null } = { harness: null };

/** True while the running worker may write and send: its fence is the row's and its lease holds. */
function fenceOk(h: Harness): boolean {
  const fence = currentLoadManagementFence(SITE_ID);
  if (fence == null) return true;
  return fence.signal?.aborted !== true && fence.fence === h.row.fence;
}

/** Fake `loadManagementFenceHolds`. */
export function fakeFenceHolds(): Promise<boolean> {
  const h = shared.harness;
  return Promise.resolve(h == null ? true : fenceOk(h));
}

/** Fake `claimAndLogAllocations`: the locked, fenced claim of the cycle. */
export function fakeClaim(input: {
  applied: unknown;
  mergeLocked?: (locked: unknown) => unknown;
  appliedAt?: Date;
}): Promise<boolean> {
  const h = shared.harness;
  if (h == null || !h.row.enabled) return Promise.resolve(false);
  if (!fenceOk(h)) {
    h.staleAttempts += 1;
    return Promise.resolve(false);
  }
  h.row.appliedAllocations =
    input.mergeLocked != null ? input.mergeLocked(h.row.appliedAllocations) : input.applied;
  if (input.appliedAt != null) h.row.appliedAt = input.appliedAt;
  return Promise.resolve(true);
}

/** Fake `writeLoadManagementRecords`: the records written under the row lock, fenced. */
export function fakeWrite(
  _sql: unknown,
  _siteId: string,
  build: (locked: unknown) => unknown[],
  options: { nullAppliedAt?: boolean } = {},
): Promise<boolean> {
  const h = shared.harness;
  if (h == null || !h.row.enabled) return Promise.resolve(false);
  if (!fenceOk(h)) {
    h.staleAttempts += 1;
    return Promise.resolve(false);
  }
  h.row.appliedAllocations = build(h.row.appliedAllocations);
  if (options.nullAppliedAt === true) h.row.appliedAt = null;
  return Promise.resolve(true);
}

/** The stored profile rows `storedLimitsOf` reads (the fake database's select). */
export function storedRowsOf(): StoredProfileRow[] {
  return shared.harness?.storedRows ?? [];
}

/**
 * I6 at every publish: a worker whose lease was lost, or that a newer holder
 * replaced, sends nothing.
 */
export function checkPublishFence(h: Harness, command: Command): void {
  const fence = currentLoadManagementFence(SITE_ID);
  if (fence == null) return;
  if (fence.signal?.aborted === true || fence.fence !== h.row.fence) {
    h.violations.push(
      `I6 stale worker (fence ${String(fence.fence)}, row ${String(h.row.fence)}, lease ${fence.signal?.aborted === true ? 'lost' : 'held'}) published ${command.action} to ${command.stationId} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
    );
  }
}

/** The station event writer of the database package on the in-memory row. */
export function applyEvent(h: Harness, model: ModelStation, event: StationLimitEvent): void {
  if (!h.row.enabled) return;
  const commandId = 'commandId' in event ? event.commandId : null;
  if (commandId == null || !h.cycleIds.has(commandId)) h.foreignEvents += 1;
  const hasStoredLimit =
    bootAddsEntry(h.row.appliedAllocations, model.id, event) &&
    h.storedRows.some(
      (r) => r.stationId === model.id && r.profileData['id'] === loadManagementProfileId(null),
    );
  const { next, changed, resend } = allocationsAfterStationEvent(
    h.row.appliedAllocations,
    { stationUuid: model.id, stationId: model.ocppId },
    event,
    { hasStoredLimit },
  );
  if (!changed) return;
  h.row.appliedAllocations = next;
  if (resend) h.row.appliedAt = null;
}

/** A station model's view of a SetChargingProfile payload. */
export function profileOf(payload: Record<string, unknown>): ModelProfile | null {
  const raw = payload['chargingProfile'];
  if (raw == null || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const schedule = (p['chargingSchedule'] as Array<Record<string, unknown>> | undefined)?.[0];
  const period = (
    schedule?.['chargingSchedulePeriod'] as Array<{ limit: number }> | undefined
  )?.[0];
  if (period == null || typeof p['id'] !== 'number') return null;
  const validTo = typeof p['validTo'] === 'string' ? Date.parse(p['validTo']) : undefined;
  return {
    id: p['id'],
    purpose: String(p['chargingProfilePurpose']),
    stackLevel: Number(p['stackLevel']),
    evseId: Number(payload['evseId'] ?? 0),
    ...(typeof p['transactionId'] === 'string' ? { transactionId: p['transactionId'] } : {}),
    unit: schedule?.['chargingRateUnit'] === 'A' ? 'A' : 'W',
    limit: period.limit,
    ...(validTo != null && Number.isFinite(validTo) ? { validToMs: validTo } : {}),
  };
}

/** A stack level above ChargeProfileMaxStackLevel, which the station refuses (Rejected). */
function aboveMaxStackLevel(model: ModelStation, profile: ModelProfile): boolean {
  return model.maxStackLevel != null && profile.stackLevel > model.maxStackLevel;
}

/** The station applies a SetChargingProfile: false when it refuses it (a TxProfile of no transaction). */
function stationTakes(model: ModelStation, profile: ModelProfile): boolean {
  if (profile.purpose !== 'TxProfile') return true;
  return [...model.cars.values()].some((c) => c.transactionId === profile.transactionId);
}

/** The stored copies after an accepted SetChargingProfile or ClearChargingProfile. */
function storeAccepted(h: Harness, model: ModelStation, command: Command): void {
  if (command.action === 'SetChargingProfile') {
    const raw = command.payload['chargingProfile'];
    if (raw == null || typeof raw !== 'object') return;
    const data: Record<string, unknown> = {
      ...(raw as Record<string, unknown>),
      evseId: command.payload['evseId'] ?? 0,
    };
    h.storedRows = h.storedRows.filter(
      (r) => !(r.stationId === model.id && r.profileData['id'] === data['id']),
    );
    h.storedRows.push({ stationId: model.id, profileData: data });
    return;
  }
  if (command.action !== 'ClearChargingProfile') return;
  const c = chargingProfileClearCriteria(command.payload);
  h.storedRows = h.storedRows.filter((r) => {
    if (r.stationId !== model.id) return true;
    const d = r.profileData;
    if (c.chargingProfileId != null) return d['id'] !== c.chargingProfileId;
    const match =
      (c.chargingProfilePurpose == null ||
        c.chargingProfilePurpose === d['chargingProfilePurpose']) &&
      (c.stackLevel == null || c.stackLevel === d['stackLevel']) &&
      (c.evseId == null || c.evseId === Number(d['evseId'] ?? 0));
    return !match;
  });
}

/** The projection's limit event for a SetChargingProfile result. */
function limitEventOf(
  command: Command,
  result: { accepted: boolean; notSent: boolean; txNotFound: boolean },
): StationLimitEvent | null {
  const raw = command.payload['chargingProfile'];
  if (raw == null || typeof raw !== 'object' || command.commandId == null) return null;
  const profile = raw as Record<string, unknown>;
  const transactionId =
    profile['chargingProfilePurpose'] === 'TxProfile' && profile['stackLevel'] === 1
      ? String(profile['transactionId'])
      : null;
  // The per-EVSE default (TxDefaultProfile, stack level 1) that holds a new session in its box.
  const defaultEvse =
    profile['chargingProfilePurpose'] === 'TxDefaultProfile' && profile['stackLevel'] === 1
      ? Number(command.payload['evseId'] ?? 0)
      : null;
  if (defaultEvse != null) {
    return result.notSent
      ? {
          type: 'notSent',
          commandId: command.commandId,
          transactionId: null,
          evseDefault: defaultEvse,
        }
      : {
          type: 'defaultReply',
          accepted: result.accepted,
          commandId: command.commandId,
          evseNumber: defaultEvse,
        };
  }
  const credit = isLoadManagementCreditProfile(profile);
  if (result.notSent) {
    if (transactionId == null && !credit && !isLoadManagementProfile(profile)) return null;
    return { type: 'notSent', commandId: command.commandId, transactionId, credit };
  }
  if (transactionId != null) {
    return !result.accepted && result.txNotFound
      ? { type: 'evseGone', transactionId }
      : {
          type: 'evseReply',
          accepted: result.accepted,
          commandId: command.commandId,
          transactionId,
        };
  }
  if (credit)
    return { type: 'creditReply', accepted: result.accepted, commandId: command.commandId };
  if (!isLoadManagementProfile(profile)) return null;
  const unit = profileRateUnit(profile);
  if (unit == null) return null;
  return { type: 'reply', accepted: result.accepted, commandId: command.commandId, unit };
}

/**
 * The OCPP server and the stations: each station takes its CALLs one at a time
 * in the order they were published, after its scripted delay; an unanswered
 * CALL times out, an offline station is answered at once (never queued), and a
 * CALL sent on a connection that dropped meanwhile never runs.
 */
export function createStations(
  h: Harness,
  scripts: Map<string, StationScript>,
  check: (moment: string) => void,
): (command: Command) => void {
  const busyUntil = new Map<string, number>();
  const steps = new Map<string, number>();
  const sendResult = (body: Record<string, unknown>): void => {
    const response = body['response'] as { status?: string } | undefined;
    h.trace.push(
      `  reply #${String(body['commandId']).slice(0, 4)} ${response?.status ?? String(body['error'])}`,
    );
    if (typeof body['commandId'] === 'string' && response?.status === 'Accepted') {
      h.acceptedIds.add(body['commandId']);
    }
    const raw = JSON.stringify(body);
    for (const handler of [...h.resultHandlers]) handler(raw);
  };
  const clock = (): string => String(Math.round((Date.now() % 1_000_000) / 100) / 10);
  const dropPending = (model: ModelStation, command: Command): void => {
    const list = h.pending.get(model.id) ?? [];
    h.pending.set(
      model.id,
      list.filter((c) => c !== command),
    );
  };
  return (command) => {
    const model = h.models.find((m) => m.ocppId === command.stationId);
    if (model == null) return;
    const commandId = command.commandId;
    {
      const traced = profileOf(command.payload);
      h.trace.push(
        `${clock()} ${command.stationId} ${command.action} ${traced == null ? '' : `${traced.purpose}@${String(traced.stackLevel)} e${String(traced.evseId)} ${String(traced.limit)}${traced.unit}`} ${model.online ? '' : 'offline'} #${(commandId ?? '').slice(0, 4)}`,
      );
    }
    const isSet = command.action === 'SetChargingProfile';
    if (!model.online) {
      // noQueue: the OCPP server answers an offline station's limit as not sent.
      if (commandId != null) sendResult({ commandId, error: 'Station offline', offline: true });
      if (isSet) {
        const event = limitEventOf(command, { accepted: false, notSent: true, txNotFound: false });
        if (event != null) applyEvent(h, model, event);
      }
      return;
    }
    h.pending.set(model.id, [...(h.pending.get(model.id) ?? []), command]);
    const connection = model.connection;
    const script = scripts.get(model.id) ?? { answers: ['accept'], delaysMs: [0] };
    const step = steps.get(model.id) ?? 0;
    steps.set(model.id, step + 1);
    const answer = script.answers[step % script.answers.length] ?? 'accept';
    const delay = script.delaysMs[step % script.delaysMs.length] ?? 0;
    const at = Math.max(Date.now() + delay, busyUntil.get(model.id) ?? 0);
    busyUntil.set(model.id, at);
    if (commandId != null && at - Date.now() >= LOAD_MANAGEMENT_CUT_CONFIRM_MS) {
      h.lateIds.add(commandId);
    }
    let answered = false;
    const timeout = setTimeout(() => {
      if (answered) return;
      answered = true;
      dropPending(model, command);
      if (commandId != null) sendResult({ commandId, error: 'No response', timedOut: true });
      if (isSet) {
        const event = limitEventOf(command, { accepted: false, notSent: true, txNotFound: false });
        if (event != null) applyEvent(h, model, event);
      }
    }, OCPP_CALL_TIMEOUT_MS);
    setTimeout(() => {
      dropPending(model, command);
      // A station that rebooted or went away meanwhile never ran the CALL.
      if (!model.online || model.connection !== connection) return;
      const nowMs = Date.now();
      let accepted = answer !== 'reject' && answer !== 'callError' && answer !== 'silentDropped';
      let txNotFound = false;
      if (isSet) {
        const profile = profileOf(command.payload);
        if (
          profile != null &&
          profile.stackLevel === 2 &&
          profile.purpose === 'ChargingStationMaxProfile'
        ) {
          h.creditSends += 1;
        }
        if (profile == null || aboveMaxStackLevel(model, profile)) accepted = false;
        else if (!stationTakes(model, profile)) {
          accepted = false;
          txNotFound = true;
        } else if (accepted) {
          applyProfile(model, profile);
          // A phase choice the car follows after a while, unless it refuses.
          const schedule = (
            (command.payload['chargingProfile'] as Record<string, unknown>)['chargingSchedule'] as
              | Array<Record<string, unknown>>
              | undefined
          )?.[0];
          const period = (
            schedule?.['chargingSchedulePeriod'] as Array<Record<string, unknown>> | undefined
          )?.[0];
          const phaseToUse = period?.['phaseToUse'];
          const car = [...model.cars.values()].find(
            (c) => c.transactionId === profile.transactionId,
          );
          if (
            car != null &&
            car.phases === 1 &&
            typeof phaseToUse === 'number' &&
            (phaseToUse === 1 || phaseToUse === 2 || phaseToUse === 3) &&
            !car.refusesSwitch
          ) {
            car.switchTo = { phase: phaseToUse, atMs: nowMs + 20_000 };
          }
          check(`${model.ocppId} applied ${command.action}`);
        }
      } else if (command.action === 'ClearChargingProfile' && accepted) {
        const c = chargingProfileClearCriteria(command.payload);
        applyClear(model, {
          id: c.chargingProfileId,
          purpose: c.chargingProfilePurpose,
          stackLevel: c.stackLevel,
          evseId: c.evseId,
        });
        check(`${model.ocppId} applied a clear`);
      }
      if (answer === 'silentApplied' || answer === 'silentDropped' || answered) return;
      answered = true;
      clearTimeout(timeout);
      if (commandId != null) {
        sendResult(
          answer === 'callError'
            ? { commandId, error: 'CALLERROR FormationViolation' }
            : {
                commandId,
                response: {
                  status: accepted ? 'Accepted' : 'Rejected',
                  ...(txNotFound ? { statusInfo: { reasonCode: 'TxNotFound' } } : {}),
                },
              },
        );
      }
      if (accepted) storeAccepted(h, model, command);
      if (isSet) {
        const sent = profileOf(command.payload);
        if (
          sent != null &&
          sent.purpose !== 'TxProfile' &&
          sent.evseId === 0 &&
          sent.stackLevel === 1
        ) {
          if (accepted) h.refusedLimit.delete(model.id);
          else h.refusedLimit.add(model.id);
        }
        const event = limitEventOf(command, { accepted, notSent: false, txNotFound });
        if (event != null) applyEvent(h, model, event);
      } else if (command.action === 'ClearChargingProfile' && accepted) {
        const c = chargingProfileClearCriteria(command.payload);
        if (clearRemovesLoadManagementProfile(c, loadManagementProfileId(null))) {
          applyEvent(h, model, { type: 'cleared' });
        }
        const defaults = clearRemovesDefaultProfiles(c, loadManagementProfileId(null));
        if (defaults === 'all' || defaults.length > 0) {
          applyEvent(h, model, { type: 'defaultsCleared', evseNumbers: defaults });
        }
      }
    }, at - Date.now());
  };
}

/** The station status and tree of a cycle, assembled from the models. */
export function cycleView(
  spec: SiteSpec,
  models: readonly ModelStation[],
  solar: SolarState,
  nowMs: number,
): { stations: StationPowerInfo[]; roots: HierarchyNode[]; energyAssets: 'read' | 'unknown' } {
  const stations = models.map((m) => stationStatus(m, nowMs));
  const { roots, energyAssets } = siteTree(spec, stations, solar, nowMs);
  return { stations, roots, energyAssets };
}

/**
 * The stored accepted load management profiles (base and credit) of each
 * station without a record, read the way the cycle reads them.
 */
export function storedProfiles(
  h: Harness,
  roots: readonly HierarchyNode[],
  stations: readonly StationPowerInfo[],
  nowMs: number,
): ReturnType<typeof storedLimitsOf> {
  const entries = parseAppliedAllocations(h.row.appliedAllocations) ?? [];
  const withEntry = new Set(entries.map((e) => e.stationDbId));
  return storedLimitsOf(
    stations.filter((s) => !withEntry.has(s.id)),
    stationRates(roots),
    nowMs,
  );
}

/**
 * One load management cycle of the model site, the real per-site cycle, run
 * by a worker holding `fence` (its lease ends when `signal` aborts).
 */
export async function runCycle(
  h: Harness,
  spec: SiteSpec,
  solar: SolarState,
  fence: { fence: number; signal: AbortSignal },
): Promise<void> {
  const nowMs = Date.now();
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  const site = {
    siteId: SITE_ID,
    strategy: spec.strategy,
    appliedAllocations: h.row.appliedAllocations,
    appliedAt: h.row.appliedAt,
  };
  await runWithLoadManagementFence({ siteId: SITE_ID, ...fence }, () =>
    runSiteLoadManagement(site, log, {
      allocate: async (previous) => {
        const view = cycleView(spec, h.models, solar, nowMs);
        const allocation = await allocateSite({
          siteId: SITE_ID,
          strategy: spec.strategy,
          hierarchy: view.roots,
          stations: view.stations,
          previous,
          storedLimits: await storedProfiles(h, view.roots, view.stations, nowMs),
          energyAssets: view.energyAssets,
          nowMs,
        });
        return { status: { totalDrawKw: 0, stations: view.stations }, ...allocation };
      },
      planOwnedSessions: () => Promise.resolve(new Set()),
      clearProfiles: () => Promise.resolve(true),
      planProfiles: () => Promise.resolve(),
      isEnabled: () => Promise.resolve(h.row.enabled),
      now: () => new Date(),
    }),
  );
}

/** The solar the transformer gets now: what the last fresh reading reported, else none. */
export function solarKw(solar: SolarState, nowMs: number): number {
  return solar.freshUntilMs != null && solar.freshUntilMs > nowMs ? solar.creditKw : 0;
}

interface NodeLoad {
  phase: PhaseKw;
  total: number;
}

function fail(
  h: Harness,
  what: string,
  load: number,
  cap: number,
  moment: string,
  detail: () => string,
): void {
  if (load > cap + 1e-3) {
    h.violations.push(
      `${what}: ${load.toFixed(3)} kW over ${cap.toFixed(3)} kW at ${moment} ${detail()} TRACE ${h.trace.slice(-40).join(' | ')}`,
    );
  }
}

/** Every node and phase of the site against the per-station loads (I1). */
function checkSiteNodes(
  h: Harness,
  spec: SiteSpec,
  solar: SolarState,
  loads: ReadonlyMap<string, NodeLoad>,
  label: string,
  moment: string,
): void {
  const nowMs = Date.now();
  const detail = (): string =>
    `${h.models.map(describeStation).join(' ')} pending ${describePending(h)} rows ${JSON.stringify(h.row.appliedAllocations)}`;
  const on = (circuit: ModelStation['circuit']): ModelStation[] =>
    h.models.filter((m) => m.circuit === circuit);
  const phase = (list: readonly ModelStation[], p: Phase): number =>
    list.reduce((s, m) => s + (loads.get(m.id)?.phase[p] ?? 0), 0);
  const threePhaseCap = circuitKw(spec.threePhaseBreakerA, 3) / 3;
  for (const p of PHASES) {
    fail(
      h,
      `${label} three-phase circuit ${p}`,
      phase(on('three'), p),
      threePhaseCap,
      moment,
      detail,
    );
  }
  fail(
    h,
    `${label} single-phase circuit`,
    phase(on('single'), 'L2'),
    circuitKw(spec.singlePhaseBreakerA, 1),
    moment,
    detail,
  );
  const own = spec.panelUnmanagedKw / 3;
  const sun = solarKw(solar, nowMs);
  for (const p of PHASES) {
    const load = phase(h.models, p) + own;
    fail(h, `${label} panel ${p}`, load, panelPhaseKw(spec), moment, detail);
    fail(h, `${label} transformer ${p}`, load, spec.transformerKw / 3 + sun / 3, moment, detail);
  }
  const total =
    h.models.reduce((s, m) => s + (loads.get(m.id)?.total ?? 0), 0) + spec.panelUnmanagedKw;
  fail(h, `${label} panel total`, total, spec.panelKw, moment, detail);
  fail(h, `${label} transformer total`, total, spec.transformerKw + sun, moment, detail);
}

/**
 * I1 now, from the station models: what the cars plugged in now can draw
 * under what each station holds, on every node and phase.
 */
export function checkNodes(h: Harness, spec: SiteSpec, solar: SolarState, moment: string): void {
  const nowMs = Date.now();
  const loads = new Map<string, NodeLoad>();
  for (const m of h.models) {
    loads.set(m.id, {
      phase: {
        L1: maxPhaseKw(m, 'L1', nowMs),
        L2: maxPhaseKw(m, 'L2', nowMs),
        L3: maxPhaseKw(m, 'L3', nowMs),
      },
      total: maxTotalKw(m, nowMs),
    });
  }
  checkSiteNodes(h, spec, solar, loads, 'I1 now', moment);
}

/** The calls of `m` that change what a new car may draw (station limits, defaults, clears). */
function pendingLimitCalls(h: Harness, m: ModelStation): Command[] {
  return (h.pending.get(m.id) ?? []).filter((c) => {
    if (c.action === 'ClearChargingProfile') return true;
    if (c.action !== 'SetChargingProfile') return false;
    const p = profileOf(c.payload);
    return p != null && p.purpose !== 'TxProfile' && p.purpose !== 'PriorityCharging';
  });
}

/**
 * The profile sets a station may hold from now on: what it holds, with any
 * of the calls on their way to it applied in order (each may run or not:
 * accepted, refused, lost).
 */
export function profileVariants(h: Harness, m: ModelStation): ModelProfile[][] {
  let variants: ModelProfile[][] = [m.profiles];
  for (const call of pendingLimitCalls(h, m).slice(-10)) {
    const next = new Map<string, ModelProfile[]>();
    for (const v of variants) {
      next.set(JSON.stringify(v), v);
      const copy = cloneStation({ ...m, profiles: v });
      if (call.action === 'ClearChargingProfile') {
        const c = chargingProfileClearCriteria(call.payload);
        applyClear(copy, {
          id: c.chargingProfileId,
          purpose: c.chargingProfilePurpose,
          stackLevel: c.stackLevel,
          evseId: c.evseId,
        });
      } else {
        const p = profileOf(call.payload);
        if (p != null) applyProfile(copy, p);
      }
      next.set(JSON.stringify(copy.profiles), copy.profiles);
    }
    variants = [...next.values()];
  }
  return variants;
}

/**
 * The most station `m` may draw from now on, per phase and in all: the
 * highest of every profile set it may hold, with a new car (no EVSE limit
 * yet) on every EVSE, three-phase or single-phase on any grid phase.
 */
export function worstLoad(h: Harness, m: ModelStation, nowMs: number): NodeLoad {
  const load: NodeLoad = { phase: { L1: 0, L2: 0, L3: 0 }, total: 0 };
  const clock = nowMs - STATION_CLOCK_LAG_MS;
  for (const profiles of profileVariants(h, m)) {
    for (const fill of WORST_FILLS) {
      const v = withNewCars({ ...m, profiles }, fill, nowMs);
      for (const p of PHASES) load.phase[p] = Math.max(load.phase[p], maxPhaseKw(v, p, clock));
      load.total = Math.max(load.total, maxTotalKw(v, clock));
    }
  }
  return load;
}

/**
 * I1 from the station models alone, at every moment: the highest limit each
 * station may enforce from what it holds and the calls on their way to it,
 * counted per phase by its physics (a single-phase car on one phase, a W
 * limit in full on any phase its cars may use, an A limit per phase, every
 * EVSE at a new car), fits every node and phase.
 */
export function checkCountedNodes(
  h: Harness,
  spec: SiteSpec,
  solar: SolarState,
  moment: string,
): void {
  const nowMs = Date.now();
  const loads = new Map(h.models.map((m) => [m.id, worstLoad(h, m, nowMs)]));
  checkSiteNodes(h, spec, solar, loads, 'I1 may draw', moment);
}

/**
 * I2 for a station limited per EVSE, from the station models: no unit box
 * carries more than 80 percent of its budget, now or from now on (a new car
 * on every EVSE under every profile set the station may hold). A station
 * limited as a whole has no per-box limit (owner decision 2 of 2026-11-24).
 */
export function checkUnits(h: Harness, moment: string): void {
  const nowMs = Date.now();
  for (const m of h.models) {
    if (m.balancing !== 'evse' || m.units.length === 0) continue;
    const variants = profileVariants(h, m);
    for (const unit of m.units) {
      const capA = unit.budgetA * UNIT_BOX_SHARE;
      for (const p of PHASES) {
        let worst = maxUnitPhaseA(m, unit.id, p, nowMs);
        for (const profiles of variants) {
          for (const fill of WORST_FILLS) {
            const v = withNewCars({ ...m, profiles }, fill, nowMs);
            worst = Math.max(worst, maxUnitPhaseA(v, unit.id, p, nowMs - STATION_CLOCK_LAG_MS));
          }
        }
        if (worst > capA + 0.05) {
          h.violations.push(
            `I2 ${m.ocppId} ${unit.id} ${p}: ${worst.toFixed(2)} A over ${capA.toFixed(2)} A at ${moment} ${describeStation(m)} pending ${describePending(h)} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
          );
        }
      }
    }
  }
}

/** The highest station limit `m` may enforce from now on, kW in the CSMS terms; null: none. */
function mayEnforceKw(h: Harness, m: ModelStation, nowMs: number): number | null {
  let most: number | null = 0;
  for (const profiles of profileVariants(h, m)) {
    const kw = enforcedStationKw({ ...m, profiles }, nowMs - STATION_CLOCK_LAG_MS);
    if (kw == null) return null;
    most = Math.max(most, kw);
  }
  return most;
}

/**
 * I4 corollary and I7: what the CSMS counts each station at (its record, or
 * the stored profile of a station without one) never lies below what the
 * station may enforce, the calls on their way included; and each EVSE record
 * counts its EVSE at least at what its transaction's limit lets it draw.
 */
export async function checkCounted(
  h: Harness,
  spec: SiteSpec,
  solar: SolarState,
  moment: string,
): Promise<void> {
  const nowMs = Date.now();
  const entries = parseAppliedAllocations(h.row.appliedAllocations) ?? [];
  const view = cycleView(spec, h.models, solar, nowMs);
  const stored = await storedProfiles(h, view.roots, view.stations, nowMs);
  for (const m of h.models) {
    const entry = entries.find((e) => e.stationDbId === m.id);
    const might = mightEnforceKw(entry, { nowMs, storedLimit: stored.get(m.id) ?? null });
    const enforced = mayEnforceKw(h, m, nowMs);
    if (might != null && (enforced == null || enforced > might + 1e-3)) {
      h.violations.push(
        `I4 ${m.ocppId} (${entry == null ? (stored.has(m.id) ? 'profiled' : 'no record') : entry.limit.state}): counted at ${might.toFixed(3)} kW, may enforce ${enforced == null ? 'no limit' : `${enforced.toFixed(3)} kW`} at ${moment} ${describeStation(m)} pending ${describePending(h)} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
      );
    }
    for (const evse of entry?.evses ?? []) {
      if (evse.limit == null) continue;
      const kw = evse.limit.state === 'unknown' ? null : mightEvse(evse);
      if (kw == null) continue;
      const evseModel = m.evses.find((e) => e.number === evse.evseNumber);
      const car = evseModel != null ? m.cars.get(evseModel.number) : undefined;
      if (evseModel == null || car == null || car.transactionId !== evse.transactionId) continue;
      const capKw =
        (evseCapA(m, evseModel, car, nowMs) *
          PHASE_VOLTAGE_V *
          carPanelPhases(m, evseModel, car).length) /
        1000;
      // The EVSE limit holds only below the station limit; compare when the TxProfile binds.
      const stationKw = enforcedStationKw(m, nowMs);
      if (capKw > kw + 0.1 && (stationKw == null || stationKw > kw + 0.1)) {
        h.violations.push(
          `I7 ${m.ocppId} EVSE ${String(evse.evseNumber)}: counted at ${kw.toFixed(3)} kW, may draw ${capKw.toFixed(3)} kW at ${moment}`,
        );
      }
    }
  }
}

function mightEvse(evse: {
  limit?: { state: string; mightKw: number | null; sentKw?: number };
}): number | null {
  const r = evse.limit;
  if (r == null) return null;
  if (r.state === 'awaiting') return r.mightKw == null ? null : Math.max(r.mightKw, r.sentKw ?? 0);
  return r.mightKw;
}

/** A limit in A per phase on the station's circuit, or null for a W limit. */
function limitA(p: ModelProfile | null): number | null {
  return p == null || p.unit !== 'A' ? null : p.limit;
}

/** The TxProfile limit an EVSE's session holds, kW; null: none. */
function txKw(m: ModelStation, evseNumber: number, nowMs: number): number | null {
  const car = m.cars.get(evseNumber);
  const evse = m.evses.find((e) => e.number === evseNumber);
  if (car == null || evse == null) return null;
  const tx = m.profiles
    .filter(
      (p) =>
        p.purpose === 'TxProfile' &&
        p.transactionId === car.transactionId &&
        (p.validToMs == null || p.validToMs > nowMs),
    )
    .sort((a, b) => b.stackLevel - a.stackLevel)[0];
  if (tx == null) return null;
  return tx.unit === 'W'
    ? tx.limit / 1000
    : (tx.limit * PHASE_VOLTAGE_V * carPanelPhases(m, evse, car).length) / 1000;
}

/**
 * I3, after a cycle in which every station answered: every charging session
 * gets at least its minimum (its station's `load_min_power_kw`, 6 A for an AC
 * session) when every node on its path has room for the minimums of all
 * sessions on it; otherwise only the lowest priority sessions are paused,
 * never a higher one before a lower one. Room is counted conservatively
 * (each minimum in full on every phase it may use, a station without a
 * session at the most it may draw), so a node with room has room however
 * the cars sit.
 */
export function checkMinimums(h: Harness, spec: SiteSpec, solar: SolarState, moment: string): void {
  const nowMs = Date.now();
  const charging = h.models.filter((m) => m.online && m.cars.size > 0);
  if (charging.length === 0) return;
  // Minimum of a charging station, kW, and the 6 A floor of its AC sessions.
  const minimum = new Map<string, number>();
  for (const m of charging) {
    // The minimum is capped only by a maximum the station reported (every EVSE rated):
    // a minimum above what a circuit carries pauses the station.
    const maxKw = m.evses.every((e) => e.reportedKw != null)
      ? m.evses.reduce((s, e) => s + (e.reportedKw ?? 0), 0)
      : Number.POSITIVE_INFINITY;
    // The station shares its limit at one current between its sessions, DC
    // too, so the AC sessions reach 6 A only when every session does.
    let floorKw = 0;
    let acFloorKw = 0;
    for (const [n, car] of m.cars) {
      const evse = m.evses.find((e) => e.number === n);
      if (evse == null) continue;
      const kw = (AC_MIN_A * PHASE_VOLTAGE_V * carPanelPhases(m, evse, car).length) / 1000;
      floorKw += kw;
      if (evse.kind === 'ac') acFloorKw += kw;
    }
    if (acFloorKw === 0 || m.balancing === 'evse') floorKw = acFloorKw;
    minimum.set(m.id, Math.max(Math.min(m.minPowerKw, maxKw), floorKw));
  }
  // A station whose last station limit answer was a refusal counts at its maximum, as the
  // CSMS must count it ("Refused(H): max(H, station maximum)"): the station maximum when
  // every EVSE is rated, else its circuit; in full on every phase when it takes W only.
  const refusedLoad = (m: ModelStation): NodeLoad => {
    const total = m.evses.every((e) => e.reportedKw != null)
      ? m.evses.reduce((s, e) => s + (e.reportedKw ?? 0), 0)
      : m.circuit === 'three'
        ? circuitKw(spec.threePhaseBreakerA, 3)
        : circuitKw(spec.singlePhaseBreakerA, 1);
    const perPhase = m.circuit === 'single' || !m.reportedUnits.includes('A') ? total : total / 3;
    return { phase: { L1: perPhase, L2: perPhase, L3: perPhase }, total };
  };
  const loadOf = (m: ModelStation): NodeLoad => {
    const worst = worstLoad(h, m, nowMs);
    if (!h.refusedLimit.has(m.id)) return worst;
    const refused = refusedLoad(m);
    return {
      phase: {
        L1: Math.max(worst.phase.L1, refused.phase.L1),
        L2: Math.max(worst.phase.L2, refused.phase.L2),
        L3: Math.max(worst.phase.L3, refused.phase.L3),
      },
      total: Math.max(worst.total, refused.total),
    };
  };
  // An idle station counts at least as the CSMS must count the limit it holds,
  // from what the CSMS knows: a W limit or a single-phase circuit in full on a
  // phase, an A limit a third, an EVSE rating only when the station reported it.
  const entries = new Map(
    (parseAppliedAllocations(h.row.appliedAllocations) ?? []).map((e) => [e.stationDbId, e]),
  );
  const countedLoad = (m: ModelStation): NodeLoad => {
    const worst = loadOf(m);
    const entry = entries.get(m.id);
    const kw = entry == null ? null : mightEnforceKw(entry, { nowMs });
    if (kw == null) return worst;
    const inFull = m.circuit === 'single' || mightEnforceInWatts(entry, { nowMs });
    const perPhase = inFull ? kw : kw / 3;
    return {
      phase: {
        L1: Math.max(worst.phase.L1, perPhase),
        L2: Math.max(worst.phase.L2, perPhase),
        L3: Math.max(worst.phase.L3, perPhase),
      },
      total: Math.max(worst.total, kw),
    };
  };
  const idle = new Map(
    h.models.filter((m) => !charging.includes(m)).map((m) => [m.id, countedLoad(m)]),
  );
  // The nodes and their stations: [name, stations on it, capacity, whether per phase].
  // Solar counts only while a credit profile can still go out on it: one
  // clock margin before the reading ends, more than one cycle ahead.
  const sun =
    solar.freshUntilMs != null &&
    solar.freshUntilMs - CREDIT_CLOCK_MARGIN_MS - nowMs > LOAD_MANAGEMENT_CYCLE_MS
      ? solarKw(solar, nowMs)
      : 0;
  const nodes: Array<{
    name: string;
    ids: Set<string>;
    capKw: number;
    perPhase: boolean;
    fixedKw: number;
    /** The floor a box node owes its own sessions; the station minimum otherwise. */
    needKw?: number;
  }> = [];
  const ids = (list: readonly ModelStation[]): Set<string> => new Set(list.map((m) => m.id));
  const three = h.models.filter((m) => m.circuit === 'three');
  const single = h.models.filter((m) => m.circuit === 'single');
  const idleOn = (list: readonly ModelStation[], perPhase: boolean): number =>
    list.reduce((s, m) => {
      const load = idle.get(m.id);
      if (load == null) return s;
      return s + (perPhase ? Math.max(load.phase.L1, load.phase.L2, load.phase.L3) : load.total);
    }, 0);
  nodes.push({
    name: 'three-phase circuit',
    ids: ids(three),
    capKw: circuitKw(spec.threePhaseBreakerA, 3) / 3,
    perPhase: true,
    fixedKw: idleOn(three, true),
  });
  nodes.push({
    name: 'single-phase circuit',
    ids: ids(single),
    capKw: circuitKw(spec.singlePhaseBreakerA, 1),
    perPhase: true,
    fixedKw: idleOn(single, true),
  });
  nodes.push({
    name: 'panel phase',
    ids: ids(h.models),
    capKw: panelPhaseKw(spec),
    perPhase: true,
    fixedKw: idleOn(h.models, true) + spec.panelUnmanagedKw / 3,
  });
  nodes.push({
    name: 'panel',
    ids: ids(h.models),
    capKw: spec.panelKw,
    perPhase: false,
    fixedKw: idleOn(h.models, false) + spec.panelUnmanagedKw,
  });
  nodes.push({
    name: 'transformer phase',
    ids: ids(h.models),
    capKw: spec.transformerKw / 3 + sun / 3,
    perPhase: true,
    fixedKw: idleOn(h.models, true) + spec.panelUnmanagedKw / 3,
  });
  nodes.push({
    name: 'transformer',
    ids: ids(h.models),
    capKw: spec.transformerKw + sun,
    perPhase: false,
    fixedKw: idleOn(h.models, false) + spec.panelUnmanagedKw,
  });
  // A box whose EVSE ratings exceed its budget holds the station limit (single-phase worst
  // case), in either balancing mode: the box bound covers stations limited as a whole too.
  for (const m of charging) {
    for (const unit of m.units) {
      const ratedA = m.evses.filter((e) => e.unitId === unit.id).reduce((s, e) => s + e.ratingA, 0);
      if (ratedA <= unit.budgetA * UNIT_BOX_SHARE + EPS) continue;
      // The box owes 6 A to its own cars: one of them for a station limited per EVSE.
      const boxCars = [...m.cars].filter(
        ([n]) => m.evses.find((e) => e.number === n)?.unitId === unit.id,
      );
      const carFloors = boxCars.map(([n, car]) => {
        const evse = m.evses.find((e) => e.number === n);
        return evse == null
          ? 0
          : (AC_MIN_A * PHASE_VOLTAGE_V * carPanelPhases(m, evse, car).length) / 1000;
      });
      nodes.push({
        // A station limited as a whole has its whole limit capped at the box, so the box
        // owes its whole minimum. One limited per EVSE owes the box's own largest car
        // floor, and its own minimum when every car is in the box.
        needKw:
          m.balancing === 'evse'
            ? Math.max(boxCars.length === m.cars.size ? m.minPowerKw : 0, 0, ...carFloors)
            : (minimum.get(m.id) ?? 0),
        name: `box ${unit.id}`,
        ids: new Set([m.id]),
        capKw: (unit.budgetA * UNIT_BOX_SHARE * PHASE_VOLTAGE_V) / 1000,
        perPhase: true,
        fixedKw: 0,
      });
    }
  }
  // A total node counts a minimum as the station limit that delivers it: an A
  // limit spread over three phases reaches a car only on its own phases (a
  // station alone on its circuit has its limit split onto them).
  const alone = (m: ModelStation): boolean =>
    h.models.filter((x) => x.circuit === m.circuit).length === 1;
  const limitTermsKw = (m: ModelStation): number => {
    const min = minimum.get(m.id) ?? 0;
    if (m.circuit !== 'three' || !m.reportedUnits.includes('A') || alone(m)) return min;
    const used = new Set<Phase>();
    for (const [n, car] of m.cars) {
      const evse = m.evses.find((e) => e.number === n);
      if (evse != null) for (const p of carPanelPhases(m, evse, car)) used.add(p);
    }
    return used.size > 0 ? (min * 3) / used.size : min;
  };
  const needOn = (node: (typeof nodes)[number]): number =>
    node.needKw ??
    charging
      .filter((m) => node.ids.has(m.id))
      .reduce((s, m) => s + (node.perPhase ? (minimum.get(m.id) ?? 0) : limitTermsKw(m)), 0);
  const fullNodes = nodes.filter((node) => needOn(node) + node.fixedKw > node.capKw + 1e-3);
  // Solar counts only for a station that takes a credit profile; the others
  // get their limit without readings.
  const sunOf = (node: (typeof nodes)[number]): number =>
    node.name === 'transformer' ? sun : node.name === 'transformer phase' ? sun / 3 : 0;
  const fullWithoutSun = nodes.filter(
    (node) => needOn(node) + node.fixedKw > node.capKw - sunOf(node) + 1e-3,
  );
  // What each charging station and session gets now, from what it holds.
  const paused = new Set<string>();
  for (const m of charging) {
    const limit = stationLimit(m, nowMs);
    const stationKw = enforcedStationKw(m, nowMs);
    const a = limitA(limit);
    const hasAc = [...m.cars.keys()].some(
      (n) => m.evses.find((e) => e.number === n)?.kind === 'ac',
    );
    if (a != null && a > 0.05 && a < AC_MIN_A - 0.05 && hasAc) {
      h.violations.push(
        `I3 ${m.ocppId}: station limit ${a.toFixed(2)} A below the 6 A minimum at ${moment} ${describeStation(m)} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
      );
    }
    let gets = stationKw ?? Number.POSITIVE_INFINITY;
    let sessionPaused = false;
    if (m.balancing === 'evse') {
      let sum = 0;
      let bound = true;
      for (const [n] of m.cars) {
        const kw = txKw(m, n, nowMs);
        if (kw == null) {
          bound = false;
          continue;
        }
        sum += kw;
        const evse = m.evses.find((e) => e.number === n);
        const car = m.cars.get(n);
        if (evse != null && car != null && evse.kind === 'ac' && kw > 0.05) {
          const phases = carPanelPhases(m, evse, car).length;
          const ampsA = (kw * 1000) / (PHASE_VOLTAGE_V * phases);
          if (ampsA < AC_MIN_A - 0.05) {
            h.violations.push(
              `I3 ${m.ocppId} EVSE ${String(n)}: EVSE limit ${ampsA.toFixed(2)} A below the 6 A minimum at ${moment} ${describeStation(m)} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
            );
          }
        }
        if (kw < 0.05) sessionPaused = true;
      }
      if (bound) gets = Math.min(gets, sum);
    } else {
      // The station shares its limit over its sessions (review M3): each AC
      // session gets its 6 A floor on its own phases, and the station's minimum
      // is met by what the cars draw, not by the station limit in kW.
      const draws = actualDraws(m, nowMs);
      let drawnKw = 0;
      for (const [n, d] of draws) {
        drawnKw += d.kw;
        const evse = m.evses.find((e) => e.number === n);
        if (evse?.kind !== 'ac') continue;
        if (d.a < 0.05) sessionPaused = true;
        else if (d.a < AC_MIN_A - 0.05) {
          h.violations.push(
            `I3 ${m.ocppId} EVSE ${String(n)}: session gets ${d.a.toFixed(2)} A of its station limit, below the 6 A minimum at ${moment} ${describeStation(m)} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
          );
        }
      }
      if (stationKw != null) gets = Math.min(gets, drawnKw);
    }
    if (gets < 0.05 || sessionPaused) {
      paused.add(m.id);
      continue;
    }
    // The minimum never asks for more than the cars can draw: each car at its
    // EVSE current on its own phases (a DC session at its EVSE rating).
    let drawableKw = 0;
    for (const [n, car] of m.cars) {
      const evse = m.evses.find((e) => e.number === n);
      if (evse == null) continue;
      drawableKw +=
        evse.kind === 'ac'
          ? (Math.min(evse.ratingA, car.maxA) *
              PHASE_VOLTAGE_V *
              carPanelPhases(m, evse, car).length) /
            1000
          : evse.ratingKw;
    }
    // Nor more than its circuit carries on the panel phases its cars charge on.
    const phaseCapKw =
      m.circuit === 'three'
        ? circuitKw(spec.threePhaseBreakerA, 3) / 3
        : circuitKw(spec.singlePhaseBreakerA, 1);
    const demandOn = new Map<Phase, number>();
    for (const [n, car] of m.cars) {
      const evse = m.evses.find((e) => e.number === n);
      if (evse == null) continue;
      const phases = carPanelPhases(m, evse, car);
      const perPhaseKw =
        evse.kind === 'ac'
          ? (Math.min(evse.ratingA, car.maxA) * PHASE_VOLTAGE_V) / 1000
          : evse.ratingKw / phases.length;
      for (const p of phases) demandOn.set(p, (demandOn.get(p) ?? 0) + perPhaseKw);
    }
    const attainableKw = [...demandOn.values()].reduce((s, d) => s + Math.min(d, phaseCapKw), 0);
    // An own minimum the phases cannot carry is out of reach (the CSMS knows
    // no wiring): then only the 6 A floors are owed, checked per session above.
    const required =
      m.minPowerKw > attainableKw + 1e-6
        ? 0
        : Math.min(
            m.minPowerKw,
            m.evses.reduce((s, e) => s + e.ratingKw, 0),
            drawableKw,
          );
    if (required > 0 && gets < required - 0.1) {
      h.violations.push(
        `I3 ${m.ocppId}: gets ${gets.toFixed(3)} kW, below its minimum ${required.toFixed(3)} kW at ${moment} ${describeStation(m)} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
      );
    }
  }
  for (const id of paused) {
    const m = charging.find((x) => x.id === id);
    if (m == null) continue;
    // A station with no minimum is owed nothing above 0 when the priority
    // strategy gives every kW to higher priorities first.
    if ((minimum.get(id) ?? 0) <= 0 && spec.strategy === 'priority_based') continue;
    const takesCredit = m.maxStackLevel == null || m.maxStackLevel >= 2;
    const full = (takesCredit ? fullNodes : fullWithoutSun).filter((node) => node.ids.has(id));
    if (full.length === 0) {
      h.violations.push(
        `I3 ${m.ocppId}: a session paused while every node on its path has room for the minimums at ${moment} minimums ${JSON.stringify(Object.fromEntries(minimum))} ${h.models.map(describeStation).join(' ')} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
      );
      continue;
    }
    // A box of its own, or any node its minimum does not fit alone, pauses it
    // whatever the others get.
    if (full.some((node) => node.name.startsWith('box ') && node.ids.size === 1)) continue;
    const alone = minimum.get(id) ?? 0;
    if (full.some((node) => alone + node.fixedKw > node.capKw + 1e-3)) continue;
    for (const q of charging) {
      if (paused.has(q.id) || q.loadPriority >= m.loadPriority) continue;
      if (!full.some((node) => node.ids.has(q.id))) continue;
      h.violations.push(
        `I3 ${m.ocppId} (priority ${String(m.loadPriority)}) paused before ${q.ocppId} (priority ${String(q.loadPriority)}) on ${full.map((n) => n.name).join(', ')} at ${moment} ${h.models.map(describeStation).join(' ')} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
      );
    }
  }
}

/** A station model in one line: its profiles and cars, for a violation message. */
export function describeStation(m: ModelStation): string {
  const profiles = m.profiles
    .map(
      (p) =>
        `${p.purpose}@${String(p.stackLevel)}#${String(p.id)} e${String(p.evseId)} ${p.transactionId ?? ''} ${String(p.limit)}${p.unit}${p.validToMs != null ? ` to ${String(p.validToMs)}` : ''}`,
    )
    .join(', ');
  const cars = [...m.cars.entries()]
    .map(
      ([n, c]) =>
        `e${String(n)}:${c.transactionId} ${String(c.phases)}ph p${String(c.evsePhase)} ${String(c.maxA)}A`,
    )
    .join(', ');
  return `{${m.ocppId} ${m.protocol} ${m.circuit} ${m.balancing} prio${String(m.loadPriority)} min${String(m.minPowerKw)} ${m.online ? 'on' : 'off'} units[${m.units.map((u) => `${u.id} ${String(u.budgetA)}A ${String(u.phases)}ph`).join(',')}] evses[${m.evses.map((e) => `${String(e.number)}:${e.kind} ${String(e.ratingA)}A ${e.unitId ?? '-'} ${e.wiring.join('')}`).join(',')}] profiles[${profiles}] cars[${cars}]}`;
}

function describePending(h: Harness): string {
  return [...h.pending]
    .filter(([, list]) => list.length > 0)
    .map(
      ([id, list]) =>
        `${id}:[${list
          .map((c) => {
            const p = profileOf(c.payload);
            return `${c.action}${p == null ? '' : ` ${p.purpose}@${String(p.stackLevel)} ${String(p.limit)}${p.unit}`}`;
          })
          .join(',')}]`,
    )
    .join(' ');
}

export { EPS, chargingNeedsProfileId };
