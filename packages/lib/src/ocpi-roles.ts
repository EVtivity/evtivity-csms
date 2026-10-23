// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The OCPI role names (OCPI 2.2.1 and 2.3.0 `Role`; PTP, the payment terminal
 * provider, is new in 2.3.0). The one list the OCPI server, the API
 * `approvedRoles` enum and the CSMS partner page use. Protocol codes: never
 * translated. Browser-safe.
 */
export const OCPI_ROLE_NAMES = [
  'CPO',
  'EMSP',
  'HUB',
  'NAP',
  'NSP',
  'OTHER',
  'SCSP',
  'PTP',
] as const;

export type OcpiRoleName = (typeof OCPI_ROLE_NAMES)[number];

/** The role names of a stored role list: OCPI role objects or plain names. */
export function roleNamesOf(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  const names = (roles as unknown[])
    .map((r) => {
      if (typeof r === 'string') return r;
      if (r == null || typeof r !== 'object') return null;
      const role = (r as { role?: unknown }).role;
      return typeof role === 'string' ? role : null;
    })
    .filter((r): r is string => r != null);
  return [...new Set(names)];
}
