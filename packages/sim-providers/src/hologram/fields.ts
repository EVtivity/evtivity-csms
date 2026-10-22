// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Hologram replies are read through these allow lists only. A reply also holds
// fields the CSMS must never keep or show: the link PIN, PUK and eUICC
// activation code, the device IMEI and IMEISV, the ICCID and tags on usage
// records, location (latitude and longitude), and the payload and device metadata of CSR
// records (they can hold IMEI values). None of them is read here.
//
// A string longer than HOLOGRAM_MAX_FIELD_LENGTH is dropped (read as absent),
// never cut: a cut APN or profile name would look valid and be wrong.

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) return Number(value);
  return null;
}

export const HOLOGRAM_MAX_FIELD_LENGTH = 200;

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= HOLOGRAM_MAX_FIELD_LENGTH
    ? value
    : null;
}

/** A digit string kept as text (an IMSI can be sent as a number or a string). */
function digits(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^\d{1,200}$/.test(value)) return value;
  return null;
}

export interface HologramLink {
  id: number;
  /** Not in the pinned spec's link schema (seen in live replies): optional. */
  simcardId: number | null;
  /** The ICCID of the link's profile, read for the status only. */
  iccid: string | null;
  imsi: string | null;
  state: string | null;
  apn: string | null;
  profileName: string | null;
  overageLimit: number | null;
  /** `plan.data`, not in the pinned spec's link schema: optional. */
  planData: number | null;
}

export interface HologramDevice {
  id: number;
  simcardId: number | null;
  /** `intended_plan_data`, not in the pinned spec's device schema: optional. */
  intendedPlanData: number | null;
  links: HologramLink[];
}

function pickLink(raw: unknown): HologramLink | null {
  const link = asObject(raw);
  const id = int(link?.['id']);
  if (link == null || id == null) return null;
  return {
    id,
    simcardId: int(link['simcardid']),
    iccid: text(link['sim']),
    imsi: digits(link['imsi']),
    state: text(link['state']),
    apn: text(link['apn']),
    profileName: text(link['profile_name']),
    overageLimit: int(link['overagelimit']),
    planData: int(asObject(link['plan'])?.['data']),
  };
}

export function pickDevice(raw: unknown): HologramDevice | null {
  const device = asObject(raw);
  const id = int(device?.['id']);
  if (device == null || id == null) return null;
  const links = asArray(asObject(device['links'])?.['cellular'])
    .map(pickLink)
    .filter((l): l is HologramLink => l != null);
  return {
    id,
    simcardId: int(device['simcardid']),
    intendedPlanData: int(device['intended_plan_data']),
    links,
  };
}

export interface HologramClosedSessionSummary {
  linkId: number | null;
  begin: string | null;
  end: string | null;
}

export interface HologramOpenSession {
  linkId: number | null;
  begin: string | null;
}

export interface HologramBillingUsage {
  bytes: number | null;
  periodEnd: string | null;
  recentSessions: HologramClosedSessionSummary[];
  openSessions: HologramOpenSession[];
}

export function pickBillingUsage(raw: unknown): HologramBillingUsage | null {
  const usage = asObject(raw);
  if (usage == null) return null;
  return {
    bytes: int(usage['current_billing_usage']),
    periodEnd: text(usage['billing_period_end']),
    recentSessions: asArray(usage['most_recent_sessions']).flatMap((s) => {
      const session = asObject(s);
      if (session == null) return [];
      return [
        {
          linkId: int(session['linkid']),
          begin: text(session['session_begin']),
          end: text(session['session_end']),
        },
      ];
    }),
    openSessions: asArray(usage['open_sessions']).flatMap((s) => {
      const session = asObject(s);
      if (session == null) return [];
      return [{ linkId: int(session['linkid']), begin: text(session['session_begin']) }];
    }),
  };
}

export interface HologramUsageRecord {
  recordId: number;
  begin: string | null;
  end: string | null;
  bytes: number | null;
  networkName: string | null;
  radioAccessTechnology: string | null;
  cellId: number | null;
}

export function pickUsageRecord(raw: unknown): HologramUsageRecord | null {
  const record = asObject(raw);
  const recordId = int(record?.['record_id']);
  if (record == null || recordId == null) return null;
  return {
    recordId,
    begin: text(record['session_begin']),
    end: text(record['timestamp']),
    bytes: int(record['bytes']),
    networkName: text(record['network_name']),
    radioAccessTechnology: text(record['radio_access_technology']),
    cellId: int(record['cellid']),
  };
}

export interface HologramCsrRecord {
  id: number;
  logged: string | null;
  topics: string[];
}

export function pickCsrRecord(raw: unknown): HologramCsrRecord | null {
  const record = asObject(raw);
  const id = int(record?.['id']);
  if (record == null || id == null) return null;
  return {
    id,
    logged: text(record['logged']),
    // Only system topic names (underscore wrapped) are kept, never user tags.
    topics: asArray(record['tags']).filter(
      (t): t is string => typeof t === 'string' && /^_[A-Z_]{1,62}_$/.test(t),
    ),
  };
}

export interface HologramOrganization {
  id: number;
  name: string;
}

export function pickOrganization(raw: unknown): HologramOrganization | null {
  const org = asObject(raw);
  const id = int(org?.['id']);
  if (org == null || id == null) return null;
  return { id, name: text(org['name']) ?? String(id) };
}

export interface HologramListPage {
  data: unknown[];
  continues: boolean;
  lastId: number | null;
}

export function pickListPage(raw: unknown): HologramListPage {
  const page = asObject(raw);
  return {
    data: asArray(page?.['data']),
    continues: page?.['continues'] === true,
    lastId: int(page?.['lastid']),
  };
}

export function pickData(raw: unknown): unknown {
  return asObject(raw)?.['data'];
}
