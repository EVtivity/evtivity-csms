// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// drizzle-orm's postgres-js driver makes the timestamp and date parsers of the
// client it wraps transparent (config.ts restores only the serializers). A raw
// query through the shared `client` (client`...`, db.execute(sql`...`),
// client.unsafe) therefore returns timestamptz columns as postgres text
// ('2026-10-10 10:49:38.215+00'), not Date and not ISO 8601. Map such a
// value with these helpers before using it as a Date or sending it out.

/** A nullable timestamp column of a raw query row. */
export type RawTimestamp = Date | string | null | undefined;

/** A timestamp value from a raw query row, as a Date. Throws on an unparsable value. */
export function toDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Unparsable timestamp from the database: ${value}`);
  }
  return date;
}

/** Like `toDate`, with null and undefined mapped to null. */
export function toDateOrNull(value: RawTimestamp): Date | null {
  return value == null ? null : toDate(value);
}

/** A timestamp value from a raw query row, as an ISO 8601 string, or null. */
export function toIsoOrNull(value: RawTimestamp): string | null {
  return value == null ? null : toDate(value).toISOString();
}
