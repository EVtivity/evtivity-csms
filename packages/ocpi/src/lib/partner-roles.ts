// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OCPI_ROLE_NAMES, roleNamesOf } from '@evtivity/lib/ocpi-roles';
import type { OcpiCredentialsRole } from '../types/ocpi.js';

/**
 * The role entries of a partner's credentials stored as declared: an OCPI
 * role name, for the party of the partner row. Other entries (an unknown
 * role, another country code or party id) are dropped.
 */
export function declaredRolesOf(
  roles: unknown,
  partner: { countryCode: string; partyId: string },
): OcpiCredentialsRole[] {
  if (!Array.isArray(roles)) return [];
  return (roles as unknown[]).filter((r): r is OcpiCredentialsRole => {
    if (r == null || typeof r !== 'object') return false;
    const entry = r as { role?: unknown; country_code?: unknown; party_id?: unknown };
    return (
      typeof entry.role === 'string' &&
      (OCPI_ROLE_NAMES as readonly string[]).includes(entry.role) &&
      entry.country_code === partner.countryCode &&
      entry.party_id === partner.partyId
    );
  });
}

/**
 * The partner roles the CSMS acts on (`ocpi_partners.approved_roles`) after a
 * credentials handshake: always the roles the operator approved, empty until
 * the operator decides (deny by default, owner decision 2026-10-23). A
 * handshake never writes them, so a partner's declaration never widens them
 * (a partner registered as an eMSP that declares CPO would otherwise read
 * every driver token). Declared roles beyond the approved set are `held` for
 * the operator, who approves them on the partner page.
 */
export function approvedRolesAfterHandshake(
  locked: { approvedRoles: unknown },
  declared: unknown,
): { approved: string[]; held: string[] } {
  const current = roleNamesOf(locked.approvedRoles);
  return {
    approved: current,
    held: roleNamesOf(declared).filter((r) => !current.includes(r)),
  };
}

/**
 * The approved partner roles each OCPI module interface serves, deny by
 * default. The CPO interface serves an
 * eMSP (a NAP or NSP reads the public locations and tariffs only), the eMSP
 * interface a CPO, hub client info a hub; a hub reaches every interface for
 * the parties behind it. A module route missing here serves no partner.
 */
const MODULE_ROLES: Record<string, readonly string[]> = {
  'cpo/locations': ['EMSP', 'HUB', 'NAP', 'NSP'],
  'cpo/tariffs': ['EMSP', 'HUB', 'NAP', 'NSP'],
  'cpo/sessions': ['EMSP', 'HUB'],
  'cpo/cdrs': ['EMSP', 'HUB'],
  'cpo/tokens': ['EMSP', 'HUB'],
  'cpo/commands': ['EMSP', 'HUB'],
  'emsp/locations': ['CPO', 'HUB'],
  'emsp/tariffs': ['CPO', 'HUB'],
  'emsp/sessions': ['CPO', 'HUB'],
  'emsp/cdrs': ['CPO', 'HUB'],
  'emsp/tokens': ['CPO', 'HUB'],
  hubclientinfo: ['HUB'],
};

/**
 * The approved roles that may call a module route (`/ocpi/<version>/cpo/...`,
 * `/ocpi/<version>/emsp/...`, `/ocpi/<version>/hubclientinfo...`), or an
 * empty list for a route of no known module.
 */
export function rolesForModuleRoute(routeUrl: string): readonly string[] {
  const match = /^\/ocpi\/[^/]+\/(?:(cpo|emsp)\/([a-z]+)|(hubclientinfo))(?:\/|$)/.exec(routeUrl);
  if (match == null) return [];
  const key = match[3] ?? `${match[1] ?? ''}/${match[2] ?? ''}`;
  return MODULE_ROLES[key] ?? [];
}

/** True when an approved role of the partner may call the module route. */
export function moduleRouteAllows(routeUrl: string, approvedRoleNames: readonly string[]): boolean {
  const allowed = rolesForModuleRoute(routeUrl);
  return approvedRoleNames.some((role) => allowed.includes(role));
}
