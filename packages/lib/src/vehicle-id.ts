// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Vehicle ids a charger learns from the EV (Autocharge, charge by plugging in).
 * One normalization for the OCPP server, the API and both frontends, so a
 * value captured at a start, stored on a vehicle and typed by a driver all
 * compare equal. Browser-safe.
 *
 * Protocol facts (OCPP 2.1 Appendices, IdTokenEnumStringType and
 * additional_info_types; Q01.FR.02):
 * - `MacAddress`: the MAC address of the EV's charging controller, used for
 *   Autocharge.
 * - `EVCCID`: the EVCC id, the MAC address for ISO 15118-2, an identifier of
 *   up to 255 characters for ISO 15118-20. A station also sends it as
 *   `idToken.additionalInfo` with type `EVCCID` next to the token that
 *   authorizes the transaction (Q01.FR.02, TransactionEvent Started).
 * - `VIN`: the vehicle identification number.
 * - IdToken values are case insensitive.
 *
 * OCPP 1.6 has no token type. Autocharge stations send the MAC address in the
 * idTag with the prefix `VID:` (Monta Auto Charge specification:
 * `VID:92D50A693F80`). A 1.6 idTag is a vehicle id when it carries a known
 * prefix, has the VIN shape (17 characters, no I, O or Q), or the MAC shape
 * (12 hex digits, with or without `:`, `-` or `.` separators). ISO 14443 and
 * ISO 15693 card UIDs are 4, 7 or 8 bytes (8, 14 or 16 hex digits), so a
 * 6-byte MAC address does not collide with a card UID. A driver token with
 * the same value is checked first, so a card always wins.
 */

/** The OCPP 2.1 token types that identify a vehicle. */
export const VEHICLE_ID_TYPES = ['VIN', 'EVCCID', 'MacAddress'] as const;
export type VehicleIdType = (typeof VEHICLE_ID_TYPES)[number];

/**
 * Where the id came from: the 2.1 idToken itself, an additionalInfo entry of
 * the 2.1 idToken (alongside a card or another token), or a 1.6 idTag.
 */
export const VEHICLE_ID_SOURCES = ['id_token', 'additional_info', 'id_tag'] as const;
export type VehicleIdSource = (typeof VEHICLE_ID_SOURCES)[number];

export interface VehicleIdCapture {
  /** Normalized: a MAC address as 12 uppercase hex digits, a VIN uppercase. */
  value: string;
  type: VehicleIdType;
  source: VehicleIdSource;
}

/** 1.6 idTag prefixes stripped before the value is read (case insensitive). */
export const VEHICLE_ID_TAG_PREFIXES = ['VID:'] as const;

/** Longest stored vehicle id (the ISO 15118-20 EVCCID and the IdToken limit). */
export const VEHICLE_ID_MAX_LENGTH = 255;

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
const MAC_PATTERN =
  /^(?:[0-9A-F]{12}|[0-9A-F]{2}(?::[0-9A-F]{2}){5}|[0-9A-F]{2}(?:-[0-9A-F]{2}){5}|[0-9A-F]{4}(?:\.[0-9A-F]{4}){2})$/;

export function isVehicleIdType(value: string | null | undefined): value is VehicleIdType {
  return value != null && (VEHICLE_ID_TYPES as readonly string[]).includes(value);
}

/** A MAC address as 12 uppercase hex digits, or null when the value is not one. */
export function normalizeMacAddress(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  if (!MAC_PATTERN.test(value)) return null;
  return value.replace(/[:.-]/g, '');
}

/** A VIN uppercase, or null when the value is not 17 VIN characters. */
export function normalizeVin(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  return VIN_PATTERN.test(value) ? value : null;
}

/**
 * An EVCCID: the MAC address form when it is one (ISO 15118-2), otherwise the
 * trimmed value uppercase (ISO 15118-20, case insensitive like every IdToken).
 * Null when empty or longer than the IdToken limit.
 */
export function normalizeEvccid(raw: string): string | null {
  const mac = normalizeMacAddress(raw);
  if (mac != null) return mac;
  const value = raw.trim().toUpperCase();
  if (value === '' || value.length > VEHICLE_ID_MAX_LENGTH || /\s/.test(value)) return null;
  return value;
}

/** Normalizes a value of a vehicle id type, null when it does not fit the type. */
export function normalizeVehicleId(type: VehicleIdType, raw: string): string | null {
  if (type === 'VIN') return normalizeVin(raw);
  if (type === 'MacAddress') return normalizeMacAddress(raw);
  return normalizeEvccid(raw);
}

/** The vehicle id of an OCPP 2.1 idToken of type VIN, EVCCID or MacAddress. */
export function vehicleIdFromIdToken(
  type: string | null | undefined,
  value: string,
): VehicleIdCapture | null {
  if (!isVehicleIdType(type)) return null;
  const normalized = normalizeVehicleId(type, value);
  return normalized != null ? { value: normalized, type, source: 'id_token' } : null;
}

/**
 * The first vehicle id among a 2.1 idToken's additionalInfo entries. The
 * Appendices define the type `EVCCID`; `VIN` and `MacAddress` are accepted
 * as custom types (matched case insensitively).
 */
export function vehicleIdFromAdditionalInfo(
  additionalInfo: readonly { additionalIdToken: string; type: string }[] | null | undefined,
): VehicleIdCapture | null {
  if (additionalInfo == null) return null;
  for (const entry of additionalInfo) {
    const type = VEHICLE_ID_TYPES.find((t) => t.toLowerCase() === entry.type.trim().toLowerCase());
    if (type == null) continue;
    const value = normalizeVehicleId(type, entry.additionalIdToken);
    if (value != null) return { value, type, source: 'additional_info' };
  }
  return null;
}

/** The idTag without a known vehicle id prefix, and whether it had one. */
export function stripVehicleIdPrefix(idTag: string): { value: string; prefixed: boolean } {
  const trimmed = idTag.trim();
  for (const prefix of VEHICLE_ID_TAG_PREFIXES) {
    if (trimmed.toUpperCase().startsWith(prefix)) {
      return { value: trimmed.slice(prefix.length), prefixed: true };
    }
  }
  return { value: trimmed, prefixed: false };
}

/** The vehicle id an OCPP 1.6 idTag carries, or null for any other idTag. */
export function vehicleIdFromIdTag(idTag: string): VehicleIdCapture | null {
  const { value } = stripVehicleIdPrefix(idTag);
  const mac = normalizeMacAddress(value);
  if (mac != null) return { value: mac, type: 'MacAddress', source: 'id_tag' };
  const vin = normalizeVin(value);
  if (vin != null) return { value: vin, type: 'VIN', source: 'id_tag' };
  return null;
}

/**
 * The vehicle id of a 2.1 IdToken: the token itself when its type is a
 * vehicle type, otherwise an additionalInfo entry.
 */
export function vehicleIdFromTypedToken(idToken: {
  idToken: string;
  type: string;
  additionalInfo?: readonly { additionalIdToken: string; type: string }[] | null;
}): VehicleIdCapture | null {
  return (
    vehicleIdFromIdToken(idToken.type, idToken.idToken) ??
    vehicleIdFromAdditionalInfo(idToken.additionalInfo)
  );
}

/**
 * The vehicle column a type is matched against: a VIN against `vin`, an
 * EVCCID or MAC address against `evccid`.
 */
export function vehicleIdColumn(type: VehicleIdType): 'vin' | 'evccid' {
  return type === 'VIN' ? 'vin' : 'evccid';
}

/** A stored id for display: a 12 hex digit MAC address as AA:BB:CC:DD:EE:FF. */
export function formatVehicleId(value: string): string {
  return /^[0-9A-F]{12}$/.test(value) ? (value.match(/.{2}/g) ?? [value]).join(':') : value;
}
