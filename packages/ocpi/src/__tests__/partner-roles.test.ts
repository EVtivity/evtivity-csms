// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { roleNamesOf } from '@evtivity/lib/ocpi-roles';
import {
  approvedRolesAfterHandshake,
  declaredRolesOf,
  moduleRouteAllows,
  rolesForModuleRoute,
} from '../lib/partner-roles.js';

/** The role list a `const OCPI_ROLES = [...]` line of another package holds. */
const PARTNER = { countryCode: 'NL', partyId: 'ABC' };
const details = { name: 'Partner' };

describe('declaredRolesOf', () => {
  it('keeps OCPI roles of the partner party and drops foreign parties and unknown roles', () => {
    const roles = [
      { role: 'CPO', country_code: 'NL', party_id: 'ABC', business_details: details },
      { role: 'HUB', country_code: 'DE', party_id: 'ABC', business_details: details },
      { role: 'EMSP', country_code: 'NL', party_id: 'XYZ', business_details: details },
      { role: 'ADMIN', country_code: 'NL', party_id: 'ABC', business_details: details },
      'CPO',
      null,
    ];
    expect(declaredRolesOf(roles, PARTNER)).toEqual([roles[0]]);
  });

  it('answers no roles for a value that is not a list', () => {
    expect(declaredRolesOf({ role: 'CPO' }, PARTNER)).toEqual([]);
  });
});

describe('approvedRolesAfterHandshake (deny by default)', () => {
  const declared = [
    { role: 'CPO', country_code: 'NL', party_id: 'ABC', business_details: details },
    { role: 'HUB', country_code: 'NL', party_id: 'ABC', business_details: details },
  ];

  it('grants nothing to a new registration until the operator approves', () => {
    expect(approvedRolesAfterHandshake({ approvedRoles: [] }, declared)).toEqual({
      approved: [],
      held: ['CPO', 'HUB'],
    });
  });

  it('grants exactly the roles the operator approved, never a declared extra', () => {
    expect(approvedRolesAfterHandshake({ approvedRoles: ['CPO'] }, declared)).toEqual({
      approved: ['CPO'],
      held: ['HUB'],
    });
    expect(roleNamesOf(['EMSP'])).toEqual(['EMSP']);
    expect(approvedRolesAfterHandshake({ approvedRoles: ['EMSP'] }, declared).approved).toEqual([
      'EMSP',
    ]);
  });
});

// Every module interface serves only
// the approved roles that use it; an unknown module serves nobody.
describe('rolesForModuleRoute and moduleRouteAllows', () => {
  it.each([
    ['/ocpi/2.2.1/cpo/locations/:location_id', ['EMSP', 'HUB', 'NAP', 'NSP']],
    ['/ocpi/2.3.0/cpo/tariffs', ['EMSP', 'HUB', 'NAP', 'NSP']],
    ['/ocpi/2.2.1/cpo/sessions', ['EMSP', 'HUB']],
    ['/ocpi/2.2.1/cpo/cdrs', ['EMSP', 'HUB']],
    ['/ocpi/2.2.1/cpo/tokens/:country_code/:party_id/:token_uid', ['EMSP', 'HUB']],
    ['/ocpi/2.2.1/cpo/commands/START_SESSION', ['EMSP', 'HUB']],
    ['/ocpi/2.2.1/emsp/locations/:country_code/:party_id/:location_id', ['CPO', 'HUB']],
    ['/ocpi/2.2.1/emsp/tariffs', ['CPO', 'HUB']],
    ['/ocpi/2.2.1/emsp/sessions/:country_code/:party_id/:session_id', ['CPO', 'HUB']],
    ['/ocpi/2.2.1/emsp/cdrs/:cdr_id', ['CPO', 'HUB']],
    ['/ocpi/2.2.1/emsp/tokens', ['CPO', 'HUB']],
    ['/ocpi/2.2.1/hubclientinfo/:country_code/:party_id', ['HUB']],
    ['/ocpi/2.2.1/cpo/chargingprofiles', []],
    ['/ocpi/2.2.1/credentials', []],
    ['/elsewhere', []],
  ])('%s serves %j', (url, roles) => {
    expect([...rolesForModuleRoute(url)].sort()).toEqual([...roles].sort());
  });

  it('allows a partner only through an approved role of the interface', () => {
    expect(moduleRouteAllows('/ocpi/2.2.1/cpo/commands/START_SESSION', ['CPO'])).toBe(false);
    expect(moduleRouteAllows('/ocpi/2.2.1/cpo/commands/START_SESSION', [])).toBe(false);
    expect(moduleRouteAllows('/ocpi/2.2.1/cpo/commands/START_SESSION', ['EMSP'])).toBe(true);
    expect(moduleRouteAllows('/ocpi/2.2.1/emsp/locations', ['EMSP'])).toBe(false);
    expect(moduleRouteAllows('/ocpi/2.2.1/emsp/locations', ['CPO'])).toBe(true);
  });
});

describe('OCPI role lists', () => {
  it('keeps a declared PTP role (OCPI 2.3.0) as held, never approved', () => {
    const declared = [
      { role: 'PTP', country_code: 'NL', party_id: 'ABC', business_details: details },
    ];
    expect(declaredRolesOf(declared, PARTNER)).toEqual(declared);
    expect(approvedRolesAfterHandshake({ approvedRoles: [] }, declared)).toEqual({
      approved: [],
      held: ['PTP'],
    });
  });
});
