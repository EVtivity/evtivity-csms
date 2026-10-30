// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';

// 1NCE replies are read through these allow lists only (schemas of
// https://help.1nce.com/specs/sim-management-v2.json). A reply also holds
// fields the CSMS must never keep or show: the IMEI and IMEISV, the MSISDN,
// every IP address, the SGSN, VLR and MSC, location, the organisation and the
// endpoint name. None of them is read here, except the event IMEI, which is
// replaced by a one-way hash at once and only compared in memory (a device
// change alert); the hash is never returned, stored or logged.
//
// A string longer than ONENCE_MAX_FIELD_LENGTH is dropped (read as absent),
// never cut: a cut APN would look valid and be wrong.

export const ONENCE_MAX_FIELD_LENGTH = 200;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= ONENCE_MAX_FIELD_LENGTH
    ? value
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}

/** A digit string kept as text (an id or an IMSI can come as a number or a string). */
function digits(value: unknown, max = 32): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && new RegExp(`^\\d{1,${String(max)}}$`).test(value)) return value;
  return null;
}

/**
 * An ISO 8601 UTC time from a 1NCE time: `2023-03-01T12:07:09.000Z`, the
 * `+0000` offset form of `activation_date`, or `2023-08-06 09:59:05` (UTC).
 */
export function oneNceTimeToIso(value: unknown): string | null {
  const raw = text(value);
  if (raw == null) return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})?$/.exec(
      raw.trim(),
    );
  if (match == null) return null;
  let zone = match[3] ?? 'Z';
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const at = Date.parse(`${match[1] ?? ''}T${match[2] ?? ''}${zone}`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

export interface OneNceSim {
  /** The 19-digit ICCID, the path key of every v2 call. */
  iccid: string | null;
  /** The 20-digit ICCID with its Luhn check digit. */
  iccidWithLuhn: string | null;
  /** `current_imsi`, else `imsi`. */
  imsi: string | null;
  status: string | null;
  /** When less than 20 percent of the data quota was left. */
  thresholdReachedAt: string | null;
  /** When the data quota was used up. */
  quotaExceededAt: string | null;
}

export function pickSim(raw: unknown): OneNceSim | null {
  const sim = asObject(raw);
  if (sim == null) return null;
  const quota = asObject(sim['quota_status']);
  return {
    iccid: digits(sim['iccid'], 20),
    iccidWithLuhn: digits(sim['iccid_with_luhn'], 20),
    imsi: digits(sim['current_imsi'], 15) ?? digits(sim['imsi'], 15),
    status: text(sim['status']),
    thresholdReachedAt: oneNceTimeToIso(quota?.['threshold_reached_date']),
    quotaExceededAt: oneNceTimeToIso(quota?.['quota_exceeded_date']),
  };
}

export interface OneNceOpenContext {
  createdAt: string | null;
  apn: string | null;
}

export interface OneNceConnectivity {
  /** ONLINE, ATTACHED, OFFLINE or BLOCKED. */
  status: string | null;
  /** The open data sessions (PDP contexts). */
  openContexts: OneNceOpenContext[];
}

export function pickStatus(raw: unknown): OneNceConnectivity | null {
  const reply = asObject(raw);
  if (reply == null) return null;
  const contexts = Array.isArray(reply['pdp_contexts']) ? reply['pdp_contexts'] : [];
  const openContexts: OneNceOpenContext[] = [];
  for (const item of contexts) {
    const context = asObject(item);
    if (context == null) continue;
    openContexts.push({
      createdAt: oneNceTimeToIso(context['created']),
      apn: text(context['apn']),
    });
  }
  return { status: text(asObject(reply['status'])?.['description']), openContexts };
}

export interface OneNceQuota {
  /** MB left; can be negative. */
  volume: number | null;
  /** MB of the current quota. */
  totalVolume: number | null;
  expiresAt: string | null;
  /** ACTIVE, EXHAUSTED or EXPIRED. */
  status: string | null;
}

export function pickQuota(raw: unknown): OneNceQuota | null {
  const quota = asObject(raw);
  if (quota == null) return null;
  return {
    volume: finite(quota['volume']),
    totalVolume: finite(quota['total_volume']),
    expiresAt: oneNceTimeToIso(quota['expiry_date']),
    status: text(asObject(quota['status'])?.['description']),
  };
}

export interface OneNceEvent {
  id: number;
  typeId: number | null;
  /** `event_type.description`, such as `Delete PDP Context`. */
  typeName: string | null;
  timestamp: string;
  /**
   * A one-way hash of the device IMEI, compared in memory to tell a device
   * change. Never returned, stored or logged.
   */
  deviceHash: string | null;
  /** PDP context events only. */
  pdpContextId: string | null;
  /** MB of the closed data session (Delete PDP Context). */
  volumeTotal: number | null;
  /** `detail.name`: the network name, unverified (Q4). */
  networkName: string | null;
  /** 3GPP TS 29.274 RAT type number, unverified (Q4). */
  ratType: number | null;
  /** E-UTRAN cell id, else the cell id, unverified (Q4). */
  cellId: string | null;
  apn: string | null;
  tunnelCreatedAt: string | null;
}

function deviceHash(value: unknown): string | null {
  const imei = digits(value, 20);
  return imei == null ? null : createHash('sha256').update(imei).digest('hex');
}

export function pickEvent(raw: unknown): OneNceEvent | null {
  const event = asObject(raw);
  const id = int(event?.['id']);
  const timestamp = oneNceTimeToIso(event?.['timestamp']);
  if (event == null || id == null || timestamp == null) return null;
  const detail = asObject(event['detail']);
  const context = asObject(detail?.['pdp_context']);
  const v2 = asObject(context?.['gtp_v2_uli']);
  const v1 = asObject(context?.['gtp_v1_uli']);
  const cell = digits(v2?.['eci']) ?? digits(v1?.['ci']) ?? digits(context?.['ci']);
  return {
    id,
    typeId: int(asObject(event['event_type'])?.['id']),
    typeName: text(asObject(event['event_type'])?.['description']),
    timestamp,
    deviceHash: deviceHash(asObject(event['endpoint'])?.['imei']),
    pdpContextId: digits(context?.['pdp_context_id']),
    volumeTotal: finite(asObject(detail?.['volume'])?.['total']),
    networkName: context == null ? null : text(detail?.['name']),
    ratType: int(context?.['rat_type']),
    cellId: cell,
    apn: text(context?.['apn']),
    tunnelCreatedAt: oneNceTimeToIso(context?.['tunnel_created']),
  };
}

/** The events of one `GET /v2/sims/{iccid}/events` page; a body that is not a list is empty. */
export function pickEvents(raw: unknown): { events: OneNceEvent[]; read: number } {
  if (!Array.isArray(raw)) return { events: [], read: 0 };
  const events: OneNceEvent[] = [];
  for (const item of raw) {
    const event = pickEvent(item);
    if (event != null) events.push(event);
  }
  return { events, read: raw.length };
}

// 3GPP TS 29.274, 8.17 RAT Type.
const RAT_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: '3G',
  2: '2G',
  6: '4G',
  8: 'NB-IoT',
  9: 'LTE-M',
  10: '5G',
});

/** The radio type name of a RAT type number, or null for another value. */
export function ratName(value: number | null): string | null {
  return value == null ? null : (RAT_TYPE_NAMES[value] ?? null);
}
