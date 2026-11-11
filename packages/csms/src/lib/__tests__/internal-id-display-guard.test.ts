// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Guard: list tables and link text never show an internal id as plain text
// (frontend/ui.md, "No internal ids in lists or link text"). A table cell or a
// link whose whole content is a field named `id` or ending in `Id` fails,
// unless the field is a readable external identifier listed below (an OCPP
// station id, an OCPI id, a depot system id). Detail pages keep the copyable
// id under their title through CopyableId, which this guard does not match.

import { describe, expect, it } from 'vitest';

// Every CSMS .tsx source file except tests, keyed `../../<path>`.
const SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

function files(): Array<[string, string]> {
  return Object.entries(SOURCES).map(([key, text]) => [key.replace(/^\.\.\/\.\.\//, ''), text]);
}

/** `<file>:<field expression>` pairs that show a readable, external identifier. */
const ALLOWED = new Set([
  // OCPP station ids (the id the station connects with), the name operators use.
  'components/MatchingStationsCard.tsx:station.stationId',
  'components/load-management/CircuitStationTable.tsx:station.stationId',
  'components/reports/NeviComplianceTab.tsx:station.stationId',
  'pages/MaintenanceEventStations.tsx:r.stationOcppId',
  'components/charts/SecurityEventsCard.tsx:row.stationId',
  'components/reservation/ReservationDetailsTab.tsx:reservation.stationOcppId',
  // The NEVI report EVSE id (the published EVSE identifier).
  'components/reports/NeviComplianceTab.tsx:record.evseId',
  // Bus depot (VDV 463) identifiers the depot system itself sends and uses.
  'components/settings/BusDepotSystemsSettings.tsx:s.presystemId',
  'components/depot-systems/DepotSystemDetail.tsx:r.requestId',
  'components/depot-systems/DepotSystemDetail.tsx:depot.depotId',
  'components/depot-systems/DepotSystemDetail.tsx:bus.vehicleId',
  'components/depot-systems/DepotSystemDetail.tsx:station.chargingStationId',
  // The OCPI CDR id the roaming partner knows the record by.
  'pages/RoamingCdrs.tsx:cdr.ocpiCdrId',
  'pages/RoamingTariffs.tsx:mapping.ocpiTariffId',
  // OCTT conformance test case ids (TC_A_01_CSMS).
  'pages/ConformanceDetail.tsx:result.testId',
  // Owner decision 2026-11-11: rows without a name show their ID first (the
  // session ID, the reservation number).
  'components/SessionsTable.tsx:session.id',
  'components/ReservationsTable.tsx:r.reservationId',
  'pages/Reservations.tsx:r.reservationId',
]);

// A cell or link whose only content is `{a.b.id}` or `{a.fooId}`, also as the
// fallback of `??` (`{a.name ?? a.siteId}`).
const ID_FIELD = String.raw`[A-Za-z_][\w.?]*\.(?:id|[a-z]\w*Id)`;
const PATTERNS = [
  new RegExp(String.raw`<TableCell\b[^>]*>\s*\{\s*(${ID_FIELD})\s*\}\s*</TableCell>`, 'g'),
  new RegExp(String.raw`<Link\b[^>]*>\s*\{\s*(${ID_FIELD})\s*\}\s*</Link>`, 'g'),
  new RegExp(String.raw`\?\?\s*(${ID_FIELD})\s*\}\s*</(?:Link|TableCell|span)>`, 'g'),
];

describe('internal id display guard', () => {
  it('shows no internal id as plain text in a list cell or link', () => {
    const offenders: string[] = [];
    for (const [rel, text] of files()) {
      for (const pattern of PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const field = match[1] ?? '';
          if (!ALLOWED.has(`${rel}:${field}`)) offenders.push(`${rel}:${field}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lists only allowlist entries that still exist', () => {
    const present = new Set<string>();
    for (const [rel, text] of files()) {
      for (const entry of ALLOWED) {
        const [path, field] = entry.split(':');
        if (path === rel && field != null && text.includes(`{${field}}`)) present.add(entry);
      }
    }
    expect([...ALLOWED].filter((entry) => !present.has(entry))).toEqual([]);
  });
});
