// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * An OCPI object id we publish and partners put in URL paths (Location.id,
 * Tariff.id: CiString(36)). CiString allows any printable ASCII; we accept
 * only the URL unreserved characters (RFC 3986: letters, digits, `-`, `.`,
 * `_`, `~`), so the id never needs escaping in a partner's receiver URL and a
 * `/`, `?` or `#` cannot change the path a push reaches.
 */
export const OCPI_OBJECT_ID_PATTERN = /^[A-Za-z0-9._~-]{1,36}$/;

export const OCPI_OBJECT_ID_MESSAGE =
  'Use 1 to 36 letters, digits, hyphens, periods, underscores or tildes';
