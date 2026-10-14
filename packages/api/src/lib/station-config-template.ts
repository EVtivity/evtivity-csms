// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, configTemplates } from '@evtivity/database';

// Either the shared db instance or a Drizzle transaction.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface NewStation {
  id: string;
  stationId: string;
  ocppProtocol: string | null;
  siteId: string | null;
  vendorId: string | null;
  model: string | null;
}

/**
 * Creates the empty configuration template bound to a new station (the
 * per-station template of the Configurations tab, pushed to that station
 * only). Every way a station is created calls it: POST /v1/stations and the
 * site CSV import. Idempotent: the unique index on config_templates.station_id
 * keeps one template per station, so a second call changes nothing. The
 * template is deleted with its station (cascade).
 */
export async function createStationConfigTemplate(
  exec: Executor,
  station: NewStation,
): Promise<void> {
  const ocppVersion = station.ocppProtocol === 'ocpp2.1' ? '2.1' : '1.6';
  const targetFilter: { stationId: string; siteId?: string; vendorId?: string; model?: string } = {
    stationId: station.id,
  };
  if (station.siteId != null) targetFilter.siteId = station.siteId;
  if (station.vendorId != null) targetFilter.vendorId = station.vendorId;
  if (station.model != null) targetFilter.model = station.model;
  await exec
    .insert(configTemplates)
    .values({
      name: `${station.stationId} - Configurations`,
      description: `Auto generated. ${station.stationId} configurations (OCPP ${ocppVersion})`,
      ocppVersion,
      variables: [],
      stationId: station.id,
      targetFilter,
    })
    .onConflictDoNothing({ target: configTemplates.stationId });
}
