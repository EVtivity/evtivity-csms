// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, or, ilike, and, asc, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { sites, chargingStations, evses, connectors, vendors } from '@evtivity/database';

const VALID_CONNECTOR_TYPES = ['CCS2', 'CHAdeMO', 'Type2', 'Type1', 'GBT', 'Tesla', 'NACS'];

const CSV_HEADER =
  'siteName,stationId,stationModel,stationSerialNumber,stationStatus,onboardingStatus,evseId,connectorId,connectorType,maxPowerKw,maxCurrentAmps,stationVendor';

const TEMPLATE_ROWS = [
  'Downtown Garage,CS-001,PowerCharge 150,SN-12345,pending,1,1,CCS2,150,32,ACME Chargers',
  'Downtown Garage,CS-001,PowerCharge 150,SN-12345,pending,1,2,CHAdeMO,50,125,ACME Chargers',
  'Downtown Garage,CS-001,PowerCharge 150,SN-12345,pending,2,1,Type2,22,32,ACME Chargers',
  'Airport Lot,,,,,,,,',
];

export interface ImportRow {
  siteName: string;
  stationId?: string | undefined;
  stationModel?: string | undefined;
  stationSerialNumber?: string | undefined;
  evseId?: number | undefined;
  connectorId?: number | undefined;
  connectorType?: string | undefined;
  maxPowerKw?: number | undefined;
  maxCurrentAmps?: number | undefined;
  stationVendor?: string | undefined;
}

export interface ImportResult {
  sitesCreated: number;
  sitesUpdated: number;
  stationsCreated: number;
  stationsUpdated: number;
  evsesCreated: number;
  evsesUpdated: number;
  connectorsCreated: number;
  connectorsUpdated: number;
  errors: string[];
}

export async function exportSitesCsv(search?: string, siteIds?: string[]): Promise<string> {
  const conditions = [];
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(ilike(sites.name, pattern), ilike(sites.city, pattern), ilike(sites.state, pattern)),
    );
  }
  if (siteIds != null) {
    if (siteIds.length === 0) return CSV_HEADER;
    conditions.push(inArray(sites.id, siteIds));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const data = await db
    .select({
      siteName: sites.name,
      stationId: chargingStations.stationId,
      stationModel: chargingStations.model,
      stationSerialNumber: chargingStations.serialNumber,
      stationStatus: chargingStations.availability,
      onboardingStatus: chargingStations.onboardingStatus,
      evseId: evses.evseId,
      connectorId: connectors.connectorId,
      connectorType: connectors.connectorType,
      maxPowerKw: connectors.maxPowerKw,
      maxCurrentAmps: connectors.maxCurrentAmps,
      vendorName: vendors.name,
    })
    .from(sites)
    .leftJoin(chargingStations, eq(chargingStations.siteId, sites.id))
    .leftJoin(vendors, eq(vendors.id, chargingStations.vendorId))
    .leftJoin(evses, eq(evses.stationId, chargingStations.id))
    .leftJoin(connectors, eq(connectors.evseId, evses.id))
    .where(where)
    .orderBy(
      asc(sites.name),
      asc(chargingStations.stationId),
      asc(evses.evseId),
      asc(connectors.connectorId),
    );

  const rows = data.map((row) => {
    return [
      csvEscape(row.siteName),
      csvEscape(row.stationId ?? ''),
      csvEscape(row.stationModel ?? ''),
      csvEscape(row.stationSerialNumber ?? ''),
      csvEscape(row.stationStatus ?? ''),
      csvEscape(row.onboardingStatus ?? ''),
      row.evseId != null ? String(row.evseId) : '',
      row.connectorId != null ? String(row.connectorId) : '',
      csvEscape(row.connectorType ?? ''),
      row.maxPowerKw ?? '',
      row.maxCurrentAmps != null ? String(row.maxCurrentAmps) : '',
      csvEscape(row.vendorName ?? ''),
    ].join(',');
  });

  return [CSV_HEADER, ...rows].join('\n');
}

export function exportSitesTemplateCsv(): string {
  return [CSV_HEADER, ...TEMPLATE_ROWS].join('\n');
}

export async function importSitesCsv(
  rows: ImportRow[],
  updateExisting: boolean,
): Promise<ImportResult> {
  const result: ImportResult = {
    sitesCreated: 0,
    sitesUpdated: 0,
    stationsCreated: 0,
    stationsUpdated: 0,
    evsesCreated: 0,
    evsesUpdated: 0,
    connectorsCreated: 0,
    connectorsUpdated: 0,
    errors: [],
  };

  // Validate rows upfront
  const validRows: Array<{ index: number; row: ImportRow }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row == null) continue;

    if (!row.siteName) {
      result.errors.push(`Row ${String(i + 1)}: missing siteName`);
      continue;
    }

    if (row.connectorType && !VALID_CONNECTOR_TYPES.includes(row.connectorType)) {
      result.errors.push(`Row ${String(i + 1)}: invalid connectorType "${row.connectorType}"`);
      continue;
    }

    if (row.evseId != null && !row.stationId) {
      result.errors.push(`Row ${String(i + 1)}: evseId provided without stationId`);
      continue;
    }

    if (row.connectorId != null && row.evseId == null) {
      result.errors.push(`Row ${String(i + 1)}: connectorId provided without evseId`);
      continue;
    }

    validRows.push({ index: i, row });
  }

  // Group by siteName
  const siteGroups = new Map<string, Array<{ index: number; row: ImportRow }>>();
  for (const entry of validRows) {
    const key = entry.row.siteName;
    const group = siteGroups.get(key) ?? [];
    group.push(entry);
    siteGroups.set(key, group);
  }

  await db.transaction(async (tx) => {
    const siteIdByName = new Map<string, string>();
    const stationUuidByStationId = new Map<string, string>();
    const evseUuidByKey = new Map<string, string>();
    const vendorIdByName = new Map<string, string>();

    for (const [siteName, siteRows] of siteGroups) {
      // Upsert or insert site
      if (updateExisting) {
        const [site] = await tx
          .insert(sites)
          .values({ name: siteName })
          .onConflictDoUpdate({
            target: sites.name,
            set: { updatedAt: new Date() },
          })
          .returning({ id: sites.id, createdAt: sites.createdAt, updatedAt: sites.updatedAt });
        if (site != null) {
          siteIdByName.set(siteName, site.id);
          if (site.createdAt.getTime() === site.updatedAt.getTime()) {
            result.sitesCreated++;
          } else {
            result.sitesUpdated++;
          }
        }
      } else {
        const [existing] = await tx
          .select({ id: sites.id })
          .from(sites)
          .where(eq(sites.name, siteName));
        if (existing != null) {
          siteIdByName.set(siteName, existing.id);
          result.errors.push(`Site "${siteName}" already exists, skipped`);
        } else {
          const [site] = await tx
            .insert(sites)
            .values({ name: siteName })
            .returning({ id: sites.id });
          if (site != null) {
            siteIdByName.set(siteName, site.id);
            result.sitesCreated++;
          }
        }
      }

      // Process stations within this site
      const stationGroups = new Map<string, Array<{ index: number; row: ImportRow }>>();
      for (const entry of siteRows) {
        if (!entry.row.stationId) continue;
        const group = stationGroups.get(entry.row.stationId) ?? [];
        group.push(entry);
        stationGroups.set(entry.row.stationId, group);
      }

      for (const [stationId, stationRows] of stationGroups) {
        const siteId = siteIdByName.get(siteName);
        if (siteId == null) continue;

        const firstStationRow = stationRows[0];
        if (firstStationRow == null) continue;

        // Resolve vendor
        let vendorId: string | null = null;
        const vendorName = firstStationRow.row.stationVendor;
        if (vendorName) {
          if (vendorIdByName.has(vendorName)) {
            vendorId = vendorIdByName.get(vendorName) ?? null;
          } else {
            const [vendor] = await tx
              .select({ id: vendors.id })
              .from(vendors)
              .where(eq(vendors.name, vendorName));
            if (vendor != null) {
              vendorId = vendor.id;
              vendorIdByName.set(vendorName, vendor.id);
            } else {
              result.errors.push(
                `Row ${String(firstStationRow.index + 1)}: vendor "${vendorName}" not found`,
              );
            }
          }
        }

        const stationValues: {
          stationId: string;
          siteId: string;
          model?: string;
          serialNumber?: string;
          vendorId?: string;
        } = {
          stationId,
          siteId,
        };

        if (firstStationRow.row.stationModel) {
          stationValues.model = firstStationRow.row.stationModel;
        }
        if (firstStationRow.row.stationSerialNumber) {
          stationValues.serialNumber = firstStationRow.row.stationSerialNumber;
        }
        if (vendorId) {
          stationValues.vendorId = vendorId;
        }

        if (updateExisting) {
          const [station] = await tx
            .insert(chargingStations)
            .values(stationValues)
            .onConflictDoUpdate({
              target: chargingStations.stationId,
              set: { ...stationValues, updatedAt: new Date() },
            })
            .returning({
              id: chargingStations.id,
              createdAt: chargingStations.createdAt,
              updatedAt: chargingStations.updatedAt,
            });
          if (station != null) {
            stationUuidByStationId.set(stationId, station.id);
            if (station.createdAt.getTime() === station.updatedAt.getTime()) {
              result.stationsCreated++;
            } else {
              result.stationsUpdated++;
            }
          }
        } else {
          const [existing] = await tx
            .select({ id: chargingStations.id })
            .from(chargingStations)
            .where(eq(chargingStations.stationId, stationId));
          if (existing != null) {
            stationUuidByStationId.set(stationId, existing.id);
            result.errors.push(`Station "${stationId}" already exists, skipped`);
          } else {
            const [station] = await tx
              .insert(chargingStations)
              .values(stationValues)
              .returning({ id: chargingStations.id });
            if (station != null) {
              stationUuidByStationId.set(stationId, station.id);
              result.stationsCreated++;
            }
          }
        }

        // Process EVSEs within this station
        const evseGroups = new Map<number, Array<{ index: number; row: ImportRow }>>();
        for (const entry of stationRows) {
          if (entry.row.evseId == null) continue;
          const group = evseGroups.get(entry.row.evseId) ?? [];
          group.push(entry);
          evseGroups.set(entry.row.evseId, group);
        }

        for (const [evseId, evseRows] of evseGroups) {
          const stationUuid = stationUuidByStationId.get(stationId);
          if (stationUuid == null) continue;

          if (updateExisting) {
            const [existing] = await tx
              .select({ id: evses.id })
              .from(evses)
              .where(and(eq(evses.stationId, stationUuid), eq(evses.evseId, evseId)));
            if (existing != null) {
              await tx
                .update(evses)
                .set({ updatedAt: new Date() })
                .where(eq(evses.id, existing.id));
              evseUuidByKey.set(`${stationId}:${String(evseId)}`, existing.id);
              result.evsesUpdated++;
            } else {
              const [evse] = await tx
                .insert(evses)
                .values({ stationId: stationUuid, evseId })
                .returning({ id: evses.id });
              if (evse != null) {
                evseUuidByKey.set(`${stationId}:${String(evseId)}`, evse.id);
                result.evsesCreated++;
              }
            }
          } else {
            const [existing] = await tx
              .select({ id: evses.id })
              .from(evses)
              .where(and(eq(evses.stationId, stationUuid), eq(evses.evseId, evseId)));
            if (existing != null) {
              evseUuidByKey.set(`${stationId}:${String(evseId)}`, existing.id);
              result.errors.push(
                `EVSE ${String(evseId)} on station "${stationId}" already exists, skipped`,
              );
            } else {
              const [evse] = await tx
                .insert(evses)
                .values({ stationId: stationUuid, evseId })
                .returning({ id: evses.id });
              if (evse != null) {
                evseUuidByKey.set(`${stationId}:${String(evseId)}`, evse.id);
                result.evsesCreated++;
              }
            }
          }

          // Process connectors within this EVSE
          for (const entry of evseRows) {
            if (entry.row.connectorId == null) continue;

            const evseUuid = evseUuidByKey.get(`${stationId}:${String(evseId)}`);
            if (evseUuid == null) continue;

            const connectorValues: {
              evseId: string;
              connectorId: number;
              connectorType?: string;
              maxPowerKw?: string;
              maxCurrentAmps?: number;
            } = {
              evseId: evseUuid,
              connectorId: entry.row.connectorId,
            };

            if (entry.row.connectorType) {
              connectorValues.connectorType = entry.row.connectorType;
            }
            if (entry.row.maxPowerKw != null) {
              connectorValues.maxPowerKw = String(entry.row.maxPowerKw);
            }
            if (entry.row.maxCurrentAmps != null) {
              connectorValues.maxCurrentAmps = entry.row.maxCurrentAmps;
            }

            if (updateExisting) {
              const [existing] = await tx
                .select({ id: connectors.id })
                .from(connectors)
                .where(
                  and(
                    eq(connectors.evseId, evseUuid),
                    eq(connectors.connectorId, entry.row.connectorId),
                  ),
                );
              if (existing != null) {
                const updateSet: {
                  updatedAt: Date;
                  connectorType?: string;
                  maxPowerKw?: string;
                  maxCurrentAmps?: number;
                } = { updatedAt: new Date() };
                if (entry.row.connectorType) {
                  updateSet.connectorType = entry.row.connectorType;
                }
                if (entry.row.maxPowerKw != null) {
                  updateSet.maxPowerKw = String(entry.row.maxPowerKw);
                }
                if (entry.row.maxCurrentAmps != null) {
                  updateSet.maxCurrentAmps = entry.row.maxCurrentAmps;
                }
                await tx.update(connectors).set(updateSet).where(eq(connectors.id, existing.id));
                result.connectorsUpdated++;
              } else {
                await tx.insert(connectors).values(connectorValues);
                result.connectorsCreated++;
              }
            } else {
              const [existing] = await tx
                .select({ id: connectors.id })
                .from(connectors)
                .where(
                  and(
                    eq(connectors.evseId, evseUuid),
                    eq(connectors.connectorId, entry.row.connectorId),
                  ),
                );
              if (existing != null) {
                result.errors.push(
                  `Connector ${String(entry.row.connectorId)} on EVSE ${String(evseId)} of station "${stationId}" already exists, skipped`,
                );
              } else {
                await tx.insert(connectors).values(connectorValues);
                result.connectorsCreated++;
              }
            }
          }
        }
      }
    }
  });

  return result;
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
