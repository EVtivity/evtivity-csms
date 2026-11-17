// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** A CSV import of fleet RFID cards takes at most this many data rows. */
export const FLEET_CARD_IMPORT_MAX_ROWS = 2000;
/** And at most this many bytes. */
export const FLEET_CARD_IMPORT_MAX_BYTES = 512 * 1024;

/** The template a user downloads: the header the import reads and two example rows. */
export const FLEET_CARD_IMPORT_TEMPLATE =
  'idToken,tokenType,label,memberEmail\r\n04A1B2C3D4E5F6,ISO14443,Van 12,\r\n04A1B2C3D4E5F7,ISO14443,Van 14,driver@example.com\r\n';

/** The template a fleet user downloads: no member emails, which only operators may match. */
export const FLEET_USER_CARD_IMPORT_TEMPLATE =
  'idToken,tokenType,label\r\n04A1B2C3D4E5F6,ISO14443,Van 12\r\n04A1B2C3D4E5F7,ISO14443,Van 14\r\n';
