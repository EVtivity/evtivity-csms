// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * What the CSMS knows about one load management limit at a station (the
 * station limit at stack level 1, or the TxProfile of one transaction): the
 * state machine of the load management safety spec. Pure: the cycle, the
 * station reply writers and the send outcome use the same transitions.
 *
 * - `unknown`: no limit of ours is known to hold (never sent, a boot, a
 *   cleared profile, a lost send with nothing known before): unlimited.
 * - `profiled`: no record, but the stored accepted profile holds `mightKw`.
 * - `awaiting`: `sentKw` went out as `commandId` and has no reply yet; the
 *   station may hold it or anything up to `mightKw` from before.
 * - `accepted`: the reply to `commandId` accepted `sentKw`.
 * - `lost`: the send got no reply or was never published; the station may
 *   hold up to `mightKw` (null: unlimited).
 * - `refused`: the station refused the send and may run without our limit.
 */
export type LimitState = 'unknown' | 'profiled' | 'awaiting' | 'accepted' | 'lost' | 'refused';

export const LIMIT_STATES: readonly LimitState[] = [
  'unknown',
  'profiled',
  'awaiting',
  'accepted',
  'lost',
  'refused',
];

export interface LimitRecord {
  state: LimitState;
  /** The command of the last send; a reply changes the record only for it. */
  commandId?: string;
  /** The limit of the last send, in kW. */
  sentKw?: number;
  /** The highest limit the station might hold apart from `sentKw`; null: unlimited. */
  mightKw: number | null;
  /** `sentKw` went out as a W limit. */
  sentInW?: true;
  /** `mightKw` may be a W limit. */
  mightInW?: true;
}

export type LimitEvent =
  /** `watts`: the limit goes out in W (a W limit may land in full on one phase). */
  | { type: 'send'; commandId: string; kw: number; watts?: boolean }
  | { type: 'accepted'; commandId: string }
  | { type: 'rejected'; commandId: string }
  /** The confirmation wait ended without a reply, or the OCPP server reports no answer. */
  | { type: 'timeout'; commandId: string }
  /** The publish failed: the station never saw the command. */
  | { type: 'unpublished'; commandId: string }
  /** The station booted: profiles it held may be gone. */
  | { type: 'boot' }
  /** A clear of the load management profile was accepted. */
  | { type: 'cleared' };

export const UNKNOWN_LIMIT: LimitRecord = { state: 'unknown', mightKw: null };

/** The record of a station without one that holds a stored accepted profile of `kw` (in W: `watts`). */
export function profiledLimit(kw: number, watts = false): LimitRecord {
  return { state: 'profiled', mightKw: kw, ...(watts ? { mightInW: true as const } : {}) };
}

/**
 * True while the limit the station might enforce may be a W limit: the last
 * accepted limit was in W, or a W limit is sent and unanswered or lost, or
 * the limit held before it was one. A W limit bounds the total only, so its
 * kW count in full on every phase the station may use.
 */
export function limitMayBeWatts(record: LimitRecord): boolean {
  switch (record.state) {
    case 'unknown':
    case 'refused':
      return false;
    case 'accepted':
      return record.sentInW === true;
    case 'profiled':
      return record.mightInW === true;
    case 'awaiting':
    case 'lost':
      return record.sentInW === true || record.mightInW === true;
  }
}

function inW(sent: boolean, might: boolean): Pick<LimitRecord, 'sentInW' | 'mightInW'> {
  return {
    ...(sent ? { sentInW: true as const } : {}),
    ...(might ? { mightInW: true as const } : {}),
  };
}

/** The highest limit the station might enforce, in kW; null when it may be unlimited. */
export function limitMightKw(record: LimitRecord): number | null {
  switch (record.state) {
    case 'unknown':
    case 'refused':
      return null;
    case 'profiled':
    case 'lost':
      return record.mightKw;
    case 'accepted':
      return record.sentKw ?? null;
    case 'awaiting':
      return record.mightKw == null || record.sentKw == null
        ? null
        : Math.max(record.sentKw, record.mightKw);
  }
}

function answers(record: LimitRecord, commandId: string): boolean {
  return (record.state === 'awaiting' || record.state === 'lost') && record.commandId === commandId;
}

/** The record after `event`; an event that does not apply returns `record` unchanged. */
export function limitTransition(record: LimitRecord, event: LimitEvent): LimitRecord {
  switch (event.type) {
    case 'send':
      return {
        state: 'awaiting',
        commandId: event.commandId,
        sentKw: event.kw,
        mightKw: limitMightKw(record),
        ...inW(event.watts === true, limitMayBeWatts(record)),
      };
    case 'accepted':
      if (!answers(record, event.commandId) || record.sentKw == null) return record;
      return {
        state: 'accepted',
        commandId: event.commandId,
        sentKw: record.sentKw,
        mightKw: record.sentKw,
        ...inW(record.sentInW === true, record.sentInW === true),
      };
    case 'rejected':
      if (!answers(record, event.commandId)) return record;
      return { ...record, state: 'refused', mightKw: null };
    case 'timeout':
      if (record.state !== 'awaiting' || record.commandId !== event.commandId) return record;
      return {
        ...record,
        state: 'lost',
        mightKw: limitMightKw(record),
        ...inW(record.sentInW === true, limitMayBeWatts(record)),
      };
    case 'unpublished':
      if (record.state !== 'awaiting' || record.commandId !== event.commandId) return record;
      return { ...record, state: 'lost' };
    case 'boot':
    case 'cleared':
      return UNKNOWN_LIMIT;
  }
}

/** Reads a stored record; anything else is `unknown` (the safe state). */
export function parseLimitRecord(value: unknown): LimitRecord {
  if (value == null || typeof value !== 'object') return UNKNOWN_LIMIT;
  const v = value as Record<string, unknown>;
  const state = v['state'];
  if (typeof state !== 'string' || !(LIMIT_STATES as readonly string[]).includes(state)) {
    return UNKNOWN_LIMIT;
  }
  const num = (x: unknown): number | undefined =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
  const sentKw = num(v['sentKw']);
  const mightKw = num(v['mightKw']) ?? null;
  const commandId =
    typeof v['commandId'] === 'string' && v['commandId'] !== '' ? v['commandId'] : undefined;
  const record: LimitRecord = {
    state: state as LimitState,
    ...(commandId != null ? { commandId } : {}),
    ...(sentKw != null ? { sentKw } : {}),
    mightKw,
    ...inW(v['sentInW'] === true, v['mightInW'] === true),
  };
  // A record missing what its state needs is not trusted.
  if ((state === 'awaiting' || state === 'accepted') && (sentKw == null || commandId == null)) {
    return UNKNOWN_LIMIT;
  }
  if (state === 'profiled' && mightKw == null) return UNKNOWN_LIMIT;
  return record;
}

/**
 * A credit profile record's transition: a refused credit profile changes
 * nothing at the station, so the record keeps what the station held before.
 */
export function creditTransition(record: LimitRecord, event: LimitEvent): LimitRecord {
  const next = limitTransition(record, event);
  return next.state === 'refused'
    ? { state: 'lost', mightKw: limitMightKw(record), ...inW(false, limitMayBeWatts(record)) }
    : next;
}
